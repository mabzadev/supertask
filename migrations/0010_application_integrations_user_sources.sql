CREATE TABLE IF NOT EXISTS "core_integration" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "application_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "order" TEXT NOT NULL DEFAULT '10000',
  "configuration" TEXT NOT NULL DEFAULT '{}',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "core_integration_application_idx" ON "core_integration" ("application_id", "order");

CREATE TABLE IF NOT EXISTS "core_usersource" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "application_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "integration_id" INTEGER REFERENCES "core_integration" ("id") ON DELETE SET NULL,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "uid" TEXT NOT NULL UNIQUE,
  "order" TEXT NOT NULL DEFAULT '10000',
  "configuration" TEXT NOT NULL DEFAULT '{}',
  "auth_providers" TEXT NOT NULL DEFAULT '[]',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "core_usersource_application_idx" ON "core_usersource" ("application_id", "order");
CREATE INDEX IF NOT EXISTS "core_usersource_integration_idx" ON "core_usersource" ("integration_id");
