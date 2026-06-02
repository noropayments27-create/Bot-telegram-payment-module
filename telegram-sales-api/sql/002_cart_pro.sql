-- 002_cart_pro.sql
-- Cart PRO schema (carts, cart_items, order_items)

CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_active_unique
  ON carts(telegram_id)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  name text NOT NULL,
  unit_price_usd numeric(12,2) NOT NULL,
  qty int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cart_id, item_key)
);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  name text NOT NULL,
  unit_price_usd numeric(12,2) NOT NULL,
  qty int NOT NULL DEFAULT 1,
  line_total_usd numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
