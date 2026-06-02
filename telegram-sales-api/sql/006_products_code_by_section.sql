-- 006_products_code_by_section.sql
-- Reset and reassign product codes by section prefix.

-- Reset codes for prefixed products
UPDATE products
SET code = NULL
WHERE sku_key LIKE 'shop_%'
   OR sku_key LIKE 'metodos_%'
   OR sku_key LIKE 'vip_%'
   OR sku_key LIKE 'web_%';

WITH categorized AS (
  SELECT
    id,
    sku_key,
    name,
    created_at,
    CASE
      WHEN sku_key LIKE 'shop_%' THEN 'T'
      WHEN sku_key LIKE 'metodos_%' THEN 'M'
      WHEN sku_key LIKE 'vip_%' THEN 'V'
      WHEN sku_key LIKE 'web_%' THEN 'W'
      ELSE NULL
    END AS prefix,
    CASE
      WHEN sku_key ~ '_([0-9]+)$' THEN substring(sku_key FROM '_([0-9]+)$')::int
      WHEN name ~* '^(SHOP|METODOS|VIP|WEB)\\s*([0-9]+)' THEN substring(name FROM '^(?:SHOP|METODOS|VIP|WEB)\\s*([0-9]+)')::int
      ELSE NULL
    END AS order_num
  FROM products
  WHERE sku_key LIKE 'shop_%'
     OR sku_key LIKE 'metodos_%'
     OR sku_key LIKE 'vip_%'
     OR sku_key LIKE 'web_%'
),
ranked AS (
  SELECT
    id,
    prefix,
    row_number() OVER (
      PARTITION BY prefix
      ORDER BY
        CASE WHEN order_num IS NULL THEN 1 ELSE 0 END,
        order_num,
        created_at,
        id
    ) AS rn
  FROM categorized
)
UPDATE products p
SET code = ranked.prefix || lpad(ranked.rn::text, 5, '0')
FROM ranked
WHERE p.id = ranked.id;

-- Replace numeric code trigger with section-aware assignment
CREATE OR REPLACE FUNCTION set_products_code_by_section()
RETURNS trigger AS $$
DECLARE
  prefix text;
  next_num int;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    IF NEW.sku_key LIKE 'shop_%' THEN
      prefix := 'T';
    ELSIF NEW.sku_key LIKE 'metodos_%' THEN
      prefix := 'M';
    ELSIF NEW.sku_key LIKE 'vip_%' THEN
      prefix := 'V';
    ELSIF NEW.sku_key LIKE 'web_%' THEN
      prefix := 'W';
    ELSE
      RETURN NEW;
    END IF;

    SELECT COALESCE(MAX(substring(code FROM 2)::int), 0) + 1
      INTO next_num
      FROM products
     WHERE code LIKE prefix || '%'
       AND code ~ '^[A-Z][0-9]{5}$';

    NEW.code := prefix || lpad(next_num::text, 5, '0');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_code ON products;
CREATE TRIGGER trg_products_code
BEFORE INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION set_products_code_by_section();
