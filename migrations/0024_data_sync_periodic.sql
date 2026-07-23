-- Native periodic data sync scheduling and failure tracking.
ALTER TABLE "database_datasync" ADD COLUMN "periodic_interval" TEXT;
ALTER TABLE "database_datasync" ADD COLUMN "periodic_interval_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "database_datasync" ADD COLUMN "last_periodic_sync" TEXT;
ALTER TABLE "database_datasync" ADD COLUMN "next_periodic_sync" TEXT;
ALTER TABLE "database_datasync" ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "database_datasync" ADD COLUMN "deactivated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "database_datasync" ADD COLUMN "deactivation_reason" TEXT;

CREATE INDEX IF NOT EXISTS "database_datasync_periodic_due_idx"
  ON "database_datasync" ("authorized", "deactivated", "next_periodic_sync");
