-- Baserow Enterprise periodic data sync stores a time-of-day.
ALTER TABLE "database_datasync" ADD COLUMN "periodic_when" TEXT;
