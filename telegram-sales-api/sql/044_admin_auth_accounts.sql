-- 044_admin_auth_accounts.sql
-- Admin authentication baseline tables.
--
-- PR-1 scope:
-- 1) Persist admin accounts in DB (instead of relying only on .env).
-- 2) Prepare OTP and audit tables for upcoming password reset/change flows.

CREATE TABLE IF NOT EXISTS admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  auth_version int NOT NULL DEFAULT 1,
  telegram_id bigint,
  recovery_email text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_username_unique
  ON admin_accounts ((lower(btrim(username))));

CREATE INDEX IF NOT EXISTS admin_accounts_active_idx
  ON admin_accounts (is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_auth_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  channel text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_auth_otps_admin_idx
  ON admin_auth_otps (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_auth_otps_active_idx
  ON admin_auth_otps (expires_at, used_at);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  ip inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx
  ON admin_audit_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_logs_admin_idx
  ON admin_audit_logs (admin_id, created_at DESC);
