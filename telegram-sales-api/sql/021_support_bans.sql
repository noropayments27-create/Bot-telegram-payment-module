CREATE TABLE IF NOT EXISTS support_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  reason text,
  banned_at timestamptz NOT NULL DEFAULT now()
);
