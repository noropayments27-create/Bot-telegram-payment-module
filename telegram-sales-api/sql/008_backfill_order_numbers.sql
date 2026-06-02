-- 008_backfill_order_numbers.sql
-- Backfill order_number for existing orders missing it

WITH missing AS (
  SELECT id
  FROM orders
  WHERE order_number IS NULL
  ORDER BY created_at ASC, id ASC
)
UPDATE orders o
SET order_number = nextval('orders_order_number_seq')
FROM missing m
WHERE o.id = m.id;
