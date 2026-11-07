//! Request and response types of the Supertask HTTP API, shared by the egui app
//! and the Worker.
//!
//! The crate is transport-agnostic ("sans-IO"): [`endpoints`] builds
//! [`ApiRequest`] values that describe a call and decode its answer, and the
//! caller sends them with whatever HTTP client its platform has. This keeps
//! HTTP libraries and async runtimes out of the shared code.

pub mod auth;
pub mod endpoints;
pub mod error;
pub mod request;
pub mod row;
pub mod workspace;

pub use auth::{AuthResponse, LoginRequest, LoginResponse, TokenClaims, User, read_claims};
pub use error::{ApiError, ClientError};
pub use request::{ApiRequest, Method};
pub use row::{Row, RowPage, RowsQuery};
pub use workspace::{Application, ApplicationSummary, Table, View, Workspace};
