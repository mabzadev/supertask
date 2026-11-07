//! The "port the common case, forward the rest" contract.
//!
//! Every ported handler returns [`Failure::Unsupported`] the moment it meets a
//! case the Rust code does not reproduce exactly (an unported field type, an
//! odd input the TS code would turn into a 500, a 2FA account). The router
//! then replays the original request against the TypeScript Worker, so a
//! client can never tell which side answered.

use std::borrow::Cow;
use std::fmt;

/// Why a ported handler did not produce the response itself.
#[derive(Debug)]
pub enum Failure {
    /// Not covered by the Rust port: replay the request against the TS Worker.
    Unsupported(Cow<'static, str>),
    /// An API error the TS Worker answers with the same status and JSON.
    Api(ApiError),
    /// A runtime failure (D1, bindings). The TS Worker answers a generic 500.
    Internal(String),
}

impl Failure {
    /// Shorthand for [`Failure::Unsupported`].
    pub fn unsupported(reason: impl Into<Cow<'static, str>>) -> Self {
        Self::Unsupported(reason.into())
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(reason) => write!(f, "not ported: {reason}"),
            Self::Api(error) => write!(f, "{} {}", error.status, error.code),
            Self::Internal(message) => write!(f, "internal error: {message}"),
        }
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

/// Result alias for ported code.
pub type Outcome<T> = Result<T, Failure>;

/// An error response of the TS Worker (`src/middleware/error.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// HTTP status.
    pub status: u16,
    /// The `error` member of the JSON body.
    pub code: String,
    /// The `detail` member of the JSON body.
    pub detail: String,
}

impl ApiError {
    /// An error with an explicit code, like `c.json({ error, detail }, status)`.
    pub fn new(status: u16, code: &str, detail: &str) -> Self {
        Self {
            status,
            code: code.to_owned(),
            detail: detail.to_owned(),
        }
    }

    /// `AuthenticationError` → 401 `NOT_AUTHENTICATED`.
    pub fn authentication(detail: &str) -> Self {
        Self::new(401, "NOT_AUTHENTICATED", detail)
    }

    /// `PermissionError` → 403 `PERMISSION_DENIED`.
    pub fn permission(detail: &str) -> Self {
        Self::new(403, "PERMISSION_DENIED", detail)
    }

    /// `DoesNotExist(model, id)` → 404 `NOT_FOUND`, with its message rules.
    pub fn does_not_exist(model: &str, id: Option<&str>) -> Self {
        let detail = match id {
            Some(id) => format!("{model} with id {id} does not exist."),
            None => format!("{model} does not exist."),
        };
        Self {
            status: 404,
            code: "NOT_FOUND".to_owned(),
            detail,
        }
    }

    /// The generic 500 of the TS error handler.
    pub fn internal() -> Self {
        Self::new(
            500,
            "INTERNAL_SERVER_ERROR",
            "An unexpected error occurred.",
        )
    }

    /// The JSON body, members in the TS order.
    pub fn body(&self) -> serde_json::Value {
        serde_json::json!({ "error": self.code, "detail": self.detail })
    }
}
