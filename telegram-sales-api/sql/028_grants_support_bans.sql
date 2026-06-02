-- 028_grants_support_bans.sql
-- Run: psql -d telegram_sales -f sql/028_grants_support_bans.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'support_bans'
  ) THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_bans TO telegram;
  END IF;
END $$;
