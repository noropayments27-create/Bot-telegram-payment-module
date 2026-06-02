-- 001_init.sql
-- PostgreSQL initial schema for Proyecto Bot Telegram

-- UUID generation (choose one extension; pgcrypto is common)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================
-- ENUMS
-- =========================
DO $$ BEGIN
  CREATE TYPE affiliate_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('CREATED','WAITING_PAYMENT','PAID','DELIVERED','CANCELLED','REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_review_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE commission_status AS ENUM ('EARNED','PAID_OUT','REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('OPEN','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_sender AS ENUM ('USER','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delivery_type AS ENUM ('FILE','TEXT','IMAGE','VIDEO','LINK','EXPIRING_LINK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_method AS ENUM ('USDT_BSC','BINANCE_ID','NEQUI');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_status AS ENUM ('REQUESTED','SENT','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE broadcast_segment AS ENUM (
    'ALL',
    'CLIENTS',
    'AFFILIATES',
    'LEADS',
    'BY_PRODUCT',
    'BUYERS',
    'BUYERS_AFFILIATES',
    'GROUPS',
    'CHANNELS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE broadcast_destination AS ENUM ('DM','CHANNEL','GROUP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE broadcast_status AS ENUM ('DRAFT','SENT','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================
-- TABLES
-- =========================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  telegram_username text,
  referred_by_affiliate_id uuid NULL,
  referred_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- AFFILIATES (1:1 with users)
CREATE TABLE IF NOT EXISTS affiliates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status affiliate_status NOT NULL DEFAULT 'PENDING',
  wallet_usdt_bsc text,
  wallet_nequi text,
  binance_id text,
  commission_rate numeric(6,4) NOT NULL DEFAULT 0.2000,
  affiliate_debt numeric(12,2) NOT NULL DEFAULT 0 CHECK (affiliate_debt >= 0),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Add FK now that affiliates exists
DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_referred_by_affiliate_id_fk
    FOREIGN KEY (referred_by_affiliate_id) REFERENCES affiliates(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PRODUCTS
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_key text,
  code text,
  name text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  unique_purchase boolean NOT NULL DEFAULT false,
  delivery_type delivery_type NOT NULL,
  delivery_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_key_unique
  ON products(sku_key)
  WHERE sku_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique
  ON products(code)
  WHERE code IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS products_code_seq;
SELECT setval('products_code_seq', 1, false);

CREATE OR REPLACE FUNCTION set_products_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := lpad(nextval('products_code_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_code ON products;
CREATE TRIGGER trg_products_code
BEFORE INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION set_products_code();

-- ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  affiliate_id uuid NULL REFERENCES affiliates(id) ON DELETE SET NULL,
  status order_status NOT NULL DEFAULT 'CREATED',
  unit_price_at_purchase numeric(12,2) NOT NULL CHECK (unit_price_at_purchase >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  delivered_at timestamptz,
  refunded_at timestamptz,
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  refund_reason text
);

-- ORDER PAYMENTS (Payments A: 1 payment per order)
CREATE TABLE IF NOT EXISTS order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  screenshot_file_id text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  review_status payment_review_status NOT NULL DEFAULT 'PENDING',
  reviewed_by_admin_at timestamptz
);

-- COMMISSIONS (Commissions A: 1 commission per order)
CREATE TABLE IF NOT EXISTS commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  rate numeric(6,4) NOT NULL CHECK (rate >= 0),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  status commission_status NOT NULL DEFAULT 'EARNED',
  earned_at timestamptz NOT NULL DEFAULT now(),
  paid_out_at timestamptz,
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  refunded_at timestamptz,
  refund_reason text
);

-- PAYOUTS
CREATE TABLE IF NOT EXISTS payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  debt_applied numeric(12,2) NOT NULL DEFAULT 0 CHECK (debt_applied >= 0),
  method payout_method NOT NULL,
  destination text NOT NULL,
  status payout_status NOT NULL DEFAULT 'REQUESTED',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- AFFILIATE ADJUSTMENTS
CREATE TABLE IF NOT EXISTS affiliate_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  reason text,
  status commission_status NOT NULL DEFAULT 'EARNED',
  created_by_admin_id bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_adjustments_affiliate
  ON affiliate_adjustments(affiliate_id, status, created_at DESC);

-- PAYOUT ADJUSTMENTS
CREATE TABLE IF NOT EXISTS payout_adjustments (
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL REFERENCES affiliate_adjustments(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payout_id, adjustment_id)
);

CREATE INDEX IF NOT EXISTS idx_payout_adjustments_payout
  ON payout_adjustments(payout_id);

-- AFFILIATE INVOICES
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'affiliate_invoice_status'
  ) THEN
    CREATE TYPE affiliate_invoice_status AS ENUM ('PENDING', 'PAID', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS affiliate_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text,
  status affiliate_invoice_status NOT NULL DEFAULT 'PENDING',
  created_by_admin_id bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_affiliate_invoices_affiliate
  ON affiliate_invoices(affiliate_id, status, created_at DESC);

-- ORDER REFUNDS
CREATE TABLE IF NOT EXISTS order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  refund_type text NOT NULL CHECK (refund_type IN ('PARTIAL', 'FULL')),
  reason text,
  refunded_by_admin text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON order_refunds(order_id);

-- TICKETS
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status ticket_status NOT NULL DEFAULT 'OPEN',
  subject text NOT NULL,
  allow_image boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- TICKET MESSAGES
CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender ticket_sender NOT NULL,
  message_text text,
  telegram_file_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    message_text IS NOT NULL OR telegram_file_id IS NOT NULL
  )
);

-- BROADCASTS
CREATE TABLE IF NOT EXISTS broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment broadcast_segment NOT NULL,
  product_id uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  destination broadcast_destination NOT NULL,
  message_text text NOT NULL,
  image_path text,
  image_filename text,
  image_mime text,
  buttons jsonb,
  saved boolean NOT NULL DEFAULT false,
  status broadcast_status NOT NULL DEFAULT 'DRAFT',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- USER BANS
CREATE TABLE IF NOT EXISTS user_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  reason text,
  banned_at timestamptz NOT NULL DEFAULT now()
);

-- SUPPORT BANS
CREATE TABLE IF NOT EXISTS support_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  reason text,
  banned_at timestamptz NOT NULL DEFAULT now()
);

-- AUDIT LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================
-- INDEXES
-- =========================
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_affiliate_id);

CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_affiliate_created ON orders(affiliate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_commissions_affiliate_status ON commissions(affiliate_id, status);

CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_created ON ticket_messages(ticket_id, created_at);

CREATE INDEX IF NOT EXISTS idx_broadcasts_status_created ON broadcasts(status, created_at DESC);

-- Done
