CREATE TABLE IF NOT EXISTS "database_datasyncselectoptionmapping" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "data_sync_id" INTEGER NOT NULL REFERENCES "database_datasync" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "source_option_id" TEXT NOT NULL,
  "destination_option_id" INTEGER NOT NULL REFERENCES "database_selectoption" ("id") ON DELETE CASCADE,
  UNIQUE("field_id", "source_option_id")
);

CREATE INDEX IF NOT EXISTS "database_datasyncselectoptionmapping_sync_idx"
  ON "database_datasyncselectoptionmapping" ("data_sync_id", "field_id");
