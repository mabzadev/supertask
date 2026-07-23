ALTER TABLE "core_workspace" ADD COLUMN "trashed" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "core_workspace_trashed_idx"
  ON "core_workspace" ("trashed");
