//! The editable document: a yrs document plus the editing commands.
//!
//! Every command runs in one yrs transaction, so every edit is a Yjs update
//! that other Supertask clients (the Vue editor through y-prosemirror, or
//! another Rust client) can apply. Commands take and return [`Pos`] values
//! against [`RichTextDoc::lines`], which is rebuilt after each change.

use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map as JsonMap, Value};
use yrs::types::Attrs;
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Doc, Map, MapRef, OffsetKind, Options, Origin, Out, ReadTxn, StateVector, Transact,
    TransactionMut, Update, Xml, XmlFragment, XmlFragmentRef, XmlOut,
};

use crate::edit::{self, Anchor};
use crate::lines::{Line, LineKind, Wrapper, build_lines, element_role};
use crate::model::{Document, any_to_json, json_to_any};
use crate::schema::{FRAGMENT, ListKind, MATERIALIZED_KEY, META_MAP, Mark, Role, TextBlock, node};

/// Origin of the transactions made by this editor; the undo manager tracks it.
const LOCAL_ORIGIN: &str = "st-richtext";
/// Origin of the `materialized` mirror refresh, kept out of the undo history.
const MIRROR_ORIGIN: &str = "st-richtext/materialized";
/// Origin of updates received from other clients.
const REMOTE_ORIGIN: &str = "st-richtext/remote";

/// A cursor position: a line of [`RichTextDoc::lines`] and a character
/// offset in it (inline nodes count as one character).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    /// Index in [`RichTextDoc::lines`].
    pub line: usize,
    /// Offset in the line, from `0` to [`Line::len`].
    pub offset: usize,
}

impl Pos {
    /// A position.
    pub fn new(line: usize, offset: usize) -> Self {
        Self { line, offset }
    }
}

/// Errors of update decoding and integration.
#[derive(Debug)]
pub enum Error {
    /// The bytes are not a Yjs v1 update.
    Decode(String),
    /// yrs refused to integrate the update.
    Apply(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(e) => write!(f, "invalid Yjs update: {e}"),
            Self::Apply(e) => write!(f, "could not apply Yjs update: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// A Supertask rich text document backed by yrs.
pub struct RichTextDoc {
    doc: Doc,
    fragment: XmlFragmentRef,
    meta: MapRef,
    lines: Vec<Line>,
    outbox: Arc<Mutex<Vec<Vec<u8>>>>,
    undo: UndoManager<()>,
    clock: Arc<AtomicU64>,
    mirror_materialized: bool,
}

impl fmt::Debug for RichTextDoc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RichTextDoc")
            .field("client_id", &self.doc.client_id())
            .field("lines", &self.lines.len())
            .finish_non_exhaustive()
    }
}

impl Default for RichTextDoc {
    fn default() -> Self {
        Self::new()
    }
}

impl RichTextDoc {
    /// An empty document with a random client id.
    pub fn new() -> Self {
        Self::from_doc(Doc::with_options(Options {
            offset_kind: OffsetKind::Bytes,
            ..Options::default()
        }))
    }

    /// An empty document with a fixed client id, for reproducible tests.
    pub fn with_client_id(client_id: u64) -> Self {
        Self::from_doc(Doc::with_options(Options {
            client_id: yrs::block::ClientID::new(client_id),
            offset_kind: OffsetKind::Bytes,
            ..Options::default()
        }))
    }

    /// Loads a document from a Yjs v1 update, such as the `ydoc` value the
    /// content room Durable Object stores.
    ///
    /// The client id is random. On the web it comes from
    /// `crypto.getRandomValues` (see the `fastrand/js` dependency).
    ///
    /// # Errors
    ///
    /// When the bytes are not a valid Yjs v1 update.
    pub fn from_update(update: &[u8]) -> Result<Self, Error> {
        let mut doc = Self::new();
        doc.apply_update(update)?;
        Ok(doc)
    }

    /// [`Self::from_update`] with a fixed client id.
    ///
    /// # Errors
    ///
    /// When the bytes are not a valid Yjs v1 update.
    pub fn from_update_with_client_id(update: &[u8], client_id: u64) -> Result<Self, Error> {
        let mut doc = Self::with_client_id(client_id);
        doc.apply_update(update)?;
        Ok(doc)
    }

    fn from_doc(doc: Doc) -> Self {
        let fragment = doc.get_or_insert_xml_fragment(FRAGMENT);
        let meta = doc.get_or_insert_map(META_MAP);

        // Collect every update this client produces (edits, undo, mirror) to
        // hand them to the sync layer; remote updates are not echoed back.
        let outbox = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&outbox);
        let remote = Origin::from(REMOTE_ORIGIN);
        doc.observe_update_v1("st-richtext/outbox", move |txn, event| {
            if txn.origin() != Some(&remote) {
                sink.lock().expect("outbox lock").push(event.update.clone());
            }
        })
        .expect("a new document has no open transaction");

        // yrs needs a clock to group edits in undo steps; the widget feeds it
        // the egui time so that it also works on wasm and in tests.
        let clock = Arc::new(AtomicU64::new(0));
        let now = Arc::clone(&clock);
        let mut undo = UndoManager::with_options(UndoOptions {
            capture_timeout_millis: 500,
            tracked_origins: HashSet::from([Origin::from(LOCAL_ORIGIN)]),
            capture_transaction: None,
            timestamp: Arc::new(move || now.load(Ordering::Relaxed)),
            init_undo_stack: Vec::new(),
            init_redo_stack: Vec::new(),
        });
        undo.expand_scope(&doc, &fragment);

        let lines = build_lines(&doc.transact(), &fragment);
        Self {
            doc,
            fragment,
            meta,
            lines,
            outbox,
            undo,
            clock,
            mirror_materialized: true,
        }
    }

    /// Fills an empty document from ProseMirror JSON, like page.vue does
    /// with the page content stored in D1 when the collaboration room has no
    /// state yet. Does nothing if the fragment already has content, so two
    /// clients opening a new page cannot duplicate it.
    pub fn load_prosemirror_json(&mut self, json: &Value) -> bool {
        if self.fragment.len(&self.doc.transact()) > 0 {
            return false;
        }
        let content = json
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let fragment = self.fragment.clone();
        self.edit(Pos::default(), |txn, _| {
            edit::insert_prosemirror_nodes(txn, &fragment, 0, &content);
            None
        });
        true
    }

    /// The underlying yrs document.
    pub fn yrs_doc(&self) -> &Doc {
        &self.doc
    }

    /// Integrates an update from another client. It is not echoed by
    /// [`Self::take_local_updates`].
    ///
    /// # Errors
    ///
    /// When the bytes are not a valid Yjs v1 update or yrs rejects it.
    pub fn apply_update(&mut self, update: &[u8]) -> Result<(), Error> {
        let update = Update::decode_v1(update).map_err(|e| Error::Decode(e.to_string()))?;
        self.doc
            .transact_mut_with(REMOTE_ORIGIN)
            .apply_update(update)
            .map_err(|e| Error::Apply(e.to_string()))?;
        self.refresh();
        Ok(())
    }

    /// The whole state as a Yjs v1 update.
    pub fn encode_state_as_update(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// The state vector, to ask another client for what is missing.
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// What another client is missing, given its state vector (y-sync
    /// step 2).
    ///
    /// # Errors
    ///
    /// When the state vector cannot be decoded.
    pub fn encode_diff(&self, state_vector: &[u8]) -> Result<Vec<u8>, Error> {
        let sv = StateVector::decode_v1(state_vector).map_err(|e| Error::Decode(e.to_string()))?;
        Ok(self.doc.transact().encode_diff_v1(&sv))
    }

    /// Takes the updates produced locally since the last call, in order,
    /// for the sync layer to send.
    pub fn take_local_updates(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *self.outbox.lock().expect("outbox lock"))
    }

    /// Whether each edit also rewrites `supertask.materialized.content`, like
    /// `mirrorMaterialized()` in page.vue. On by default: the Durable Object
    /// persists that JSON to D1, which serves search, exports and versions.
    pub fn set_mirror_materialized(&mut self, enabled: bool) {
        self.mirror_materialized = enabled;
    }

    /// The `supertask.materialized` JSON, if any.
    pub fn materialized(&self) -> Option<Value> {
        match self.meta.get(&self.doc.transact(), MATERIALIZED_KEY)? {
            Out::Any(any) => Some(any_to_json(&any)),
            _ => None,
        }
    }

    /// The flattened lines.
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    /// A snapshot of the document tree.
    pub fn document(&self) -> Document {
        Document::read(&self.doc.transact(), &self.fragment)
    }

    /// The ProseMirror JSON of the document.
    pub fn to_prosemirror_json(&self) -> Value {
        self.document().to_prosemirror_json()
    }

    /// Sets the time used to group edits into undo steps, in seconds.
    pub fn set_time(&self, seconds: f64) {
        self.clock
            .store((seconds.max(0.0) * 1000.0) as u64, Ordering::Relaxed);
    }

    fn refresh(&mut self) {
        self.lines = build_lines(&self.doc.transact(), &self.fragment);
    }

    /// Runs one local edit transaction, then rebuilds the lines and resolves
    /// the returned anchor to a position (`fallback` if there is none or its
    /// block is gone).
    fn edit(
        &mut self,
        fallback: Pos,
        f: impl FnOnce(&mut TransactionMut, &[Line]) -> Option<Anchor>,
    ) -> Pos {
        let anchor = {
            let mut txn = self.doc.transact_mut_with(LOCAL_ORIGIN);
            let anchor = f(&mut txn, &self.lines);
            ensure_text_line(&mut txn, &self.fragment);
            anchor
        };
        self.after_local_change();
        anchor
            .and_then(|anchor| self.resolve(&anchor))
            .unwrap_or_else(|| self.clamp(fallback))
    }

    fn after_local_change(&mut self) {
        if self.mirror_materialized {
            let mut txn = self.doc.transact_mut_with(MIRROR_ORIGIN);
            write_materialized(&mut txn, &self.fragment, &self.meta);
        }
        self.refresh();
    }

    fn resolve(&self, anchor: &Anchor) -> Option<Pos> {
        let line = self.line_index(&crate::lines::branch_id(&anchor.element))?;
        Some(Pos::new(line, anchor.offset.min(self.lines[line].len)))
    }

    /// The index of a line from its Yjs id, for cursors that must survive
    /// remote edits.
    pub(crate) fn line_index(&self, id: &yrs::BranchID) -> Option<usize> {
        self.lines.iter().position(|line| &line.id == id)
    }

    /// The first position of the first text line.
    pub fn first_text_pos(&self) -> Pos {
        Pos::new(self.next_text_line(0).unwrap_or(0), 0)
    }

    /// The last position of the last text line.
    pub fn last_text_pos(&self) -> Pos {
        let line = self.prev_text_line(self.lines.len()).unwrap_or(0);
        Pos::new(line, self.lines.get(line).map_or(0, Line::len))
    }

    /// The first text line at or after `from`.
    pub fn next_text_line(&self, from: usize) -> Option<usize> {
        (from..self.lines.len()).find(|&i| self.lines[i].is_text())
    }

    /// The last text line strictly before `before`.
    pub fn prev_text_line(&self, before: usize) -> Option<usize> {
        (0..before.min(self.lines.len()))
            .rev()
            .find(|&i| self.lines[i].is_text())
    }

    /// Moves a position onto the closest valid text position.
    pub fn clamp(&self, pos: Pos) -> Pos {
        let line = pos.line.min(self.lines.len().saturating_sub(1));
        let line = self
            .next_text_line(line)
            .or_else(|| self.prev_text_line(line))
            .unwrap_or(0);
        let len = self.lines.get(line).map_or(0, Line::len);
        Pos::new(
            line,
            if line == pos.line {
                pos.offset.min(len)
            } else {
                0
            },
        )
    }

    /// The plain text between two positions, lines joined with `\n`.
    pub fn text_between(&self, from: Pos, to: Pos) -> String {
        let (from, to) = ordered(from, to);
        let mut out = String::new();
        for (index, line) in self
            .lines
            .iter()
            .enumerate()
            .take(to.line + 1)
            .skip(from.line)
        {
            if index > from.line {
                out.push('\n');
            }
            let a = if index == from.line { from.offset } else { 0 };
            let b = if index == to.line {
                to.offset
            } else {
                line.len
            };
            out.extend(line.text().chars().skip(a).take(b.saturating_sub(a)));
        }
        out
    }

    /// The marks text typed at `at` would get.
    pub fn marks_at(&self, at: Pos) -> Attrs {
        self.lines
            .get(at.line)
            .map(|line| line.marks_at(at.offset))
            .unwrap_or_default()
    }

    /// Types text at `at` with the marks of the surrounding text. Newlines
    /// split the block, except in code blocks.
    pub fn insert_text(&mut self, at: Pos, text: &str) -> Pos {
        let marks = self.marks_at(self.clamp(at));
        self.insert_text_with_marks(at, text, marks)
    }

    /// Types text at `at` with exactly the given formatting attributes.
    pub fn insert_text_with_marks(&mut self, at: Pos, text: &str, marks: Attrs) -> Pos {
        let mut at = self.clamp(at);
        let code = matches!(
            self.lines[at.line].kind,
            LineKind::Text(TextBlock::CodeBlock)
        );
        let mut parts = if code {
            vec![text]
        } else {
            text.split('\n').collect()
        };
        let first = parts.remove(0);
        at = self.insert_plain(at, first, marks.clone());
        for part in parts {
            at = self.split_block(at);
            at = self.insert_plain(at, part, marks.clone());
        }
        at
    }

    fn insert_plain(&mut self, at: Pos, text: &str, marks: Attrs) -> Pos {
        let text = text.replace('\r', "");
        if text.is_empty() {
            return at;
        }
        self.edit(at, |txn, lines| {
            let line = &lines[at.line];
            edit::insert_text(txn, line, at.offset, &text, marks);
            Some(Anchor::new(&line.element, at.offset + text.chars().count()))
        })
    }

    /// Deletes between two positions, merging the end line into the start
    /// line when they differ.
    pub fn delete(&mut self, from: Pos, to: Pos) -> Pos {
        let (from, to) = ordered(self.clamp(from), self.clamp(to));
        if from == to {
            return from;
        }
        self.edit(from, |txn, lines| {
            let first = &lines[from.line];
            if from.line == to.line {
                edit::delete_in_line(txn, first, from.offset, to.offset);
                return Some(Anchor::new(&first.element, from.offset));
            }
            let last = &lines[to.line];
            edit::delete_in_line(txn, last, 0, to.offset);
            edit::delete_in_line(txn, first, from.offset, first.len);
            for line in &lines[from.line + 1..to.line] {
                edit::remove_node(txn, &line.element);
            }
            let last = edit::reread(txn, last);
            edit::merge_lines(txn, &first.element, &last);
            Some(Anchor::new(&first.element, from.offset))
        })
    }

    /// Backspace without selection: deletes the previous character, or
    /// joins the line with what comes before (ProseMirror's `joinBackward`).
    pub fn backspace(&mut self, at: Pos) -> Pos {
        let at = self.clamp(at);
        if at.offset > 0 {
            return self.delete(Pos::new(at.line, at.offset - 1), at);
        }
        // Where the cursor goes if the line disappears without merging.
        let previous = self
            .prev_text_line(at.line)
            .map(|line| Anchor::new(&self.lines[line].element, self.lines[line].len));
        let is_first = previous.is_none();
        self.edit(at, |txn, lines| {
            join_backward(txn, &lines[at.line], is_first).or(previous)
        })
    }

    /// Delete without selection: deletes the next character, or pulls the
    /// next text line into this one.
    pub fn delete_forward(&mut self, at: Pos) -> Pos {
        let at = self.clamp(at);
        if at.offset < self.lines[at.line].len {
            return self.delete(at, Pos::new(at.line, at.offset + 1));
        }
        match self.lines.get(at.line + 1) {
            Some(next) if next.is_text() => self.delete(at, Pos::new(at.line + 1, 0)),
            _ => at,
        }
    }

    /// Enter: splits the block at `at` (ProseMirror's `splitBlock`, or
    /// `splitListItem` in lists, which leaves the list from an empty item).
    pub fn split_block(&mut self, at: Pos) -> Pos {
        let at = self.clamp(at);
        self.edit(at, |txn, lines| {
            Some(split(txn, &lines[at.line], at.offset))
        })
    }

    /// Shift+Enter: inserts a hard break.
    pub fn insert_hard_break(&mut self, at: Pos) -> Pos {
        let at = self.clamp(at);
        if matches!(
            self.lines[at.line].kind,
            LineKind::Text(TextBlock::CodeBlock)
        ) {
            return self.insert_text(at, "\n");
        }
        self.edit(at, |txn, lines| {
            let line = &lines[at.line];
            edit::insert_inline(txn, line, at.offset, node::HARD_BREAK);
            Some(Anchor::new(&line.element, at.offset + 1))
        })
    }

    /// Whether all the text between two positions has the mark.
    pub fn has_mark(&self, from: Pos, to: Pos, mark: Mark) -> bool {
        let (from, to) = ordered(from, to);
        edit::all_marked(&edit::text_pieces(
            &self.lines,
            (from.line, from.offset),
            (to.line, to.offset),
            mark.name(),
        ))
    }

    /// Toggles a mark on the text between two positions (Ctrl+B, Ctrl+I).
    pub fn toggle_mark(&mut self, from: Pos, to: Pos, mark: Mark) {
        let (from, to) = ordered(self.clamp(from), self.clamp(to));
        let pieces = edit::text_pieces(
            &self.lines,
            (from.line, from.offset),
            (to.line, to.offset),
            mark.name(),
        );
        if pieces.is_empty() {
            return;
        }
        self.edit(from, |txn, _| {
            edit::toggle_mark(txn, &pieces, mark.name());
            None
        });
    }

    /// Ticks or unticks the task item a line belongs to.
    pub fn toggle_task(&mut self, line: usize) {
        let Some(item) = self.lines.get(line).and_then(|l| l.item().cloned()) else {
            return;
        };
        let checked = self.lines[line]
            .wrappers
            .iter()
            .rev()
            .find_map(|w| match w {
                Wrapper::Item {
                    checked: Some(checked),
                    ..
                } => Some(*checked),
                _ => None,
            });
        let Some(checked) = checked else { return };
        self.edit(Pos::new(line, 0), |txn, _| {
            item.insert_attribute(txn, "checked", !checked);
            None
        });
    }

    /// Undoes the last group of local edits; returns whether anything changed.
    pub fn undo(&mut self) -> bool {
        let changed = self.undo.undo_blocking();
        if changed {
            self.after_local_change();
        }
        changed
    }

    /// Redoes the last undone group of edits.
    pub fn redo(&mut self) -> bool {
        let changed = self.undo.redo_blocking();
        if changed {
            self.after_local_change();
        }
        changed
    }

    /// Closes the current undo group, so the next edit starts a new one.
    pub fn close_undo_group(&mut self) {
        self.undo.reset();
    }
}

fn ordered(a: Pos, b: Pos) -> (Pos, Pos) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Keeps a place for the cursor: ProseMirror always shows at least one text
/// block. Text blocks inside unknown nodes (table cells) do not count, since
/// the cursor cannot go there; lists and quotes always contain one.
fn ensure_text_line(txn: &mut TransactionMut, fragment: &XmlFragmentRef) {
    let has_text = fragment.children(txn).any(|node| {
        matches!(&node, XmlOut::Element(e) if matches!(
            element_role(txn, e),
            Role::TextBlock(_) | Role::List(_) | Role::Blockquote
        ))
    });
    if !has_text {
        let end = fragment.len(txn);
        edit::insert_element(txn, fragment, end, node::PARAGRAPH, &[]);
    }
}

/// Mirrors the fragment into `supertask.materialized.content`, keeping the
/// other fields (title, icon, cover) the Vue client writes there.
fn write_materialized(txn: &mut TransactionMut, fragment: &XmlFragmentRef, meta: &MapRef) {
    let content = Document::read(txn, fragment).to_prosemirror_json();
    let mut value = match meta.get(txn, MATERIALIZED_KEY) {
        Some(Out::Any(any @ Any::Map(_))) => match any_to_json(&any) {
            Value::Object(map) => map,
            _ => JsonMap::new(),
        },
        _ => {
            let mut map = JsonMap::new();
            map.insert("title".into(), "".into());
            map.insert("icon".into(), "".into());
            map.insert("cover".into(), "".into());
            map.insert("settings".into(), Value::Object(JsonMap::new()));
            map.insert("editor_schema_version".into(), 1.into());
            map
        }
    };
    value.insert("content".into(), content);
    meta.insert(txn, MATERIALIZED_KEY, json_to_any(&Value::Object(value)));
}

/// Backspace at the start of a line; `None` when the line was removed.
fn join_backward(
    txn: &mut TransactionMut,
    line: &Line,
    is_first_text_line: bool,
) -> Option<Anchor> {
    let stay = Some(Anchor::new(&line.element, 0));
    let index = edit::index_in_parent(txn, &line.element);
    let parent = edit::parent_element(&line.element);
    if index == 0 {
        return match parent.as_ref().map(|p| element_role(txn, p)) {
            Some(Role::Item) => {
                let item = parent.expect("checked above");
                let item_index = edit::index_in_parent(txn, &item);
                if item_index > 0 {
                    // Join with the previous item, like ProseMirror's
                    // `deleteBarrier` joining two list items.
                    let list = edit::parent_of(&item);
                    let Some(XmlOut::Element(previous)) = list.get(txn, item_index - 1) else {
                        return stay;
                    };
                    let target = edit::fragment_of(&previous);
                    let end = previous.len(txn);
                    edit::unwrap_children(txn, &item, &target, end)
                        .map(|moved| Anchor::new(&moved, 0))
                } else {
                    // First item: lift its content out, before the list.
                    let list = edit::parent_element(&item).expect("an item is in a list");
                    let list_index = edit::index_in_parent(txn, &list);
                    edit::unwrap_children(txn, &item, &edit::parent_of(&list), list_index)
                        .map(|moved| Anchor::new(&moved, 0))
                }
            }
            Some(Role::Blockquote) => {
                let quote = parent.expect("checked above");
                let quote_index = edit::index_in_parent(txn, &quote);
                let moved =
                    edit::move_node(txn, &line.element, &edit::parent_of(&quote), quote_index);
                Some(Anchor::new(&moved, 0))
            }
            // TipTap's Backspace turns a heading that starts the document
            // into a paragraph (`clearNodes`).
            None if is_first_text_line
                && !matches!(line.kind, LineKind::Text(TextBlock::Paragraph)) =>
            {
                let moved = edit::retag(txn, &line.element, node::PARAGRAPH, &[]);
                Some(Anchor::new(&moved, 0))
            }
            _ => stay,
        };
    }
    let siblings = edit::parent_of(&line.element);
    let Some(XmlOut::Element(previous)) = siblings.get(txn, index - 1) else {
        return stay;
    };
    match element_role(txn, &previous) {
        Role::TextBlock(_) => {
            let offset = edit::merge_lines(txn, &previous, line);
            Some(Anchor::new(&previous, offset))
        }
        Role::List(kind) => {
            // A block after a list becomes its last item (`deleteBarrier`
            // wraps it with `findWrapping`).
            let list = edit::fragment_of(&previous);
            let end = previous.len(txn);
            let attrs = task_attrs(kind);
            let item = edit::insert_element(txn, &list, end, kind.item_tag(), &attrs);
            let moved = edit::move_node(txn, &line.element, &edit::fragment_of(&item), 0);
            Some(Anchor::new(&moved, 0))
        }
        Role::Blockquote => {
            let end = previous.len(txn);
            let moved = edit::move_node(txn, &line.element, &edit::fragment_of(&previous), end);
            Some(Anchor::new(&moved, 0))
        }
        // Rules, tables and other blocks the editor does not edit: an empty
        // line after them is removed, otherwise nothing happens.
        Role::Rule | Role::Unknown | Role::Item => {
            if line.is_empty() && siblings.len(txn) > 1 {
                edit::remove_node(txn, &line.element);
                return None;
            }
            stay
        }
    }
}

fn task_attrs(kind: ListKind) -> Vec<(String, Any)> {
    if kind == ListKind::Task {
        vec![("checked".to_owned(), Any::Bool(false))]
    } else {
        Vec::new()
    }
}

/// Enter at `offset` of a line.
fn split(txn: &mut TransactionMut, line: &Line, offset: usize) -> Anchor {
    if matches!(line.kind, LineKind::Text(TextBlock::CodeBlock)) {
        edit::insert_text(txn, line, offset, "\n", Attrs::new());
        return Anchor::new(&line.element, offset + 1);
    }
    if let Some(item) = line.item().cloned() {
        let index = edit::index_in_parent(txn, &line.element);
        if line.is_empty() && item.len(txn) == 1 {
            return lift_item(txn, &item, line);
        }
        // splitListItem: a new item after this one gets the rest of the
        // paragraph and the blocks that followed it in the item.
        let list = edit::parent_of(&item);
        let item_index = edit::index_in_parent(txn, &item);
        let kind = match element_role(txn, &edit::parent_element(&item).expect("item in a list")) {
            Role::List(kind) => kind,
            _ => ListKind::Bullet,
        };
        let new_item =
            edit::insert_element(txn, &list, item_index + 1, item.tag(), &task_attrs(kind));
        let paragraph =
            edit::insert_element(txn, &edit::fragment_of(&new_item), 0, node::PARAGRAPH, &[]);
        edit::move_tail(txn, line, offset, &paragraph);
        edit::move_children_from(txn, &item, index + 1, &new_item);
        return Anchor::new(&paragraph, 0);
    }
    let at_end = offset >= line.len;
    let (tag, attrs) = match line.kind {
        LineKind::Text(TextBlock::Heading(_)) if at_end => (node::PARAGRAPH, Vec::new()),
        LineKind::Text(kind) => (kind.tag(), edit::line_attributes(txn, line)),
        _ => (node::PARAGRAPH, Vec::new()),
    };
    let new = edit::split_line(txn, line, offset, tag, &attrs);
    Anchor::new(&new, 0)
}

/// Enter in an empty list item: leave the list, or go up one level in a
/// nested list (ProseMirror's `liftListItem`).
fn lift_item(txn: &mut TransactionMut, item: &yrs::XmlElementRef, line: &Line) -> Anchor {
    let list = edit::parent_element(item).expect("an item is in a list");
    let list_attrs: Vec<(String, Any)> = list
        .attributes(txn)
        .filter_map(|(k, v)| match v {
            Out::Any(any) => Some((k.to_owned(), any)),
            _ => None,
        })
        .collect();
    let item_index = edit::index_in_parent(txn, item);
    let following = list.len(txn) - item_index - 1;
    let outer_item = edit::parent_element(&list).filter(|p| element_role(txn, p) == Role::Item);

    // Where the item's content goes, and the container for the items that
    // followed it.
    let (target_parent, target_index, holder) = match &outer_item {
        Some(outer) => {
            let outer_list = edit::parent_of(outer);
            let outer_index = edit::index_in_parent(txn, outer);
            let new_item =
                edit::insert_element(txn, &outer_list, outer_index + 1, outer.tag(), &[]);
            (edit::fragment_of(&new_item), 0, Some(new_item))
        }
        None => {
            let list_index = edit::index_in_parent(txn, &list);
            (edit::parent_of(&list), list_index + 1, None)
        }
    };
    let moved = edit::move_node(txn, &line.element, &target_parent, target_index);
    if following > 0 {
        let rest_parent = match &holder {
            Some(new_item) => edit::fragment_of(new_item),
            None => target_parent.clone(),
        };
        let rest_index = match &holder {
            Some(new_item) => new_item.len(txn),
            None => edit::index_in_parent(txn, &moved) + 1,
        };
        let rest = edit::insert_element(txn, &rest_parent, rest_index, list.tag(), &list_attrs);
        // The emptied item was removed with the paragraph, so the followers
        // now start at `item_index`.
        edit::move_children_from(txn, &list, item_index, &rest);
        if list.len(txn) == 0 {
            edit::remove_node(txn, &list);
        }
    }
    Anchor::new(&moved, 0)
}
