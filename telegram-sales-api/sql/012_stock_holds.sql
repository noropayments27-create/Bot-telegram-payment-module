-- 012_stock_holds.sql
-- Stock holds for SIMPLE mode
-- Run: psql -d telegram_sales -f sql/012_stock_holds.sql

CREATE TABLE IF NOT EXISTS product_stock_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id uuid NULL REFERENCES orders(id) ON DELETE CASCADE,
  cart_id uuid NULL REFERENCES carts(id) ON DELETE CASCADE,
  telegram_id bigint NULL,
  qty integer NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'HELD',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psh_product_status
  ON product_stock_holds(product_id, status);

CREATE INDEX IF NOT EXISTS idx_psh_expires_at
  ON product_stock_holds(expires_at);

CREATE INDEX IF NOT EXISTS idx_psh_held_only
  ON product_stock_holds(product_id)
  WHERE status = 'HELD';
