-- 004_products_code.sql
-- Add short code for products, backfill existing rows, auto-assign new ones.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS code text;

WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM products
)
UPDATE products p
SET code = lpad(ranked.rn::text, 5, '0')
FROM ranked
WHERE p.id = ranked.id AND p.code IS NULL;

DO $$ BEGIN
  CREATE SEQUENCE IF NOT EXISTS products_code_seq;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

SELECT setval(
  'products_code_seq',
  GREATEST(
    COALESCE((SELECT MAX(code::int) FROM products WHERE code ~ '^[0-9]+$'), 0),
    1
  ),
  true
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique
    ON products(code)
    WHERE code IS NOT NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION set_products_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := lpad(nextval('products_code_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_code ON products;
CREATE TRIGGER trg_products_code
BEFORE INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION set_products_code();
