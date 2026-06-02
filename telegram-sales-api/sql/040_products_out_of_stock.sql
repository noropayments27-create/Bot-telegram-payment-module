ALTER TABLE products
  ADD COLUMN IF NOT EXISTS out_of_stock boolean NOT NULL DEFAULT false;
