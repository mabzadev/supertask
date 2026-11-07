//! The Worker itself: routing, ported handlers and the strangler fallback.

mod auth;
mod db;
mod http;
mod legacy;
mod rows;
#[cfg(feature = "spikes")]
mod spikes;
mod token_auth;

use worker::{Context, Env, Method, Request, event, web_sys};

use crate::fallback::{ApiError, Failure, Outcome};
use crate::listing::table_segment;

/// Turns a handler outcome into the response: declined cases are replayed
/// against the TS Worker with `replay`, errors get the TS error JSON.
async fn finish(
    env: &Env,
    outcome: Outcome<web_sys::Response>,
    replay: &web_sys::Request,
) -> worker::Result<web_sys::Response> {
    match outcome {
        Ok(response) => Ok(response),
        Err(Failure::Unsupported(reason)) => legacy::forward(env, replay, &reason).await,
        Err(Failure::Api(error)) => http::json_response(env, error.status, &error.body()),
        Err(Failure::Internal(message)) => {
            // Same log line and body as the TS error handler.
            worker::console_error!("[ERROR] {message}");
            let error = ApiError::internal();
            http::json_response(env, error.status, &error.body())
        }
    }
}

/// Every request enters here. Ported routes answer themselves; anything else,
/// or any case a ported route declines, goes to the TS Worker unchanged.
#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> worker::Result<web_sys::Response> {
    console_error_panic_hook::set_once();
    let url = req.inner().url();
    let (path, search) = http::split_url(&url);
    match req.method() {
        Method::Post if path == "/api/user/token-auth/" => {
            // The TS Worker may still have to answer (2FA, odd hashes): a tee
            // of the request keeps the body so the replay sends the same bytes.
            let replay = req.clone()?;
            let outcome = token_auth::handle(req, &env, &ctx).await;
            finish(&env, outcome, replay.inner()).await
        }
        Method::Get if table_segment(path).is_some() => {
            let segment = table_segment(path).unwrap_or_default();
            let outcome = rows::list(&req, &env, segment, search).await;
            finish(&env, outcome, req.inner()).await
        }
        #[cfg(feature = "spikes")]
        _ if path.starts_with("/__spike/") => spikes::handle(req, env, ctx).await,
        _ => legacy::forward(&env, req.inner(), "route not ported").await,
    }
}
