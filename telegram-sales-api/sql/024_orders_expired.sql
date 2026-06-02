-- 024_orders_expired.sql
-- Run: psql -d telegram_sales -f sql/024_orders_expired.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'order_status'
      AND e.enumlabel = 'EXPIRED'
  ) THEN
    ALTER TYPE order_status ADD VALUE 'EXPIRED';
  END IF;
END$$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_source text;

ALTER TABLE orders
  ALTER COLUMN order_number DROP DEFAULT;

UPDATE orders o
SET status = 'EXPIRED',
    cancel_source = 'EXPIRED',
    cancelled_at = COALESCE(cancelled_at, now()),
    order_number = NULL
WHERE o.status = 'CANCELLED'
  AND NOT EXISTS (
    SELECT 1 FROM order_payments op WHERE op.order_id = o.id
  )
  AND o.paid_at IS NULL
  AND o.delivered_at IS NULL
  AND o.refunded_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM audit_logs al
    WHERE al.entity_type = 'order'
      AND al.entity_id = o.id
      AND al.admin_action IN ('HOLD_RELEASE_CANCEL_ORDER', 'ORDER_REJECT')
  );

UPDATE orders o
SET order_number = nextval('orders_order_number_seq')
WHERE o.status = 'CANCELLED'
  AND o.order_number IS NULL;

SELECT setval(
  'orders_order_number_seq',
  COALESCE((SELECT MAX(order_number) FROM orders), 1),
  true
);
