-- 043_permanent_product_link_codes.sql
-- Permanent product deep-link token strategy: code -> UUID fallback.
--
-- Goals:
-- 1) Ensure every product has a stable short `code`.
-- 2) Ensure new products always get `code` automatically.
-- 3) Keep backward compatibility with old UUID links.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS code text;

CREATE SEQUENCE IF NOT EXISTS products_code_seq;

-- Normalize empty strings to NULL.
UPDATE products
SET code = NULL
WHERE code IS NOT NULL
  AND btrim(code) = '';

-- First pass: use existing SKU as code where possible (short, readable),
-- only when it is unique and does not collide with existing codes.
WITH candidates AS (
  SELECT
    p.id,
    upper(btrim(p.sku_key)) AS new_code
  FROM products p
  WHERE (p.code IS NULL OR btrim(p.code) = '')
    AND p.sku_key IS NOT NULL
    AND btrim(p.sku_key) <> ''
    AND upper(btrim(p.sku_key)) ~ '^[0-9A-Z_-]{2,40}$'
),
unique_candidates AS (
  SELECT c.id, c.new_code
  FROM candidates c
  JOIN (
    SELECT new_code
    FROM candidates
    GROUP BY new_code
    HAVING COUNT(*) = 1
  ) u ON u.new_code = c.new_code
  WHERE NOT EXISTS (
    SELECT 1
    FROM products p2
    WHERE p2.id <> c.id
      AND upper(coalesce(btrim(p2.code), '')) = c.new_code
  )
)
UPDATE products p
SET code = uc.new_code
FROM unique_candidates uc
WHERE p.id = uc.id
  AND (p.code IS NULL OR btrim(p.code) = '');

-- Second pass: fill remaining missing codes using sequence.
WITH missing AS (
  SELECT id
  FROM products
  WHERE code IS NULL OR btrim(code) = ''
  ORDER BY created_at, id
)
UPDATE products p
SET code = lpad(nextval('products_code_seq')::text, 5, '0')
FROM missing m
WHERE p.id = m.id;

CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique
  ON products(code)
  WHERE code IS NOT NULL;

-- Align sequence to current max numeric code.
SELECT setval(
  'products_code_seq',
  GREATEST(
    COALESCE((SELECT MAX(code::int) FROM products WHERE code ~ '^[0-9]+$'), 0),
    1
  ),
  true
);

-- Stable trigger for future products (not dependent on sku_key prefixes).
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
