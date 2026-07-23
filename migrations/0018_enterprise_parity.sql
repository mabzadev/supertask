-- Enterprise parity support for the Cloudflare-native backend.
INSERT OR IGNORE INTO "enterprise_role" (uid, description) VALUES
  ('NO_ACCESS', 'No access'),
  ('NO_ROLE_LOW_PRIORITY', 'No explicit role');

ALTER TABLE "enterprise_fieldpermission" ADD COLUMN "allow_in_forms" INTEGER NOT NULL DEFAULT 1;
