//! Collaborative rich text editor for egui on top of yrs, compatible with the
//! Yjs documents of Supertask.
//!
//! Supertask pages are edited in the Vue frontend with TipTap (ProseMirror)
//! and y-prosemirror, which store the document in the `default` XmlFragment
//! of a Yjs document synced by the content room Durable Object. This crate
//! reads and edits that same structure with yrs, so a Rust client and a
//! browser can edit the same page:
//!
//! - [`RichTextDoc`] wraps a yrs document and exposes editing commands
//!   (typing, deleting, Enter, marks, undo). Each command is one yrs
//!   transaction, hence one Yjs update ([`RichTextDoc::take_local_updates`]).
//! - [`RichTextEditor`] is the egui widget that lays out, paints and edits a
//!   [`RichTextDoc`].
//! - [`Document`] is a read-only snapshot that converts to ProseMirror JSON.
//!
//! Nodes the editor does not know (tables, callouts, images…) are kept intact
//! and shown as placeholders.

mod doc;
mod edit;
pub mod headless;
mod lines;
pub mod model;
pub mod schema;
mod widget;

pub use doc::{Error, Pos, RichTextDoc};
pub use lines::{Line, LineKind, OBJECT_CHAR, Run, Wrapper};
pub use model::Document;
pub use schema::{ListKind, Mark, TextBlock};
pub use widget::{EditorOutput, EditorState, EditorStyle, RichTextEditor};
