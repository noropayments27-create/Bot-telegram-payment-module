-- 007_order_number.sql
-- Add global order_number sequence + column (no backfill)

CREATE SEQUENCE IF NOT EXISTS orders_order_number_seq;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_number bigint NULL;

ALTER TABLE orders
  ALTER COLUMN order_number SET DEFAULT nextval('orders_order_number_seq');

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_unique
  ON orders(order_number)
  WHERE order_number IS NOT NULL;
