DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'broadcast_segment'
      AND e.enumlabel = 'BUYERS'
  ) THEN
    ALTER TYPE broadcast_segment ADD VALUE 'BUYERS';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'broadcast_segment'
      AND e.enumlabel = 'CHANNELS'
  ) THEN
    ALTER TYPE broadcast_segment ADD VALUE 'CHANNELS';
  END IF;
END$$;
