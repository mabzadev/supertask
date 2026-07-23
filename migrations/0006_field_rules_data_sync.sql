-- Field rules and native Cloudflare data sync metadata.
ALTER TABLE "database_table" ADD COLUMN "field_rules_validity_column_added" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "database_table" ADD COLUMN "data_sync_id" INTEGER;

CREATE TABLE IF NOT EXISTS "database_fieldrule" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "is_active" INTEGER NOT NULL DEFAULT 1,
  "is_valid" INTEGER NOT NULL DEFAULT 1,
  "error_text" TEXT,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "database_fieldrule_table_idx" ON "database_fieldrule" ("table_id");
CREATE UNIQUE INDEX IF NOT EXISTS "database_fieldrule_date_dependency_unique"
  ON "database_fieldrule" ("table_id", "type") WHERE "type" = 'date_dependency';

CREATE TABLE IF NOT EXISTS "database_datasync" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL UNIQUE REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "last_sync" TEXT,
  "last_error" TEXT,
  "auto_add_new_properties" INTEGER NOT NULL DEFAULT 0,
  "two_way_sync" INTEGER NOT NULL DEFAULT 0,
  "authorized" INTEGER NOT NULL DEFAULT 1,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "database_datasync_type_idx" ON "database_datasync" ("type");

CREATE TABLE IF NOT EXISTS "database_datasyncsyncedproperty" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "data_sync_id" INTEGER NOT NULL REFERENCES "database_datasync" ("id") ON DELETE CASCADE,
  "field_id" INTEGER REFERENCES "database_field" ("id") ON DELETE SET NULL,
  "key" TEXT NOT NULL,
  "unique_primary" INTEGER NOT NULL DEFAULT 0,
  UNIQUE("data_sync_id", "key")
);
