//! The egui widget: lays out the lines with egui's text layout, paints them,
//! and turns input events into document commands.
//!
//! The widget owns no document state: the cursor and selection live in egui
//! memory as [`EditorState`], keyed by the Yjs id of their line so that they
//! survive edits made by other clients between two frames.

use std::sync::Arc;

use egui::text::{CCursor, CCursorRange, LayoutJob, TextFormat};
use egui::text_selection::visuals::{paint_cursor_end, paint_text_selection};
use egui::{
    Align, AsIdSalt, Context, CornerRadius, Event, EventFilter, FontFamily, FontId, Galley, Id,
    IdSalt, ImeEvent, Key, Modifiers, Pos2, Rect, Response, Sense, Stroke, Ui, Widget, pos2, vec2,
};
use yrs::BranchID;
use yrs::types::Attrs;

use crate::doc::{Pos, RichTextDoc};
use crate::lines::{Line, LineKind, OBJECT_CHAR, Segment, Wrapper};
use crate::schema::{ListKind, Mark, TextBlock, mark, mark_type, node};

/// Fonts, colors and spacing of the editor.
#[derive(Clone, Debug)]
pub struct EditorStyle {
    /// Paragraph text.
    pub body: FontId,
    /// Headings of level 1, 2 and 3.
    pub headings: [FontId; 3],
    /// Code blocks.
    pub code: FontId,
    /// Placeholders of blocks the editor does not edit.
    pub placeholder: FontId,
    /// Font family for bold text, when the app registers one. egui's
    /// default fonts have no bold face, so bold falls back to the strong
    /// text color.
    pub bold_family: Option<FontFamily>,
    /// Space between blocks.
    pub block_gap: f32,
    /// Indentation of each list level.
    pub list_indent: f32,
    /// Indentation of each blockquote level.
    pub quote_indent: f32,
}

impl Default for EditorStyle {
    fn default() -> Self {
        Self {
            body: FontId::proportional(16.0),
            headings: [
                FontId::proportional(28.0),
                FontId::proportional(22.0),
                FontId::proportional(18.0),
            ],
            code: FontId::monospace(14.0),
            placeholder: FontId::proportional(13.0),
            bold_family: None,
            block_gap: 6.0,
            list_indent: 24.0,
            quote_indent: 16.0,
        }
    }
}

/// A position stored across frames: the Yjs id of the line rather than its
/// index, which changes whenever a block is inserted above.
#[derive(Clone, Debug, PartialEq)]
struct Cursor {
    line: BranchID,
    hint: usize,
    offset: usize,
}

/// Cursor and selection of an editor, kept in egui memory between frames.
#[derive(Clone, Debug, Default)]
pub struct EditorState {
    anchor: Option<Cursor>,
    head: Option<Cursor>,
    /// Horizontal position kept while moving up and down.
    preferred_x: Option<f32>,
    /// Marks toggled with an empty selection, applied to the next typed text
    /// (ProseMirror's stored marks).
    stored_marks: Option<Attrs>,
    last_interaction: f64,
}

impl EditorState {
    /// Loads the state of the editor `id`.
    pub fn load(ctx: &Context, id: Id) -> Option<Self> {
        ctx.data(|data| data.get_temp(id))
    }

    /// Stores the state of the editor `id`.
    pub fn store(self, ctx: &Context, id: Id) {
        ctx.data_mut(|data| data.insert_temp(id, self));
    }

    /// The selection as (anchor, head), resolved against the current lines.
    pub fn selection(&self, doc: &RichTextDoc) -> Option<(Pos, Pos)> {
        let head = resolve(doc, self.head.as_ref()?);
        let anchor = self
            .anchor
            .as_ref()
            .map_or(head, |anchor| resolve(doc, anchor));
        Some((anchor, head))
    }

    /// The cursor (selection head), if the editor has been used.
    pub fn cursor(&self, doc: &RichTextDoc) -> Option<Pos> {
        self.selection(doc).map(|(_, head)| head)
    }

    /// Selects from `anchor` to `head`.
    pub fn set_selection(&mut self, doc: &RichTextDoc, anchor: Pos, head: Pos) {
        self.anchor = Some(cursor_at(doc, doc.clamp(anchor)));
        self.head = Some(cursor_at(doc, doc.clamp(head)));
        self.stored_marks = None;
    }

    /// Puts the cursor at `pos`.
    pub fn set_cursor(&mut self, doc: &RichTextDoc, pos: Pos) {
        self.set_selection(doc, pos, pos);
    }
}

fn cursor_at(doc: &RichTextDoc, pos: Pos) -> Cursor {
    Cursor {
        line: doc
            .lines()
            .get(pos.line)
            .map_or(BranchID::Root("".into()), |line| line.id.clone()),
        hint: pos.line,
        offset: pos.offset,
    }
}

fn resolve(doc: &RichTextDoc, cursor: &Cursor) -> Pos {
    match doc.line_index(&cursor.line) {
        Some(line) => doc.clamp(Pos::new(line, cursor.offset)),
        None => doc.clamp(Pos::new(cursor.hint, 0)),
    }
}

/// The keys the editor keeps while focused instead of letting egui move the
/// focus. Tab is left to egui until lists get Tab/Shift+Tab indentation.
const EDITOR_EVENTS: EventFilter = EventFilter {
    tab: false,
    horizontal_arrows: true,
    vertical_arrows: true,
    escape: false,
};

/// What [`RichTextEditor::show`] returns.
pub struct EditorOutput {
    /// The response of the editor area.
    pub response: Response,
    /// The state after this frame.
    pub state: EditorState,
    /// Whether the document changed during this frame.
    pub changed: bool,
}

/// The rich text editor widget.
pub struct RichTextEditor<'a> {
    doc: &'a mut RichTextDoc,
    id_salt: IdSalt,
    style: EditorStyle,
    desired_width: Option<f32>,
}

impl<'a> RichTextEditor<'a> {
    /// An editor for `doc`.
    pub fn new(doc: &'a mut RichTextDoc) -> Self {
        Self {
            doc,
            id_salt: IdSalt::new("st-richtext"),
            style: EditorStyle::default(),
            desired_width: None,
        }
    }

    /// Distinguishes several editors in the same `Ui`.
    pub fn id_salt(mut self, salt: impl AsIdSalt) -> Self {
        self.id_salt = IdSalt::new(salt);
        self
    }

    /// Fonts and spacing.
    pub fn style(mut self, style: EditorStyle) -> Self {
        self.style = style;
        self
    }

    /// Width of the editor, the available width by default.
    pub fn desired_width(mut self, width: f32) -> Self {
        self.desired_width = Some(width);
        self
    }

    /// Shows the editor and handles this frame's input.
    pub fn show(self, ui: &mut Ui) -> EditorOutput {
        let Self {
            doc,
            id_salt,
            style,
            desired_width,
        } = self;
        let id = ui.make_persistent_id(id_salt);
        let mut state = EditorState::load(ui.ctx(), id).unwrap_or_default();
        let width = desired_width
            .unwrap_or_else(|| ui.available_width())
            .max(40.0);
        doc.set_time(ui.input(|i| i.time));

        let mut layout = Layout::new(ui, doc, &style, width);
        // Interact with the persistent id, so that focus and state survive
        // frames whatever the surrounding layout allocates.
        let (rect, _) = ui.allocate_exact_size(vec2(width, layout.height), Sense::hover());
        let response = ui.interact(rect, id, Sense::click_and_drag());
        let mut editor = Editor {
            doc,
            changed: false,
        };

        // Pointer: place the cursor, extend with drag or shift-click, tick
        // task checkboxes.
        if let Some(pointer) = response.interact_pointer_pos() {
            let local = pointer - rect.min.to_vec2();
            if response.clicked()
                && let Some(line) = layout.checkbox_at(editor.doc, &style, local)
            {
                editor.doc.toggle_task(line);
                editor.changed = true;
                layout = Layout::new(ui, editor.doc, &style, width);
            } else {
                let pos = layout.pos_at(editor.doc, local);
                let extend = ui.input(|i| i.modifiers.shift)
                    || response.dragged() && !response.drag_started();
                if extend && state.head.is_some() {
                    state.head = Some(cursor_at(editor.doc, pos));
                } else if response.is_pointer_button_down_on() || response.clicked() {
                    state.set_cursor(editor.doc, pos);
                }
                state.preferred_x = None;
            }
            response.request_focus();
            state.last_interaction = ui.input(|i| i.time);
        }

        let focused = response.has_focus();
        if focused {
            ui.memory_mut(|memory| {
                memory.set_focus_lock_filter(id, EDITOR_EVENTS);
            });
            if state.head.is_none() {
                state.set_cursor(editor.doc, editor.doc.first_text_pos());
            }
            let events = ui.input(|i| i.filtered_events(&EDITOR_EVENTS));
            for event in &events {
                let (anchor, head) = state.selection(editor.doc).expect("set above");
                let before = editor.changed;
                editor.handle(ui, &mut state, &layout, event, anchor, head);
                if editor.changed != before {
                    layout = Layout::new(ui, editor.doc, &style, width);
                }
                state.last_interaction = ui.input(|i| i.time);
            }
        }

        layout.paint(ui, rect, editor.doc, &style, &state, focused);
        if focused && let Some(head) = state.cursor(editor.doc) {
            // Tell the platform where the caret is, for IME candidate
            // windows and virtual keyboards.
            let cursor_rect = layout.cursor_rect(head).translate(rect.min.to_vec2());
            ui.output_mut(|output| {
                output.ime = Some(egui::output::IMEOutput {
                    purpose: egui::IMEPurpose::Normal,
                    rect,
                    cursor_rect,
                    should_interrupt_composition: false,
                });
            });
        }
        if editor.changed {
            ui.ctx().request_repaint();
        }
        let changed = editor.changed;
        state.clone().store(ui.ctx(), id);
        EditorOutput {
            response,
            state,
            changed,
        }
    }
}

impl Widget for RichTextEditor<'_> {
    fn ui(self, ui: &mut Ui) -> Response {
        self.show(ui).response
    }
}

/// The input handling half of the widget.
struct Editor<'a> {
    doc: &'a mut RichTextDoc,
    changed: bool,
}

impl Editor<'_> {
    fn handle(
        &mut self,
        ui: &Ui,
        state: &mut EditorState,
        layout: &Layout,
        event: &Event,
        anchor: Pos,
        head: Pos,
    ) {
        let (from, to) = if anchor <= head {
            (anchor, head)
        } else {
            (head, anchor)
        };
        let has_selection = from != to;
        match event {
            Event::Text(text) | Event::Ime(ImeEvent::Commit(text)) => {
                let text = text.replace(['\n', '\r'], "");
                if text.is_empty() {
                    return;
                }
                let at = self.delete_selection(from, to);
                let pos = match state.stored_marks.take() {
                    Some(marks) => self.doc.insert_text_with_marks(at, &text, marks),
                    None => self.doc.insert_text(at, &text),
                };
                self.collapse(state, pos);
            }
            Event::Ime(ImeEvent::DeleteSurrounding {
                before_chars,
                after_chars,
            }) => {
                let len = self.doc.lines()[head.line].len();
                let start = Pos::new(head.line, head.offset.saturating_sub(*before_chars));
                let end = Pos::new(head.line, (head.offset + after_chars).min(len));
                let pos = self.delete_selection(start, end);
                self.collapse(state, pos);
            }
            Event::Paste(text) => {
                let at = self.delete_selection(from, to);
                let pos = self.doc.insert_text(at, text);
                self.collapse(state, pos);
            }
            Event::Copy if has_selection => ui.copy_text(self.doc.text_between(from, to)),
            Event::Cut if has_selection => {
                ui.copy_text(self.doc.text_between(from, to));
                let pos = self.delete_selection(from, to);
                self.collapse(state, pos);
            }
            Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } => self.key(state, layout, *key, *modifiers, anchor, head),
            _ => {}
        }
    }

    fn delete_selection(&mut self, from: Pos, to: Pos) -> Pos {
        if from == to {
            return from;
        }
        self.changed = true;
        self.doc.delete(from, to)
    }

    fn collapse(&mut self, state: &mut EditorState, pos: Pos) {
        self.changed = true;
        state.set_cursor(self.doc, pos);
        state.preferred_x = None;
    }

    fn key(
        &mut self,
        state: &mut EditorState,
        layout: &Layout,
        key: Key,
        modifiers: Modifiers,
        anchor: Pos,
        head: Pos,
    ) {
        let (from, to) = if anchor <= head {
            (anchor, head)
        } else {
            (head, anchor)
        };
        let has_selection = from != to;
        let command = modifiers.command;
        match key {
            Key::B | Key::I | Key::U if command => {
                let mark = match key {
                    Key::B => Mark::Bold,
                    Key::I => Mark::Italic,
                    _ => Mark::Underline,
                };
                if has_selection {
                    self.doc.toggle_mark(from, to, mark);
                    self.changed = true;
                } else {
                    let mut marks = state
                        .stored_marks
                        .take()
                        .unwrap_or_else(|| self.doc.marks_at(head));
                    let key: Arc<str> = Arc::from(mark.name());
                    if marks.remove(&key).is_none() {
                        marks.insert(key, yrs::Any::Map(Default::default()));
                    }
                    state.stored_marks = Some(marks);
                }
            }
            Key::A if command => {
                let (first, last) = (self.doc.first_text_pos(), self.doc.last_text_pos());
                state.set_selection(self.doc, first, last);
            }
            Key::Z if command && !modifiers.shift => {
                if self.doc.undo() {
                    self.changed = true;
                    state.set_cursor(self.doc, self.doc.clamp(head));
                }
            }
            Key::Z | Key::Y if command => {
                if self.doc.redo() {
                    self.changed = true;
                    state.set_cursor(self.doc, self.doc.clamp(head));
                }
            }
            Key::Enter => {
                let at = self.delete_selection(from, to);
                self.doc.close_undo_group();
                // ProseMirror's splitBlock keeps the marks: typing goes on in
                // bold after Enter at the end of bold text.
                let marks = state
                    .stored_marks
                    .take()
                    .or_else(|| (at.offset > 0).then(|| self.doc.marks_at(at)))
                    .filter(|marks| !marks.is_empty());
                let pos = if modifiers.shift {
                    self.doc.insert_hard_break(at)
                } else {
                    self.doc.split_block(at)
                };
                self.collapse(state, pos);
                state.stored_marks = marks;
            }
            Key::Backspace => {
                let pos = if has_selection {
                    self.delete_selection(from, to)
                } else {
                    self.doc.backspace(head)
                };
                self.collapse(state, pos);
            }
            Key::Delete => {
                let pos = if has_selection {
                    self.delete_selection(from, to)
                } else {
                    self.doc.delete_forward(head)
                };
                self.collapse(state, pos);
            }
            Key::ArrowLeft
            | Key::ArrowRight
            | Key::ArrowUp
            | Key::ArrowDown
            | Key::Home
            | Key::End => {
                let target = if has_selection
                    && !modifiers.shift
                    && matches!(key, Key::ArrowLeft | Key::ArrowRight)
                {
                    if key == Key::ArrowLeft { from } else { to }
                } else {
                    self.moved(state, layout, key, head)
                };
                let vertical = matches!(key, Key::ArrowUp | Key::ArrowDown);
                let keep_x = state.preferred_x;
                if modifiers.shift {
                    state.head = Some(cursor_at(self.doc, target));
                    state.stored_marks = None;
                } else {
                    state.set_cursor(self.doc, target);
                }
                state.preferred_x = if vertical { keep_x } else { None };
            }
            _ => {}
        }
    }

    /// The position a navigation key moves the cursor to.
    fn moved(&self, state: &mut EditorState, layout: &Layout, key: Key, head: Pos) -> Pos {
        let doc = &*self.doc;
        let line_len = doc.lines()[head.line].len();
        match key {
            Key::ArrowLeft if head.offset > 0 => Pos::new(head.line, head.offset - 1),
            Key::ArrowLeft => doc
                .prev_text_line(head.line)
                .map_or(head, |line| Pos::new(line, doc.lines()[line].len())),
            Key::ArrowRight if head.offset < line_len => Pos::new(head.line, head.offset + 1),
            Key::ArrowRight => doc
                .next_text_line(head.line + 1)
                .map_or(head, |line| Pos::new(line, 0)),
            Key::Home | Key::End => {
                let Some(galley) = layout.galley(head.line) else {
                    return head;
                };
                let cursor = CCursor::new(head.offset);
                let moved = if key == Key::Home {
                    galley.cursor_begin_of_row(&cursor)
                } else {
                    galley.cursor_end_of_row(&cursor)
                };
                Pos::new(head.line, moved.index.0)
            }
            Key::ArrowUp | Key::ArrowDown => {
                let Some(galley) = layout.galley(head.line) else {
                    return head;
                };
                let cursor = CCursor::new(head.offset);
                let x = *state.preferred_x.get_or_insert_with(|| {
                    galley.pos_from_cursor(cursor).center().x + layout.indent(head.line)
                });
                let row = galley.layout_from_cursor(cursor).row;
                let up = key == Key::ArrowUp;
                if up && row > 0 || !up && row + 1 < galley.rows.len() {
                    let target_row = if up { row - 1 } else { row + 1 };
                    let y = galley.rows[target_row].rect().center().y;
                    let local_x = x - layout.indent(head.line);
                    return Pos::new(head.line, galley.cursor_from_pos(vec2(local_x, y)).index.0);
                }
                let next = if up {
                    doc.prev_text_line(head.line)
                } else {
                    doc.next_text_line(head.line + 1)
                };
                match next {
                    Some(line) => {
                        let Some(galley) = layout.galley(line) else {
                            return head;
                        };
                        let rows = &galley.rows;
                        let y = if up {
                            rows.last().map_or(0.0, |r| r.rect().center().y)
                        } else {
                            rows.first().map_or(0.0, |r| r.rect().center().y)
                        };
                        let local_x = x - layout.indent(line);
                        Pos::new(line, galley.cursor_from_pos(vec2(local_x, y)).index.0)
                    }
                    None if up => Pos::new(head.line, 0),
                    None => Pos::new(head.line, line_len),
                }
            }
            _ => head,
        }
    }
}

/// One laid out line, in coordinates relative to the editor's top-left.
struct LaidLine {
    top: f32,
    height: f32,
    indent: f32,
    galley: Option<Arc<Galley>>,
}

struct Layout {
    lines: Vec<LaidLine>,
    height: f32,
}

impl Layout {
    fn new(ui: &Ui, doc: &RichTextDoc, style: &EditorStyle, width: f32) -> Self {
        let visuals = ui.visuals();
        let mut top = 0.0;
        let mut lines = Vec::with_capacity(doc.lines().len());
        for line in doc.lines() {
            let indent = line
                .wrappers()
                .iter()
                .map(|wrapper| match wrapper {
                    Wrapper::Item { .. } => style.list_indent,
                    Wrapper::Quote => style.quote_indent,
                })
                .sum::<f32>();
            let wrap = (width - indent).max(20.0);
            let (galley, height) = match line.kind() {
                LineKind::Text(kind) => {
                    let job = text_job(line, *kind, style, visuals, wrap);
                    let galley = ui.painter().layout_job(job);
                    let height = galley.size().y;
                    (Some(galley), height)
                }
                LineKind::Rule => (None, 16.0),
                LineKind::Placeholder { name, summary } => {
                    let label = if summary.is_empty() {
                        format!("[{name}]")
                    } else {
                        format!("[{name}] {summary}")
                    };
                    let galley = ui.painter().layout(
                        label,
                        style.placeholder.clone(),
                        visuals.weak_text_color(),
                        wrap - 16.0,
                    );
                    let height = galley.size().y + 12.0;
                    (Some(galley), height)
                }
            };
            lines.push(LaidLine {
                top,
                height,
                indent,
                galley,
            });
            top += height + style.block_gap;
        }
        Self {
            lines,
            height: (top - style.block_gap).max(style.body.size),
        }
    }

    fn galley(&self, line: usize) -> Option<&Arc<Galley>> {
        self.lines.get(line)?.galley.as_ref()
    }

    /// The caret rectangle of a position, relative to the editor.
    fn cursor_rect(&self, pos: Pos) -> Rect {
        let Some(laid) = self.lines.get(pos.line) else {
            return Rect::NOTHING;
        };
        let origin = vec2(laid.indent, laid.top);
        match &laid.galley {
            Some(galley) => galley
                .pos_from_cursor(CCursor::new(pos.offset))
                .translate(origin),
            None => Rect::from_min_size(origin.to_pos2(), vec2(1.0, laid.height)),
        }
    }

    fn indent(&self, line: usize) -> f32 {
        self.lines.get(line).map_or(0.0, |l| l.indent)
    }

    /// The text position under a point relative to the editor.
    fn pos_at(&self, doc: &RichTextDoc, point: Pos2) -> Pos {
        let index = self
            .lines
            .iter()
            .position(|line| point.y < line.top + line.height)
            .unwrap_or(self.lines.len().saturating_sub(1));
        let Some(line) = self.lines.get(index) else {
            return doc.first_text_pos();
        };
        if !doc.lines()[index].is_text() {
            return doc.clamp(Pos::new(index, 0));
        }
        let galley = line.galley.as_ref().expect("text lines have a galley");
        let local = vec2(point.x - line.indent, point.y - line.top);
        Pos::new(index, galley.cursor_from_pos(local).index.0)
    }

    /// The task line whose checkbox is under a point.
    fn checkbox_at(&self, doc: &RichTextDoc, style: &EditorStyle, point: Pos2) -> Option<usize> {
        self.lines.iter().enumerate().find_map(|(index, laid)| {
            let line = &doc.lines()[index];
            let rect = checkbox_rect(line, laid, style)?;
            rect.expand(2.0).contains(point).then_some(index)
        })
    }

    fn paint(
        &self,
        ui: &Ui,
        rect: Rect,
        doc: &RichTextDoc,
        style: &EditorStyle,
        state: &EditorState,
        focused: bool,
    ) {
        let painter = ui.painter_at(rect.expand(4.0));
        let visuals = ui.visuals();
        let selection = state.selection(doc);
        for (index, (line, laid)) in doc.lines().iter().zip(&self.lines).enumerate() {
            let origin = rect.min + vec2(laid.indent, laid.top);
            self.paint_wrappers(ui, rect, line, laid, style);
            match line.kind() {
                LineKind::Text(kind) => {
                    let mut galley = laid.galley.clone().expect("text lines have a galley");
                    if *kind == TextBlock::CodeBlock {
                        let bg = Rect::from_min_size(
                            origin,
                            vec2(rect.width() - laid.indent, laid.height),
                        )
                        .expand2(vec2(4.0, 2.0));
                        painter.rect_filled(bg, CornerRadius::same(4), visuals.code_bg_color);
                    }
                    if let Some((anchor, head)) = selection {
                        let (from, to) = if anchor <= head {
                            (anchor, head)
                        } else {
                            (head, anchor)
                        };
                        if (from.line..=to.line).contains(&index) && from != to {
                            let a = if index == from.line { from.offset } else { 0 };
                            let b = if index == to.line {
                                to.offset
                            } else {
                                line.len()
                            };
                            let range = CCursorRange::two(CCursor::new(a), CCursor::new(b));
                            paint_text_selection(&mut galley, visuals, &range, None);
                        }
                    }
                    painter.galley(origin, galley.clone(), visuals.text_color());
                    if focused
                        && let Some((_, head)) = selection
                        && head.line == index
                    {
                        let cursor = galley.pos_from_cursor(CCursor::new(head.offset));
                        paint_cursor_end(&painter, visuals, cursor.translate(origin.to_vec2()));
                    }
                }
                LineKind::Rule => {
                    let y = origin.y + laid.height / 2.0;
                    painter.hline(
                        origin.x..=rect.right(),
                        y,
                        visuals.widgets.noninteractive.bg_stroke,
                    );
                }
                LineKind::Placeholder { .. } => {
                    let frame =
                        Rect::from_min_size(origin, vec2(rect.width() - laid.indent, laid.height));
                    painter.rect(
                        frame,
                        CornerRadius::same(6),
                        visuals.faint_bg_color,
                        visuals.widgets.noninteractive.bg_stroke,
                        egui::StrokeKind::Inside,
                    );
                    if let Some(galley) = &laid.galley {
                        painter.galley(
                            origin + vec2(8.0, 6.0),
                            galley.clone(),
                            visuals.weak_text_color(),
                        );
                    }
                }
            }
        }
    }

    fn paint_wrappers(
        &self,
        ui: &Ui,
        rect: Rect,
        line: &Line,
        laid: &LaidLine,
        style: &EditorStyle,
    ) {
        let painter = ui.painter();
        let visuals = ui.visuals();
        let mut x = rect.min.x;
        let first_row = laid
            .galley
            .as_ref()
            .and_then(|g| g.rows.first().map(|r| r.rect()))
            .unwrap_or(Rect::from_min_size(Pos2::ZERO, vec2(0.0, laid.height)));
        let marker_y = rect.min.y + laid.top + first_row.center().y;
        for wrapper in line.wrappers() {
            match wrapper {
                Wrapper::Quote => {
                    let top = rect.min.y + laid.top - style.block_gap / 2.0;
                    let bottom = rect.min.y + laid.top + laid.height + style.block_gap / 2.0;
                    painter.vline(
                        x + 3.0,
                        top..=bottom,
                        Stroke::new(3.0, visuals.weak_text_color()),
                    );
                    x += style.quote_indent;
                }
                Wrapper::Item {
                    list,
                    number,
                    marker,
                    checked,
                } => {
                    if *marker {
                        match list {
                            ListKind::Bullet => {
                                painter.circle_filled(
                                    pos2(x + 10.0, marker_y),
                                    2.5,
                                    visuals.text_color(),
                                );
                            }
                            ListKind::Ordered => {
                                painter.text(
                                    pos2(x + style.list_indent - 6.0, marker_y),
                                    egui::Align2([Align::Max, Align::Center]),
                                    format!("{number}."),
                                    style.body.clone(),
                                    visuals.text_color(),
                                );
                            }
                            ListKind::Task => {
                                if let Some(checkbox) = checkbox_rect(line, laid, style) {
                                    let checkbox = checkbox.translate(rect.min.to_vec2());
                                    paint_checkbox(
                                        painter,
                                        visuals,
                                        checkbox,
                                        checked.unwrap_or(false),
                                    );
                                }
                            }
                        }
                    }
                    x += style.list_indent;
                }
            }
        }
    }
}

/// The checkbox of a task line, relative to the editor.
fn checkbox_rect(line: &Line, laid: &LaidLine, style: &EditorStyle) -> Option<Rect> {
    let mut x = 0.0;
    let mut found = None;
    for wrapper in line.wrappers() {
        match wrapper {
            Wrapper::Quote => x += style.quote_indent,
            Wrapper::Item { list, marker, .. } => {
                if *list == ListKind::Task && *marker {
                    found = Some(x);
                }
                x += style.list_indent;
            }
        }
    }
    let x = found?;
    let center_y = laid
        .galley
        .as_ref()
        .and_then(|g| g.rows.first().map(|r| r.rect().center().y))
        .unwrap_or(laid.height / 2.0);
    Some(Rect::from_center_size(
        pos2(x + 10.0, laid.top + center_y),
        vec2(12.0, 12.0),
    ))
}

fn paint_checkbox(painter: &egui::Painter, visuals: &egui::Visuals, rect: Rect, checked: bool) {
    painter.rect_stroke(
        rect,
        CornerRadius::same(2),
        Stroke::new(1.5, visuals.text_color()),
        egui::StrokeKind::Inside,
    );
    if checked {
        let points = [
            pos2(rect.left() + 2.5, rect.center().y),
            pos2(rect.center().x - 1.0, rect.bottom() - 3.0),
            pos2(rect.right() - 2.5, rect.top() + 2.5),
        ];
        painter.line(points.to_vec(), Stroke::new(1.8, visuals.text_color()));
    }
}

/// The layout job of a text line: one section per run, hard breaks as
/// newlines and unknown inline nodes as one object character, so that a
/// galley character index is a document offset.
fn text_job(
    line: &Line,
    kind: TextBlock,
    style: &EditorStyle,
    visuals: &egui::Visuals,
    wrap: f32,
) -> LayoutJob {
    let base = match kind {
        TextBlock::Paragraph => style.body.clone(),
        TextBlock::Heading(level) => style.headings[usize::from(level.clamp(1, 3)) - 1].clone(),
        TextBlock::CodeBlock => style.code.clone(),
    };
    let color = match kind {
        TextBlock::Heading(_) => visuals.strong_text_color(),
        _ => visuals.text_color(),
    };
    let plain = TextFormat::simple(base.clone(), color);
    let mut job = LayoutJob::default();
    job.wrap.max_width = wrap;
    for segment in &line.segments {
        match segment {
            Segment::Text { runs, .. } => {
                for run in runs {
                    job.append(
                        &run.text,
                        0.0,
                        run_format(&plain, &run.attrs, style, visuals),
                    );
                }
            }
            Segment::Inline { name, .. } if name == node::HARD_BREAK => {
                job.append("\n", 0.0, plain.clone())
            }
            Segment::Inline { .. } => {
                let mut format = plain.clone();
                format.color = visuals.weak_text_color();
                job.append(&OBJECT_CHAR.to_string(), 0.0, format);
            }
        }
    }
    if job.text.is_empty() {
        // An empty section still gives the row the height of the font.
        job.append("", 0.0, plain);
    }
    job
}

fn run_format(
    plain: &TextFormat,
    attrs: &Attrs,
    style: &EditorStyle,
    visuals: &egui::Visuals,
) -> TextFormat {
    let mut format = plain.clone();
    for key in attrs.keys() {
        match mark_type(key) {
            mark::BOLD => {
                format.color = visuals.strong_text_color();
                if let Some(family) = &style.bold_family {
                    format.font_id.family = family.clone();
                }
            }
            mark::ITALIC => format.italics = true,
            mark::UNDERLINE => format.underline = Stroke::new(1.0, format.color),
            mark::STRIKE => format.strikethrough = Stroke::new(1.0, format.color),
            mark::LINK => {
                format.color = visuals.hyperlink_color;
                format.underline = Stroke::new(1.0, visuals.hyperlink_color);
            }
            mark::SUBSCRIPT | mark::SUPERSCRIPT => {
                format.font_id.size *= 0.75;
                format.valign = if mark_type(key) == mark::SUPERSCRIPT {
                    Align::TOP
                } else {
                    Align::BOTTOM
                };
            }
            _ => {}
        }
    }
    format
}
