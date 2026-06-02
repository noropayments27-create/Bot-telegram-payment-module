let orderNumberSchemaReady = false;
let orderNumberSchemaPromise = null;

async function ensureOrderNumberSchema(db) {
  if (orderNumberSchemaReady) {
    return;
  }
  if (orderNumberSchemaPromise) {
    await orderNumberSchemaPromise;
    return;
  }

  orderNumberSchemaPromise = (async () => {
    await db.query(
      `CREATE TABLE IF NOT EXISTS available_order_numbers (
         order_number bigint PRIMARY KEY,
         source_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
         reason text,
         released_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS is_scam boolean NOT NULL DEFAULT false`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS scam_flagged_at timestamptz`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS scam_reason text`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS released_order_number bigint`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false`
    );
    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS test_cleanup_after timestamptz`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS orders_is_scam_idx
       ON orders(is_scam)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS orders_is_test_idx
       ON orders(is_test)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS orders_test_cleanup_after_idx
       ON orders(test_cleanup_after)`
    );

    orderNumberSchemaReady = true;
  })();

  try {
    await orderNumberSchemaPromise;
  } finally {
    orderNumberSchemaPromise = null;
  }
}

async function syncOrderNumberSequence(db) {
  await ensureOrderNumberSchema(db);
  await db.query(
    `SELECT setval(
       'orders_order_number_seq',
       GREATEST(
         COALESCE((SELECT last_value FROM orders_order_number_seq), 1),
         COALESCE((SELECT MAX(order_number) FROM orders), 1)
       ),
       true
     )`
  );
}

async function bumpOrderNumberSequence(db, orderNumber) {
  const parsed = Number(orderNumber || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return;
  }
  await ensureOrderNumberSchema(db);
  await db.query(
    `SELECT setval(
       'orders_order_number_seq',
       GREATEST(
         COALESCE((SELECT last_value FROM orders_order_number_seq), 1),
         $1::bigint
       ),
       true
     )`,
    [parsed]
  );
}

async function claimReusableOrderNumber(db) {
  await ensureOrderNumberSchema(db);
  const reusableRes = await db.query(
    `SELECT order_number
     FROM available_order_numbers
     ORDER BY order_number ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  if (reusableRes.rowCount === 0) {
    return null;
  }

  const orderNumber = Number(reusableRes.rows[0].order_number || 0);
  if (!Number.isFinite(orderNumber) || orderNumber <= 0) {
    return null;
  }

  await db.query(
    `DELETE FROM available_order_numbers
     WHERE order_number = $1`,
    [orderNumber]
  );
  await bumpOrderNumberSequence(db, orderNumber);
  return orderNumber;
}

async function getNextVisibleOrderNumber(db) {
  await ensureOrderNumberSchema(db);
  const reusable = await claimReusableOrderNumber(db);
  if (Number.isFinite(reusable) && reusable > 0) {
    return reusable;
  }
  const seqRes = await db.query(
    `SELECT nextval('orders_order_number_seq') AS order_number`
  );
  return Number(seqRes.rows[0]?.order_number || 0) || null;
}

async function ensureOrderNumberForOrder(db, orderId) {
  await ensureOrderNumberSchema(db);
  const currentRes = await db.query(
    `SELECT order_number
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [orderId]
  );
  if (currentRes.rowCount === 0) {
    return null;
  }

  const currentNumber = Number(currentRes.rows[0].order_number || 0);
  if (Number.isFinite(currentNumber) && currentNumber > 0) {
    return currentNumber;
  }

  const nextNumber = await getNextVisibleOrderNumber(db);
  if (!Number.isFinite(nextNumber) || nextNumber <= 0) {
    return null;
  }

  await db.query(
    `UPDATE orders
     SET order_number = $2
     WHERE id = $1
       AND order_number IS NULL`,
    [orderId, nextNumber]
  );
  return nextNumber;
}

async function releaseOrderNumber(db, orderNumber, sourceOrderId = null, reason = null) {
  await ensureOrderNumberSchema(db);
  const parsed = Number(orderNumber || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return false;
  }
  const releasedRes = await db.query(
    `INSERT INTO available_order_numbers (order_number, source_order_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_number) DO NOTHING`,
    [parsed, sourceOrderId || null, reason || null]
  );
  return releasedRes.rowCount > 0;
}

module.exports = {
  ensureOrderNumberSchema,
  syncOrderNumberSequence,
  ensureOrderNumberForOrder,
  releaseOrderNumber,
};
