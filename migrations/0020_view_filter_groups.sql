-- Preserve Supertask filter group membership for nested view filter trees.
ALTER TABLE "database_viewfilter" ADD COLUMN "group_id" INTEGER REFERENCES "database_viewfiltergroup" ("id") ON DELETE CASCADE;
