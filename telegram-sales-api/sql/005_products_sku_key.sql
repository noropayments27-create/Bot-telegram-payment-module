-- 005_products_sku_key.sql
-- Add stable sku_key for seed upserts.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku_key text;

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_key_unique
  ON products(sku_key)
  WHERE sku_key IS NOT NULL;
