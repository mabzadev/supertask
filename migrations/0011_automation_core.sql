CREATE TABLE IF NOT EXISTS "automation_workflow" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "automation_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "order" REAL NOT NULL DEFAULT 1,
  "state" TEXT NOT NULL DEFAULT 'draft',
  "allow_test_run_until" TEXT,
  "simulate_until_node_id" INTEGER,
  "published_on" TEXT,
  "graph" TEXT NOT NULL DEFAULT '{}',
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  UNIQUE("automation_id", "name")
);
CREATE INDEX IF NOT EXISTS "automation_workflow_automation_idx" ON "automation_workflow" ("automation_id", "order");
CREATE INDEX IF NOT EXISTS "automation_workflow_state_idx" ON "automation_workflow" ("state");

CREATE TABLE IF NOT EXISTS "automation_node" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workflow_id" INTEGER NOT NULL REFERENCES "automation_workflow" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "service" TEXT NOT NULL DEFAULT '{}',
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "automation_node_workflow_idx" ON "automation_node" ("workflow_id", "id");
CREATE INDEX IF NOT EXISTS "automation_node_type_idx" ON "automation_node" ("type");

CREATE TABLE IF NOT EXISTS "automation_workflow_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workflow_id" INTEGER NOT NULL REFERENCES "automation_workflow" ("id") ON DELETE CASCADE,
  "started_on" TEXT NOT NULL,
  "completed_on" TEXT,
  "is_test_run" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'started'
);
CREATE INDEX IF NOT EXISTS "automation_workflow_history_workflow_idx" ON "automation_workflow_history" ("workflow_id", "started_on");

CREATE TABLE IF NOT EXISTS "automation_node_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workflow_history_id" INTEGER NOT NULL REFERENCES "automation_workflow_history" ("id") ON DELETE CASCADE,
  "node_id" INTEGER NOT NULL REFERENCES "automation_node" ("id") ON DELETE CASCADE,
  "started_on" TEXT NOT NULL,
  "completed_on" TEXT,
  "status" TEXT NOT NULL DEFAULT 'started',
  "message" TEXT NOT NULL DEFAULT '',
  "input" TEXT NOT NULL DEFAULT '{}',
  "output" TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "automation_node_history_workflow_history_idx" ON "automation_node_history" ("workflow_history_id", "node_id");
