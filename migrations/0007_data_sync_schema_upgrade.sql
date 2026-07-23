-- Upgrade the pre-existing data sync table from the initial schema.
ALTER TABLE "database_datasync" ADD COLUMN "settings" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "database_datasync" ADD COLUMN "created_on" TEXT;
ALTER TABLE "database_datasync" ADD COLUMN "updated_on" TEXT;

UPDATE "database_datasync"
SET
  "settings" = CASE
    WHEN "settings" IS NULL OR "settings" = '' THEN '{}'
    ELSE "settings"
  END,
  "created_on" = COALESCE("created_on", "last_sync", strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_on" = COALESCE("updated_on", "last_sync", strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
