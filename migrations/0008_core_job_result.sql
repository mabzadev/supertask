-- Persist completed job payloads returned by async endpoints.
ALTER TABLE "core_job" ADD COLUMN "result" TEXT;
