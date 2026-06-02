-- 026_renumber_orders_with_payment.sql
-- Run: psql -d telegram_sales -f sql/026_renumber_orders_with_payment.sql

BEGIN;

-- Only orders with payment proof keep numbers.
WITH paid_orders AS (
  SELECT o.id
  FROM orders o
  JOIN order_payments op ON op.order_id = o.id
  WHERE o.status != 'EXPIRED'
)
UPDATE orders o
SET order_number = NULL
FROM paid_orders p
WHERE o.id = p.id;

WITH paid_orders AS (
  SELECT o.id
  FROM orders o
  JOIN order_payments op ON op.order_id = o.id
  WHERE o.status != 'EXPIRED'
),
renumbered AS (
  SELECT o.id,
         ROW_NUMBER() OVER (ORDER BY o.created_at, o.id) AS new_number
  FROM orders o
  JOIN paid_orders p ON p.id = o.id
)
UPDATE orders o
SET order_number = r.new_number
FROM renumbered r
WHERE o.id = r.id;

-- Remove numbers from orders without payment proof or expired.
UPDATE orders o
SET order_number = NULL
WHERE o.id NOT IN (SELECT order_id FROM order_payments)
   OR o.status = 'EXPIRED';

SELECT setval(
  'orders_order_number_seq',
  COALESCE((SELECT MAX(order_number) FROM orders), 1),
  true
);

COMMIT;
