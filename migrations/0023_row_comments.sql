-- ── Premium: row comments and row comment notifications ─────────────────────
CREATE TABLE IF NOT EXISTS "database_rowcomment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "row_id" INTEGER NOT NULL,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "message" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  "trashed" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "database_rowcomment_table_row_created_idx"
  ON "database_rowcomment" ("table_id", "row_id", "created_on");

CREATE TABLE IF NOT EXISTS "database_rowcommentmention" (
  "row_comment_id" INTEGER NOT NULL REFERENCES "database_rowcomment" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("row_comment_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "database_rowcommentmention_user_idx"
  ON "database_rowcommentmention" ("user_id");

CREATE TABLE IF NOT EXISTS "database_rowcommentsnotificationmode" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "row_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "mode" TEXT NOT NULL DEFAULT 'mentions',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  UNIQUE("table_id", "row_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "database_rowcommentsnotificationmode_row_idx"
  ON "database_rowcommentsnotificationmode" ("table_id", "row_id");
