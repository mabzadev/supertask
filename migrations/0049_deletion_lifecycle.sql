-- Track when an account deletion was requested so the configured grace period
-- can be enforced by the scheduled cleanup job.

ALTER TABLE "core_userprofile" ADD COLUMN "deletion_requested_at" TEXT;

-- Older builds only stored the boolean. Start their grace period when this
-- migration is applied instead of deleting those accounts immediately.
UPDATE "core_userprofile"
SET "deletion_requested_at" = datetime('now')
WHERE "to_be_deleted" = 1 AND "deletion_requested_at" IS NULL;
