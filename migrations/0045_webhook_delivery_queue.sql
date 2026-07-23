CREATE TABLE IF NOT EXISTS "database_tablewebhookdelivery" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "webhook_id" INTEGER NOT NULL REFERENCES "database_tablewebhook" ("id") ON DELETE CASCADE,
  "delivery_key" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" TEXT NOT NULL DEFAULT '{}',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "queued_on" INTEGER NOT NULL,
  "available_at" INTEGER NOT NULL,
  "lease_token" TEXT,
  "lease_expires_at" INTEGER,
  UNIQUE("webhook_id", "delivery_key")
);

CREATE INDEX IF NOT EXISTS "database_tablewebhookdelivery_dispatch_idx"
  ON "database_tablewebhookdelivery" ("webhook_id", "status", "available_at", "queued_on", "id");
