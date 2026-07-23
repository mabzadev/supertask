CREATE TABLE IF NOT EXISTS "builder_settings" (
  "builder_id" INTEGER PRIMARY KEY REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "favicon_file" TEXT,
  "login_page_id" INTEGER REFERENCES "builder_page" ("id") ON DELETE SET NULL,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "builder_settings_login_page_idx"
  ON "builder_settings" ("login_page_id");
