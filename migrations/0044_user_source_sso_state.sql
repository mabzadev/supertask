CREATE TABLE IF NOT EXISTS core_user_source_sso_state (
  state TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('saml', 'oidc')),
  payload TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  created_on TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS core_user_source_sso_state_expires_on_idx
  ON core_user_source_sso_state(expires_on);
