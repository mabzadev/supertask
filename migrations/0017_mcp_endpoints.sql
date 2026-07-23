CREATE TABLE IF NOT EXISTS "core_mcpendpoint" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "key" TEXT NOT NULL UNIQUE,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "core_mcpendpoint_user_idx" ON "core_mcpendpoint" ("user_id");
CREATE INDEX IF NOT EXISTS "core_mcpendpoint_workspace_idx" ON "core_mcpendpoint" ("workspace_id");
CREATE INDEX IF NOT EXISTS "core_mcpendpoint_key_idx" ON "core_mcpendpoint" ("key");
