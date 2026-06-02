ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS asset_images text;
