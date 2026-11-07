//! The grid view of a table: columns from the fields, rows loaded page by page.
//!
//! Rows are fetched in pages of [`PAGE_SIZE`] only when the scroll position
//! needs them, and `TableBuilder::rows` lays out only the rows inside the
//! viewport, so the cost of a frame depends on the window height, not on the
//! size of the table. Pages are kept once loaded: 10 000 rows of a few fields
//! weigh a few megabytes.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

use egui::{Align, Key, Label, Layout, RichText, Sense, TextEdit, Ui, vec2};
use egui_extras::{Column, TableBuilder};
use serde_json::{Map, Value};
use st_api::{ClientError, Row, RowPage, RowsQuery, endpoints};
use st_core::date::LocalZone;
use st_core::{DisplayContext, Field, FieldType, display_cell};

use crate::app::{Msg, Remote};
use crate::net::Api;
use crate::{cell, labels};

/// Rows per request, the size the web app uses too.
pub const PAGE_SIZE: usize = 200;
/// Pages requested at the same time while scrolling.
const MAX_PAGES_IN_FLIGHT: usize = 3;
/// Load the next page when the viewport gets this close to the end of a page.
const PREFETCH_ROWS: usize = 60;
/// A page is requested once the viewport has needed it this long (seconds), so
/// that a fast scroll across the table does not fetch every page it passes.
const SETTLE_SECS: f64 = 0.08;
const ROW_HEIGHT: f32 = 30.0;
const HEADER_HEIGHT: f32 = 30.0;
const ROW_NUMBER_WIDTH: f32 = 56.0;

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// An answer for the grid, tagged by the app with the grid's generation.
pub enum GridMsg {
    Fields(Result<Vec<Field>, ClientError>),
    Page {
        page: usize,
        result: Result<RowPage, ClientError>,
    },
    Saved {
        index: usize,
        row_id: u64,
        key: String,
        previous: Value,
        result: Result<Row, ClientError>,
    },
}

struct GridColumn {
    field: Field,
    /// `field_<id>`, computed once rather than per cell and frame.
    key: String,
    initial_width: f32,
    editable: bool,
}

impl GridColumn {
    fn new(field: Field) -> Self {
        let initial_width = initial_width(&field);
        let editable = field.field_type.is_inline_editable() && !field.read_only;
        Self {
            key: field.row_key(),
            field,
            initial_width,
            editable,
        }
    }
}

enum Page {
    Loading,
    Ready(Vec<Row>),
    Failed(String),
}

/// A cell being edited in place.
struct Edit {
    index: usize,
    column: usize,
    row_id: u64,
    buffer: String,
    original: String,
    needs_focus: bool,
}

/// What the user did to the cell editor during a frame.
enum EditAction {
    Start { index: usize, column: usize },
    Commit,
    Cancel,
}

/// Measurements of the last frame, shown in the status bar and published for
/// the phase 0 measures.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GridStats {
    pub total: usize,
    pub loaded: usize,
    /// Rows whose cells were laid out during the last frame.
    pub laid_out: usize,
    pub first_visible: usize,
    pub pages_in_flight: usize,
}

pub struct GridView {
    pub table_id: u64,
    pub table_name: String,
    /// Distinguishes this grid from a previous one of the same table, so that
    /// late answers for a grid that was closed are ignored.
    pub generation: u64,
    columns: Remote<Vec<GridColumn>>,
    total: Option<usize>,
    pages: HashMap<usize, Page>,
    edit: Option<Edit>,
    pending_saves: Vec<PendingSave>,
    notice: Option<String>,
    pub stats: GridStats,
    /// Set when an answer was refused for an expired token, for the app to refresh it.
    pub needs_reauth: bool,
    /// When each page still missing was first needed (egui time, seconds).
    wanted_since: HashMap<usize, f64>,
}

impl GridView {
    pub fn new(table_id: u64, table_name: String) -> Self {
        Self {
            table_id,
            table_name,
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            columns: Remote::Idle,
            total: None,
            pages: HashMap::new(),
            edit: None,
            pending_saves: Vec::new(),
            notice: None,
            stats: GridStats::default(),
            needs_reauth: false,
            wanted_since: HashMap::new(),
        }
    }

    /// Applies an answer of the API.
    pub fn handle(&mut self, msg: GridMsg) {
        match msg {
            GridMsg::Fields(Ok(mut fields)) => {
                st_core::field::sort_for_display(&mut fields);
                self.columns = Remote::Ready(fields.into_iter().map(GridColumn::new).collect());
            }
            GridMsg::Fields(Err(error)) => {
                self.columns = self.failure(&error).map_or(Remote::Idle, Remote::Failed);
            }
            GridMsg::Page {
                page,
                result: Ok(rows),
            } => {
                self.total = Some(usize::try_from(rows.count).unwrap_or(usize::MAX));
                self.pages.insert(page, Page::Ready(rows.results));
            }
            GridMsg::Page {
                page,
                result: Err(error),
            } => match self.failure(&error) {
                Some(message) => {
                    self.pages.insert(page, Page::Failed(message));
                }
                None => {
                    self.pages.remove(&page);
                }
            },
            GridMsg::Saved {
                index,
                row_id,
                result: Ok(row),
                ..
            } => {
                if let Some(slot) = self.row_mut(index, row_id) {
                    *slot = row;
                }
            }
            GridMsg::Saved {
                index,
                row_id,
                key,
                previous,
                result: Err(error),
            } => {
                if let Some(slot) = self.row_mut(index, row_id) {
                    slot.values.insert(key, previous);
                }
                self.notice = Some(format!(
                    "Modification non enregistrée : {}",
                    labels::client_error(&error)
                ));
                self.needs_reauth |= error.is_unauthenticated();
            }
        }
    }

    /// The message to show for a failed request, or `None` when it only needs
    /// a token refresh and a retry.
    fn failure(&mut self, error: &ClientError) -> Option<String> {
        if error.is_unauthenticated() {
            self.needs_reauth = true;
            None
        } else {
            Some(labels::client_error(error))
        }
    }

    fn row(&self, index: usize) -> Option<&Row> {
        match self.pages.get(&(index / PAGE_SIZE)) {
            Some(Page::Ready(rows)) => rows.get(index % PAGE_SIZE),
            _ => None,
        }
    }

    fn row_mut(&mut self, index: usize, row_id: u64) -> Option<&mut Row> {
        match self.pages.get_mut(&(index / PAGE_SIZE)) {
            Some(Page::Ready(rows)) => rows
                .get_mut(index % PAGE_SIZE)
                .filter(|row| row.id == row_id),
            _ => None,
        }
    }

    fn pages_in_flight(&self) -> usize {
        self.pages
            .values()
            .filter(|page| matches!(page, Page::Loading))
            .count()
    }

    fn request_page(&mut self, api: Api<'_>, page: usize) {
        self.pages.insert(page, Page::Loading);
        let generation = self.generation;
        let query = RowsQuery {
            page: page as u32 + 1,
            size: PAGE_SIZE as u32,
            ..Default::default()
        };
        api.send(endpoints::rows(self.table_id, &query), move |result| {
            Msg::Grid {
                generation,
                msg: GridMsg::Page { page, result },
            }
        });
    }

    /// Starts the requests the grid needs and that are not in flight yet.
    fn load(&mut self, api: Option<Api<'_>>, wanted_pages: &BTreeSet<usize>) {
        let Some(api) = api else { return };
        if matches!(self.columns, Remote::Idle) {
            self.columns = Remote::Loading;
            let generation = self.generation;
            api.send(endpoints::fields(self.table_id), move |result| Msg::Grid {
                generation,
                msg: GridMsg::Fields(result),
            });
        }
        // The row count is only known from the first page.
        if self.total.is_none() && !self.pages.contains_key(&0) {
            self.request_page(api, 0);
        }
        for &page in wanted_pages {
            if self.pages_in_flight() >= MAX_PAGES_IN_FLIGHT {
                break;
            }
            if !self.pages.contains_key(&page) {
                self.request_page(api, page);
            }
        }
    }

    pub fn ui(&mut self, ui: &mut Ui, api: Option<Api<'_>>, zone: &dyn LocalZone) {
        ui.style_mut().interaction.selectable_labels = false;
        self.title_bar(ui);
        egui::Panel::bottom(("grid-status", self.generation))
            .show_separator_line(true)
            .show(ui, |ui| self.status_bar(ui));

        let wanted = match &self.columns {
            Remote::Ready(_) => self.table(ui, zone),
            Remote::Idle | Remote::Loading => {
                centered_spinner(ui, "Chargement des champs…");
                BTreeSet::new()
            }
            Remote::Failed(message) => {
                let message = message.clone();
                if retry_panel(ui, &message) {
                    self.columns = Remote::Idle;
                }
                BTreeSet::new()
            }
        };
        let settled = self.settled(ui.ctx(), wanted);
        self.send_saves(api);
        self.load(api, &settled);
    }

    /// Keeps the pages the viewport has needed for [`SETTLE_SECS`], and makes
    /// sure a frame runs when the others settle.
    fn settled(&mut self, ctx: &egui::Context, wanted: BTreeSet<usize>) -> BTreeSet<usize> {
        let now = ctx.input(|input| input.time);
        self.wanted_since.retain(|page, _| wanted.contains(page));
        let mut settled = BTreeSet::new();
        for page in wanted {
            let since = *self.wanted_since.entry(page).or_insert(now);
            let waited = now - since;
            if waited >= SETTLE_SECS {
                settled.insert(page);
            } else {
                ctx.request_repaint_after_secs((SETTLE_SECS - waited) as f32);
            }
        }
        settled
    }

    fn title_bar(&self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.heading(&self.table_name);
            if let Some(total) = self.total {
                ui.weak(labels::rows(total));
            }
            if self.pages_in_flight() > 0 || matches!(self.columns, Remote::Loading) {
                ui.spinner();
            }
        });
        ui.add_space(4.0);
    }

    fn status_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            let stats = self.stats;
            match self.total {
                Some(total) => {
                    ui.label(labels::rows(total));
                    ui.weak(format!("· {} chargées", labels::count(stats.loaded)));
                    ui.weak(format!("· {} dessinées", labels::count(stats.laid_out)));
                }
                None => {
                    ui.weak("Chargement des lignes…");
                }
            }
            if stats.pages_in_flight > 0 {
                ui.weak(format!("· {} page(s) en cours", stats.pages_in_flight));
            }
            let failed: Vec<usize> = self
                .pages
                .iter()
                .filter_map(|(page, state)| matches!(state, Page::Failed(_)).then_some(*page))
                .collect();
            if !failed.is_empty() {
                let reason = failed.iter().find_map(|page| match self.pages.get(page) {
                    Some(Page::Failed(message)) => Some(message.clone()),
                    _ => None,
                });
                ui.colored_label(
                    ui.visuals().error_fg_color,
                    format!("· Chargement impossible : {}", reason.unwrap_or_default()),
                );
                if ui.small_button("Réessayer").clicked() {
                    for page in failed {
                        self.pages.remove(&page);
                    }
                }
            }
            if let Some(notice) = &self.notice {
                ui.colored_label(ui.visuals().error_fg_color, format!("· {notice}"));
                if ui.small_button("✕").on_hover_text("Masquer").clicked() {
                    self.notice = None;
                }
            }
        });
    }

    /// Draws the table and returns the pages the viewport needs.
    fn table(&mut self, ui: &mut Ui, zone: &dyn LocalZone) -> BTreeSet<usize> {
        let Remote::Ready(columns) = &self.columns else {
            return BTreeSet::new();
        };
        let Some(total) = self.total else {
            centered_spinner(ui, "Chargement des lignes…");
            return BTreeSet::new();
        };
        if total == 0 {
            ui.centered_and_justified(|ui| ui.weak("Cette table ne contient aucune ligne."));
            return BTreeSet::new();
        }

        let context = DisplayContext { zone };
        let mut wanted = BTreeSet::new();
        let mut actions = Vec::new();
        let mut laid_out = 0;
        let mut first_visible = usize::MAX;
        let mut last_visible = 0;
        let pages = &self.pages;
        let edit = &mut self.edit;

        egui::ScrollArea::horizontal()
            .id_salt(("grid-columns", self.generation))
            .auto_shrink(false)
            .show(ui, |ui| {
                let mut builder = TableBuilder::new(ui)
                    .id_salt(("grid", self.table_id))
                    .striped(true)
                    .resizable(true)
                    .sense(Sense::click())
                    .auto_shrink(false)
                    .min_scrolled_height(0.0)
                    .cell_layout(Layout::left_to_right(Align::Center))
                    .column(Column::exact(ROW_NUMBER_WIDTH));
                for column in columns {
                    builder = builder.column(
                        Column::initial(column.initial_width)
                            .at_least(48.0)
                            .clip(true),
                    );
                }
                builder
                    .header(HEADER_HEIGHT, |mut header| {
                        header.col(|ui| {
                            ui.add_space(6.0);
                            ui.weak("#");
                        });
                        for column in columns {
                            header.col(|ui| {
                                ui.add_space(6.0);
                                let mut name = RichText::new(&column.field.name).strong();
                                if column.field.primary {
                                    name = name.underline();
                                }
                                let mut hint =
                                    labels::field_type(&column.field.field_type).to_owned();
                                if column.field.primary {
                                    hint.push_str(" · champ principal");
                                }
                                if column.editable {
                                    hint.push_str(" · double-cliquez une cellule pour la modifier");
                                }
                                ui.add(Label::new(name).truncate()).on_hover_text(hint);
                            });
                        }
                    })
                    .body(|body| {
                        body.rows(ROW_HEIGHT, total, |mut table_row| {
                            let index = table_row.index();
                            laid_out += 1;
                            first_visible = first_visible.min(index);
                            last_visible = last_visible.max(index);
                            table_row.col(|ui| {
                                ui.add_space(6.0);
                                ui.weak(labels::count(index + 1));
                            });
                            let page = index / PAGE_SIZE;
                            let row = match pages.get(&page) {
                                Some(Page::Ready(rows)) => rows.get(index % PAGE_SIZE),
                                _ => None,
                            };
                            let Some(row) = row else {
                                if !matches!(pages.get(&page), Some(Page::Failed(_))) {
                                    wanted.insert(page);
                                }
                                for _ in columns {
                                    table_row.col(cell::placeholder);
                                }
                                return;
                            };
                            for (position, column) in columns.iter().enumerate() {
                                let editing = edit
                                    .as_mut()
                                    .filter(|edit| edit.index == index && edit.column == position);
                                let (_, response) = table_row.col(|ui| match editing {
                                    Some(edit) => {
                                        if let Some(action) = edit_cell(ui, edit) {
                                            actions.push(action);
                                        }
                                    }
                                    None => {
                                        let display = display_cell(
                                            &column.field,
                                            row.value(&column.key),
                                            &context,
                                        );
                                        cell::show(ui, &display);
                                    }
                                });
                                if column.editable && response.double_clicked() {
                                    actions.push(EditAction::Start {
                                        index,
                                        column: position,
                                    });
                                }
                            }
                        });
                    });
            });

        // Prefetch the next page before the viewport reaches its end, so that
        // scrolling down at a steady pace never shows placeholders.
        if last_visible % PAGE_SIZE + PREFETCH_ROWS >= PAGE_SIZE
            && (last_visible / PAGE_SIZE + 1) * PAGE_SIZE < total
        {
            wanted.insert(last_visible / PAGE_SIZE + 1);
        }

        self.stats = GridStats {
            total,
            loaded: self
                .pages
                .values()
                .map(|page| {
                    if let Page::Ready(rows) = page {
                        rows.len()
                    } else {
                        0
                    }
                })
                .sum(),
            laid_out,
            first_visible: if first_visible == usize::MAX {
                0
            } else {
                first_visible
            },
            pages_in_flight: self.pages_in_flight(),
        };
        for action in actions {
            self.apply(action);
        }
        wanted
    }

    fn apply(&mut self, action: EditAction) {
        match action {
            EditAction::Start { index, column } => {
                let Remote::Ready(columns) = &self.columns else {
                    return;
                };
                let (Some(row), Some(grid_column)) = (self.row(index), columns.get(column)) else {
                    return;
                };
                let original = editable_text(row.value(&grid_column.key));
                self.edit = Some(Edit {
                    index,
                    column,
                    row_id: row.id,
                    buffer: original.clone(),
                    original,
                    needs_focus: true,
                });
            }
            EditAction::Cancel => self.edit = None,
            EditAction::Commit => self.commit_edit(),
        }
    }

    /// Writes the edited value into the row right away and leaves the request
    /// to [`Self::send_saves`]: the grid shows the new value while the
    /// server confirms it, and puts the old one back if it refuses.
    fn commit_edit(&mut self) {
        let Some(edit) = self.edit.take() else { return };
        if edit.buffer == edit.original {
            return;
        }
        let Remote::Ready(columns) = &self.columns else {
            return;
        };
        let Some(column) = columns.get(edit.column) else {
            return;
        };
        let value = wire_value(&column.field.field_type, &edit.buffer);
        let key = column.key.clone();
        let Some(row) = self.row_mut(edit.index, edit.row_id) else {
            return;
        };
        let previous = row
            .values
            .insert(key.clone(), value.clone())
            .unwrap_or(Value::Null);
        self.pending_saves.push(PendingSave {
            index: edit.index,
            row_id: edit.row_id,
            key,
            value,
            previous,
        });
    }

    /// Sends the edits committed during this frame.
    fn send_saves(&mut self, api: Option<Api<'_>>) {
        let Some(api) = api else { return };
        for save in self.pending_saves.drain(..) {
            let mut values = Map::new();
            values.insert(save.key.clone(), save.value);
            let generation = self.generation;
            let (index, row_id, key, previous) = (save.index, save.row_id, save.key, save.previous);
            api.send(
                endpoints::update_row(self.table_id, row_id, values),
                move |result| Msg::Grid {
                    generation,
                    msg: GridMsg::Saved {
                        index,
                        row_id,
                        key,
                        previous,
                        result,
                    },
                },
            );
        }
    }
}

/// An edit written into the grid but not sent yet.
struct PendingSave {
    index: usize,
    row_id: u64,
    key: String,
    value: Value,
    previous: Value,
}

/// The editor of a cell; returns what to do when the user leaves it.
fn edit_cell(ui: &mut Ui, edit: &mut Edit) -> Option<EditAction> {
    let response = ui.add(
        TextEdit::singleline(&mut edit.buffer)
            .desired_width(f32::INFINITY)
            .margin(vec2(6.0, 2.0)),
    );
    if edit.needs_focus {
        response.request_focus();
        edit.needs_focus = false;
    }
    if response.lost_focus() {
        // Escape cancels; Enter, Tab or a click elsewhere keep the change.
        let cancelled = ui.input(|input| input.key_pressed(Key::Escape));
        return Some(if cancelled {
            EditAction::Cancel
        } else {
            EditAction::Commit
        });
    }
    None
}

/// The text an editor starts from.
fn editable_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The JSON sent for an edited text: numbers go as strings (the API parses
/// them exactly) and an emptied number becomes null.
fn wire_value(field_type: &FieldType, text: &str) -> Value {
    match field_type {
        FieldType::Number if text.trim().is_empty() => Value::Null,
        FieldType::Number => Value::String(text.trim().to_owned()),
        _ => Value::String(text.to_owned()),
    }
}

fn initial_width(field: &Field) -> f32 {
    if field.primary {
        return 220.0;
    }
    match field.field_type {
        FieldType::LongText
        | FieldType::MultipleSelect
        | FieldType::LinkRow
        | FieldType::Lookup
        | FieldType::Ai => 240.0,
        FieldType::File | FieldType::MultipleCollaborators | FieldType::Url | FieldType::Email => {
            210.0
        }
        FieldType::Uuid => 290.0,
        FieldType::Boolean => 80.0,
        FieldType::Rating | FieldType::Password => 110.0,
        FieldType::Number
        | FieldType::Count
        | FieldType::Rollup
        | FieldType::Autonumber
        | FieldType::Duration => 120.0,
        FieldType::Date if !field.date_settings().include_time => 115.0,
        FieldType::Date | FieldType::CreatedOn | FieldType::LastModified => 160.0,
        FieldType::PhoneNumber
        | FieldType::SingleSelect
        | FieldType::CreatedBy
        | FieldType::LastModifiedBy => 160.0,
        _ => 190.0,
    }
}

fn centered_spinner(ui: &mut Ui, text: &str) {
    ui.vertical_centered(|ui| {
        ui.add_space(40.0);
        ui.spinner();
        ui.weak(text);
    });
}

/// An error with a retry button; returns whether the user asked to retry.
pub fn retry_panel(ui: &mut Ui, message: &str) -> bool {
    let mut retry = false;
    ui.vertical_centered(|ui| {
        ui.add_space(40.0);
        ui.colored_label(ui.visuals().error_fg_color, message);
        retry = ui.button("Réessayer").clicked();
    });
    retry
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;
    use egui::{Event, Modifiers, MouseWheelSource, MouseWheelUnit, TouchPhase, pos2};
    use egui_kittest::Harness;
    use serde_json::json;

    use super::*;

    /// A grid of 10 000 rows with only the first page loaded, as after opening
    /// the table.
    fn grid_with_10k_rows() -> GridView {
        let mut grid = GridView::new(9, "Grille 10 000 lignes".into());
        let fields = serde_json::from_value(json!([
            {"id": 1, "name": "Nom", "type": "text", "primary": true},
            {"id": 2, "name": "Montant", "type": "number", "number_decimal_places": 2},
            {"id": 3, "name": "Statut", "type": "single_select"},
            {"id": 4, "name": "Note", "type": "rating"},
        ]))
        .unwrap();
        grid.handle(GridMsg::Fields(Ok(fields)));
        let results = (1..=PAGE_SIZE)
            .map(|id| {
                serde_json::from_value(json!({
                    "id": id, "order": id.to_string(), "field_1": format!("Ligne {id}"), "field_2": "12.5",
                    "field_3": {"id": 1, "value": "En cours", "color": "blue"}, "field_4": id % 6,
                }))
                .unwrap()
            })
            .collect();
        grid.handle(GridMsg::Page {
            page: 0,
            result: Ok(RowPage {
                count: 10_000,
                next: None,
                previous: None,
                results,
            }),
        });
        grid
    }

    #[test]
    fn lays_out_only_the_visible_rows_of_a_large_table() {
        let zone = FixedOffset::east_opt(0).unwrap();
        let mut harness = Harness::builder()
            .with_size(vec2(1200.0, 800.0))
            .build_ui_state(
                |ui, grid: &mut GridView| grid.ui(ui, None, &zone),
                grid_with_10k_rows(),
            );
        harness.run_steps(3);
        let stats = harness.state().stats;
        assert_eq!(
            (stats.total, stats.loaded, stats.first_visible),
            (10_000, PAGE_SIZE, 0)
        );
        assert!((15..40).contains(&stats.laid_out), "{stats:?}");

        // Scroll deep into the table: still one screenful of rows, drawn as
        // placeholders until their page arrives.
        harness.hover_at(pos2(600.0, 400.0));
        harness.event(Event::MouseWheel {
            unit: MouseWheelUnit::Point,
            delta: vec2(0.0, -150_000.0),
            phase: TouchPhase::Move,
            source: MouseWheelSource::Unknown,
            modifiers: Modifiers::NONE,
        });
        harness.run_steps(30);
        let stats = harness.state().stats;
        assert!(stats.first_visible > 1_000, "{stats:?}");
        assert!((15..40).contains(&stats.laid_out), "{stats:?}");
        // Without an API handle nothing is requested, and nothing else is kept.
        assert_eq!(harness.state().pages.len(), 1);
    }

    #[test]
    fn numbers_are_sent_as_trimmed_strings() {
        assert_eq!(
            wire_value(&FieldType::Number, " 12.5 "),
            Value::String("12.5".into())
        );
        assert_eq!(wire_value(&FieldType::Number, " "), Value::Null);
        assert_eq!(
            wire_value(&FieldType::Text, " a "),
            Value::String(" a ".into())
        );
    }
}
