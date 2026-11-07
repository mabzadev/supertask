//! Responses shaped like Hono's `c.json()` behind the TS Worker's CORS middleware.

use serde_json::Value;
use worker::{Env, js_sys, wasm_bindgen::JsValue, web_sys};

use crate::json;

/// `(path, search)` of a request URL; `search` excludes the `?`.
pub fn split_url(url: &str) -> (&str, &str) {
    let after_scheme = url.find("://").map_or(0, |i| i + 3);
    let path_start = url[after_scheme..]
        .find('/')
        .map_or(url.len(), |i| after_scheme + i);
    let rest = &url[path_start..];
    match rest.split_once('?') {
        Some((path, search)) => (if path.is_empty() { "/" } else { path }, search),
        None => (if rest.is_empty() { "/" } else { rest }, ""),
    }
}

/// A string binding (plain var or secret), `None` when absent.
pub fn string_binding(env: &Env, name: &str) -> Option<String> {
    js_sys::Reflect::get(env, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.as_string())
}

/// `c.json(body, status)`: `JSON.stringify` body, `application/json`, and the
/// headers Hono's `cors({ origin: "*", exposeHeaders: ["Content-Disposition"] })` adds.
pub fn json_response(env: &Env, status: u16, body: &Value) -> worker::Result<web_sys::Response> {
    let headers = web_sys::Headers::new()?;
    headers.set("Content-Type", "application/json")?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Expose-Headers", "Content-Disposition")?;
    // Local diagnostics only: lets the differential tests see which side answered.
    if string_binding(env, "ST_BACKEND_HEADER").as_deref() == Some("1") {
        headers.set("X-Supertask-Backend", "rust")?;
    }
    let init = web_sys::ResponseInit::new();
    init.set_status(status);
    init.set_headers(&headers);
    web_sys::Response::new_with_opt_str_and_init(Some(&json::stringify(body)), &init)
        .map_err(worker::Error::from)
}
