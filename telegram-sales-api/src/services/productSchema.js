let productCategorySchemaReady = false;

async function ensureProductCategorySchema(pool) {
  if (productCategorySchemaReady) {
    return;
  }
  await pool.query(
    `ALTER TABLE products
     ADD COLUMN IF NOT EXISTS category_key text,
     ADD COLUMN IF NOT EXISTS name_en text,
     ADD COLUMN IF NOT EXISTS description_en text,
     ADD COLUMN IF NOT EXISTS image_url text,
     ADD COLUMN IF NOT EXISTS image_file_id text,
     ADD COLUMN IF NOT EXISTS out_of_stock boolean NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS delivery_payload_en jsonb,
     ADD COLUMN IF NOT EXISTS delivery_template_en text`
  );
  await pool.query(
    `UPDATE products
     SET category_key = CASE
       WHEN category_key IS NOT NULL AND category_key <> '' THEN category_key
       WHEN code LIKE 'T%' THEN 'TIENDA'
       WHEN code LIKE 'M%' THEN 'METODOS'
       WHEN code LIKE 'V%' THEN 'VIP'
       WHEN code LIKE 'W%' THEN 'PROGRAMAS'
       WHEN upper(name) LIKE 'SHOP %' THEN 'TIENDA'
       WHEN upper(name) LIKE 'METODOS %' THEN 'METODOS'
       WHEN upper(name) LIKE 'VIP %' THEN 'VIP'
       WHEN upper(name) LIKE 'WEB %' THEN 'PROGRAMAS'
       ELSE 'TIENDA'
     END
     WHERE category_key IS NULL OR category_key = ''`
  );
  productCategorySchemaReady = true;
}

module.exports = { ensureProductCategorySchema };
