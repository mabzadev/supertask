ALTER TABLE "builder_domain"
  ADD COLUMN "published_to_id" INTEGER REFERENCES "core_application" ("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "builder_domain_published_to_unique"
  ON "builder_domain" ("published_to_id")
  WHERE "published_to_id" IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS "builder_publication_delete_domain_status"
BEFORE DELETE ON "core_application"
BEGIN
  UPDATE "builder_domain"
  SET "published" = 0, "updated_on" = datetime('now')
  WHERE "published_to_id" = OLD."id";
END;

CREATE TRIGGER IF NOT EXISTS "builder_domain_delete_publication"
AFTER DELETE ON "builder_domain"
WHEN OLD."published_to_id" IS NOT NULL
BEGIN
  DELETE FROM "core_application" WHERE "id" = OLD."published_to_id";
END;
