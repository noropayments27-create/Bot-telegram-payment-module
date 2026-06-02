-- 045_admin_auth_version.sql
-- Adds auth_version to admin accounts for JWT session invalidation on password change.

ALTER TABLE IF EXISTS admin_accounts
  ADD COLUMN IF NOT EXISTS auth_version int NOT NULL DEFAULT 1;
