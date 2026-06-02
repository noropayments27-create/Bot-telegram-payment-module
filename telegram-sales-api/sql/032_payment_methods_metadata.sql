CREATE TABLE IF NOT EXISTS payment_methods (
  method_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS markup text,
  ADD COLUMN IF NOT EXISTS sort_order int;
