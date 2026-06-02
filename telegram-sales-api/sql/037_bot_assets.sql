CREATE TABLE IF NOT EXISTS bot_assets (
  id int PRIMARY KEY DEFAULT 1,
  payment_methods_image_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bot_assets (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
