CREATE TABLE IF NOT EXISTS "core_action" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "user_name" TEXT NOT NULL DEFAULT '',
  "session" TEXT NOT NULL DEFAULT '',
  "action_group" TEXT,
  "action_scope" TEXT,
  "action_timestamp" TEXT NOT NULL,
  "action_type" TEXT NOT NULL,
  "action_command_type" TEXT NOT NULL DEFAULT 'DO',
  "undone_at" TEXT,
  "error" TEXT,
  "params" TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS "core_action_user_session_undo_idx"
  ON "core_action" ("user_id", "session", "undone_at", "action_timestamp", "id");
CREATE INDEX IF NOT EXISTS "core_action_scope_idx"
  ON "core_action" ("action_scope", "action_group");
