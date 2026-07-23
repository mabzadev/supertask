-- Premium view settings required by the Baserow frontend registry.
ALTER TABLE "database_view" ADD COLUMN "card_cover_image_field" INTEGER;
ALTER TABLE "database_view" ADD COLUMN "single_select_field" INTEGER;
ALTER TABLE "database_view" ADD COLUMN "date_field" INTEGER;
ALTER TABLE "database_view" ADD COLUMN "ical_public" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "database_view" ADD COLUMN "ical_slug" TEXT;
ALTER TABLE "database_view" ADD COLUMN "start_date_field" INTEGER;
ALTER TABLE "database_view" ADD COLUMN "end_date_field" INTEGER;
ALTER TABLE "database_view" ADD COLUMN "timescale" TEXT NOT NULL DEFAULT 'month';
