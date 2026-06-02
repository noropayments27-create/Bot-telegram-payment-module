ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS allow_image boolean NOT NULL DEFAULT false;
