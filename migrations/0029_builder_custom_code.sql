CREATE TABLE IF NOT EXISTS "builder_custom_code" (
  "builder_id" INTEGER PRIMARY KEY REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "css" TEXT NOT NULL DEFAULT '',
  "js" TEXT NOT NULL DEFAULT '',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "builder_custom_script" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "builder_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "order" INTEGER NOT NULL DEFAULT 0,
  "type" TEXT NOT NULL DEFAULT 'javascript',
  "url" TEXT NOT NULL DEFAULT '',
  "load_type" TEXT NOT NULL DEFAULT '',
  "crossorigin" TEXT NOT NULL DEFAULT '',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "builder_custom_script_builder_idx"
  ON "builder_custom_script" ("builder_id", "order", "id");
