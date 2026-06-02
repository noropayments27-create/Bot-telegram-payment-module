-- 027_affiliate_invoice_expiry.sql
-- Run: psql -d telegram_sales -f sql/027_affiliate_invoice_expiry.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'affiliate_invoice_status'
  ) THEN
    CREATE TYPE affiliate_invoice_status AS ENUM ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED');
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'affiliate_invoice_status'
        AND pg_enum.enumlabel = 'EXPIRED'
    ) THEN
      ALTER TYPE affiliate_invoice_status ADD VALUE 'EXPIRED';
    END IF;
  END IF;
END $$;

ALTER TABLE affiliate_invoices
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

ALTER TABLE affiliate_invoices
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '10 minutes');

UPDATE affiliate_invoices
SET expires_at = COALESCE(expires_at, created_at + interval '10 minutes')
WHERE expires_at IS NULL;

UPDATE affiliate_invoices
SET status = 'EXPIRED',
    expired_at = COALESCE(expired_at, now())
WHERE status = 'PENDING'
  AND expires_at <= now();

CREATE INDEX IF NOT EXISTS idx_affiliate_invoices_expiry
  ON affiliate_invoices(affiliate_id, status, expires_at DESC);
