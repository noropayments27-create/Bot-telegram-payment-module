-- 009_order_number_seq_grants.sql
-- Ensure app role can use order number sequence

GRANT USAGE, SELECT ON SEQUENCE orders_order_number_seq TO telegram;
