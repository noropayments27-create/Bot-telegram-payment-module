DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'broadcast_segment'
      AND e.enumlabel = 'BUYERS_AFFILIATES'
  ) THEN
    ALTER TYPE broadcast_segment ADD VALUE 'BUYERS_AFFILIATES';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'broadcast_segment'
      AND e.enumlabel = 'GROUPS'
  ) THEN
    ALTER TYPE broadcast_segment ADD VALUE 'GROUPS';
  END IF;
END$$;
