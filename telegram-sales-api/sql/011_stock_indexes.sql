-- 011_stock_indexes.sql
-- Stock indexes
-- Run: psql -d telegram_sales -f sql/011_stock_indexes.sql

CREATE INDEX IF NOT EXISTS idx_psu_product_status
  ON product_stock_units(product_id, status);

CREATE INDEX IF NOT EXISTS idx_psu_held_by_order
  ON product_stock_units(held_by_order_id);

CREATE INDEX IF NOT EXISTS idx_psu_available_only
  ON product_stock_units(product_id)
  WHERE status = 'AVAILABLE';
