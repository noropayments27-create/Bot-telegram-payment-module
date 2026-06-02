-- 014_affiliate_adjustments.sql
-- Manual affiliate balance adjustments + payout linkage

CREATE TABLE IF NOT EXISTS affiliate_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount numeric(12, 2) NOT NULL,
  reason text NOT NULL,
  status commission_status NOT NULL DEFAULT 'EARNED',
  created_by_admin_id bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE affiliate_adjustments
  ADD CONSTRAINT affiliate_adjustments_amount_nonzero CHECK (amount <> 0);

CREATE INDEX IF NOT EXISTS idx_affiliate_adjustments_affiliate
  ON affiliate_adjustments(affiliate_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payout_adjustments (
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL REFERENCES affiliate_adjustments(id) ON DELETE CASCADE,
  amount numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payout_id, adjustment_id)
);

CREATE INDEX IF NOT EXISTS idx_payout_adjustments_payout
  ON payout_adjustments(payout_id);
