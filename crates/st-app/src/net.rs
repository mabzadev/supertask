//! Runs the sans-IO requests of `st-api` over `ehttp`.
//!
//! `ehttp` calls back on a background thread on the desktop and from the
//! browser event loop on the web. Either way the callback only decodes the
//! answer into a [`Msg`] and posts it to the app's inbox, then wakes egui up:
//! the app state is only ever touched from the UI pass, with no locks and no
//! async runtime (there is no tokio on the web).

use std::sync::mpsc::{Receiver, Sender, channel};

use serde::de::DeserializeOwned;
use st_api::{ApiRequest, ClientError, Method};

use crate::app::Msg;

/// The HTTP side of the app: where to send requests and where answers go.
pub struct Net {
    base_url: String,
    sender: Sender<Msg>,
    ctx: egui::Context,
}

impl Net {
    pub fn new(ctx: egui::Context, base_url: String) -> (Self, Receiver<Msg>) {
        let (sender, inbox) = channel();
        (
            Self {
                base_url,
                sender,
                ctx,
            },
            inbox,
        )
    }

    pub fn set_base_url(&mut self, base_url: String) {
        self.base_url = base_url;
    }

    /// Detaches every request in flight: their answers are dropped instead of
    /// reaching the new inbox (used on logout, so that a late answer for the
    /// previous user never lands in the new session).
    pub fn reset_inbox(&mut self) -> Receiver<Msg> {
        let (sender, inbox) = channel();
        self.sender = sender;
        inbox
    }

    /// Sends `request`; `on_done` turns its outcome into a message for the app.
    pub fn send<T, F>(&self, request: ApiRequest<T>, token: Option<&str>, on_done: F)
    where
        T: DeserializeOwned + 'static,
        F: FnOnce(Result<T, ClientError>) -> Msg + Send + 'static,
    {
        let mut http = ehttp::Request::get(request.url(&self.base_url));
        http.method = match request.method {
            Method::Get => ehttp::Method::GET,
            Method::Post => ehttp::Method::POST,
            Method::Patch => ehttp::Method::PATCH,
            Method::Delete => ehttp::Method::DELETE,
        };
        http.headers.insert("Accept", "application/json");
        if let Some(body) = request.body_bytes() {
            http.headers.insert("Content-Type", "application/json");
            http.body = body;
        }
        if request.authenticated
            && let Some(token) = token
        {
            http.headers.insert("Authorization", format!("JWT {token}"));
        }
        log::debug!("{} {}", request.method, http.url);

        let sender = self.sender.clone();
        let ctx = self.ctx.clone();
        ehttp::fetch(http, move |outcome| {
            let result = match outcome {
                Ok(response) => request.decode(response.status, &response.bytes),
                Err(error) => Err(ClientError::Network(error)),
            };
            // A closed inbox means the answer belongs to a finished session.
            let _ = sender.send(on_done(result));
            ctx.request_repaint();
        });
    }
}

/// A request scoped to the current access token.
#[derive(Clone, Copy)]
pub struct Api<'a> {
    pub net: &'a Net,
    pub token: &'a str,
}

impl Api<'_> {
    pub fn send<T, F>(&self, request: ApiRequest<T>, on_done: F)
    where
        T: DeserializeOwned + 'static,
        F: FnOnce(Result<T, ClientError>) -> Msg + Send + 'static,
    {
        self.net.send(request, Some(self.token), on_done);
    }
}
