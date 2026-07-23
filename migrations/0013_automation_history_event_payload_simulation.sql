ALTER TABLE "automation_workflow_history" ADD COLUMN "event_payload" TEXT;
ALTER TABLE "automation_workflow_history" ADD COLUMN "simulate_until_node_id" INTEGER;
CREATE INDEX IF NOT EXISTS "automation_workflow_history_simulation_idx"
  ON "automation_workflow_history" ("workflow_id", "simulate_until_node_id", "started_on");
