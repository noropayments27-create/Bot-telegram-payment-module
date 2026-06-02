-- 014_add_payment_method.sql
-- Add payment_method to order_payments
-- Run: psql -d telegram_sales -f sql/014_add_payment_method.sql

ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS payment_method text;