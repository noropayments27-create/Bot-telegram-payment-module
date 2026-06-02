-- 016_affiliate_adjustments_reason_nullable.sql
-- Run: psql -d telegram_sales -f sql/016_affiliate_adjustments_reason_nullable.sql
ALTER TABLE affiliate_adjustments
  ALTER COLUMN reason DROP NOT NULL;
