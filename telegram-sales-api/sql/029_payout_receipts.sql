-- 029_payout_receipts.sql
-- Run: psql -d telegram_sales -f sql/029_payout_receipts.sql

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS receipt_path text,
  ADD COLUMN IF NOT EXISTS receipt_filename text,
  ADD COLUMN IF NOT EXISTS receipt_mime text;
