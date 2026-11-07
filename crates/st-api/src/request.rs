//! A sans-IO description of an API call.
//!
//! An [`ApiRequest`] says what to send (method, path, query, JSON body) and
//! knows how to read the answer, but does not send anything: the egui app runs
//! it through `ehttp`, a test through a fixture, the Worker through `fetch`.
//! The response type is carried in the request type, so a caller cannot decode
//! the answer of one endpoint as the payload of another.

use std::fmt;
use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{ApiError, ClientError};

/// The HTTP methods the API uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One call to the API whose successful answer decodes to `T`.
pub struct ApiRequest<T> {
    pub method: Method,
    /// Absolute path, starting with `/api/`.
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    /// Whether the call needs the `Authorization: JWT …` header.
    pub authenticated: bool,
    response: PhantomData<fn() -> T>,
}

// Manual impls: deriving would require `T: Clone`/`T: Debug` for no reason.
impl<T> Clone for ApiRequest<T> {
    fn clone(&self) -> Self {
        Self {
            method: self.method,
            path: self.path.clone(),
            query: self.query.clone(),
            body: self.body.clone(),
            authenticated: self.authenticated,
            response: PhantomData,
        }
    }
}

impl<T> fmt::Debug for ApiRequest<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiRequest")
            .field("method", &self.method)
            .field("path", &self.path)
            .field("query", &self.query)
            .field("authenticated", &self.authenticated)
            .finish_non_exhaustive()
    }
}

impl<T> ApiRequest<T> {
    pub(crate) fn new(method: Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            query: Vec::new(),
            body: None,
            authenticated: true,
            response: PhantomData,
        }
    }

    pub(crate) fn get(path: impl Into<String>) -> Self {
        Self::new(Method::Get, path)
    }

    pub(crate) fn with_body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    pub(crate) fn with_query(mut self, key: &str, value: impl ToString) -> Self {
        self.query.push((key.to_owned(), value.to_string()));
        self
    }

    pub(crate) fn anonymous(mut self) -> Self {
        self.authenticated = false;
        self
    }

    /// The full URL of the call. `base` is the server origin
    /// (`http://127.0.0.1:8811`), or empty to stay on the page's origin.
    pub fn url(&self, base: &str) -> String {
        let mut url = format!("{}{}", base.trim_end_matches('/'), self.path);
        for (index, (key, value)) in self.query.iter().enumerate() {
            url.push(if index == 0 { '?' } else { '&' });
            url.push_str(&percent_encode(key));
            url.push('=');
            url.push_str(&percent_encode(value));
        }
        url
    }

    /// The serialized JSON body, if any.
    pub fn body_bytes(&self) -> Option<Vec<u8>> {
        self.body
            .as_ref()
            .map(|body| serde_json::to_vec(body).expect("a JSON value serializes"))
    }
}

impl<T: DeserializeOwned> ApiRequest<T> {
    /// Reads the answer of the server: the payload on a 2xx status, the API
    /// error otherwise.
    pub fn decode(&self, status: u16, body: &[u8]) -> Result<T, ClientError> {
        if !(200..300).contains(&status) {
            return Err(ClientError::Api(ApiError::from_response(status, body)));
        }
        // Some endpoints answer 204 without a body; `()` and `Option` accept null.
        let body = if body.is_empty() {
            b"null".as_slice()
        } else {
            body
        };
        serde_json::from_slice(body).map_err(|error| ClientError::Decode(error.to_string()))
    }
}

/// Percent-encodes everything but the RFC 3986 unreserved characters, which is
/// always valid in a query component.
fn percent_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls_with_an_encoded_query() {
        let request = ApiRequest::<()>::get("/api/database/rows/table/1/")
            .with_query("page", 2)
            .with_query("search", "Été & co");
        assert_eq!(
            request.url("http://127.0.0.1:8811/"),
            "http://127.0.0.1:8811/api/database/rows/table/1/?page=2&search=%C3%89t%C3%A9%20%26%20co"
        );
        assert_eq!(
            request.url(""),
            "/api/database/rows/table/1/?page=2&search=%C3%89t%C3%A9%20%26%20co"
        );
    }

    #[test]
    fn decodes_errors_and_empty_bodies() {
        let request = ApiRequest::<Option<u32>>::get("/api/x/");
        assert_eq!(request.decode(204, b"").unwrap(), None);
        assert_eq!(request.decode(200, b"7").unwrap(), Some(7));
        let error = request
            .decode(
                401,
                br#"{"error":"NOT_AUTHENTICATED","detail":"Invalid credentials."}"#,
            )
            .unwrap_err();
        assert!(error.is_unauthenticated());
        assert!(matches!(
            request.decode(200, b"{"),
            Err(ClientError::Decode(_))
        ));
    }
}
