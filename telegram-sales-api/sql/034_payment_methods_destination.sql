ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS destination text;
