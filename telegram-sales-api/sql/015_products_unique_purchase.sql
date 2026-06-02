ALTER TABLE products
  ADD COLUMN IF NOT EXISTS unique_purchase boolean NOT NULL DEFAULT false;
