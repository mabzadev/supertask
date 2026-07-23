-- Module 10: Baserow application templates metadata and preview workspaces.

CREATE TABLE IF NOT EXISTS "core_templatecategory" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS "core_template" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "icon" TEXT NOT NULL,
  "keywords" TEXT NOT NULL DEFAULT '',
  "workspace_id" INTEGER REFERENCES "core_workspace" ("id") ON DELETE SET NULL,
  "open_application" INTEGER REFERENCES "core_application" ("id") ON DELETE SET NULL,
  "export_hash" TEXT NOT NULL DEFAULT '',
  "synced_at" TEXT
);

CREATE TABLE IF NOT EXISTS "core_template_categories" (
  "template_id" INTEGER NOT NULL REFERENCES "core_template" ("id") ON DELETE CASCADE,
  "category_id" INTEGER NOT NULL REFERENCES "core_templatecategory" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("template_id", "category_id")
);

CREATE TABLE IF NOT EXISTS "core_applicationtemplatedata" (
  "application_id" INTEGER PRIMARY KEY REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "data" TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS "core_template_workspace_idx" ON "core_template" ("workspace_id");
