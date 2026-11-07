//! Request authentication of `src/middleware/auth.ts`: JWT access tokens and
//! database tokens (`Authorization: Token <key>` or `Bearer <key>`).

use serde_json::Value;
use worker::{Env, Request, js_sys};

use super::db::{Db, Param};
use super::http::string_binding;
use crate::fallback::{ApiError, Failure, Outcome};
use crate::fields::Row;
use crate::{js, jwt};

/// `Math.floor(Date.now() / 1000)`, jose's clock.
pub fn now_seconds() -> f64 {
    (js_sys::Date::now() / 1000.0).floor()
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    String::from(js_sys::Date::new_0().to_iso_string())
}

/// `JWT_SIGNING_KEY` (a secret in production, `.dev.vars` locally).
pub fn signing_key(env: &Env) -> Outcome<String> {
    string_binding(env, "JWT_SIGNING_KEY")
        .ok_or_else(|| Failure::Internal("JWT_SIGNING_KEY is not set".into()))
}

/// A database token's permissions (`db_token_permissions`).
pub struct TokenPermissions {
    /// The token's workspace.
    pub workspace_id: f64,
    /// `(type, table_id, database_id)` rows.
    pub permissions: Vec<(String, Value, Value)>,
}

impl TokenPermissions {
    /// `databaseTokenAllows(token, table, operations)`.
    pub fn allows(
        &self,
        table_id: f64,
        database_id: f64,
        workspace_id: f64,
        operation: &str,
    ) -> bool {
        if self.workspace_id != workspace_id {
            return false;
        }
        self.permissions.iter().any(|(kind, table, database)| {
            if kind != operation {
                return false;
            }
            if table.is_null() && database.is_null() {
                return true;
            }
            table.as_f64() == Some(table_id) || database.as_f64() == Some(database_id)
        })
    }
}

/// Who is calling, after `databaseTokenAuthMiddleware({ optional: true })`.
pub struct Caller {
    /// The user id, when a valid JWT or database token was given.
    pub user_id: Option<f64>,
    /// The database token's permissions, for token calls.
    pub token: Option<TokenPermissions>,
}

/// `databaseTokenKey(header)`: `^(?:Token|Bearer) (\S+)$` on the trimmed header.
fn database_token_key(header: &str) -> Option<&str> {
    let trimmed = js::trim(header);
    let key = trimmed
        .strip_prefix("Token ")
        .or_else(|| trimmed.strip_prefix("Bearer "))?;
    (!key.is_empty() && !key.chars().any(js::is_js_whitespace)).then_some(key)
}

/// `Date.parse(String(value))` as V8 does it.
fn date_parse(value: &Value) -> f64 {
    js_sys::Date::parse(&js::to_js_string(value))
}

/// `issuedBeforePasswordChange(iat, lastPasswordChange)`.
fn issued_before_password_change(
    iat: Option<&Value>,
    last_password_change: Option<&Value>,
) -> bool {
    let Some(changed) = last_password_change.filter(|v| js::truthy(v)) else {
        return false;
    };
    let changed_at = (date_parse(changed) / 1000.0).floor();
    if !changed_at.is_finite() {
        return false;
    }
    match iat {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|iat| changed_at > iat),
        _ => true,
    }
}

/// `userById`.
async fn user_by_id(db: &Db, user_id: f64) -> Outcome<Option<Row>> {
    db.first(
        "SELECT id, email, username, is_staff, is_active,
            is_staff AS can_create_accounts, last_password_change
     FROM auth_user WHERE id = ?",
        &[Param::Num(user_id)],
    )
    .await
}

/// `setOptionalJwtUser`: the active user of a valid access token, any failure ignored.
async fn optional_jwt_user(env: &Env, db: &Db, token: &str) -> Outcome<Option<f64>> {
    let Ok(claims) = jwt::verify(token, &signing_key(env)?, now_seconds()) else {
        return Ok(None);
    };
    if claims.get("token_type").and_then(Value::as_str) != Some("access") {
        return Ok(None);
    }
    let user_id = js::to_number_opt(claims.get("user_id"));
    if !user_id.is_finite() {
        // D1 cannot bind NaN; the TS code's failing lookup lands in the same catch.
        return Ok(None);
    }
    // The TS try/catch turns a D1 failure into an anonymous caller (a 403).
    // Here it surfaces instead, so the read is replayed against the TS Worker:
    // with two local processes on one D1 file, SQLITE_BUSY is not rare.
    let row = user_by_id(db, user_id).await?;
    Ok(row
        .filter(|row| js::truthy_opt(row.get("is_active")))
        .filter(|row| {
            !issued_before_password_change(claims.get("iat"), row.get("last_password_change"))
        })
        .and_then(|row| row.get("id").and_then(Value::as_f64)))
}

/// `authenticateDatabaseToken`: an early 401 for unknown, orphaned or disabled tokens.
async fn database_token(db: &Db, key: &str) -> Outcome<Caller> {
    let token = db
        .first(
            "SELECT t.id AS token_id, t.workspace_id, u.id, u.email, u.username, u.is_staff, u.is_active,
              u.is_staff AS can_create_accounts,
              EXISTS (
                SELECT 1 FROM core_workspaceuser wu
                WHERE wu.workspace_id = t.workspace_id AND wu.user_id = t.user_id AND wu.to_be_deleted = 0
              ) AS is_member
       FROM database_token t
       JOIN auth_user u ON u.id = t.user_id
       WHERE t.key = ? AND t.active = 1",
            &[Param::from(key)],
        )
        .await?;
    let permissions = db
        .all(
            "SELECT p.type, p.table_id, p.database_id
       FROM database_tokenpermission p
       JOIN database_token t ON t.id = p.token_id
       WHERE t.key = ? AND t.active = 1",
            &[Param::from(key)],
        )
        .await?;
    let Some(token) = token else {
        return Err(ApiError::new(
            401,
            "ERROR_TOKEN_DOES_NOT_EXIST",
            "The provided token does not exist.",
        )
        .into());
    };
    if !js::truthy_opt(token.get("is_member")) {
        return Err(ApiError::new(
            401,
            "ERROR_TOKEN_GROUP_MISMATCH",
            "The token's user does not belong to the group anymore.",
        )
        .into());
    }
    if !js::truthy_opt(token.get("is_active")) {
        return Err(ApiError::new(
            401,
            "ERROR_USER_NOT_ACTIVE",
            "The user related to the token is disabled.",
        )
        .into());
    }
    let permissions = permissions
        .into_iter()
        .map(|p| {
            let kind = p.get("type").map(js::to_js_string).unwrap_or_default();
            (
                kind,
                p.get("table_id").cloned().unwrap_or(Value::Null),
                p.get("database_id").cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    Ok(Caller {
        user_id: token.get("id").and_then(Value::as_f64),
        token: Some(TokenPermissions {
            workspace_id: js::to_number_opt(token.get("workspace_id")),
            permissions,
        }),
    })
}

/// `databaseTokenAuthMiddleware({ optional: true })`.
pub async fn optional_database_token_auth(req: &Request, env: &Env, db: &Db) -> Outcome<Caller> {
    let header = req
        .headers()
        .get("Authorization")
        .ok()
        .flatten()
        .unwrap_or_default();
    if let Some(key) = database_token_key(&header) {
        return database_token(db, key).await;
    }
    if let Some(token) = header.strip_prefix("JWT ") {
        return Ok(Caller {
            user_id: optional_jwt_user(env, db, token).await?,
            token: None,
        });
    }
    Ok(Caller {
        user_id: None,
        token: None,
    })
}
