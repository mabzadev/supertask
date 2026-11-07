//! Domain types shared by the egui app and the Worker: field types, view types,
//! cell values and their display.
//!
//! This crate is pure logic. It knows nothing about egui, HTTP or async
//! runtimes, so that the very same rules run in the browser, on the desktop and
//! in the Worker.

pub mod color;
pub mod date;
pub mod display;
pub mod duration;
pub mod field;
pub mod kinds;
pub mod number;
mod string_enum;

pub use display::{CellDisplay, Chip, DisplayContext, display_cell};
pub use field::{Field, FieldSettings, SelectOption};
pub use kinds::{ApplicationType, FieldType, FormulaType, ViewType};
