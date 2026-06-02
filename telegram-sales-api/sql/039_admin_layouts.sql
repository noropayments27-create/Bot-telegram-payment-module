CREATE TABLE IF NOT EXISTS admin_layouts (
  layout_key text PRIMARY KEY,
  layout jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
