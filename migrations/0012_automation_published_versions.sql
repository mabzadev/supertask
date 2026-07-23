ALTER TABLE "automation_workflow" ADD COLUMN "published_from_workflow_id" INTEGER REFERENCES "automation_workflow" ("id") ON DELETE CASCADE;
ALTER TABLE "automation_workflow" ADD COLUMN "is_published_version" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "automation_workflow_published_from_idx"
  ON "automation_workflow" ("published_from_workflow_id", "id");
