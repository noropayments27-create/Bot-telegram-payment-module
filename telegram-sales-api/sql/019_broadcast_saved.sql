ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS saved boolean NOT NULL DEFAULT false;
