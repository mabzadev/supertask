-- Module 9: complete core settings and 2FA metadata used by the Supertask UI.

ALTER TABLE "core_settings" ADD COLUMN "email_verification" TEXT NOT NULL DEFAULT 'no_verification';
ALTER TABLE "core_settings" ADD COLUMN "instance_id" TEXT;

INSERT OR IGNORE INTO "core_settings" (
  "id",
  "allow_new_signups",
  "allow_signups_via_workspace_invitations",
  "allow_reset_password",
  "allow_global_workspace_creation",
  "account_deletion_grace_delay",
  "show_admin_signup_page",
  "track_workspace_usage",
  "show_supertask_help_request",
  "email_verified",
  "verify_import_signature",
  "allow_accessing_externally_hosted_files_in_rich_text_editors",
  "email_verification",
  "instance_id",
  "updated_at"
) VALUES (
  1,
  1,
  1,
  1,
  1,
  30,
  1,
  0,
  1,
  0,
  1,
  0,
  'no_verification',
  lower(hex(randomblob(16))),
  datetime('now')
);
