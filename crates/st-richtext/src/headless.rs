//! Drives the editor widget without a window, by feeding raw input events to
//! an `egui::Context`. Used by the tests and the verification tools, and
//! usable by the app's own tests.
//!
//! Text layout needs fonts: enable egui's `default_fonts` feature (the
//! dev-dependencies of this crate do) or install fonts with
//! [`Harness::context`].

use egui::{
    Context, Event, Id, Key, Modifiers, PointerButton, Pos2, RawInput, Rect, Vec2, pos2, vec2,
};

use crate::doc::{Pos, RichTextDoc};
use crate::widget::{EditorState, RichTextEditor};

/// A window-less egui frame loop around one editor.
pub struct Harness {
    ctx: Context,
    size: Vec2,
    time: f64,
    events: Vec<Event>,
    id: Option<Id>,
    rect: Rect,
    changed: bool,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    /// A 700×900 point screen.
    pub fn new() -> Self {
        Self {
            ctx: Context::default(),
            size: vec2(700.0, 900.0),
            time: 0.0,
            events: Vec::new(),
            id: None,
            rect: Rect::NOTHING,
            changed: false,
        }
    }

    /// The egui context, e.g. to install fonts.
    pub fn context(&self) -> &Context {
        &self.ctx
    }

    /// Runs one frame with the queued events; returns whether the document
    /// changed.
    pub fn run(&mut self, doc: &mut RichTextDoc) -> bool {
        let input = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, self.size)),
            time: Some(self.time),
            events: std::mem::take(&mut self.events),
            focused: true,
            ..RawInput::default()
        };
        let mut id = None;
        let mut rect = Rect::NOTHING;
        let mut changed = false;
        self.ctx
            .run_ui(input, |ui| {
                let output = RichTextEditor::new(doc).show(ui);
                id = Some(output.response.id);
                rect = output.response.rect;
                changed = output.changed;
            })
            .drop_without_applying_deltas();
        self.id = id;
        self.rect = rect;
        self.changed = changed;
        self.time += 1.0 / 60.0;
        changed
    }

    /// Lets time pass, e.g. to end an undo group (edits less than 500 ms
    /// apart are undone together).
    pub fn wait(&mut self, seconds: f64) {
        self.time += seconds;
    }

    /// Runs a frame and gives the editor the keyboard focus.
    pub fn focus(&mut self, doc: &mut RichTextDoc) {
        self.run(doc);
        let id = self.id.expect("the editor ran");
        self.ctx.memory_mut(|memory| memory.request_focus(id));
        self.run(doc);
    }

    /// The editor's screen rectangle in the last frame.
    pub fn rect(&self) -> Rect {
        self.rect
    }

    /// The cursor and selection after the last frame.
    pub fn state(&self) -> EditorState {
        self.id
            .and_then(|id| EditorState::load(&self.ctx, id))
            .unwrap_or_default()
    }

    /// Moves the cursor, as a click would.
    pub fn set_cursor(&mut self, doc: &RichTextDoc, pos: Pos) {
        self.set_selection(doc, pos, pos);
    }

    /// Selects from `anchor` to `head`, as a drag would.
    pub fn set_selection(&mut self, doc: &RichTextDoc, anchor: Pos, head: Pos) {
        let id = self.id.expect("run a frame first");
        let mut state = self.state();
        state.set_selection(doc, anchor, head);
        state.store(&self.ctx, id);
    }

    /// Queues a raw event for the next frame.
    pub fn push_event(&mut self, event: Event) {
        self.events.push(event);
    }

    /// Types text in one frame, like a keyboard does.
    pub fn type_text(&mut self, doc: &mut RichTextDoc, text: &str) -> bool {
        self.events.push(Event::Text(text.to_owned()));
        self.run(doc)
    }

    /// Presses and releases a key with modifiers in one frame.
    pub fn press(&mut self, doc: &mut RichTextDoc, key: Key, modifiers: Modifiers) -> bool {
        for pressed in [true, false] {
            self.events.push(Event::Key {
                key,
                physical_key: None,
                pressed,
                repeat: false,
                modifiers,
            });
        }
        self.run(doc)
    }

    /// Clicks at a point relative to the editor's top-left corner.
    pub fn click(&mut self, doc: &mut RichTextDoc, at: Vec2) -> bool {
        let pos = self.rect.min + at;
        self.events.push(Event::PointerMoved(pos));
        let mut changed = self.run(doc);
        for pressed in [true, false] {
            self.events.push(Event::PointerButton {
                pos,
                button: PointerButton::Primary,
                pressed,
                modifiers: Modifiers::NONE,
            });
            changed |= self.run(doc);
        }
        self.events.push(Event::PointerMoved(pos2(-10.0, -10.0)));
        self.run(doc) || changed
    }
}
