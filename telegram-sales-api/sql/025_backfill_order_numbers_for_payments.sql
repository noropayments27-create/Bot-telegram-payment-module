-- 025_backfill_order_numbers_for_payments.sql
-- Run: psql -d telegram_sales -f sql/025_backfill_order_numbers_for_payments.sql

WITH target AS (
  SELECT o.id
  FROM orders o
  JOIN order_payments op ON op.order_id = o.id
  WHERE o.order_number IS NULL
    AND o.status != 'EXPIRED'
)
UPDATE orders o
SET order_number = nextval('orders_order_number_seq')
FROM target
WHERE o.id = target.id;

SELECT setval(
  'orders_order_number_seq',
  COALESCE((SELECT MAX(order_number) FROM orders), 1),
  true
);
