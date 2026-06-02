-- 017_affiliate_invoices.sql
-- Run: psql -d telegram_sales -f sql/017_affiliate_invoices.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'affiliate_invoice_status'
  ) THEN
    CREATE TYPE affiliate_invoice_status AS ENUM ('PENDING', 'PAID', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS affiliate_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text,
  status affiliate_invoice_status NOT NULL DEFAULT 'PENDING',
  created_by_admin_id bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_affiliate_invoices_affiliate
  ON affiliate_invoices(affiliate_id, status, created_at DESC);
