//! Role resolution of `src/services/enterprise-permissions.ts`, as pure
//! functions over the rows the Worker reads from D1.
//!
//! Only table scopes are needed by the ported routes, but the hierarchy walk
//! is the general one so view and field scopes can be added without rework.

use serde::Deserialize;
use serde_json::Value;

use crate::js;

/// `ROLE_RANK`: lower is stronger; unknown roles rank 99.
fn role_rank(role: &str) -> u32 {
    match role {
        "ADMIN" => 1,
        "BUILDER" => 2,
        "EDITOR" => 3,
        "COMMENTER" => 4,
        "VIEWER" | "READ_ONLY" => 5,
        "NO_ROLE_LOW_PRIORITY" | "NO_ROLE" => 6,
        _ => 99,
    }
}

/// `CORE_PERMISSION_ROLE[membership.permissions] || "NO_ROLE_LOW_PRIORITY"`.
pub fn core_permission_role(permissions: &str) -> &'static str {
    match permissions {
        "ADMIN" => "ADMIN",
        "MEMBER" | "BUILDER" => "BUILDER",
        "EDITOR" => "EDITOR",
        "COMMENTER" => "COMMENTER",
        "VIEWER" => "VIEWER",
        "NO_ACCESS" => "NO_ACCESS",
        _ => "NO_ROLE_LOW_PRIORITY",
    }
}

/// `normalizeRole`: `builder` and `Builder` stay distinct from camelCase uids like `noRole`.
pub fn normalize_role(value: &Value) -> String {
    let raw = if js::truthy(value) {
        js::to_js_string(value)
    } else {
        "NO_ROLE_LOW_PRIORITY".to_owned()
    };
    normalize_role_str(&raw)
}

fn normalize_role_str(raw: &str) -> String {
    let raw = js::trim(raw);
    if raw.is_empty() {
        return "NO_ROLE_LOW_PRIORITY".to_owned();
    }
    if raw == raw.to_uppercase() {
        return raw.to_owned();
    }
    let mut snake = String::new();
    for c in raw.chars() {
        if c.is_ascii_uppercase() {
            snake.push('_');
        }
        snake.push(c);
    }
    let upper = snake.to_uppercase();
    upper.strip_prefix('_').map_or(upper.clone(), str::to_owned)
}

fn stronger_role(left: &str, right: &str) -> String {
    let (left, right) = (normalize_role_str(left), normalize_role_str(right));
    if role_rank(&left) <= role_rank(&right) {
        left
    } else {
        right
    }
}

/// `roleAllows(required, effective)`.
pub fn role_allows(required: &str, effective: &str) -> bool {
    let required = normalize_role_str(required);
    let effective = normalize_role_str(effective);
    if required == "NOBODY" || effective == "NO_ACCESS" {
        return false;
    }
    role_rank(&effective) <= role_rank(&required)
}

/// A row of `enterprise_roleassignment JOIN enterprise_role`.
#[derive(Debug, Clone, Deserialize)]
pub struct Assignment {
    /// `enterprise_role.uid`.
    pub uid: Value,
    /// `auth.User` or `supertask_enterprise.Team`.
    pub subject_type: String,
    /// Scope kind (`workspace`, `application`, `database_table`, …).
    pub scope_type: String,
    /// Scope id.
    pub scope_id: f64,
}

/// A team of the user in the workspace.
#[derive(Debug, Clone, Deserialize)]
pub struct Team {
    /// `enterprise_team.id`.
    pub id: f64,
    /// Role every member gets on the workspace.
    pub default_role_uid: Value,
}

/// `RoleInputs`: everything that decides a user's roles inside one workspace.
#[derive(Debug, Clone)]
pub struct RoleInputs {
    /// Role from `core_workspaceuser.permissions`.
    pub core_workspace_role: String,
    /// The user's teams in the workspace.
    pub teams: Vec<Team>,
    /// Roles assigned to the user or to those teams.
    pub assignments: Vec<Assignment>,
}

/// A scope inside a workspace (`EffectiveRoleScope` without view and field).
#[derive(Debug, Clone, Copy)]
pub struct Scope {
    /// Workspace id.
    pub workspace_id: f64,
    /// Database (application) id, if the scope is inside one.
    pub database_id: Option<f64>,
    /// Table id, if the scope is a table.
    pub table_id: Option<f64>,
}

fn scope_hierarchy(scope: &Scope) -> Vec<Vec<(&'static str, f64)>> {
    let mut levels = Vec::new();
    if let Some(table) = scope.table_id.filter(|id| *id != 0.0) {
        levels.push(vec![("database_table", table), ("table", table)]);
    }
    if let Some(database) = scope.database_id.filter(|id| *id != 0.0) {
        levels.push(vec![("application", database), ("database", database)]);
    }
    levels.push(vec![("workspace", scope.workspace_id)]);
    levels
}

fn scope_matches(level: &[(&str, f64)], row: &Assignment) -> bool {
    level
        .iter()
        .any(|(kind, id)| *kind == row.scope_type && *id == row.scope_id)
}

fn merge(current: Option<String>, uid: &Value) -> Option<String> {
    Some(match current {
        Some(role) => stronger_role(&role, &normalize_role(uid)),
        None => normalize_role(uid),
    })
}

/// `resolveRole(inputs, scope)`: the role before the readable-descendant fallback.
pub fn resolve_role(inputs: &RoleInputs, scope: &Scope) -> String {
    for level in scope_hierarchy(scope) {
        let is_workspace_level = level
            .iter()
            .any(|(kind, id)| *kind == "workspace" && *id == scope.workspace_id);
        let mut actor_role: Option<String> = None;
        for row in inputs
            .assignments
            .iter()
            .filter(|r| r.subject_type == "auth.User" && scope_matches(&level, r))
        {
            actor_role = merge(actor_role, &row.uid);
        }
        if is_workspace_level && actor_role.is_none() {
            actor_role = Some(inputs.core_workspace_role.clone());
        }
        if let Some(role) = actor_role
            .as_deref()
            .filter(|role| normalize_role_str(role) != "NO_ROLE_LOW_PRIORITY")
        {
            return normalize_role_str(role);
        }
        let mut team_role: Option<String> = None;
        for row in inputs
            .assignments
            .iter()
            .filter(|r| r.subject_type == "supertask_enterprise.Team" && scope_matches(&level, r))
        {
            team_role = merge(team_role, &row.uid);
        }
        if is_workspace_level {
            for team in inputs
                .teams
                .iter()
                .filter(|team| js::truthy(&team.default_role_uid))
            {
                team_role = merge(team_role, &team.default_role_uid);
            }
        }
        if let Some(role) = team_role {
            return normalize_role_str(&role);
        }
        if let Some(role) = actor_role {
            return normalize_role_str(&role);
        }
    }
    normalize_role_str(&inputs.core_workspace_role)
}

fn canonical_scope_type(value: &str) -> &str {
    match value {
        "database" => "application",
        "table" => "database_table",
        "view" => "database_view",
        "field" => "database_field",
        other => other,
    }
}

/// Ids of the readable descendants of a scope, by canonical scope type.
#[derive(Debug, Default)]
pub struct Descendants {
    /// `(canonical scope type, ids)` pairs.
    pub ids: Vec<(&'static str, Vec<f64>)>,
}

/// The decision of `readableDescendantRole` once its rows are loaded: any
/// role of the user (or, without one, of a team) on a descendant that allows VIEWER.
pub fn readable_descendant(descendants: &Descendants, assignments: &[Assignment]) -> bool {
    if descendants.ids.iter().all(|(_, ids)| ids.is_empty()) {
        return false;
    }
    let mut groups: Vec<(String, f64, Vec<&Assignment>)> = Vec::new();
    for row in assignments {
        let kind = canonical_scope_type(&row.scope_type);
        let listed = descendants
            .ids
            .iter()
            .any(|(t, ids)| *t == kind && ids.contains(&row.scope_id));
        if !listed {
            continue;
        }
        match groups
            .iter_mut()
            .find(|(t, id, _)| t == kind && *id == row.scope_id)
        {
            Some((_, _, rows)) => rows.push(row),
            None => groups.push((kind.to_owned(), row.scope_id, vec![row])),
        }
    }
    groups.iter().any(|(_, _, rows)| {
        let best = |subject: &str| {
            rows.iter()
                .filter(|r| r.subject_type == subject)
                .fold(None, |role: Option<String>, r| merge(role, &r.uid))
        };
        match best("auth.User") {
            Some(actor) if actor != "NO_ROLE_LOW_PRIORITY" => role_allows("VIEWER", &actor),
            _ => best("supertask_enterprise.Team").is_some_and(|team| role_allows("VIEWER", &team)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assignment(uid: &str, subject: &str, scope_type: &str, scope_id: f64) -> Assignment {
        Assignment {
            uid: json!(uid),
            subject_type: subject.into(),
            scope_type: scope_type.into(),
            scope_id,
        }
    }

    const TABLE: Scope = Scope {
        workspace_id: 1.0,
        database_id: Some(7.0),
        table_id: Some(4.0),
    };

    #[test]
    fn workspace_role_applies_without_assignments() {
        let inputs = RoleInputs {
            core_workspace_role: "COMMENTER".into(),
            teams: vec![],
            assignments: vec![],
        };
        assert_eq!(resolve_role(&inputs, &TABLE), "COMMENTER");
        assert!(role_allows("VIEWER", "COMMENTER"));
        assert!(!role_allows("EDITOR", "COMMENTER"));
    }

    #[test]
    fn closer_scopes_win() {
        let inputs = RoleInputs {
            core_workspace_role: "ADMIN".into(),
            teams: vec![],
            assignments: vec![assignment("NO_ACCESS", "auth.User", "table", 4.0)],
        };
        assert_eq!(resolve_role(&inputs, &TABLE), "NO_ACCESS");
        let teams = RoleInputs {
            core_workspace_role: "NO_ROLE_LOW_PRIORITY".into(),
            teams: vec![Team {
                id: 3.0,
                default_role_uid: json!("viewer"),
            }],
            assignments: vec![],
        };
        assert_eq!(resolve_role(&teams, &TABLE), "VIEWER");
    }

    #[test]
    fn camel_case_roles_normalize() {
        assert_eq!(
            normalize_role(&json!("noRoleLowPriority")),
            "NO_ROLE_LOW_PRIORITY"
        );
        assert_eq!(normalize_role(&json!("Builder")), "BUILDER");
        assert_eq!(normalize_role(&Value::Null), "NO_ROLE_LOW_PRIORITY");
    }

    #[test]
    fn readable_descendants_grant_read_only() {
        let descendants = Descendants {
            ids: vec![("database_view", vec![9.0]), ("database_field", vec![])],
        };
        let rows = [assignment("VIEWER", "auth.User", "view", 9.0)];
        assert!(readable_descendant(&descendants, &rows));
        let denied = [
            assignment("NO_ACCESS", "auth.User", "view", 9.0),
            assignment("VIEWER", "supertask_enterprise.Team", "view", 9.0),
        ];
        assert!(!readable_descendant(&descendants, &denied));
    }
}
