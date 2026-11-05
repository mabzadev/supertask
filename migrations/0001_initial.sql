-- ============================================================
-- Supertask D1 Schema — Baserow 2.1.4 port to SQLite/D1
-- Generated from Django migrations (204 database migrations)
-- ============================================================

-- ── Django auth ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "auth_user" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "password" TEXT NOT NULL,
  "last_login" TEXT,
  "is_superuser" INTEGER NOT NULL DEFAULT 0,
  "username" TEXT NOT NULL UNIQUE,
  "first_name" TEXT NOT NULL DEFAULT '',
  "last_name" TEXT NOT NULL DEFAULT '',
  "email" TEXT NOT NULL UNIQUE,
  "is_staff" INTEGER NOT NULL DEFAULT 0,
  "is_active" INTEGER NOT NULL DEFAULT 1,
  "date_joined" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "auth_user_email_idx" ON "auth_user" ("email");

-- ── User profile ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_userprofile" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL UNIQUE REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "language" TEXT NOT NULL DEFAULT 'en',
  "timezone" TEXT,
  "email_notification_frequency" TEXT NOT NULL DEFAULT 'instant',
  "completed_onboarding" INTEGER NOT NULL DEFAULT 0,
  "to_be_deleted" INTEGER NOT NULL DEFAULT 0,
  "profile_image_url" TEXT,
  "email_verified" INTEGER NOT NULL DEFAULT 0,
  "user_session_expiry_seconds" INTEGER NOT NULL DEFAULT 604800
);

-- ── Password reset & email verification ──────────────────────
CREATE TABLE IF NOT EXISTS "core_passwordreset" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "core_emailverification" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);

-- ── Workspaces ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_workspace" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "created_on" TEXT NOT NULL,
  "storage_usage" INTEGER NOT NULL DEFAULT 0,
  "seats_taken" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "core_workspaceuser" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "order" REAL NOT NULL DEFAULT 1,
  "permissions" TEXT NOT NULL DEFAULT 'MEMBER',
  "to_be_deleted" INTEGER NOT NULL DEFAULT 0,
  UNIQUE("workspace_id","user_id")
);
CREATE INDEX IF NOT EXISTS "core_workspaceuser_user_idx" ON "core_workspaceuser" ("user_id");

CREATE TABLE IF NOT EXISTS "core_workspaceinvitation" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "invited_by_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "permissions" TEXT NOT NULL DEFAULT 'MEMBER',
  "message" TEXT NOT NULL DEFAULT '',
  "token" TEXT NOT NULL UNIQUE,
  "created_on" TEXT NOT NULL
);

-- ── Applications ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_application" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'database',
  "order" REAL NOT NULL DEFAULT 1,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "core_application_workspace_idx" ON "core_application" ("workspace_id");

-- ── Database tables ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_table" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "database_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "order" REAL NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  "needs_background_update_column_added" INTEGER NOT NULL DEFAULT 0,
  "last_modified_by_column_added" INTEGER NOT NULL DEFAULT 0,
  "created_by_column_added" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "database_table_database_idx" ON "database_table" ("database_id");

-- ── Fields ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_field" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "order" REAL NOT NULL DEFAULT 1,
  "primary" INTEGER NOT NULL DEFAULT 0,
  "read_only" INTEGER NOT NULL DEFAULT 0,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT,
  "db_index" INTEGER NOT NULL DEFAULT 0,
  "immutable_type" INTEGER NOT NULL DEFAULT 0,
  "immutable_properties" INTEGER NOT NULL DEFAULT 0,
  "field_settings" TEXT,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "database_field_table_idx" ON "database_field" ("table_id");

-- ── Field dependencies ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_fielddependency" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "dependant_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "via_id" INTEGER REFERENCES "database_field" ("id") ON DELETE SET NULL,
  "dependency_id" INTEGER REFERENCES "database_field" ("id") ON DELETE SET NULL,
  "broken_reference_field_name" TEXT
);

-- ── Select options ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_selectoption" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "value" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT 'blue',
  "order" REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS "database_selectoption_field_idx" ON "database_selectoption" ("field_id");

-- ── Views ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_view" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'grid',
  "order" REAL NOT NULL DEFAULT 1,
  "filter_type" TEXT NOT NULL DEFAULT 'AND',
  "filters_disabled" INTEGER NOT NULL DEFAULT 0,
  "public" INTEGER NOT NULL DEFAULT 0,
  "slug" TEXT UNIQUE,
  "public_view_password" TEXT,
  "trashed" INTEGER NOT NULL DEFAULT 0,
  "show_logo" INTEGER NOT NULL DEFAULT 1,
  "allow_public_export" INTEGER NOT NULL DEFAULT 0,
  "ownership_type" TEXT NOT NULL DEFAULT 'collaborative',
  "owned_by_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "row_height_size" TEXT NOT NULL DEFAULT 'small',
  "row_identifier_type" TEXT NOT NULL DEFAULT 'count',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "database_view_table_idx" ON "database_view" ("table_id");
CREATE INDEX IF NOT EXISTS "database_view_slug_idx" ON "database_view" ("slug");

-- ── View filters ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_viewfilter" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL DEFAULT '',
  "preload_values" TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS "database_viewfiltergroup" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "parent_group_id" INTEGER REFERENCES "database_viewfiltergroup" ("id") ON DELETE CASCADE,
  "filter_type" TEXT NOT NULL DEFAULT 'AND'
);

-- ── View sorts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_viewsort" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "order" TEXT NOT NULL DEFAULT 'ASC',
  "type" TEXT NOT NULL DEFAULT 'default'
);

-- ── View groupings ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_viewgroupby" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "order" TEXT NOT NULL DEFAULT 'ASC',
  "width" INTEGER NOT NULL DEFAULT 200,
  "type" TEXT NOT NULL DEFAULT 'default'
);

-- ── Grid view field options ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_gridviewfieldoptions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "grid_view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "width" INTEGER NOT NULL DEFAULT 200,
  "hidden" INTEGER NOT NULL DEFAULT 0,
  "order" REAL NOT NULL DEFAULT 32767,
  "aggregation_type" TEXT NOT NULL DEFAULT '',
  "aggregation_raw_type" TEXT NOT NULL DEFAULT '',
  UNIQUE("grid_view_id","field_id")
);

-- ── Gallery view field options ────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_galleryviewfieldoptions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "gallery_view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "hidden" INTEGER NOT NULL DEFAULT 1,
  "order" REAL NOT NULL DEFAULT 32767,
  UNIQUE("gallery_view_id","field_id")
);

-- ── Form view ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_formview" (
  "view_ptr_id" INTEGER PRIMARY KEY REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "submit_text" TEXT NOT NULL DEFAULT 'Submit',
  "submit_action" TEXT NOT NULL DEFAULT 'MESSAGE',
  "submit_action_message" TEXT NOT NULL DEFAULT '',
  "submit_action_redirect_url" TEXT NOT NULL DEFAULT '',
  "mode" TEXT NOT NULL DEFAULT 'form',
  "show_logo" INTEGER NOT NULL DEFAULT 1,
  "cover_image" TEXT,
  "logo_image" TEXT
);

CREATE TABLE IF NOT EXISTS "database_formviewfieldoptions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "form_view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "enabled" INTEGER NOT NULL DEFAULT 0,
  "required" INTEGER NOT NULL DEFAULT 0,
  "order" REAL NOT NULL DEFAULT 32767,
  "show_when_matching_conditions" INTEGER NOT NULL DEFAULT 0,
  "condition_type" TEXT NOT NULL DEFAULT 'AND',
  "include_all_select_options" INTEGER NOT NULL DEFAULT 1,
  "field_component" TEXT NOT NULL DEFAULT 'default',
  UNIQUE("form_view_id","field_id")
);

-- ── View decorations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_viewdecoration" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "value_provider_type" TEXT NOT NULL DEFAULT '',
  "value_provider_conf" TEXT NOT NULL DEFAULT '{}',
  "order" REAL NOT NULL DEFAULT 1
);

-- ── View subscriptions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_viewsubscription" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "view_id" INTEGER NOT NULL REFERENCES "database_view" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  UNIQUE("view_id","user_id")
);

-- ── Webhooks ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_tablewebhook" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "active" INTEGER NOT NULL DEFAULT 1,
  "url" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "request_method" TEXT NOT NULL DEFAULT 'POST',
  "include_all_events" INTEGER NOT NULL DEFAULT 1,
  "headers" TEXT NOT NULL DEFAULT '{}',
  "use_user_field_names" INTEGER NOT NULL DEFAULT 1,
  "consecutive_trigger_failures" INTEGER NOT NULL DEFAULT 0,
  "failed_trigger" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "database_tablewebhookevent" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "webhook_id" INTEGER NOT NULL REFERENCES "database_tablewebhook" ("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "database_tablewebhookcall" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "webhook_id" INTEGER NOT NULL REFERENCES "database_tablewebhook" ("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "called_time" TEXT NOT NULL,
  "duration" REAL,
  "called_url" TEXT NOT NULL,
  "request_headers" TEXT NOT NULL DEFAULT '{}',
  "request_body" TEXT NOT NULL DEFAULT '{}',
  "response_status" INTEGER,
  "response_headers" TEXT NOT NULL DEFAULT '{}',
  "response_body" TEXT NOT NULL DEFAULT '',
  "success" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT NOT NULL DEFAULT '',
  "batch_id" TEXT
);

-- ── API Tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_token" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "key" TEXT NOT NULL UNIQUE,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_on" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "database_tokenpermission" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "token_id" INTEGER NOT NULL REFERENCES "database_token" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "table_id" INTEGER REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "database_id" INTEGER REFERENCES "core_application" ("id") ON DELETE CASCADE
);

-- ── Jobs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_job" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT NOT NULL DEFAULT '',
  "progress_percentage" INTEGER NOT NULL DEFAULT 0,
  "human_readable_error" TEXT NOT NULL DEFAULT '',
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  "expires_at" TEXT
);
CREATE INDEX IF NOT EXISTS "core_job_user_idx" ON "core_job" ("user_id");

-- Export jobs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_exportjob" (
  "job_ptr_id" INTEGER PRIMARY KEY REFERENCES "core_job" ("id") ON DELETE CASCADE,
  "table_id" INTEGER REFERENCES "database_table" ("id") ON DELETE SET NULL,
  "view_id" INTEGER REFERENCES "database_view" ("id") ON DELETE SET NULL,
  "exporter_type" TEXT NOT NULL DEFAULT 'csv',
  "export_options" TEXT NOT NULL DEFAULT '{}',
  "exported_file_name" TEXT NOT NULL DEFAULT '',
  "expires_at" TEXT
);

-- ── Trash ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_trasheditem" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "trash_item_type" TEXT NOT NULL,
  "trash_item_id" INTEGER NOT NULL,
  "parent_trash_item_id" INTEGER,
  "trashed_at" TEXT NOT NULL,
  "should_be_permanently_deleted" INTEGER NOT NULL DEFAULT 0,
  "extra_description" TEXT,
  "application_id" INTEGER REFERENCES "core_application" ("id") ON DELETE SET NULL,
  "workspace_id" INTEGER REFERENCES "core_workspace" ("id") ON DELETE SET NULL
);

-- ── Notifications ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_notification" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "created_on" TEXT NOT NULL,
  "updated_on" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" TEXT NOT NULL DEFAULT '{}',
  "workspace_id" INTEGER REFERENCES "core_workspace" ("id") ON DELETE SET NULL,
  "sender_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "broadcast" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "core_notificationrecipient" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "notification_id" INTEGER NOT NULL REFERENCES "core_notification" ("id") ON DELETE CASCADE,
  "recipient_id" INTEGER NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "read" INTEGER NOT NULL DEFAULT 0,
  "cleared" INTEGER NOT NULL DEFAULT 0,
  "created_on" TEXT NOT NULL,
  UNIQUE("notification_id","recipient_id")
);
CREATE INDEX IF NOT EXISTS "core_notif_recipient_idx" ON "core_notificationrecipient" ("recipient_id");

-- ── Snapshots ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_snapshot" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "snapshot_from_application_id" INTEGER NOT NULL REFERENCES "core_application" ("id") ON DELETE CASCADE,
  "snapshot_to_application_id" INTEGER REFERENCES "core_application" ("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "created_by_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL
);

-- ── Row history ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_rowhistory" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "user_name" TEXT NOT NULL DEFAULT '',
  "table_id" INTEGER NOT NULL REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "row_id" INTEGER NOT NULL,
  "action_timestamp" TEXT NOT NULL,
  "action_type" TEXT NOT NULL,
  "before_values" TEXT NOT NULL DEFAULT '{}',
  "after_values" TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "database_rowhistory_table_row_idx" ON "database_rowhistory" ("table_id","row_id");

-- ── Data sync ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "database_datasync" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "table_id" INTEGER NOT NULL UNIQUE REFERENCES "database_table" ("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "synced_properties" TEXT NOT NULL DEFAULT '[]',
  "last_sync" TEXT,
  "last_error" TEXT,
  "auto_add_new_properties" INTEGER NOT NULL DEFAULT 1,
  "authorized" INTEGER NOT NULL DEFAULT 1,
  "two_way_sync" INTEGER NOT NULL DEFAULT 0
);

-- ── Auth providers (SSO) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_authprovider" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "type" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "domain" TEXT,
  "metadata" TEXT NOT NULL DEFAULT '{}'
);

-- ── 2FA ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_twofactorauthenticationdevice" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL UNIQUE REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "secret" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 0,
  "backup_codes" TEXT NOT NULL DEFAULT '[]'
);

-- ── Admin settings ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "core_settings" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "allow_new_signups" INTEGER NOT NULL DEFAULT 1,
  "allow_signups_via_workspace_invitations" INTEGER NOT NULL DEFAULT 1,
  "allow_reset_password" INTEGER NOT NULL DEFAULT 1,
  "allow_global_workspace_creation" INTEGER NOT NULL DEFAULT 1,
  "account_deletion_grace_delay" INTEGER NOT NULL DEFAULT 30,
  "show_admin_signup_page" INTEGER NOT NULL DEFAULT 1,
  "track_workspace_usage" INTEGER NOT NULL DEFAULT 0,
  "show_baserow_help_request" INTEGER NOT NULL DEFAULT 1,
  "email_verified" INTEGER NOT NULL DEFAULT 0,
  "verify_import_signature" INTEGER NOT NULL DEFAULT 1,
  "allow_accessing_externally_hosted_files_in_rich_text_editors" INTEGER NOT NULL DEFAULT 0,
  "co_branding_logo" TEXT,
  "updated_at" TEXT
);

-- ── Enterprise: RBAC roles ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "enterprise_role" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uid" TEXT NOT NULL UNIQUE,
  "description" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "enterprise_roleassignment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "role_id" INTEGER NOT NULL REFERENCES "enterprise_role" ("id") ON DELETE CASCADE,
  "subject_id" INTEGER NOT NULL,
  "subject_type" TEXT NOT NULL,
  "scope_id" INTEGER NOT NULL,
  "scope_type" TEXT NOT NULL
);

-- ── Enterprise: Teams ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "enterprise_team" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL REFERENCES "core_workspace" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "default_role_uid" TEXT,
  "created_on" TEXT NOT NULL,
  "trashed" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "enterprise_teamsubject" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER NOT NULL REFERENCES "enterprise_team" ("id") ON DELETE CASCADE,
  "subject_id" INTEGER NOT NULL,
  "subject_type" TEXT NOT NULL
);

-- ── Enterprise: Audit log ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "enterprise_auditlogentry" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL,
  "user_email" TEXT NOT NULL DEFAULT '',
  "user_name" TEXT NOT NULL DEFAULT '',
  "workspace_id" INTEGER REFERENCES "core_workspace" ("id") ON DELETE SET NULL,
  "workspace_name" TEXT NOT NULL DEFAULT '',
  "type" TEXT NOT NULL,
  "timestamp" TEXT NOT NULL,
  "ip_address" TEXT,
  "action_object_id" INTEGER,
  "action_object_type" TEXT,
  "action_params" TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "audit_log_timestamp_idx" ON "enterprise_auditlogentry" ("timestamp");
CREATE INDEX IF NOT EXISTS "audit_log_workspace_idx" ON "enterprise_auditlogentry" ("workspace_id");

-- ── Enterprise: Field permissions ──────────────────────────────
CREATE TABLE IF NOT EXISTS "enterprise_fieldpermission" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "field_id" INTEGER NOT NULL REFERENCES "database_field" ("id") ON DELETE CASCADE,
  "role_uid" TEXT NOT NULL,
  "allow_read" INTEGER NOT NULL DEFAULT 1,
  "allow_write" INTEGER NOT NULL DEFAULT 1
);

-- ── Initial admin settings row ────────────────────────────────
INSERT OR IGNORE INTO "core_settings" (
  id, allow_new_signups, allow_signups_via_workspace_invitations,
  allow_reset_password, allow_global_workspace_creation,
  account_deletion_grace_delay, show_admin_signup_page,
  track_workspace_usage, show_baserow_help_request,
  email_verified, verify_import_signature,
  allow_accessing_externally_hosted_files_in_rich_text_editors
) VALUES (1,1,1,1,1,30,1,0,1,0,1,0);

-- ── Initial enterprise roles ──────────────────────────────────
INSERT OR IGNORE INTO "enterprise_role" (uid, description) VALUES
  ('ADMIN', 'Full administrative access'),
  ('BUILDER', 'Can create and modify tables and views'),
  ('EDITOR', 'Can create and edit rows'),
  ('COMMENTER', 'Can comment on rows'),
  ('VIEWER', 'Read-only access'),
  ('NO_ROLE', 'No access');


