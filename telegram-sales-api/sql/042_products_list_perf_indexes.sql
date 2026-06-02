-- 042_products_list_perf_indexes.sql
-- Performance indexes for products listing + user purchase checks
-- Run: psql -d telegram_sales -f sql/042_products_list_perf_indexes.sql

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_key text;

-- Supports:
-- SELECT ... FROM products
-- WHERE is_active = true [AND category_key = ?]
-- ORDER BY created_at ASC, name ASC
CREATE INDEX IF NOT EXISTS idx_products_active_category_created_name
  ON products(is_active, category_key, created_at, name);

-- Fast path when listing active products without category filter.
CREATE INDEX IF NOT EXISTS idx_products_active_created_name
  ON products(created_at, name)
  WHERE is_active = true;

-- Supports EXISTS lookup used in products API:
-- WHERE user_id = ? AND product_id = ? AND status IN ('PAID','DELIVERED')
CREATE INDEX IF NOT EXISTS idx_orders_user_product_paid_delivered
  ON orders(user_id, product_id)
  WHERE status IN ('PAID', 'DELIVERED');

-- Supports held stock aggregation constrained by expires_at > now().
CREATE INDEX IF NOT EXISTS idx_psh_held_expires_product
  ON product_stock_holds(expires_at, product_id)
  WHERE status = 'HELD';
