CREATE TABLE IF NOT EXISTS "database_formview_users_to_notify_on_submit" (
  "formview_id" INTEGER NOT NULL REFERENCES "database_formview" ("view_ptr_id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("formview_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "database_formview_notify_user_idx"
  ON "database_formview_users_to_notify_on_submit" ("user_id");
