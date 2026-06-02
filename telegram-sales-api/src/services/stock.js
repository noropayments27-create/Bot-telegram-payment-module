function normalizeOrderId(orderOrId) {
  if (!orderOrId) {
    return null;
  }
  if (typeof orderOrId === "string") {
    return orderOrId;
  }
  if (typeof orderOrId === "object" && orderOrId.id) {
    return orderOrId.id;
  }
  return null;
}

async function loadOrderItems(client, orderId) {
  const itemsRes = await client.query(
    `SELECT oi.product_id,
            SUM(oi.qty)::int AS qty,
            p.stock_mode,
            p.stock_qty,
            p.unique_purchase
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     GROUP BY oi.product_id, p.stock_mode, p.stock_qty, p.unique_purchase`,
    [orderId]
  );

  if (itemsRes.rowCount > 0) {
    return itemsRes.rows.map((row) => ({
      product_id: row.product_id,
      qty: Number(row.qty),
      stock_mode: row.stock_mode,
      stock_qty: row.stock_qty,
      unique_purchase: row.unique_purchase,
    }));
  }

  const orderRes = await client.query(
    `SELECT o.product_id, p.stock_mode, p.stock_qty, p.unique_purchase
     FROM orders o
     JOIN products p ON p.id = o.product_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (orderRes.rowCount === 0) {
    return [];
  }

  return [
    {
      product_id: orderRes.rows[0].product_id,
      qty: 1,
      stock_mode: orderRes.rows[0].stock_mode,
      stock_qty: orderRes.rows[0].stock_qty,
      unique_purchase: orderRes.rows[0].unique_purchase,
    },
  ];
}

async function consumeStockForOrder(client, orderOrId) {
  const orderId = normalizeOrderId(orderOrId);
  if (!orderId) {
    throw new Error("ORDER_ID_REQUIRED");
  }
  const items = await loadOrderItems(client, orderId);
  console.log("[stock] consume for order:", orderId);

  for (const item of items) {
    if (item.stock_mode === "SIMPLE") {
      if (item.unique_purchase) {
        continue;
      }
      const productRes = await client.query(
        `SELECT stock_qty
         FROM products
         WHERE id = $1
         FOR UPDATE`,
        [item.product_id]
      );
      const stockQty =
        productRes.rowCount > 0 ? productRes.rows[0].stock_qty : null;
      if (stockQty === null || stockQty === undefined) {
        continue;
      }
      const available = Number(stockQty);

      if (available < item.qty) {
        const error = new Error("INSUFFICIENT_STOCK_SIMPLE");
        error.code = "INSUFFICIENT_STOCK";
        error.available = available;
        throw error;
      }

      await client.query(
        `UPDATE products
         SET stock_qty = stock_qty - $1
         WHERE id = $2`,
        [item.qty, item.product_id]
      );

      await client.query(
        `UPDATE product_stock_holds
         SET status = 'CONSUMED', updated_at = now()
         WHERE order_id = $1 AND product_id = $2 AND status = 'HELD'`,
        [orderId, item.product_id]
      );
    } else if (item.stock_mode === "UNITS") {
      const heldRes = await client.query(
        `SELECT id
         FROM product_stock_units
         WHERE held_by_order_id = $1
           AND product_id = $2
           AND status = 'HELD'
         FOR UPDATE`,
        [orderId, item.product_id]
      );
      const held = heldRes.rowCount;

      if (held !== item.qty) {
        const error = new Error("INSUFFICIENT_HELD_UNITS");
        error.code = "INSUFFICIENT_STOCK";
        error.available = held;
        throw error;
      }

      const updateRes = await client.query(
        `UPDATE product_stock_units
         SET status = 'DELIVERED',
             delivered_at = now(),
             updated_at = now()
         WHERE held_by_order_id = $1
           AND product_id = $2
           AND status = 'HELD'`,
        [orderId, item.product_id]
      );

      if (updateRes.rowCount !== item.qty) {
        const error = new Error("PARTIAL_DELIVERED_UNITS");
        error.code = "INSUFFICIENT_STOCK";
        error.available = updateRes.rowCount;
        throw error;
      }
    }
  }

  await client.query(
    `UPDATE product_stock_holds
     SET status = 'CONSUMED', updated_at = now()
     WHERE order_id = $1 AND status = 'HELD'`,
    [orderId]
  );

  return items;
}

async function releaseStockForOrder(client, orderOrId) {
  const orderId = normalizeOrderId(orderOrId);
  if (!orderId) {
    throw new Error("ORDER_ID_REQUIRED");
  }
  console.log("[stock] release for order:", orderId);

  await client.query(
    `UPDATE product_stock_holds
     SET status = 'RELEASED', updated_at = now()
     WHERE order_id = $1 AND status = 'HELD'`,
    [orderId]
  );

  await client.query(
    `UPDATE product_stock_units
     SET status = 'AVAILABLE',
         held_by_order_id = NULL,
         held_by_telegram_id = NULL,
         held_by_username = NULL,
         held_at = NULL,
         updated_at = now()
     WHERE held_by_order_id = $1 AND status = 'HELD'`,
    [orderId]
  );
}

module.exports = { consumeStockForOrder, releaseStockForOrder };
