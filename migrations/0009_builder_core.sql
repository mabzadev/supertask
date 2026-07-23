CREATE TABLE IF NOT EXISTS "builder_page" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "builder_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "path" TEXT NOT NULL DEFAULT '/',
  "path_params" TEXT NOT NULL DEFAULT '[]',
  "query_params" TEXT NOT NULL DEFAULT '[]',
  "shared" INTEGER NOT NULL DEFAULT 0,
  "visibility" TEXT NOT NULL DEFAULT 'all',
  "role_type" TEXT NOT NULL DEFAULT 'allow_all',
  "roles" TEXT NOT NULL DEFAULT '[]',
  "settings" TEXT NOT NULL DEFAULT '{}',
  "order" INTEGER NOT NULL DEFAULT 1,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "builder_page_builder_idx" ON "builder_page" ("builder_id", "order");
CREATE UNIQUE INDEX IF NOT EXISTS "builder_page_shared_unique" ON "builder_page" ("builder_id") WHERE "shared" = 1;

CREATE TABLE IF NOT EXISTS "builder_theme" (
  "builder_id" INTEGER PRIMARY KEY REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "theme" TEXT NOT NULL DEFAULT '{}',
  "updated_on" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "builder_element" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "page_id" INTEGER NOT NULL REFERENCES "builder_page" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "order" TEXT NOT NULL DEFAULT '10000',
  "parent_element_id" INTEGER REFERENCES "builder_element" ("id") ON DELETE CASCADE,
  "place_in_container" TEXT,
  "configuration" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "builder_element_page_idx" ON "builder_element" ("page_id", "order");
CREATE INDEX IF NOT EXISTS "builder_element_parent_idx" ON "builder_element" ("parent_element_id");

CREATE TABLE IF NOT EXISTS "builder_datasource" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "page_id" INTEGER NOT NULL REFERENCES "builder_page" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "order" TEXT NOT NULL DEFAULT '10000',
  "configuration" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "builder_datasource_page_idx" ON "builder_datasource" ("page_id", "order");

CREATE TABLE IF NOT EXISTS "builder_domain" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "builder_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL DEFAULT 'custom',
  "domain_name" TEXT NOT NULL,
  "published" INTEGER NOT NULL DEFAULT 0,
  "last_published" TEXT,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "builder_domain_name_unique" ON "builder_domain" ("domain_name");
CREATE INDEX IF NOT EXISTS "builder_domain_builder_idx" ON "builder_domain" ("builder_id");

CREATE TABLE IF NOT EXISTS "builder_workflowaction" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "page_id" INTEGER NOT NULL REFERENCES "builder_page" ("id") ON DELETE CASCADE,
  "element_id" INTEGER REFERENCES "builder_element" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "order" TEXT NOT NULL DEFAULT '10000',
  "configuration" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "builder_workflowaction_page_idx" ON "builder_workflowaction" ("page_id", "element_id", "order");
