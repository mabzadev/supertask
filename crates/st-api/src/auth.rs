//! Login, token refresh and the signed-in user.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// The body of `POST /api/user/token-auth/`.
#[derive(Clone, Debug, Serialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// The body of `POST /api/user/token-refresh/` and `/token-blacklist/`.
#[derive(Clone, Debug, Serialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// The answer of a login or a refresh: fresh tokens and the user.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthResponse {
    /// Short-lived JWT (10 minutes by default) sent as `Authorization: JWT …`.
    pub access_token: String,
    /// Long-lived JWT (7 days by default) that buys new access tokens.
    pub refresh_token: String,
    #[serde(default)]
    pub user_session: Option<String>,
    pub user: User,
}

/// What a login can answer: a session, or a second-factor challenge when the
/// account has two-factor authentication.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum LoginResponse {
    Session(Box<AuthResponse>),
    TwoFactor {
        /// The second factor asked for, `totp` today.
        two_factor_auth: String,
        token: String,
    },
}

/// The signed-in user, as serialized by the Worker's `serializeUser`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct User {
    pub id: u64,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub is_staff: bool,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub profile_image_url: Option<String>,
}

impl User {
    /// The name to show, falling back to the e-mail address.
    pub fn display_name(&self) -> &str {
        [&self.name, &self.email, &self.username]
            .into_iter()
            .find(|candidate| !candidate.is_empty())
            .map_or("", String::as_str)
    }
}

/// The claims of a Supertask JWT that a client needs.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TokenClaims {
    pub user_id: u64,
    #[serde(default)]
    pub token_type: String,
    /// Issued at, in seconds since the Unix epoch.
    pub iat: u64,
    /// Expiry, in seconds since the Unix epoch.
    pub exp: u64,
}

/// Reads the claims of a JWT without checking its signature.
///
/// The client cannot check the signature (the key is the server's secret) and
/// does not need to: it only reads the expiry to refresh the access token in
/// time, and the server still rejects any forged token.
pub fn read_claims(token: &str) -> Option<TokenClaims> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_AUTH: &str = include_str!("../tests/data/token-auth.json");

    #[test]
    fn reads_the_captured_login_answer() {
        let response: LoginResponse = serde_json::from_str(TOKEN_AUTH).unwrap();
        let LoginResponse::Session(session) = response else {
            panic!("expected a session")
        };
        assert_eq!(session.user.display_name(), "Alice Martin");
        assert_eq!(session.user.email, "alice@example.com");
        assert_eq!(session.user.language.as_deref(), Some("fr"));
    }

    #[test]
    fn reads_token_expiry() {
        let response: AuthResponse = serde_json::from_str(TOKEN_AUTH).unwrap();
        let access = read_claims(&response.access_token).unwrap();
        assert_eq!(access.token_type, "access");
        assert_eq!(access.user_id, 2);
        assert_eq!(access.exp - access.iat, 600);
        let refresh = read_claims(&response.refresh_token).unwrap();
        assert_eq!(refresh.token_type, "refresh");
        assert_eq!(refresh.exp - refresh.iat, 7 * 24 * 3600);
    }

    #[test]
    fn reads_a_two_factor_challenge() {
        let response: LoginResponse =
            serde_json::from_str(r#"{"two_factor_auth":"totp","token":"abc"}"#).unwrap();
        assert!(
            matches!(response, LoginResponse::TwoFactor { two_factor_auth, .. } if two_factor_auth == "totp")
        );
    }

    #[test]
    fn rejects_malformed_tokens() {
        assert_eq!(read_claims("not-a-jwt"), None);
        assert_eq!(read_claims("a.!!!.c"), None);
    }

    #[test]
    fn display_name_falls_back_to_email() {
        let user: User = serde_json::from_str(r#"{"id":1,"email":"x@example.com"}"#).unwrap();
        assert_eq!(user.display_name(), "x@example.com");
    }
}
