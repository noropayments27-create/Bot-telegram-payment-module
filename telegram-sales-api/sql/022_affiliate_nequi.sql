DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'payout_method'
      AND e.enumlabel = 'NEQUI'
  ) THEN
    ALTER TYPE payout_method ADD VALUE 'NEQUI';
  END IF;
END$$;

ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS wallet_nequi text;
