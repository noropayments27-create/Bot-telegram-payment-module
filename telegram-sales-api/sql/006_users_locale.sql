ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale text;

UPDATE users
SET locale = COALESCE(locale, 'es');

ALTER TABLE users
  ALTER COLUMN locale SET NOT NULL;

ALTER TABLE users
  ALTER COLUMN locale SET DEFAULT 'es';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_locale_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_locale_check CHECK (locale IN ('es', 'en'));
  END IF;
END$$;
