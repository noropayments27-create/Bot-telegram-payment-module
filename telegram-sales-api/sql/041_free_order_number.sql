-- 041_free_order_number.sql
-- Add separate numbering for free orders.

CREATE SEQUENCE IF NOT EXISTS orders_free_order_number_seq;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS free_order_number bigint NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orders_free_order_number_unique
  ON orders(free_order_number)
  WHERE free_order_number IS NOT NULL;

WITH free_orders AS (
  SELECT o.id,
         ROW_NUMBER() OVER (ORDER BY o.created_at, o.id) AS next_number
  FROM orders o
  WHERE COALESCE(o.unit_price_at_purchase, 0) <= 0
)
UPDATE orders o
SET free_order_number = f.next_number
FROM free_orders f
WHERE o.id = f.id
  AND o.free_order_number IS NULL;

SELECT setval(
  'orders_free_order_number_seq',
  COALESCE((SELECT MAX(free_order_number) FROM orders), 1),
  true
);
