CREATE TABLE IF NOT EXISTS "database_formviewfieldoptions_allowedselectoptions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "form_view_field_options_id" INTEGER NOT NULL REFERENCES "database_formviewfieldoptions" ("id") ON DELETE CASCADE,
  "select_option_id" INTEGER NOT NULL REFERENCES "database_selectoption" ("id") ON DELETE CASCADE,
  UNIQUE("form_view_field_options_id", "select_option_id")
);

CREATE TABLE IF NOT EXISTS "database_formviewfieldoptionsconditiongroup" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "field_option_id" INTEGER NOT NULL REFERENCES "database_formviewfieldoptions" ("id") ON DELETE CASCADE,
  "filter_type" TEXT NOT NULL DEFAULT 'AND',
  "parent_group_id" INTEGER REFERENCES "database_formviewfieldoptionsconditiongroup" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "database_formviewfieldoptionscondition" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "field_option_id" INTEGER NOT NULL REFERENCES "database_formviewfieldoptions" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL DEFAULT '',
  "group_id" INTEGER REFERENCES "database_formviewfieldoptionsconditiongroup" ("id") ON DELETE CASCADE
);
