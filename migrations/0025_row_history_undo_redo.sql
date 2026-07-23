ALTER TABLE "database_rowhistory" ADD COLUMN "action_command_type" TEXT NOT NULL DEFAULT 'DO';
ALTER TABLE "database_rowhistory" ADD COLUMN "undone_at" TEXT;
ALTER TABLE "database_rowhistory" ADD COLUMN "session" TEXT NOT NULL DEFAULT '';
ALTER TABLE "database_rowhistory" ADD COLUMN "action_group" TEXT;
ALTER TABLE "database_rowhistory" ADD COLUMN "action_scope" TEXT;
ALTER TABLE "database_rowhistory" ADD COLUMN "error" TEXT;
ALTER TABLE "database_rowhistory" ADD COLUMN "metadata" TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "database_rowhistory_user_session_undo_idx"
  ON "database_rowhistory" ("user_id", "session", "undone_at", "action_timestamp", "id");
CREATE INDEX IF NOT EXISTS "database_rowhistory_scope_idx"
  ON "database_rowhistory" ("action_scope", "action_group");
