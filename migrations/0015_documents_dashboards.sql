CREATE TABLE IF NOT EXISTS "supertask_document_page" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "document_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "parent_id" INTEGER REFERENCES "supertask_document_page" ("id") ON DELETE SET NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "icon" TEXT NOT NULL DEFAULT '',
  "order" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_document_page_document_idx"
  ON "supertask_document_page" ("document_id", "order");

CREATE TABLE IF NOT EXISTS "supertask_dashboard_widget" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "dashboard_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "order" INTEGER NOT NULL DEFAULT 0,
  "data_source_id" INTEGER,
  "config" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_dashboard_widget_dashboard_idx"
  ON "supertask_dashboard_widget" ("dashboard_id", "order");

CREATE TABLE IF NOT EXISTS "supertask_dashboard_data_source" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "dashboard_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL DEFAULT 'local_supertask_aggregate_rows',
  "name" TEXT NOT NULL DEFAULT '',
  "service" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "supertask_dashboard_data_source_dashboard_idx"
  ON "supertask_dashboard_data_source" ("dashboard_id");
