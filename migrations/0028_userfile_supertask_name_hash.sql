-- Add Supertask-compatible immutable file identity metadata.
ALTER TABLE "core_userfile" ADD COLUMN "original_extension" TEXT;
ALTER TABLE "core_userfile" ADD COLUMN "sha256_hash" TEXT;
ALTER TABLE "core_userfile" ADD COLUMN "deleted_at" TEXT;

CREATE INDEX IF NOT EXISTS "core_userfile_hash_original_idx"
  ON "core_userfile" ("original_name", "sha256_hash");
