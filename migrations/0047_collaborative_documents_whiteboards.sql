ALTER TABLE "supertask_document_page" ADD COLUMN "cover" TEXT NOT NULL DEFAULT '';
ALTER TABLE "supertask_document_page" ADD COLUMN "settings" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "supertask_document_page" ADD COLUMN "editor_schema_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "supertask_document_page" ADD COLUMN "collaboration_initialized" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "supertask_whiteboard_canvas" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "whiteboard_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL DEFAULT '',
  "icon" TEXT NOT NULL DEFAULT '🧠',
  "order" INTEGER NOT NULL DEFAULT 0,
  "state" TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[],"strokes":[]}',
  "settings" TEXT NOT NULL DEFAULT '{}',
  "thumbnail_key" TEXT NOT NULL DEFAULT '',
  "editor_schema_version" INTEGER NOT NULL DEFAULT 1,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_whiteboard_canvas_app_idx"
  ON "supertask_whiteboard_canvas" ("whiteboard_id", "trashed", "order");

CREATE TABLE IF NOT EXISTS "supertask_content_comment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "content_type" TEXT NOT NULL CHECK ("content_type" IN ('document-page', 'whiteboard-canvas')),
  "content_id" INTEGER NOT NULL,
  "parent_id" INTEGER REFERENCES "supertask_content_comment" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "message" TEXT NOT NULL DEFAULT '{}',
  "anchor" TEXT NOT NULL DEFAULT '{}',
  "resolved" INTEGER NOT NULL DEFAULT 0,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_content_comment_content_idx"
  ON "supertask_content_comment" ("content_type", "content_id", "trashed", "created_on");

CREATE TABLE IF NOT EXISTS "supertask_content_comment_mention" (
  "comment_id" INTEGER NOT NULL REFERENCES "supertask_content_comment" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("comment_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "supertask_content_version" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "content_type" TEXT NOT NULL CHECK ("content_type" IN ('document-page', 'whiteboard-canvas')),
  "content_id" INTEGER NOT NULL,
  "name" TEXT,
  "automatic" INTEGER NOT NULL DEFAULT 1,
  "object_key" TEXT NOT NULL,
  "editor_schema_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "created_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_content_version_content_idx"
  ON "supertask_content_version" ("content_type", "content_id", "created_on" DESC);

CREATE INDEX IF NOT EXISTS "supertask_content_version_cleanup_idx"
  ON "supertask_content_version" ("automatic", "created_on");
