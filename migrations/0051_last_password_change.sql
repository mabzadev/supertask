-- Tokens issued before a password change or reset are rejected, like
-- Baserow's UserProfile.last_password_change.
ALTER TABLE auth_user ADD COLUMN last_password_change TEXT;
