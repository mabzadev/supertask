ALTER TABLE "database_datasync" ADD COLUMN "two_way_sync_consecutive_failures" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "database_datasync_two_way_idx"
  ON "database_datasync" ("table_id", "type", "two_way_sync", "authorized", "deactivated");
