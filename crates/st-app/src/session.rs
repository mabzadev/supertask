//! The signed-in session and what the app remembers between launches.

use serde::{Deserialize, Serialize};
use st_api::{AuthResponse, User, read_claims};

/// Refresh the access token this long before it expires, so that a request
/// sent just before the expiry still carries a valid token.
const REFRESH_MARGIN_SECS: u64 = 90;

/// Seconds since the Unix epoch, on the web as on the desktop.
pub fn unix_now() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

/// Tokens and user of a signed-in session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub user: User,
}

impl Session {
    pub fn from_auth(auth: AuthResponse) -> Self {
        Self {
            access_token: auth.access_token,
            refresh_token: auth.refresh_token,
            user: auth.user,
        }
    }

    /// Takes the new tokens of a refresh, keeping the refresh token when the
    /// server does not rotate it.
    pub fn apply_refresh(&mut self, auth: AuthResponse) {
        self.access_token = auth.access_token;
        if !auth.refresh_token.is_empty() {
            self.refresh_token = auth.refresh_token;
        }
        self.user = auth.user;
    }

    /// When the access token should be refreshed (Unix seconds); now when its
    /// expiry cannot be read.
    pub fn refresh_due_at(&self) -> u64 {
        read_claims(&self.access_token)
            .map_or(0, |claims| claims.exp.saturating_sub(REFRESH_MARGIN_SECS))
    }

    /// Whether the refresh token can still buy access tokens.
    pub fn can_refresh(&self, now: u64) -> bool {
        read_claims(&self.refresh_token).is_some_and(|claims| claims.exp > now + 30)
    }
}

/// Everything persisted with eframe storage (local storage on the web, a file
/// in the user's data directory on the desktop).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Persisted {
    pub session: Option<Session>,
    /// The API origin the user picked on the login screen.
    pub api_base: Option<String>,
    pub last_email: String,
    /// The table to reopen at the next launch.
    pub selected_table: Option<u64>,
}

/// The eframe storage key of [`Persisted`].
pub const STORAGE_KEY: &str = "supertask";

/// The API origin when the user has not picked one: the page's own origin on
/// the web (Trunk or the Worker proxies `/api/`), the local API on the desktop.
pub fn default_api_base() -> String {
    if cfg!(target_arch = "wasm32") {
        String::new()
    } else {
        "http://127.0.0.1:8811".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(exp: u64) -> String {
        use base64::Engine as _;
        let payload = format!(
            r#"{{"user_id":2,"token_type":"access","iat":{},"exp":{exp}}}"#,
            exp - 600
        );
        format!(
            "e30.{}.sig",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
        )
    }

    fn session(access_exp: u64, refresh_exp: u64) -> Session {
        let user = serde_json::from_str(r#"{"id":2,"name":"Alice"}"#).unwrap();
        Session {
            access_token: token(access_exp),
            refresh_token: token(refresh_exp),
            user,
        }
    }

    #[test]
    fn refresh_is_due_before_expiry() {
        let session = session(10_000, 1_000_000);
        assert_eq!(session.refresh_due_at(), 10_000 - REFRESH_MARGIN_SECS);
        assert!(session.can_refresh(10_000));
        assert!(!session.can_refresh(1_000_000));
    }

    #[test]
    fn unreadable_token_is_refreshed_now() {
        let mut session = session(10_000, 1_000_000);
        session.access_token = "garbage".into();
        assert_eq!(session.refresh_due_at(), 0);
    }
}
