-- 010_stock_schema.sql
-- Stock schema (products + stock units)
-- Run: psql -d telegram_sales -f sql/010_stock_schema.sql

-- =========================
-- ENUMS
-- =========================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_mode_enum') THEN
    CREATE TYPE stock_mode_enum AS ENUM ('SIMPLE','UNITS');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_unit_status_enum') THEN
    CREATE TYPE stock_unit_status_enum AS ENUM ('AVAILABLE','HELD','DELIVERED');
  END IF;
END$$;

-- =========================
-- PRODUCTS (add stock columns)
-- =========================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_mode stock_mode_enum NOT NULL DEFAULT 'SIMPLE';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_qty integer;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS show_stock boolean NOT NULL DEFAULT true;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS delivery_template text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_stock_qty_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_stock_qty_nonnegative
      CHECK (stock_qty IS NULL OR stock_qty >= 0);
  END IF;
END$$;

-- =========================
-- PRODUCT STOCK UNITS
-- =========================
CREATE TABLE IF NOT EXISTS product_stock_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status stock_unit_status_enum NOT NULL DEFAULT 'AVAILABLE',

  held_by_order_id uuid NULL,
  held_by_telegram_id bigint NULL,
  held_by_username text NULL,

  held_at timestamptz NULL,
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
