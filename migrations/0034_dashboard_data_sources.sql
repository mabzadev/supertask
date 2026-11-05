ALTER TABLE "supertask_dashboard_data_source"
  ADD COLUMN "order" TEXT NOT NULL DEFAULT '1';

CREATE INDEX IF NOT EXISTS "supertask_dashboard_data_source_dashboard_order_idx"
  ON "supertask_dashboard_data_source" ("dashboard_id", "order");

CREATE TABLE IF NOT EXISTS "supertask_dashboard_aggregation_series" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "data_source_id" INTEGER NOT NULL
    REFERENCES "supertask_dashboard_data_source" ("id") ON DELETE CASCADE,
  "field_id" INTEGER REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "aggregation_type" TEXT NOT NULL DEFAULT '',
  "order" INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "supertask_dashboard_aggregation_series_source_order_idx"
  ON "supertask_dashboard_aggregation_series" ("data_source_id", "order", "id");

CREATE TABLE IF NOT EXISTS "supertask_dashboard_aggregation_group_by" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "data_source_id" INTEGER NOT NULL
    REFERENCES "supertask_dashboard_data_source" ("id") ON DELETE CASCADE,
  "field_id" INTEGER REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "order" INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "supertask_dashboard_aggregation_group_by_source_order_idx"
  ON "supertask_dashboard_aggregation_group_by" ("data_source_id", "order", "id");

CREATE TABLE IF NOT EXISTS "supertask_dashboard_aggregation_sort" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "data_source_id" INTEGER NOT NULL
    REFERENCES "supertask_dashboard_data_source" ("id") ON DELETE CASCADE,
  "sort_on" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "supertask_dashboard_aggregation_sort_source_order_idx"
  ON "supertask_dashboard_aggregation_sort" ("data_source_id", "order", "id");
