CREATE TABLE IF NOT EXISTS "enterprise_assistantchat" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" TEXT NOT NULL UNIQUE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'idle',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "enterprise_assistantchat_user_workspace_updated_idx"
  ON "enterprise_assistantchat" ("user_id", "workspace_id", "updated_on");

CREATE TABLE IF NOT EXISTS "enterprise_assistantchatmessage" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "chat_id" INTEGER NOT NULL REFERENCES "enterprise_assistantchat" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "artifacts" TEXT NOT NULL DEFAULT '{}',
  "action_group_id" TEXT,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "enterprise_assistantchatmessage_chat_created_idx"
  ON "enterprise_assistantchatmessage" ("chat_id", "created_on");

CREATE TABLE IF NOT EXISTS "enterprise_assistantchatprediction" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "human_message_id" INTEGER NOT NULL UNIQUE REFERENCES "enterprise_assistantchatmessage" ("id") ON DELETE CASCADE,
  "ai_response_id" INTEGER NOT NULL UNIQUE REFERENCES "enterprise_assistantchatmessage" ("id") ON DELETE CASCADE,
  "prediction" TEXT NOT NULL DEFAULT '{}',
  "human_sentiment" INTEGER,
  "human_feedback" TEXT NOT NULL DEFAULT '',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
