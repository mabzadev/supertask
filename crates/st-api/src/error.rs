//! Errors of an API call.

use std::fmt;

use serde::Deserialize;
use serde_json::Value;

/// An error answer of the API: `{"error": "CODE", "detail": …}` with a non-2xx
/// status.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    /// A stable machine code such as `NOT_AUTHENTICATED` or `ERROR_REQUEST_BODY_VALIDATION`.
    pub code: String,
    /// The human explanation, a string or, for validation errors, an object per field.
    pub detail: Value,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    detail: Value,
}

impl ApiError {
    /// Reads an error answer. Bodies that are not the API's JSON shape (a proxy
    /// error page, an empty 502) still give a usable error.
    pub fn from_response(status: u16, body: &[u8]) -> Self {
        match serde_json::from_slice::<ErrorBody>(body) {
            Ok(parsed) => Self {
                status,
                code: parsed.error.unwrap_or_else(|| format!("HTTP_{status}")),
                detail: parsed.detail,
            },
            Err(_) => Self {
                status,
                code: format!("HTTP_{status}"),
                detail: Value::String(String::from_utf8_lossy(body).chars().take(200).collect()),
            },
        }
    }

    /// The detail as one line of text.
    pub fn detail_text(&self) -> String {
        match &self.detail {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            Value::Object(map) => map
                .iter()
                .map(|(key, value)| format!("{key} : {}", flatten(value)))
                .collect::<Vec<_>>()
                .join(" ; "),
            other => flatten(other),
        }
    }
}

fn flatten(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(flatten).collect::<Vec<_>>().join(", "),
        Value::Object(map) => map
            .get("error")
            .or_else(|| map.get("detail"))
            .map(flatten)
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} (HTTP {}, {})",
            self.detail_text(),
            self.status,
            self.code
        )
    }
}

/// Why an API call failed.
#[derive(Clone, Debug, PartialEq)]
pub enum ClientError {
    /// The request did not reach the server or got no answer.
    Network(String),
    /// The server answered with an error.
    Api(ApiError),
    /// The server answered 2xx with a body this client does not understand.
    Decode(String),
}

impl ClientError {
    /// Whether the access token was refused, which a refresh may fix.
    pub fn is_unauthenticated(&self) -> bool {
        matches!(self, Self::Api(error) if error.status == 401)
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network(message) => write!(f, "network error: {message}"),
            Self::Api(error) => error.fmt(f),
            Self::Decode(message) => write!(f, "unexpected response: {message}"),
        }
    }
}

impl std::error::Error for ClientError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_api_error_shape() {
        let error = ApiError::from_response(
            401,
            br#"{"error":"NOT_AUTHENTICATED","detail":"Invalid credentials."}"#,
        );
        assert_eq!(error.code, "NOT_AUTHENTICATED");
        assert_eq!(error.detail_text(), "Invalid credentials.");
    }

    #[test]
    fn flattens_validation_details() {
        let error = ApiError::from_response(
            400,
            br#"{"error":"ERROR_REQUEST_BODY_VALIDATION","detail":{"name":[{"error":"This field is required.","code":"required"}]}}"#,
        );
        assert_eq!(error.detail_text(), "name : This field is required.");
    }

    #[test]
    fn survives_non_json_bodies() {
        let error = ApiError::from_response(502, b"<html>Bad gateway</html>");
        assert_eq!(error.code, "HTTP_502");
        assert_eq!(error.detail_text(), "<html>Bad gateway</html>");
    }
}
