DO $$
BEGIN
  -- Crear tabla si no existe
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='product_stock_holds'
  ) THEN
    CREATE TABLE public.product_stock_holds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
      order_id uuid NULL REFERENCES public.orders(id) ON DELETE CASCADE,
      cart_id uuid NULL REFERENCES public.carts(id) ON DELETE CASCADE,
      telegram_id bigint NULL,
      qty integer NOT NULL CHECK (qty > 0),
      status text NOT NULL DEFAULT 'HELD',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  -- Columnas por si el esquema se quedó a medias en alguna DB
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='product_stock_holds' AND column_name='updated_at'
  ) THEN
    ALTER TABLE public.product_stock_holds
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- Índices (idempotentes)
CREATE INDEX IF NOT EXISTS idx_psh_product_status
  ON public.product_stock_holds (product_id, status);

CREATE INDEX IF NOT EXISTS idx_psh_expires_at
  ON public.product_stock_holds (expires_at);

CREATE INDEX IF NOT EXISTS idx_psh_held_only
  ON public.product_stock_holds (product_id)
  WHERE status='HELD';

-- Permisos (para evitar errores de permission luego)
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_stock_holds TO PUBLIC;
