-- Restrict new Supertask accounts to workspace invitations from authorised
-- account managers and to explicitly allowlisted email addresses or domains.

ALTER TABLE "auth_user" ADD COLUMN "can_create_accounts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "core_settings" ADD COLUMN "account_creation_policy" TEXT NOT NULL DEFAULT 'invitation_allowlist';

CREATE TABLE IF NOT EXISTS "core_account_email_allowlist" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('email', 'domain')),
  "normalized_value" TEXT NOT NULL,
  "created_by_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "created_on" TEXT NOT NULL,
  UNIQUE ("kind", "normalized_value")
);

CREATE INDEX IF NOT EXISTS "core_account_email_allowlist_lookup_idx"
  ON "core_account_email_allowlist" ("kind", "normalized_value");

UPDATE "core_settings"
SET "allow_new_signups" = 0,
    "allow_signups_via_workspace_invitations" = 1,
    "account_creation_policy" = 'invitation_allowlist',
    "updated_at" = datetime('now')
WHERE "id" = 1;
