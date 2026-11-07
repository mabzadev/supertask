//! Low-level edits of the y-prosemirror structure, inside one transaction.
//!
//! The helpers keep the invariants y-prosemirror relies on when it rebuilds
//! the ProseMirror document from Yjs:
//! - a text block alternates `XmlText` and inline elements, and never has two
//!   `XmlText` children side by side (y-prosemirror would merge them on read,
//!   which is itself an edit);
//! - a list item starts with a paragraph, containers are never left empty and
//!   the fragment keeps at least one block. y-prosemirror deletes the Yjs nodes
//!   that do not fit the schema, so breaking these rules would lose data.
//!
//! Yjs has no move: moving a node means copying it and deleting the original,
//! which is also what y-prosemirror does.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::types::Attrs;
use yrs::{
    Any, ReadTxn, Text, TransactionMut, Xml, XmlElementPrelim, XmlElementRef, XmlFragment,
    XmlFragmentRef, XmlOut, XmlTextPrelim, XmlTextRef,
};

use crate::lines::{Line, Run, Segment, byte_offset, element_role, read_segments};
use crate::schema::{Role, node};

/// A cursor target expressed against Yjs handles, resolved to a line index
/// once the transaction is committed and the lines are rebuilt.
#[derive(Clone)]
pub(crate) struct Anchor {
    pub element: XmlElementRef,
    pub offset: usize,
}

impl Anchor {
    pub fn new(element: &XmlElementRef, offset: usize) -> Self {
        Self {
            element: element.clone(),
            offset,
        }
    }
}

/// A piece of inline content being copied between text blocks.
enum Piece {
    Runs(Vec<Run>),
    Node(XmlOut),
}

/// The children API of an element, which is also an `XmlFragment`.
pub(crate) fn fragment_of(element: &XmlElementRef) -> XmlFragmentRef {
    let fragment: &XmlFragmentRef = element.as_ref();
    fragment.clone()
}

/// The container of an element: its parent element or the root fragment.
pub(crate) fn parent_of(element: &XmlElementRef) -> XmlFragmentRef {
    match element.parent() {
        Some(XmlOut::Element(parent)) => fragment_of(&parent),
        Some(XmlOut::Fragment(fragment)) => fragment,
        _ => unreachable!("an element of the document always has a parent"),
    }
}

/// The parent element, `None` for top-level blocks.
pub(crate) fn parent_element(element: &XmlElementRef) -> Option<XmlElementRef> {
    match element.parent()? {
        XmlOut::Element(parent) => Some(parent),
        _ => None,
    }
}

pub(crate) fn index_in_parent<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> u32 {
    let id = crate::lines::branch_id(element);
    let index = parent_of(element)
        .children(txn)
        .position(|child| child.id() == id)
        .expect("an element is among the children of its parent");
    u32::try_from(index).expect("fewer than 4 billion siblings")
}

fn attributes<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Vec<(String, Any)> {
    element
        .attributes(txn)
        .filter_map(|(key, value)| match value {
            yrs::Out::Any(any) => Some((key.to_owned(), any)),
            _ => None,
        })
        .collect()
}

/// Inserts a new empty element with the given attributes.
pub(crate) fn insert_element(
    txn: &mut TransactionMut,
    parent: &XmlFragmentRef,
    index: u32,
    tag: &str,
    attrs: &[(String, Any)],
) -> XmlElementRef {
    let element = parent.insert(txn, index, XmlElementPrelim::empty(tag));
    for (key, value) in attrs {
        element.insert_attribute(txn, key.as_str(), value.clone());
    }
    element
}

/// The runs of an `XmlText` with their raw formatting attributes.
pub(crate) fn text_runs<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> Vec<Run> {
    crate::model::read_runs(txn, text)
        .into_iter()
        .map(|run| Run {
            text: run.text,
            attrs: run.marks.into_iter().map(|(k, v)| (k.into(), v)).collect(),
        })
        .collect()
}

/// Appends runs at the end of an `XmlText`, each with exactly its own marks.
pub(crate) fn append_runs(txn: &mut TransactionMut, text: &XmlTextRef, runs: &[Run]) {
    let mut end: usize = text_runs(txn, text).iter().map(|run| run.text.len()).sum();
    for run in runs {
        let index = u32::try_from(end).expect("text blocks are smaller than 4 GiB");
        text.insert_with_attributes(txn, index, &run.text, run.attrs.clone());
        end += run.text.len();
    }
}

/// Deep copy of a node into `parent` at `index`.
pub(crate) fn copy_node(
    txn: &mut TransactionMut,
    source: &XmlOut,
    parent: &XmlFragmentRef,
    index: u32,
) -> Option<XmlOut> {
    match source {
        XmlOut::Element(element) => {
            let attrs = attributes(txn, element);
            let children: Vec<XmlOut> = element.children(txn).collect();
            let copy = insert_element(txn, parent, index, element.tag(), &attrs);
            let target = fragment_of(&copy);
            for (i, child) in children.iter().enumerate() {
                copy_node(txn, child, &target, i as u32);
            }
            Some(XmlOut::Element(copy))
        }
        XmlOut::Text(text) => {
            let runs = text_runs(txn, text);
            let copy = parent.insert(txn, index, XmlTextPrelim::new(""));
            append_runs(txn, &copy, &runs);
            Some(XmlOut::Text(copy))
        }
        XmlOut::Fragment(_) => None,
    }
}

/// Copies `children` to `parent` from `index` on, returns the copies.
fn copy_nodes(
    txn: &mut TransactionMut,
    children: &[XmlOut],
    parent: &XmlFragmentRef,
    index: u32,
) -> Vec<XmlOut> {
    children
        .iter()
        .enumerate()
        .filter_map(|(i, child)| copy_node(txn, child, parent, index + i as u32))
        .collect()
}

fn first_element(nodes: &[XmlOut]) -> Option<XmlElementRef> {
    nodes.iter().find_map(|node| match node {
        XmlOut::Element(element) => Some(element.clone()),
        _ => None,
    })
}

/// Re-reads a line after its text changed earlier in the same transaction.
pub(crate) fn reread(txn: &TransactionMut, line: &Line) -> Line {
    let segments = read_segments(txn, &line.element);
    let len = segments.last().map_or(0, |s| s.start() + s.len());
    Line {
        segments,
        len,
        ..line.clone()
    }
}

/// Inserts text at a character offset of a text line, with exactly `attrs`.
pub(crate) fn insert_text(
    txn: &mut TransactionMut,
    line: &Line,
    offset: usize,
    text: &str,
    attrs: Attrs,
) {
    if text.is_empty() {
        return;
    }
    for segment in &line.segments {
        if let Segment::Text {
            text: ytext,
            start,
            content,
            ..
        } = segment
            && (*start..=start + segment.len()).contains(&offset)
        {
            ytext.insert_with_attributes(txn, byte_offset(content, offset - start), text, attrs);
            return;
        }
    }
    // No text child touches the offset (empty block, or between two inline
    // nodes): create one there.
    let index = line.segments.iter().filter(|s| s.start() < offset).count() as u32;
    let ytext = line.element.insert(txn, index, XmlTextPrelim::new(""));
    ytext.insert_with_attributes(txn, 0, text, attrs);
}

/// Deletes the characters `from..to` of a text line.
pub(crate) fn delete_in_line(txn: &mut TransactionMut, line: &Line, from: usize, to: usize) {
    if from >= to {
        return;
    }
    let mut removed_inline = false;
    for (index, segment) in line.segments.iter().enumerate().rev() {
        let start = segment.start();
        let (a, b) = (from.max(start), to.min(start + segment.len()));
        if a >= b {
            continue;
        }
        match segment {
            Segment::Text { text, content, .. } => {
                let begin = byte_offset(content, a - start);
                let end = byte_offset(content, b - start);
                text.remove_range(txn, begin, end - begin);
            }
            Segment::Inline { .. } => {
                line.element.remove(txn, index as u32);
                removed_inline = true;
            }
        }
    }
    if removed_inline {
        merge_adjacent_texts(txn, &line.element);
    }
}

/// Folds `XmlText` siblings into one, from the right.
fn merge_adjacent_texts(txn: &mut TransactionMut, element: &XmlElementRef) {
    let children: Vec<XmlOut> = element.children(txn).collect();
    for i in (1..children.len()).rev() {
        if let (XmlOut::Text(left), XmlOut::Text(right)) = (&children[i - 1], &children[i]) {
            let runs = text_runs(txn, right);
            append_runs(txn, left, &runs);
            element.remove(txn, i as u32);
        }
    }
}

/// The runs of `runs` between character offsets `from` and `to`.
fn slice_runs(runs: &[Run], from: usize, to: usize) -> Vec<Run> {
    let mut out = Vec::new();
    let mut position = 0;
    for run in runs {
        let len = run.text.chars().count();
        let (a, b) = (from.max(position), to.min(position + len));
        if a < b {
            out.push(Run {
                text: run.text.chars().skip(a - position).take(b - a).collect(),
                attrs: run.attrs.clone(),
            });
        }
        position += len;
    }
    out
}

/// The inline content of a line from `from` to its end.
fn tail_pieces(line: &Line, from: usize) -> Vec<Piece> {
    let mut pieces = Vec::new();
    for segment in &line.segments {
        let start = segment.start();
        let end = start + segment.len();
        match segment {
            Segment::Text { runs, .. } if end > from => {
                let runs = slice_runs(runs, from.saturating_sub(start), end - start);
                if !runs.is_empty() {
                    pieces.push(Piece::Runs(runs));
                }
            }
            Segment::Inline { element, .. } if start >= from => {
                pieces.push(Piece::Node(XmlOut::Element(element.clone())));
            }
            _ => {}
        }
    }
    pieces
}

/// Appends inline pieces at the end of a text block, merging text into its
/// last `XmlText` so that no two texts end up side by side.
fn append_pieces(txn: &mut TransactionMut, target: &XmlElementRef, pieces: &[Piece]) {
    let fragment = fragment_of(target);
    for piece in pieces {
        let len = target.len(txn);
        match piece {
            Piece::Runs(runs) => {
                let last = len.checked_sub(1).and_then(|i| target.get(txn, i));
                let text = match last {
                    Some(XmlOut::Text(text)) => text,
                    _ => target.insert(txn, len, XmlTextPrelim::new("")),
                };
                append_runs(txn, &text, runs);
            }
            Piece::Node(node) => {
                copy_node(txn, node, &fragment, len);
            }
        }
    }
}

/// Moves the content of a line after `offset` to the end of `target`.
pub(crate) fn move_tail(
    txn: &mut TransactionMut,
    line: &Line,
    offset: usize,
    target: &XmlElementRef,
) {
    append_pieces(txn, target, &tail_pieces(line, offset));
    delete_in_line(txn, line, offset, line.len);
}

/// Splits a text line at `offset`: a new block `tag` with `attrs` is inserted
/// right after it and receives the content after the offset.
pub(crate) fn split_line(
    txn: &mut TransactionMut,
    line: &Line,
    offset: usize,
    tag: &str,
    attrs: &[(String, Any)],
) -> XmlElementRef {
    let parent = parent_of(&line.element);
    let index = index_in_parent(txn, &line.element);
    let new = insert_element(txn, &parent, index + 1, tag, attrs);
    move_tail(txn, line, offset, &new);
    new
}

/// The attributes of a line's element, to give the same type to a split.
pub(crate) fn line_attributes(txn: &TransactionMut, line: &Line) -> Vec<(String, Any)> {
    attributes(txn, &line.element)
}

/// Appends the content of `source` to the text block `target`, then removes
/// `source`; returns the former length of `target`, where the cursor goes.
pub(crate) fn merge_lines(
    txn: &mut TransactionMut,
    target: &XmlElementRef,
    source: &Line,
) -> usize {
    let target_len = read_segments(txn, target)
        .last()
        .map_or(0, |s| s.start() + s.len());
    append_pieces(txn, target, &tail_pieces(source, 0));
    remove_node(txn, &source.element);
    target_len
}

/// Inserts an inline node (a hard break) at `offset`, splitting the text
/// around it into two `XmlText`.
pub(crate) fn insert_inline(txn: &mut TransactionMut, line: &Line, offset: usize, tag: &str) {
    for (index, segment) in line.segments.iter().enumerate() {
        if let Segment::Text {
            text,
            start,
            content,
            runs,
        } = segment
            && offset > *start
            && offset < start + segment.len()
        {
            let local = offset - start;
            let tail = slice_runs(runs, local, segment.len());
            let at = byte_offset(content, local);
            text.remove_range(
                txn,
                at,
                u32::try_from(content.len()).expect("small text") - at,
            );
            let index = index as u32;
            line.element
                .insert(txn, index + 1, XmlElementPrelim::empty(tag));
            let rest = line.element.insert(txn, index + 2, XmlTextPrelim::new(""));
            append_runs(txn, &rest, &tail);
            return;
        }
    }
    let index = line
        .segments
        .iter()
        .filter(|s| s.start() + s.len() <= offset)
        .count() as u32;
    line.element
        .insert(txn, index, XmlElementPrelim::empty(tag));
}

/// Removes an element, then the containers it leaves empty, then repairs
/// list items that no longer start with a paragraph.
pub(crate) fn remove_node(txn: &mut TransactionMut, element: &XmlElementRef) {
    let mut current = element.clone();
    loop {
        let parent = parent_element(&current);
        let index = index_in_parent(txn, &current);
        parent_of(&current).remove(txn, index);
        match parent {
            Some(parent) if parent.len(txn) == 0 => current = parent,
            Some(parent) => {
                repair_item(txn, &parent);
                break;
            }
            None => break,
        }
    }
}

/// A list item must start with a paragraph (`paragraph block*`).
fn repair_item(txn: &mut TransactionMut, element: &XmlElementRef) {
    if element_role(txn, element) != Role::Item {
        return;
    }
    let starts_with_text = matches!(
        element.get(txn, 0),
        Some(XmlOut::Element(first)) if matches!(element_role(txn, &first), Role::TextBlock(_))
    );
    if !starts_with_text {
        insert_element(txn, &fragment_of(element), 0, node::PARAGRAPH, &[]);
    }
}

/// Moves a block to `parent` at `index`; returns the moved copy.
pub(crate) fn move_node(
    txn: &mut TransactionMut,
    element: &XmlElementRef,
    parent: &XmlFragmentRef,
    index: u32,
) -> XmlElementRef {
    let copy = copy_node(txn, &XmlOut::Element(element.clone()), parent, index)
        .and_then(|node| first_element(&[node]))
        .expect("an element copies to an element");
    remove_node(txn, element);
    copy
}

/// Moves every child of `element` to `parent` at `index`, then removes
/// `element`; returns the first moved element.
pub(crate) fn unwrap_children(
    txn: &mut TransactionMut,
    element: &XmlElementRef,
    parent: &XmlFragmentRef,
    index: u32,
) -> Option<XmlElementRef> {
    let children: Vec<XmlOut> = element.children(txn).collect();
    let copies = copy_nodes(txn, &children, parent, index);
    remove_node(txn, element);
    first_element(&copies)
}

/// Moves the children of `element` from `from` on to the end of `target`.
pub(crate) fn move_children_from(
    txn: &mut TransactionMut,
    element: &XmlElementRef,
    from: u32,
    target: &XmlElementRef,
) {
    let children: Vec<XmlOut> = element.children(txn).skip(from as usize).collect();
    if children.is_empty() {
        return;
    }
    let target_fragment = fragment_of(target);
    let end = target.len(txn);
    copy_nodes(txn, &children, &target_fragment, end);
    element.remove_range(txn, from, children.len() as u32);
}

/// Replaces a text block by one of another type with the same content.
pub(crate) fn retag(
    txn: &mut TransactionMut,
    element: &XmlElementRef,
    tag: &str,
    attrs: &[(String, Any)],
) -> XmlElementRef {
    let parent = parent_of(element);
    let index = index_in_parent(txn, element);
    let children: Vec<XmlOut> = element.children(txn).collect();
    let new = insert_element(txn, &parent, index, tag, attrs);
    copy_nodes(txn, &children, &fragment_of(&new), 0);
    parent.remove(txn, index + 1);
    new
}

/// One stretch of an `XmlText` covered by a selection.
pub(crate) struct TextPiece {
    text: XmlTextRef,
    start: u32,
    len: u32,
    marked: bool,
}

/// The stretches of text between two positions, with whether each one fully
/// carries the mark `mark_type`.
pub(crate) fn text_pieces(
    lines: &[Line],
    from: (usize, usize),
    to: (usize, usize),
    mark_type: &str,
) -> Vec<TextPiece> {
    let mut pieces = Vec::new();
    for (index, line) in lines.iter().enumerate().take(to.0 + 1).skip(from.0) {
        let a = if index == from.0 { from.1 } else { 0 };
        let b = if index == to.0 { to.1 } else { line.len };
        for segment in &line.segments {
            let Segment::Text {
                text,
                start,
                content,
                runs,
            } = segment
            else {
                continue;
            };
            let (sa, sb) = (a.max(*start), b.min(start + segment.len()));
            if sa >= sb {
                continue;
            }
            let selected = slice_runs(runs, sa - start, sb - start);
            let begin = byte_offset(content, sa - start);
            pieces.push(TextPiece {
                text: text.clone(),
                start: begin,
                len: byte_offset(content, sb - start) - begin,
                marked: selected.iter().all(|run| run.has_mark(mark_type)),
            });
        }
    }
    pieces
}

/// Adds the mark to every piece, or removes it if all pieces already have it
/// (ProseMirror's `toggleMark`). Plain marks are stored as `{}`, like
/// y-prosemirror stores `mark.attrs`.
pub(crate) fn toggle_mark(txn: &mut TransactionMut, pieces: &[TextPiece], mark_type: &str) {
    let all_marked = pieces.iter().all(|piece| piece.marked);
    let value = if all_marked {
        Any::Null
    } else {
        Any::Map(Arc::new(HashMap::new()))
    };
    for piece in pieces {
        let attrs = Attrs::from([(Arc::from(mark_type), value.clone())]);
        piece.text.format(txn, piece.start, piece.len, attrs);
    }
}

/// Whether every piece already carries the mark.
pub(crate) fn all_marked(pieces: &[TextPiece]) -> bool {
    !pieces.is_empty() && pieces.iter().all(|piece| piece.marked)
}

/// Inserts ProseMirror JSON nodes into `parent` from `index` on, the way
/// y-prosemirror's `createTypeFromElementNode` does: non-null attributes,
/// consecutive text nodes in one `XmlText` with their marks as formatting
/// attributes (`{}` for marks without attributes).
pub(crate) fn insert_prosemirror_nodes(
    txn: &mut TransactionMut,
    parent: &XmlFragmentRef,
    mut index: u32,
    nodes: &[serde_json::Value],
) {
    let mut pending: Vec<Run> = Vec::new();
    let flush = |txn: &mut TransactionMut, index: &mut u32, pending: &mut Vec<Run>| {
        if pending.is_empty() {
            return;
        }
        let text = parent.insert(txn, *index, XmlTextPrelim::new(""));
        append_runs(txn, &text, pending);
        pending.clear();
        *index += 1;
    };
    for node in nodes {
        let kind = node
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        if kind == "text" {
            let text = node
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            let attrs = node
                .get("marks")
                .and_then(|m| m.as_array())
                .into_iter()
                .flatten()
                .filter_map(|mark| {
                    let name = mark.get("type")?.as_str()?;
                    let value = mark
                        .get("attrs")
                        .map_or(Any::Map(Arc::default()), crate::model::json_to_any);
                    Some((Arc::from(name), value))
                })
                .collect();
            pending.push(Run {
                text: text.to_owned(),
                attrs,
            });
            continue;
        }
        flush(txn, &mut index, &mut pending);
        let attrs: Vec<(String, Any)> = node
            .get("attrs")
            .and_then(|a| a.as_object())
            .into_iter()
            .flatten()
            .filter(|(_, value)| !value.is_null())
            .map(|(key, value)| (key.clone(), crate::model::json_to_any(value)))
            .collect();
        let element = insert_element(txn, parent, index, kind, &attrs);
        index += 1;
        if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
            insert_prosemirror_nodes(txn, &fragment_of(&element), 0, content);
        }
    }
    flush(txn, &mut index, &mut pending);
}
