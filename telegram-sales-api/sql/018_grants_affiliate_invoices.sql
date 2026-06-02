-- 018_grants_affiliate_invoices.sql
-- Run: psql -d telegram_sales -f sql/018_grants_affiliate_invoices.sql
-- NOTE: Ajusta el rol si tu app usa otro usuario distinto a "telegram".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_invoices TO telegram;
  END IF;
END $$;
