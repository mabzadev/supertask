//! The strangler fallback: the request goes to the TS Worker through the
//! `LEGACY` service binding and its response comes back untouched.
//!
//! The raw JS `Request` and `Response` objects are passed through instead of
//! the workers-rs wrappers, which rebuild responses and would drop the status
//! text and the content-encoding state; WebSocket upgrades (101 with a
//! `webSocket`) only survive because the response object is never copied.

use worker::js_sys::{Promise, Reflect};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures::JsFuture;
use worker::{Env, web_sys};

#[wasm_bindgen]
extern "C" {
    /// A service binding (`Fetcher`), only its `fetch` method.
    type ServiceBinding;

    #[wasm_bindgen(method, catch)]
    fn fetch(this: &ServiceBinding, request: &web_sys::Request) -> Result<Promise, JsValue>;
}

/// Sends `request` to the TS Worker and returns its response as is.
pub async fn forward(
    env: &Env,
    request: &web_sys::Request,
    reason: &str,
) -> worker::Result<web_sys::Response> {
    if super::http::string_binding(env, "ST_BACKEND_HEADER").as_deref() == Some("1") {
        worker::console_log!("[legacy] {} {} ({reason})", request.method(), request.url());
    }
    let binding = Reflect::get(env, &JsValue::from_str("LEGACY"))?;
    if binding.is_undefined() {
        return Err(worker::Error::RustError(
            "the LEGACY service binding is missing".into(),
        ));
    }
    let promise = binding.unchecked_into::<ServiceBinding>().fetch(request)?;
    Ok(JsFuture::from(promise)
        .await?
        .unchecked_into::<web_sys::Response>())
}
