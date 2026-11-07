//! Supertask's Rust Worker, phase 0 of the rewrite (`docs/plan-reecriture-rust.md`).
//!
//! It receives every request in front of the TypeScript Worker (`LEGACY`
//! service binding) and answers the routes it has ported, byte for byte like
//! the TS code; everything else, and every case a ported route does not
//! reproduce exactly, is passed to the TS Worker unchanged.
//!
//! The pure modules (JS semantics, JSON, JWT, passwords, cell serialization,
//! roles) compile natively and are unit-tested with `cargo nextest`; the
//! Worker glue only exists on `wasm32`.

pub mod fallback;
pub mod fields;
pub mod js;
pub mod json;
pub mod jwt;
pub mod listing;
pub mod number_format;
pub mod password;
pub mod query;
pub mod resolve;
pub mod roles;

#[cfg(target_arch = "wasm32")]
mod worker_glue;
