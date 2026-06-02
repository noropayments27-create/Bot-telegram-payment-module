DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'commission_status'
      AND e.enumlabel = 'RESERVED'
  ) THEN
    ALTER TYPE commission_status ADD VALUE 'RESERVED';
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  commission_id uuid NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payout_items_commission_unique
  ON payout_items(commission_id);

CREATE INDEX IF NOT EXISTS payout_items_payout_id_idx
  ON payout_items(payout_id);
