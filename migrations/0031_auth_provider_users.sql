-- Persist the Supertask AuthProvider.users many-to-many relation used to reject
-- SSO sign-ins through a different original provider.
CREATE TABLE IF NOT EXISTS "core_authprovideruser" (
  "auth_provider_id" INTEGER NOT NULL REFERENCES "core_authprovider" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "created_on" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("auth_provider_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "core_authprovideruser_user_idx"
  ON "core_authprovideruser" ("user_id");
