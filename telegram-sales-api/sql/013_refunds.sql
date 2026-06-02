-- 013_refunds.sql
-- Refunds and affiliate debt support

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'REFUNDED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE commission_status ADD VALUE IF NOT EXISTS 'REFUNDED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  ADD COLUMN IF NOT EXISTS refund_reason text;

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_reason text;

ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS affiliate_debt numeric(12,2) NOT NULL DEFAULT 0 CHECK (affiliate_debt >= 0);

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS debt_applied numeric(12,2) NOT NULL DEFAULT 0 CHECK (debt_applied >= 0);

CREATE TABLE IF NOT EXISTS order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  refund_type text NOT NULL CHECK (refund_type IN ('PARTIAL', 'FULL')),
  reason text,
  refunded_by_admin text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON order_refunds(order_id);
