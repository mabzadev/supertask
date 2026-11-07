//! The Supertask client in eframe/egui, for the web (WASM) and the desktop.
//!
//! One code base for both targets: the platform differences (HTTP transport,
//! time zone, storage) sit behind `ehttp`, `eframe` and [`platform`].

mod app;
mod cell;
mod grid;
mod labels;
mod login;
mod net;
pub mod platform;
mod session;
mod sidebar;

pub use app::SupertaskApp;

/// The id of the canvas the web build draws into (see `index.html`).
pub const CANVAS_ID: &str = "supertask_canvas";
