let freeOrderSchemaReady = false;

async function ensureFreeOrderSchema(pool) {
  if (freeOrderSchemaReady) {
    return;
  }

  await pool.query(
    `CREATE SEQUENCE IF NOT EXISTS orders_free_order_number_seq`
  );
  await pool.query(
    `ALTER TABLE orders
     ADD COLUMN IF NOT EXISTS free_order_number bigint`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS orders_free_order_number_unique
     ON orders(free_order_number)
     WHERE free_order_number IS NOT NULL`
  );

  freeOrderSchemaReady = true;
}

function isFreeOrderRow(order) {
  if (!order || typeof order !== "object") {
    return false;
  }
  const freeOrderNumber = Number(order.free_order_number || 0);
  if (Number.isFinite(freeOrderNumber) && freeOrderNumber > 0) {
    return true;
  }
  const subtotal = Number(order.unit_price_at_purchase);
  return Number.isFinite(subtotal) && subtotal <= 0;
}

function formatFreeOrderLabel(freeOrderNumber) {
  const parsed = Number(freeOrderNumber || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return `Orden Gratis: ${String(parsed).padStart(5, "0")}`;
}

module.exports = {
  ensureFreeOrderSchema,
  isFreeOrderRow,
  formatFreeOrderLabel,
};
