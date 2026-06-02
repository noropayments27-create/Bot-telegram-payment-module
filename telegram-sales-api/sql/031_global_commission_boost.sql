CREATE TABLE IF NOT EXISTS global_commission_boost (
  id int PRIMARY KEY DEFAULT 1,
  rate numeric(6,4) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  ends_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO global_commission_boost (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
