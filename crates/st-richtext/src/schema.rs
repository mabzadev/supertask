//! Names and rules of the TipTap schema used by Supertask documents.
//!
//! y-prosemirror stores a ProseMirror document in a Yjs `XmlFragment`: each
//! node becomes an `XmlElement` named after its node type and carrying its
//! non-null attributes, and each run of consecutive text nodes becomes one
//! `XmlText` whose formatting attributes are the marks (mark name → mark
//! attributes, `{}` for marks without attributes). The editor only relies on
//! these names: anything it does not know is kept untouched in the Yjs
//! document and shown as a placeholder.

/// Name of the `XmlFragment` that holds the page body
/// (`Collaboration.configure({ field: 'default' })` in `page.vue`).
pub const FRAGMENT: &str = "default";

/// Name of the Yjs map where the clients mirror the page as JSON.
pub const META_MAP: &str = "supertask";

/// Key of the JSON mirror of the page in [`META_MAP`]. The Durable Object
/// copies it to D1 on every store, so it must follow the fragment.
pub const MATERIALIZED_KEY: &str = "materialized";

/// Node type names (TipTap extension names).
pub mod node {
    /// `@tiptap/extension-paragraph`.
    pub const PARAGRAPH: &str = "paragraph";
    /// `@tiptap/extension-heading`, levels 1 to 3 in Supertask.
    pub const HEADING: &str = "heading";
    /// `@tiptap/extension-code-block`.
    pub const CODE_BLOCK: &str = "codeBlock";
    /// `@tiptap/extension-bullet-list`.
    pub const BULLET_LIST: &str = "bulletList";
    /// `@tiptap/extension-ordered-list`.
    pub const ORDERED_LIST: &str = "orderedList";
    /// `@tiptap/extension-list-item`.
    pub const LIST_ITEM: &str = "listItem";
    /// `@tiptap/extension-task-list`.
    pub const TASK_LIST: &str = "taskList";
    /// `@tiptap/extension-task-item`.
    pub const TASK_ITEM: &str = "taskItem";
    /// `@tiptap/extension-blockquote`.
    pub const BLOCKQUOTE: &str = "blockquote";
    /// `@tiptap/extension-horizontal-rule`.
    pub const HORIZONTAL_RULE: &str = "horizontalRule";
    /// `@tiptap/extension-hard-break`.
    pub const HARD_BREAK: &str = "hardBreak";
}

/// Mark type names (TipTap extension names).
pub mod mark {
    /// `@tiptap/extension-bold`.
    pub const BOLD: &str = "bold";
    /// `@tiptap/extension-italic`.
    pub const ITALIC: &str = "italic";
    /// `@tiptap/extension-underline`.
    pub const UNDERLINE: &str = "underline";
    /// `@tiptap/extension-strike`.
    pub const STRIKE: &str = "strike";
    /// `@tiptap/extension-link`.
    pub const LINK: &str = "link";
    /// `@tiptap/extension-subscript`.
    pub const SUBSCRIPT: &str = "subscript";
    /// `@tiptap/extension-superscript`.
    pub const SUPERSCRIPT: &str = "superscript";
}

/// A block whose content is inline text, where the cursor can go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextBlock {
    /// `paragraph`.
    Paragraph,
    /// `heading` with its `level` attribute.
    Heading(u8),
    /// `codeBlock`: plain text, `Enter` inserts a newline.
    CodeBlock,
}

impl TextBlock {
    /// The node type name stored in Yjs.
    pub fn tag(self) -> &'static str {
        match self {
            Self::Paragraph => node::PARAGRAPH,
            Self::Heading(_) => node::HEADING,
            Self::CodeBlock => node::CODE_BLOCK,
        }
    }
}

/// The kind of a list container.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ListKind {
    /// `bulletList` of `listItem`.
    Bullet,
    /// `orderedList` of `listItem`, numbered from its `start` attribute.
    Ordered,
    /// `taskList` of `taskItem` with a `checked` attribute.
    Task,
}

impl ListKind {
    /// The node type of the items of this list.
    pub fn item_tag(self) -> &'static str {
        match self {
            Self::Bullet | Self::Ordered => node::LIST_ITEM,
            Self::Task => node::TASK_ITEM,
        }
    }
}

/// A mark the editor can toggle on a selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mark {
    /// `bold` (Ctrl+B).
    Bold,
    /// `italic` (Ctrl+I).
    Italic,
    /// `underline` (Ctrl+U).
    Underline,
    /// `strike` (Ctrl+Shift+S in TipTap).
    Strike,
}

impl Mark {
    /// The mark type name stored as a Yjs formatting attribute.
    pub fn name(self) -> &'static str {
        match self {
            Self::Bold => mark::BOLD,
            Self::Italic => mark::ITALIC,
            Self::Underline => mark::UNDERLINE,
            Self::Strike => mark::STRIKE,
        }
    }
}

/// What the editor does with a node, decided from its type name only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    TextBlock(TextBlock),
    List(ListKind),
    Item,
    Blockquote,
    Rule,
    Unknown,
}

/// Classifies a node type. `level` is the `heading` level attribute, if any.
pub(crate) fn role(tag: &str, level: Option<i64>) -> Role {
    match tag {
        node::PARAGRAPH => Role::TextBlock(TextBlock::Paragraph),
        node::HEADING => Role::TextBlock(TextBlock::Heading(
            level.and_then(|l| u8::try_from(l).ok()).unwrap_or(1),
        )),
        node::CODE_BLOCK => Role::TextBlock(TextBlock::CodeBlock),
        node::BULLET_LIST => Role::List(ListKind::Bullet),
        node::ORDERED_LIST => Role::List(ListKind::Ordered),
        node::TASK_LIST => Role::List(ListKind::Task),
        node::LIST_ITEM | node::TASK_ITEM => Role::Item,
        node::BLOCKQUOTE => Role::Blockquote,
        node::HORIZONTAL_RULE => Role::Rule,
        _ => Role::Unknown,
    }
}

/// Returns the mark type of a Yjs formatting attribute key.
///
/// y-prosemirror suffixes the key of marks that may overlap themselves with
/// `--` and an 8-character hash of the mark (`comment--AbCd12+/`), so that
/// two such marks can cover the same text. The type is the part before.
pub fn mark_type(attribute_key: &str) -> &str {
    match attribute_key.rsplit_once("--") {
        Some((name, hash))
            if hash.len() == 8
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) =>
        {
            name
        }
        _ => attribute_key,
    }
}

/// ProseMirror's `inclusive` mark spec: whether text typed right after the
/// mark gets it. TipTap's link is not inclusive when `autolink` is off, which
/// is the Supertask configuration, so typing after a link does not extend it.
pub fn mark_is_inclusive(mark_type: &str) -> bool {
    mark_type != mark::LINK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_overlapping_mark_hash() {
        assert_eq!(mark_type("bold"), "bold");
        assert_eq!(mark_type("comment--AbCd12+/"), "comment");
        assert_eq!(mark_type("my--mark"), "my--mark");
    }

    #[test]
    fn classifies_nodes() {
        assert_eq!(
            role("heading", Some(2)),
            Role::TextBlock(TextBlock::Heading(2))
        );
        assert_eq!(role("taskList", None), Role::List(ListKind::Task));
        assert_eq!(role("table", None), Role::Unknown);
    }
}
