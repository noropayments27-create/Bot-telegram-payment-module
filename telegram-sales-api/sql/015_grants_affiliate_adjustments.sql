-- 015_grants_affiliate_adjustments.sql
-- Run: psql -d telegram_sales -f sql/015_grants_affiliate_adjustments.sql
-- NOTE: Ajusta el rol si tu app usa otro usuario distinto a "telegram".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_adjustments TO telegram;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_adjustments TO telegram;
  END IF;
END $$;
