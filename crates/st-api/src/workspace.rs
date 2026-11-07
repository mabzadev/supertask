//! Workspaces, applications, tables and views.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use st_core::{ApplicationType, Field, ViewType};

/// A workspace of `GET /api/workspaces/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub order: i64,
    /// The role of the signed-in user (`ADMIN`, `BUILDER`, `EDITOR`, …).
    #[serde(default)]
    pub permissions: String,
    #[serde(default)]
    pub users: Vec<WorkspaceUser>,
    #[serde(default)]
    pub applications: Vec<ApplicationSummary>,
}

/// A member of a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceUser {
    pub id: u64,
    pub user_id: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub permissions: String,
}

/// An application as listed inside a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationSummary {
    pub id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub application_type: ApplicationType,
    #[serde(default)]
    pub order: i64,
}

/// An application of `GET /api/applications/`, with its tables when it is a
/// database.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Application {
    pub id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub application_type: ApplicationType,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub workspace_id: Option<u64>,
    #[serde(default)]
    pub workspace: Option<WorkspaceRef>,
    #[serde(default)]
    pub tables: Vec<Table>,
}

impl Application {
    /// The workspace of the application, whichever attribute carries it.
    pub fn workspace_id(&self) -> Option<u64> {
        self.workspace_id
            .or(self.workspace.as_ref().map(|workspace| workspace.id))
    }
}

/// A reference to a workspace by id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceRef {
    pub id: u64,
}

/// A table of a database.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Table {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub database_id: u64,
    #[serde(default)]
    pub views: Vec<View>,
    /// Present in the applications listing; fetched separately otherwise.
    #[serde(default)]
    pub fields: Vec<Field>,
}

/// A view of a table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub id: u64,
    pub table_id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: ViewType,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub filter_type: Option<String>,
    #[serde(default)]
    pub filters_disabled: bool,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub slug: Option<String>,
    /// `count` (row position) or `id`.
    #[serde(default)]
    pub row_identifier_type: Option<String>,
    /// `collaborative` or `personal`.
    #[serde(default)]
    pub ownership_type: Option<String>,
    /// `small`, `medium` or `large`.
    #[serde(default)]
    pub row_height_size: Option<String>,
    #[serde(default)]
    pub filters: Vec<Value>,
    #[serde(default)]
    pub sortings: Vec<Value>,
    #[serde(default)]
    pub group_bys: Vec<Value>,
    /// Type-specific attributes (kanban select field, gallery cover…).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACES: &str = include_str!("../tests/data/workspaces.json");
    const APPLICATIONS: &str = include_str!("../tests/data/applications.json");
    const VIEWS: &str = include_str!("../tests/data/views.json");

    #[test]
    fn reads_the_captured_workspaces() {
        let workspaces: Vec<Workspace> = serde_json::from_str(WORKSPACES).unwrap();
        let names: Vec<&str> = workspaces
            .iter()
            .map(|workspace| workspace.name.as_str())
            .collect();
        assert_eq!(names, ["Agence Nova", "Studio Produit"]);
        let nova = &workspaces[0];
        assert_eq!(nova.users.len(), 6);
        let kinds: Vec<&ApplicationType> = nova
            .applications
            .iter()
            .map(|app| &app.application_type)
            .collect();
        assert!(kinds.contains(&&ApplicationType::Database));
        assert!(kinds.contains(&&ApplicationType::Whiteboard));
        assert!(kinds.contains(&&ApplicationType::Automation));
    }

    #[test]
    fn reads_the_captured_applications_with_tables() {
        let applications: Vec<Application> = serde_json::from_str(APPLICATIONS).unwrap();
        let crm = applications.iter().find(|app| app.name == "CRM").unwrap();
        assert_eq!(crm.workspace_id(), Some(1));
        let tables: Vec<&str> = crm.tables.iter().map(|table| table.name.as_str()).collect();
        assert_eq!(tables, ["Clients", "Projets", "Factures"]);
        let projets = &crm.tables[1];
        assert!(
            projets
                .views
                .iter()
                .any(|view| view.view_type == ViewType::Timeline)
        );
        assert_eq!(projets.fields.len(), 24);
        let dashboards = applications
            .iter()
            .filter(|app| app.application_type == ApplicationType::Dashboard);
        assert!(dashboards.into_iter().all(|app| app.tables.is_empty()));
    }

    #[test]
    fn reads_the_captured_views() {
        let views: Vec<View> = serde_json::from_str(VIEWS).unwrap();
        assert_eq!(views[0].view_type, ViewType::Grid);
        let kanban = views
            .iter()
            .find(|view| view.view_type == ViewType::Kanban)
            .unwrap();
        assert_eq!(kanban.extra["single_select_field"], 2);
    }
}
