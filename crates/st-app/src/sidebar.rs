//! The sidebar: workspaces, their applications, and the tables of databases.

use egui::{CollapsingHeader, Label, RichText, Ui};
use st_api::{Application, Workspace};
use st_core::ApplicationType;

use crate::app::Remote;
use crate::labels;

/// What the user did in the sidebar.
pub enum SidebarAction {
    OpenTable { id: u64, name: String },
    Retry,
}

const UNAVAILABLE: &str = "pas encore disponible dans l'app Rust";

pub fn show(
    ui: &mut Ui,
    workspaces: &Remote<Vec<Workspace>>,
    applications: &Remote<Vec<Application>>,
    selected_table: Option<u64>,
) -> Option<SidebarAction> {
    let workspaces = match workspaces {
        Remote::Ready(workspaces) => workspaces,
        Remote::Idle | Remote::Loading => {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.weak("Chargement des espaces de travail…");
            });
            return None;
        }
        Remote::Failed(message) => {
            ui.colored_label(ui.visuals().error_fg_color, message);
            return ui
                .button("Réessayer")
                .clicked()
                .then_some(SidebarAction::Retry);
        }
    };
    if workspaces.is_empty() {
        ui.weak("Aucun espace de travail.");
        return None;
    }

    let mut action = None;
    let mut sorted: Vec<&Workspace> = workspaces.iter().collect();
    sorted.sort_by_key(|workspace| (workspace.order, workspace.id));
    for workspace in sorted {
        CollapsingHeader::new(RichText::new(&workspace.name).strong())
            .id_salt(("workspace", workspace.id))
            .default_open(true)
            .show(ui, |ui| {
                let mut apps: Vec<_> = workspace.applications.iter().collect();
                apps.sort_by_key(|app| (app.order, app.id));
                for app in apps {
                    let (icon, kind) = labels::application_type(&app.application_type);
                    let title = format!("{icon} {}", app.name);
                    if app.application_type != ApplicationType::Database {
                        ui.add_enabled(false, Label::new(title).truncate())
                            .on_disabled_hover_text(format!("{kind} : {UNAVAILABLE}"));
                        continue;
                    }
                    CollapsingHeader::new(title)
                        .id_salt(("application", app.id))
                        .default_open(true)
                        .show(ui, |ui| {
                            if let Some(clicked) = tables(ui, applications, app.id, selected_table)
                            {
                                action = Some(clicked);
                            }
                        });
                }
            });
    }
    ui.add_space(12.0);
    ui.add(
        Label::new(
            RichText::new(
                "Les applications grisées ne sont pas encore disponibles dans l'app Rust.",
            )
            .small()
            .weak(),
        )
        .wrap(),
    );
    action
}

fn tables(
    ui: &mut Ui,
    applications: &Remote<Vec<Application>>,
    database_id: u64,
    selected_table: Option<u64>,
) -> Option<SidebarAction> {
    let applications = match applications {
        Remote::Ready(applications) => applications,
        Remote::Failed(message) => {
            ui.colored_label(ui.visuals().error_fg_color, message);
            return None;
        }
        Remote::Idle | Remote::Loading => {
            ui.spinner();
            return None;
        }
    };
    let Some(database) = applications.iter().find(|app| app.id == database_id) else {
        ui.weak("Base introuvable.");
        return None;
    };
    if database.tables.is_empty() {
        ui.weak("Aucune table.");
    }
    let mut tables: Vec<_> = database.tables.iter().collect();
    tables.sort_by_key(|table| (table.order, table.id));
    let mut action = None;
    for table in tables {
        let selected = selected_table == Some(table.id);
        if ui
            .selectable_label(selected, format!("▦ {}", table.name))
            .clicked()
            && !selected
        {
            action = Some(SidebarAction::OpenTable {
                id: table.id,
                name: table.name.clone(),
            });
        }
    }
    action
}

/// The name of a table, if the applications listing knows it.
pub fn table_name(applications: &Remote<Vec<Application>>, table_id: u64) -> Option<String> {
    let Remote::Ready(applications) = applications else {
        return None;
    };
    applications
        .iter()
        .flat_map(|app| app.tables.iter())
        .find(|table| table.id == table_id)
        .map(|table| table.name.clone())
}
