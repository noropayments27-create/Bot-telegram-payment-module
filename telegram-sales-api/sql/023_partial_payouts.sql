-- 023_partial_payouts.sql
-- Run: psql -d telegram_sales -f sql/023_partial_payouts.sql

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS reserved_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_out_amount numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE affiliate_adjustments
  ADD COLUMN IF NOT EXISTS reserved_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_out_amount numeric(12, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.relname = 'payout_items_commission_unique'
  ) THEN
    DROP INDEX payout_items_commission_unique;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS payout_items_commission_idx
  ON payout_items(commission_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commissions_reserved_amount_nonnegative'
  ) THEN
    ALTER TABLE commissions
      ADD CONSTRAINT commissions_reserved_amount_nonnegative
      CHECK (reserved_amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commissions_paid_out_amount_nonnegative'
  ) THEN
    ALTER TABLE commissions
      ADD CONSTRAINT commissions_paid_out_amount_nonnegative
      CHECK (paid_out_amount >= 0);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affiliate_adjustments_reserved_amount_nonnegative'
  ) THEN
    ALTER TABLE affiliate_adjustments
      ADD CONSTRAINT affiliate_adjustments_reserved_amount_nonnegative
      CHECK (reserved_amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affiliate_adjustments_paid_out_amount_nonnegative'
  ) THEN
    ALTER TABLE affiliate_adjustments
      ADD CONSTRAINT affiliate_adjustments_paid_out_amount_nonnegative
      CHECK (paid_out_amount >= 0);
  END IF;
END$$;

WITH reserved AS (
  SELECT pi.commission_id, COALESCE(SUM(pi.amount), 0) AS total
  FROM payout_items pi
  JOIN payouts p ON p.id = pi.payout_id
  WHERE p.status = 'REQUESTED'
  GROUP BY pi.commission_id
),
paid AS (
  SELECT pi.commission_id, COALESCE(SUM(pi.amount), 0) AS total
  FROM payout_items pi
  JOIN payouts p ON p.id = pi.payout_id
  WHERE p.status = 'SENT'
  GROUP BY pi.commission_id
)
UPDATE commissions c
SET reserved_amount = COALESCE(reserved.total, 0),
    paid_out_amount = COALESCE(paid.total, 0)
FROM reserved
FULL JOIN paid ON paid.commission_id = reserved.commission_id
WHERE c.id = COALESCE(reserved.commission_id, paid.commission_id);

WITH reserved AS (
  SELECT pa.adjustment_id, COALESCE(SUM(pa.amount), 0) AS total
  FROM payout_adjustments pa
  JOIN payouts p ON p.id = pa.payout_id
  WHERE p.status = 'REQUESTED'
    AND pa.amount > 0
  GROUP BY pa.adjustment_id
),
paid AS (
  SELECT pa.adjustment_id, COALESCE(SUM(pa.amount), 0) AS total
  FROM payout_adjustments pa
  JOIN payouts p ON p.id = pa.payout_id
  WHERE p.status = 'SENT'
    AND pa.amount > 0
  GROUP BY pa.adjustment_id
)
UPDATE affiliate_adjustments a
SET reserved_amount = COALESCE(reserved.total, 0),
    paid_out_amount = COALESCE(paid.total, 0)
FROM reserved
FULL JOIN paid ON paid.adjustment_id = reserved.adjustment_id
WHERE a.id = COALESCE(reserved.adjustment_id, paid.adjustment_id);

UPDATE commissions
SET status = 'PAID_OUT',
    paid_out_at = COALESCE(paid_out_at, now())
WHERE status <> 'REFUNDED'
  AND (amount - COALESCE(refunded_amount, 0)) <= paid_out_amount + 0.01;

UPDATE affiliate_adjustments
SET status = 'PAID_OUT'
WHERE amount > 0
  AND amount <= paid_out_amount + 0.01;
