-- Module 3: authentication/session support tables.

CREATE TABLE IF NOT EXISTS "core_emailchange" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "new_email" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "core_emailchange_user_idx"
  ON "core_emailchange" ("user_id");

CREATE TABLE IF NOT EXISTS "core_onboardingdetails" (
  "user_id" INTEGER PRIMARY KEY REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "team" TEXT NOT NULL DEFAULT '',
  "role" TEXT NOT NULL DEFAULT '',
  "size" TEXT NOT NULL DEFAULT '',
  "country" TEXT NOT NULL DEFAULT '',
  "how" TEXT NOT NULL DEFAULT '',
  "created_at" TEXT NOT NULL
);
