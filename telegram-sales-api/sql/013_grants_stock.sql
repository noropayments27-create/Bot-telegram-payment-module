-- Run: psql -d telegram_sales -f sql/013_grants_stock.sql
-- NOTE: Ajusta el rol si tu app usa otro usuario distinto a "telegram".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_stock_holds TO telegram;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_stock_units TO telegram;
    GRANT SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO telegram;
  END IF;
END $$;
