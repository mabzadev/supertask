//! `GET /api/database/rows/table/:tableId/` (`src/routes/database/rows.ts`).
//!
//! Ported: JWT, database-token and anonymous (template) access, permissions,
//! `page`/`size`, `order_by`, `user_field_names`, `search`, and every field
//! type but evaluated formulas. Forwarded: `filter__*` (row filters),
//! `include=row_metadata`, formula fields, and any odd input.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Map, Value, json};
use worker::{Env, Request, web_sys};

use super::auth::{Caller, optional_database_token_auth};
use super::db::{Db, Param, ensure_user_table_system_columns};
use super::http::json_response;
use crate::fallback::{ApiError, Failure, Outcome};
use crate::fields::{FieldMeta, Row, truthy_query_param};
use crate::js;
use crate::listing::{active_row_clause, order_clause, search_clauses};
use crate::query::{Query, is_filter_key, positive_int_param};
use crate::resolve::{RowSource, serialize_rows};
use crate::roles::{self, Assignment, Descendants, RoleInputs, Scope, Team};

/// D1 accepts at most 100 bound parameters; id lists are split below that.
const D1_ID_CHUNK_SIZE: usize = 90;

/// The table row `requireAccess` reads.
struct TableMeta {
    id: f64,
    database_id: f64,
    workspace_id: f64,
    is_template: bool,
}

/// `getTableMeta`.
async fn table_meta(db: &Db, table_id: i64) -> Outcome<Option<TableMeta>> {
    let row = db
        .first(
            "SELECT t.id, t.database_id, a.workspace_id, EXISTS (SELECT 1 FROM core_template template WHERE template.workspace_id=a.workspace_id) AS is_template
     FROM database_table t JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0",
            &[Param::from(table_id)],
        )
        .await?;
    Ok(row.map(|row| TableMeta {
        id: js::to_number_opt(row.get("id")),
        database_id: js::to_number_opt(row.get("database_id")),
        workspace_id: js::to_number_opt(row.get("workspace_id")),
        is_template: js::truthy_opt(row.get("is_template")),
    }))
}

fn deserialize<T: serde::de::DeserializeOwned>(rows: Vec<Row>) -> Outcome<Vec<T>> {
    rows.into_iter()
        .map(|row| {
            serde_json::from_value(Value::Object(row))
                .map_err(|e| Failure::unsupported(format!("role row: {e}")))
        })
        .collect()
}

/// `loadRoleInputs`: membership, teams and assignments; non-members are denied.
async fn role_inputs(db: &Db, user_id: f64, workspace_id: f64) -> Outcome<RoleInputs> {
    let membership = db
        .first(
            "SELECT permissions FROM core_workspaceuser WHERE user_id=? AND workspace_id=? AND to_be_deleted=0",
            &[Param::Num(user_id), Param::Num(workspace_id)],
        )
        .await?;
    let teams = db
        .all(
            "SELECT t.id, t.default_role_uid
         FROM enterprise_team t
         JOIN enterprise_teamsubject ts ON ts.team_id=t.id
        WHERE t.workspace_id=? AND t.trashed=0 AND ts.subject_id=? AND ts.subject_type='auth.User'",
            &[Param::Num(workspace_id), Param::Num(user_id)],
        )
        .await?;
    let assignments = db
        .all(
            "SELECT r.uid, ra.subject_type, ra.subject_id, ra.scope_type, ra.scope_id
         FROM enterprise_roleassignment ra
         JOIN enterprise_role r ON r.id=ra.role_id
        WHERE (ra.subject_type='auth.User' AND ra.subject_id=?)
           OR (ra.subject_type='supertask_enterprise.Team' AND ra.subject_id IN (
                SELECT ts.team_id
                  FROM enterprise_teamsubject ts
                  JOIN enterprise_team t ON t.id=ts.team_id
                 WHERE t.workspace_id=? AND t.trashed=0 AND ts.subject_id=? AND ts.subject_type='auth.User'
              ))",
            &[Param::Num(user_id), Param::Num(workspace_id), Param::Num(user_id)],
        )
        .await?;
    let Some(membership) = membership else {
        return Err(ApiError::permission("Access denied.").into());
    };
    let permissions = membership
        .get("permissions")
        .map(js::to_js_string)
        .unwrap_or_default();
    Ok(RoleInputs {
        core_workspace_role: roles::core_permission_role(&permissions).to_owned(),
        teams: deserialize::<Team>(teams)?,
        assignments: deserialize::<Assignment>(assignments)?,
    })
}

/// `readableDescendantRole` for a table scope: its views and fields.
async fn readable_descendant(
    db: &Db,
    user_id: f64,
    teams: &[Team],
    table_id: f64,
) -> Outcome<bool> {
    let ids = |rows: Vec<Row>| {
        rows.iter()
            .map(|r| js::to_number_opt(r.get("id")))
            .collect::<Vec<_>>()
    };
    let views = db
        .all(
            "SELECT id FROM database_view WHERE table_id=? AND trashed=0",
            &[Param::Num(table_id)],
        )
        .await?;
    let fields = db
        .all(
            "SELECT id FROM database_field WHERE table_id=? AND trashed=0",
            &[Param::Num(table_id)],
        )
        .await?;
    let descendants = Descendants {
        ids: vec![
            ("database_view", ids(views)),
            ("database_field", ids(fields)),
        ],
    };
    if descendants.ids.iter().all(|(_, ids)| ids.is_empty()) {
        return Ok(false);
    }
    let mut clauses = vec!["(ra.subject_type='auth.User' AND ra.subject_id=?)".to_owned()];
    let mut params = vec![Param::Num(user_id)];
    if !teams.is_empty() {
        let marks = vec!["?"; teams.len()].join(",");
        clauses.push(format!(
            "(ra.subject_type='supertask_enterprise.Team' AND ra.subject_id IN ({marks}))"
        ));
        params.extend(teams.iter().map(|team| Param::Num(team.id)));
    }
    let sql = format!(
        "SELECT r.uid, ra.subject_type, ra.scope_type, ra.scope_id
       FROM enterprise_roleassignment ra
       JOIN enterprise_role r ON r.id=ra.role_id
      WHERE {}",
        clauses.join(" OR ")
    );
    let assignments = deserialize::<Assignment>(db.all(&sql, &params).await?)?;
    Ok(roles::readable_descendant(&descendants, &assignments))
}

/// `requireAccess(db, user?.id, tableId, "VIEWER", dbToken, "read")`.
async fn require_read_access(db: &Db, caller: &Caller, table_id: i64) -> Outcome<()> {
    let Some(table) = table_meta(db, table_id).await? else {
        let id = (table_id != 0).then(|| table_id.to_string());
        return Err(ApiError::does_not_exist("Table", id.as_deref()).into());
    };
    if caller.token.is_none() && table.is_template {
        return Ok(());
    }
    if let Some(token) = &caller.token
        && !token.allows(table.id, table.database_id, table.workspace_id, "read")
    {
        return Err(ApiError::permission(
            "The database token does not have permissions to the table.",
        )
        .into());
    }
    let Some(user_id) = caller.user_id else {
        return Err(ApiError::permission("Access denied.").into());
    };
    let inputs = role_inputs(db, user_id, table.workspace_id).await?;
    let scope = Scope {
        workspace_id: table.workspace_id,
        database_id: Some(table.database_id),
        table_id: Some(table.id),
    };
    let mut role = roles::resolve_role(&inputs, &scope);
    if !roles::role_allows("VIEWER", &role) {
        let teams = inputs.teams.clone();
        if readable_descendant(db, user_id, &teams, table.id).await? {
            role = "READ_ONLY".to_owned();
        }
    }
    if !roles::role_allows("VIEWER", &role) {
        return Err(ApiError::permission("Insufficient permissions.").into());
    }
    Ok(())
}

fn fields_from_rows(rows: Vec<Row>) -> Outcome<Vec<FieldMeta>> {
    rows.iter().map(FieldMeta::from_row).collect()
}

/// `getActiveFields` (ordered by `[order]` only, unlike the read context's list).
async fn active_fields(db: &Db, table_id: i64) -> Outcome<Vec<FieldMeta>> {
    fields_from_rows(
        db.all(
            "SELECT id, name, type, \"primary\" as is_primary, read_only, field_settings
     FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC",
            &[Param::from(table_id)],
        )
        .await?,
    )
}

/// Rows by `(table id, row id)`; `None` records a row known to be missing or trashed.
type RowCache = HashMap<(i64, i64), Option<Rc<Row>>>;

/// `RowReadContext` over D1: fields and rows of linked tables, loaded once per request.
struct D1Source<'a> {
    db: &'a Db,
    fields: RefCell<HashMap<i64, Rc<Vec<FieldMeta>>>>,
    rows: RefCell<RowCache>,
}

impl RowSource for D1Source<'_> {
    async fn fields(&self, table_id: i64) -> Outcome<Rc<Vec<FieldMeta>>> {
        if let Some(fields) = self.fields.borrow().get(&table_id) {
            return Ok(Rc::clone(fields));
        }
        let rows = self
            .db
            .all(
                "SELECT id, name, type, \"primary\" AS is_primary, read_only, field_settings
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC, id ASC",
                &[Param::from(table_id)],
            )
            .await?;
        let fields = Rc::new(fields_from_rows(rows)?);
        self.fields
            .borrow_mut()
            .insert(table_id, Rc::clone(&fields));
        Ok(fields)
    }

    async fn load(&self, table_id: i64, ids: &[i64]) -> Outcome<()> {
        let missing: Vec<i64> = ids
            .iter()
            .copied()
            .filter(|id| !self.rows.borrow().contains_key(&(table_id, *id)))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        ensure_user_table_system_columns(self.db, table_id).await?;
        for chunk in missing.chunks(D1_ID_CHUNK_SIZE) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT * FROM \"database_table_{table_id}\"
     WHERE COALESCE(trashed, 0)=0 AND id IN ({marks})"
            );
            let params: Vec<Param> = chunk.iter().map(|id| Param::from(*id)).collect();
            let found = self.db.all(&sql, &params).await?;
            let mut cache = self.rows.borrow_mut();
            chunk.iter().for_each(|id| {
                cache.insert((table_id, *id), None);
            });
            for row in found {
                if let Some(id) = row.get("id").and_then(Value::as_i64) {
                    cache.insert((table_id, id), Some(Rc::new(row)));
                }
            }
        }
        Ok(())
    }

    fn cached_row(&self, table_id: i64, id: i64) -> Option<Rc<Row>> {
        self.rows.borrow().get(&(table_id, id)).cloned().flatten()
    }
}

/// The listing; unsupported cases surface as [`Failure::Unsupported`].
async fn list_rows(
    req: &Request,
    env: &Env,
    segment: &str,
    search: &str,
) -> Outcome<web_sys::Response> {
    // `parseInt` on the segment: only plain digits are taken as is.
    if !segment.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Failure::unsupported("non-numeric table id"));
    }
    let table_id = js::parse_int(segment);
    if table_id > js::MAX_SAFE_INTEGER {
        return Err(Failure::unsupported("table id beyond 2^53"));
    }
    #[allow(clippy::cast_possible_truncation)]
    let table_id = table_id as i64;
    let query = Query::parse(search)?;
    if query.keys().any(is_filter_key) {
        return Err(Failure::unsupported("row filters"));
    }
    let include = query.get("include").unwrap_or_default();
    if include
        .split(',')
        .any(|item| js::trim(item) == "row_metadata")
    {
        return Err(Failure::unsupported("include=row_metadata"));
    }

    let db = Db::new(env)?;
    let caller = optional_database_token_auth(req, env, &db).await?;
    require_read_access(&db, &caller, table_id).await?;
    let fields = Rc::new(active_fields(&db, table_id).await?);
    if fields.iter().any(FieldMeta::has_formula) {
        return Err(Failure::unsupported("formula field"));
    }
    let table = format!("database_table_{table_id}");
    ensure_user_table_system_columns(&db, table_id).await?;

    let page = positive_int_param(query.get("page"), 1.0);
    let page_size = positive_int_param(query.get("size"), 100.0).min(1000.0);
    if page > 2_147_483_647.0 {
        return Err(Failure::unsupported("page beyond 2^31"));
    }
    let offset = (page - 1.0) * page_size;
    let use_field_names = truthy_query_param(query.get("user_field_names"));
    let order = order_clause(
        &table,
        &fields,
        query.get("order_by").unwrap_or_default(),
        use_field_names,
    );

    let mut filter = active_row_clause(&table);
    let mut params: Vec<Param> = Vec::new();
    let term = query.get("search").unwrap_or_default();
    if !term.is_empty() && !fields.is_empty() {
        let clauses = search_clauses(&table, &fields);
        if !clauses.is_empty() {
            params.extend(clauses.iter().map(|_| Param::from(term)));
            filter.push_str(&format!(" AND ({})", clauses.join(" OR ")));
        }
    }

    let count_row = db
        .first(
            &format!("SELECT COUNT(*) as cnt FROM \"{table}\" WHERE {filter}"),
            &params,
        )
        .await?;
    let count = count_row
        .and_then(|row| row.get("cnt").cloned())
        .unwrap_or(json!(0));
    let mut select_params = params.clone();
    select_params.extend([Param::Num(page_size), Param::Num(offset)]);
    let rows = db
        .all(
            &format!("SELECT * FROM \"{table}\" WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?"),
            &select_params,
        )
        .await?;

    let source = D1Source {
        db: &db,
        fields: RefCell::default(),
        rows: RefCell::default(),
    };
    let rows: Vec<Rc<Row>> = rows.into_iter().map(Rc::new).collect();
    let results = serialize_rows(&source, rows, Rc::clone(&fields), use_field_names).await?;

    let total = js::to_number(&count);
    let link = |page: f64| {
        format!(
            "/api/database/rows/table/{table_id}/?page={}&size={}",
            js::number_to_string(page),
            js::number_to_string(page_size)
        )
    };
    let mut payload = Map::new();
    payload.insert("count".into(), count);
    payload.insert(
        "next".into(),
        if offset + page_size < total {
            Value::String(link(page + 1.0))
        } else {
            Value::Null
        },
    );
    payload.insert(
        "previous".into(),
        if page > 1.0 {
            Value::String(link(page - 1.0))
        } else {
            Value::Null
        },
    );
    payload.insert("results".into(), Value::Array(results));
    json_response(env, 200, &Value::Object(payload)).map_err(|e| Failure::Internal(e.to_string()))
}

/// Entry point; storage failures are left to the TS Worker since the request is a read.
pub async fn list(
    req: &Request,
    env: &Env,
    segment: &str,
    search: &str,
) -> Outcome<web_sys::Response> {
    match list_rows(req, env, segment, search).await {
        Err(Failure::Internal(message)) => {
            Err(Failure::unsupported(format!("storage error: {message}")))
        }
        other => other,
    }
}
