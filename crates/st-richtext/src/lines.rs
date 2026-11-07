//! The document flattened into lines, the unit of layout and of the cursor.
//!
//! ProseMirror documents are trees, but the cursor only ever sits in a text
//! block (paragraph, heading, code block). Flattening the tree into one line
//! per text block, plus one line per block the editor cannot edit, makes
//! layout, hit testing and cursor movement simple loops, while each line
//! keeps the Yjs handles needed to edit it in place.

use yrs::branch::Branch;
use yrs::types::Attrs;
use yrs::{Any, BranchID, Out, ReadTxn, Xml, XmlElementRef, XmlFragment, XmlOut, XmlTextRef};

use crate::model::{any_as_i64, read_runs};
use crate::schema::{ListKind, Role, TextBlock, node, role};

/// Shown for inline nodes the editor does not know (mentions, inline images).
pub const OBJECT_CHAR: char = '\u{FFFC}';

/// What a line shows.
#[derive(Clone, Debug, PartialEq)]
pub enum LineKind {
    /// Editable text.
    Text(TextBlock),
    /// A horizontal rule.
    Rule,
    /// A block the editor keeps but cannot edit (table, callout, image…).
    Placeholder {
        /// The node type, e.g. `table`.
        name: String,
        /// The beginning of its text content.
        summary: String,
    },
}

/// A container around a line, outermost first.
#[derive(Clone, Debug, PartialEq)]
pub enum Wrapper {
    /// An item of a list.
    Item {
        /// The kind of list.
        list: ListKind,
        /// The number shown for ordered lists.
        number: i64,
        /// Whether the bullet, number or checkbox is drawn on this line: only
        /// the first line of an item gets it.
        marker: bool,
        /// The `checked` attribute of task items.
        checked: Option<bool>,
    },
    /// A blockquote.
    Quote,
}

/// Uniformly formatted text inside a line.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    /// The text.
    pub text: String,
    /// The raw Yjs formatting attributes (mark key → mark attributes).
    pub attrs: Attrs,
}

impl Run {
    /// Whether the run has a mark of this type.
    pub fn has_mark(&self, mark_type: &str) -> bool {
        self.attrs
            .keys()
            .any(|key| crate::schema::mark_type(key) == mark_type)
    }
}

/// One child of a text block: Yjs stores consecutive text nodes in one
/// `XmlText` and inline nodes (hard breaks, mentions) as sibling elements,
/// so the children alternate between the two.
#[derive(Clone, Debug)]
pub(crate) enum Segment {
    Text {
        text: XmlTextRef,
        start: usize,
        content: String,
        runs: Vec<Run>,
    },
    Inline {
        element: XmlElementRef,
        start: usize,
        name: String,
    },
}

impl Segment {
    pub(crate) fn start(&self) -> usize {
        match self {
            Self::Text { start, .. } | Self::Inline { start, .. } => *start,
        }
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            Self::Text { content, .. } => content.chars().count(),
            Self::Inline { .. } => 1,
        }
    }
}

/// A line of the flattened document.
#[derive(Clone, Debug)]
pub struct Line {
    pub(crate) element: XmlElementRef,
    pub(crate) id: BranchID,
    /// Element ancestors, outermost first (the fragment is not included).
    pub(crate) ancestors: Vec<XmlElementRef>,
    pub(crate) kind: LineKind,
    pub(crate) wrappers: Vec<Wrapper>,
    pub(crate) segments: Vec<Segment>,
    pub(crate) len: usize,
}

impl Line {
    /// What the line shows.
    pub fn kind(&self) -> &LineKind {
        &self.kind
    }

    /// Whether the cursor can go in this line.
    pub fn is_text(&self) -> bool {
        matches!(self.kind, LineKind::Text(_))
    }

    /// The containers around the line, outermost first.
    pub fn wrappers(&self) -> &[Wrapper] {
        &self.wrappers
    }

    /// Number of cursor positions minus one: characters, plus one per
    /// inline node.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the line has no content.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The displayed text: one character per cursor step, `\n` for hard
    /// breaks and [`OBJECT_CHAR`] for unknown inline nodes.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for segment in &self.segments {
            match segment {
                Segment::Text { content, .. } => out.push_str(content),
                Segment::Inline { name, .. } if name == node::HARD_BREAK => out.push('\n'),
                Segment::Inline { .. } => out.push(OBJECT_CHAR),
            }
        }
        out
    }

    /// The formatted runs of the line, inline nodes excluded.
    pub fn runs(&self) -> impl Iterator<Item = &Run> {
        self.segments.iter().flat_map(|segment| match segment {
            Segment::Text { runs, .. } => runs.as_slice(),
            Segment::Inline { .. } => &[],
        })
    }

    /// The text of the line that carries a mark of this type, run by run.
    pub fn marked_text(&self, mark_type: &str) -> Vec<String> {
        self.runs()
            .filter(|run| run.has_mark(mark_type))
            .map(|run| run.text.clone())
            .collect()
    }

    /// The textual type of the closest list item around the line, if any.
    pub(crate) fn item(&self) -> Option<&XmlElementRef> {
        self.ancestors
            .last()
            .filter(|parent| matches!(role(parent.tag(), None), Role::Item))
    }

    /// The marks text typed at `offset` gets, following ProseMirror's
    /// `ResolvedPos.marks()`: inside a run, the marks of that run; at a
    /// boundary, the marks of the run before (of the run after at the start
    /// of the line), minus the non-inclusive marks that the run after does
    /// not share.
    pub(crate) fn marks_at(&self, offset: usize) -> Attrs {
        let mut before: Option<&Attrs> = None;
        let mut after: Option<&Attrs> = None;
        let mut position = 0;
        'segments: for segment in &self.segments {
            match segment {
                Segment::Text { runs, .. } => {
                    for run in runs {
                        let len = run.text.chars().count();
                        if offset > position && offset < position + len {
                            return run.attrs.clone();
                        }
                        if position + len == offset {
                            before = Some(&run.attrs);
                        }
                        if position == offset {
                            after = Some(&run.attrs);
                            break 'segments;
                        }
                        position += len;
                    }
                }
                Segment::Inline { .. } => {
                    if position == offset {
                        break;
                    }
                    position += 1;
                    before = None;
                }
            }
        }
        let (main, other) = match (before, after) {
            (Some(before), after) => (before, after),
            (None, Some(after)) => (after, None),
            (None, None) => return Attrs::new(),
        };
        main.iter()
            .filter(|(key, value)| {
                crate::schema::mark_is_inclusive(crate::schema::mark_type(key))
                    || other.is_some_and(|other| other.get(*key) == Some(*value))
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
}

/// Flattens a fragment into lines.
pub(crate) fn build_lines<T: ReadTxn, F: XmlFragment>(txn: &T, fragment: &F) -> Vec<Line> {
    let mut out = Vec::new();
    walk(txn, fragment, &mut Vec::new(), &mut Vec::new(), &mut out);
    out
}

fn walk<T: ReadTxn, F: XmlFragment>(
    txn: &T,
    parent: &F,
    ancestors: &mut Vec<XmlElementRef>,
    wrappers: &mut Vec<Wrapper>,
    out: &mut Vec<Line>,
) {
    for child in parent.children(txn) {
        let XmlOut::Element(element) = child else {
            // Text or fragments directly in a block container do not fit the
            // schema; y-prosemirror drops them, the editor ignores them.
            continue;
        };
        match element_role(txn, &element) {
            Role::TextBlock(kind) => {
                out.push(read_text_line(txn, element, kind, ancestors, wrappers))
            }
            Role::List(list) => {
                let start = attr_i64(txn, &element, "start").unwrap_or(1);
                ancestors.push(element.clone());
                for (index, item) in element.children(txn).enumerate() {
                    match item {
                        XmlOut::Element(item) if element_role(txn, &item) == Role::Item => {
                            let checked = (list == ListKind::Task)
                                .then(|| attr(txn, &item, "checked") == Some(Any::Bool(true)));
                            let depth = wrappers.len();
                            let first = out.len();
                            wrappers.push(Wrapper::Item {
                                list,
                                number: start + index as i64,
                                marker: true,
                                checked,
                            });
                            ancestors.push(item.clone());
                            walk(txn, &item, ancestors, wrappers, out);
                            ancestors.pop();
                            wrappers.pop();
                            for line in out.iter_mut().skip(first + 1) {
                                if let Some(Wrapper::Item { marker, .. }) =
                                    line.wrappers.get_mut(depth)
                                {
                                    *marker = false;
                                }
                            }
                        }
                        XmlOut::Element(other) => {
                            out.push(opaque_line(txn, other, ancestors, wrappers))
                        }
                        _ => {}
                    }
                }
                ancestors.pop();
            }
            Role::Blockquote => {
                ancestors.push(element.clone());
                wrappers.push(Wrapper::Quote);
                walk(txn, &element, ancestors, wrappers, out);
                wrappers.pop();
                ancestors.pop();
            }
            Role::Rule => out.push(Line {
                id: branch_id(&element),
                element,
                ancestors: ancestors.clone(),
                kind: LineKind::Rule,
                wrappers: wrappers.clone(),
                segments: Vec::new(),
                len: 0,
            }),
            Role::Item | Role::Unknown => out.push(opaque_line(txn, element, ancestors, wrappers)),
        }
    }
}

pub(crate) fn element_role<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Role {
    let tag = element.tag();
    let level = if tag.as_ref() == node::HEADING {
        attr_i64(txn, element, "level")
    } else {
        None
    };
    role(tag, level)
}

fn read_text_line<T: ReadTxn>(
    txn: &T,
    element: XmlElementRef,
    kind: TextBlock,
    ancestors: &[XmlElementRef],
    wrappers: &[Wrapper],
) -> Line {
    let segments = read_segments(txn, &element);
    let len = segments.last().map_or(0, |s| s.start() + s.len());
    Line {
        id: branch_id(&element),
        element,
        ancestors: ancestors.to_vec(),
        kind: LineKind::Text(kind),
        wrappers: wrappers.to_vec(),
        segments,
        len,
    }
}

/// Reads the children of a text block, one segment per Yjs child so that
/// segment indices are child indices.
pub(crate) fn read_segments<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Vec<Segment> {
    let mut start = 0;
    element
        .children(txn)
        .filter_map(|child| {
            let segment = match child {
                XmlOut::Text(text) => {
                    let runs: Vec<Run> = read_runs(txn, &text)
                        .into_iter()
                        .map(|run| Run {
                            text: run.text,
                            attrs: run.marks.into_iter().map(|(k, v)| (k.into(), v)).collect(),
                        })
                        .collect();
                    Segment::Text {
                        text,
                        start,
                        content: runs.iter().map(|run| run.text.as_str()).collect(),
                        runs,
                    }
                }
                XmlOut::Element(element) => Segment::Inline {
                    name: element.tag().to_string(),
                    element,
                    start,
                },
                XmlOut::Fragment(_) => return None,
            };
            start += segment.len();
            Some(segment)
        })
        .collect()
}

fn opaque_line<T: ReadTxn>(
    txn: &T,
    element: XmlElementRef,
    ancestors: &[XmlElementRef],
    wrappers: &[Wrapper],
) -> Line {
    let mut summary = String::new();
    for node in element.successors(txn) {
        if let XmlOut::Text(text) = node {
            if !summary.is_empty() {
                summary.push(' ');
            }
            summary.push_str(&text.get_string_plain(txn));
            if summary.chars().count() > 80 {
                break;
            }
        }
    }
    if summary.chars().count() > 80 {
        summary = summary.chars().take(80).chain(['…']).collect();
    }
    Line {
        id: branch_id(&element),
        kind: LineKind::Placeholder {
            name: element.tag().to_string(),
            summary,
        },
        element,
        ancestors: ancestors.to_vec(),
        wrappers: wrappers.to_vec(),
        segments: Vec::new(),
        len: 0,
    }
}

/// Plain text of an `XmlText` without the XML tags `get_string` adds.
trait PlainText {
    fn get_string_plain<T: ReadTxn>(&self, txn: &T) -> String;
}

impl PlainText for XmlTextRef {
    fn get_string_plain<T: ReadTxn>(&self, txn: &T) -> String {
        read_runs(txn, self)
            .into_iter()
            .map(|run| run.text)
            .collect()
    }
}

pub(crate) fn attr<T: ReadTxn>(txn: &T, element: &XmlElementRef, name: &str) -> Option<Any> {
    match element.get_attribute(txn, name)? {
        Out::Any(any) => Some(any),
        _ => None,
    }
}

pub(crate) fn attr_i64<T: ReadTxn>(txn: &T, element: &XmlElementRef, name: &str) -> Option<i64> {
    any_as_i64(&attr(txn, element, name)?)
}

/// The Yjs id of an element, stable across edits and clients.
pub(crate) fn branch_id(element: &XmlElementRef) -> BranchID {
    let branch: &Branch = element.as_ref();
    branch.id()
}

/// The UTF-8 byte offset of the character at index `chars` in `text`: yrs
/// indexes text by byte ([`yrs::OffsetKind::Bytes`]), the editor by
/// character, which is also what egui's cursors count.
pub(crate) fn byte_offset(text: &str, chars: usize) -> u32 {
    let bytes = text
        .char_indices()
        .nth(chars)
        .map_or(text.len(), |(i, _)| i);
    u32::try_from(bytes).expect("text blocks are smaller than 4 GiB")
}
