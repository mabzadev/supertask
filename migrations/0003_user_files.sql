-- User files persisted in D1 with object bytes stored in R2.
CREATE TABLE IF NOT EXISTS "core_userfile" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL UNIQUE,
  "original_name" TEXT NOT NULL,
  "r2_key" TEXT NOT NULL UNIQUE,
  "size" INTEGER NOT NULL DEFAULT 0,
  "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "is_image" INTEGER NOT NULL DEFAULT 0,
  "image_width" INTEGER,
  "image_height" INTEGER,
  "uploaded_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "core_userfile_user_idx" ON "core_userfile" ("user_id");
