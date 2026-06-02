-- 046_admin_recovery_email_unique.sql
-- Deduplicate admin recovery emails (keep earliest account) and enforce uniqueness.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY lower(btrim(recovery_email))
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM admin_accounts
  WHERE recovery_email IS NOT NULL
    AND btrim(recovery_email) <> ''
)
UPDATE admin_accounts AS a
SET recovery_email = NULL,
    updated_at = now()
FROM ranked AS r
WHERE a.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_recovery_email_unique
  ON admin_accounts ((lower(btrim(recovery_email))))
  WHERE recovery_email IS NOT NULL
    AND btrim(recovery_email) <> '';
