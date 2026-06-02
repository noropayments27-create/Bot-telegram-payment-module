const { getPool } = require("../../db");
const { ensureProductCategorySchema } = require("../../services/productSchema");
const {
  ensureFreeOrderSchema,
  formatFreeOrderLabel,
} = require("../../services/freeOrders");
const { syncOrderNumberSequence } = require("../../services/orderNumbers");

function normalizeTelegramId(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function parseAdminTelegramIds() {
  const value = process.env.ADMIN_TELEGRAM_IDS || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

function isAdminTelegramId(telegramId) {
  if (!telegramId) {
    return false;
  }
  const admins = parseAdminTelegramIds();
  return admins.includes(Number(telegramId));
}

function isUniquePurchaseActive(item) {
  if (!item || String(item.stock_mode || "").toUpperCase() !== "SIMPLE") {
    return false;
  }
  if (!item.unique_purchase) {
    return false;
  }
  if (item.stock_qty === null || item.stock_qty === undefined) {
    return true;
  }
  const stockQty = Number(item.stock_qty);
  if (!Number.isFinite(stockQty)) {
    return true;
  }
  return stockQty <= 1;
}

async function ensureUser(client, telegramId, username) {
  const userRes = await client.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  if (userRes.rowCount > 0) {
    return userRes.rows[0];
  }

  const insertRes = await client.query(
    `INSERT INTO users (telegram_id, telegram_username)
     VALUES ($1, $2)
     RETURNING *`,
    [telegramId, username || null]
  );
  return insertRes.rows[0];
}

async function getOrCreateActiveCart(client, telegramId) {
  const normalizedTelegramId = normalizeTelegramId(telegramId);
  if (!normalizedTelegramId) {
    return null;
  }
  const cartRes = await client.query(
    `SELECT * FROM carts
     WHERE telegram_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalizedTelegramId]
  );
  if (cartRes.rowCount > 0) {
    return cartRes.rows[0];
  }

  try {
    const insertRes = await client.query(
      `INSERT INTO carts (telegram_id, status)
       VALUES ($1, 'ACTIVE')
       RETURNING *`,
      [normalizedTelegramId]
    );
    return insertRes.rows[0];
  } catch (error) {
    if (error && error.code === "23505") {
      const fallbackRes = await client.query(
        `SELECT * FROM carts
         WHERE telegram_id = $1 AND status = 'ACTIVE'
         ORDER BY created_at DESC
         LIMIT 1`,
        [normalizedTelegramId]
      );
      if (fallbackRes.rowCount > 0) {
        return fallbackRes.rows[0];
      }
    }
    throw error;
  }
}

async function getActiveCart(telegramId, client, options = {}) {
  const normalizedTelegramId = normalizeTelegramId(telegramId);
  if (!normalizedTelegramId) {
    return null;
  }
  const lockClause = options.forUpdate ? "FOR UPDATE" : "";
  const cartRes = await client.query(
    `SELECT * FROM carts
     WHERE telegram_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1 ${lockClause}`,
    [normalizedTelegramId]
  );
  if (cartRes.rowCount === 0) {
    return null;
  }
  return cartRes.rows[0];
}

async function getCart(req, res, next) {
  const telegramId = normalizeTelegramId(req.query.telegram_id);
  if (!telegramId) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  try {
    const pool = getPool();
    const cart = await getActiveCart(telegramId, pool);
    let userLocale = "es";
    try {
      const userRes = await pool.query(
        "SELECT locale FROM users WHERE telegram_id = $1",
        [telegramId]
      );
      if (userRes.rowCount > 0 && userRes.rows[0].locale === "en") {
        userLocale = "en";
      }
    } catch (error) {
      // ignore locale lookup
    }

    if (!cart) {
      return res.json({ items: [], total_usd: 0 });
    }

    const itemsRes = await pool.query(
      `SELECT ci.product_id,
              p.name,
              p.name_en,
              ci.unit_price_usd,
              ci.qty,
              ci.total_price_usd
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at ASC`,
      [cart.id]
    );

    const items = itemsRes.rows.map((item) => {
      const unitPrice = Number(item.unit_price_usd);
      const qty = Number(item.qty);
      const totalPrice =
        item.total_price_usd === null || item.total_price_usd === undefined
          ? Number((unitPrice * qty).toFixed(2))
          : Number(item.total_price_usd);
      return {
        product_id: item.product_id,
        name: userLocale === "en" ? item.name_en || item.name : item.name,
        unit_price_usd: unitPrice,
        qty,
        total_price_usd: totalPrice,
      };
    });

    const total = items.reduce((sum, item) => sum + item.total_price_usd, 0);

    return res.json({ items, total_usd: Number(total.toFixed(2)) });
  } catch (error) {
    return next(error);
  }
}

async function addToCart(req, res, next) {
  const telegramId = normalizeTelegramId(req.body.telegram_id);
  const productId = req.body.product_id;
  const qty = Math.max(parseInt(req.body.qty, 10) || 1, 1);
  const username = req.body.username || null;

  if (!telegramId) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!productId) {
    return res.status(400).json({ error: "product_id is required" });
  }

  const pool = getPool();
  await ensureProductCategorySchema(pool);
  await ensureFreeOrderSchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const user = await ensureUser(client, telegramId, username);
    const cart = await getOrCreateActiveCart(client, telegramId);
    if (!cart) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "cart_not_found" });
    }

    const productRes = await client.query(
      `SELECT p.id,
              p.name,
              p.price,
              p.out_of_stock,
              p.stock_mode,
              p.stock_qty,
              p.unique_purchase,
              COALESCE(psu.available_units, 0) AS available_units,
              COALESCE(psh.held_qty, 0) AS held_qty
       FROM products p
       LEFT JOIN (
         SELECT product_id, COUNT(*)::int AS available_units
         FROM product_stock_units
         WHERE status = 'AVAILABLE'
         GROUP BY product_id
       ) psu ON psu.product_id = p.id
       LEFT JOIN (
         SELECT product_id, COALESCE(SUM(qty), 0)::int AS held_qty
         FROM product_stock_holds
         WHERE status = 'HELD' AND expires_at > now()
         GROUP BY product_id
       ) psh ON psh.product_id = p.id
       WHERE p.id = $1 AND p.is_active = true`,
      [productId]
    );
    if (productRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "product_not_found" });
    }

    const product = productRes.rows[0];
    if (product.out_of_stock) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "OUT_OF_STOCK",
        message: "❌ Producto agotado por el momento.",
      });
    }
    const cartItemRes = await client.query(
      `SELECT qty
       FROM cart_items
       WHERE cart_id = $1 AND product_id = $2`,
      [cart.id, product.id]
    );
    const currentQty = cartItemRes.rowCount
      ? Number(cartItemRes.rows[0].qty)
      : 0;
    const nextQty = currentQty + qty;

    const enforceUnique = isUniquePurchaseActive(product);
    if (enforceUnique && !isAdminTelegramId(telegramId)) {
      if (qty > 1) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "UNIQUE_LIMIT",
          message: "❌ Este producto solo lo puedes reclamar una vez.",
        });
      }
      if (currentQty >= 1) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "UNIQUE_IN_CART",
          message: "❌ Este producto solo lo puedes reclamar una vez.",
        });
      }
      const alreadyPurchasedRes = await client.query(
        `SELECT 1
         FROM orders o
         WHERE o.user_id = $1
           AND o.product_id = $2
           AND o.status IN ('PAID', 'DELIVERED')
         LIMIT 1`,
        [user.id, product.id]
      );
      if (alreadyPurchasedRes.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "UNIQUE_ALREADY_PURCHASED",
          message: "❌ Este producto solo lo puedes reclamar una vez.",
        });
      }
    }

    let availableStock = null;
    let isUnlimited = false;
    if (product.stock_mode === "SIMPLE") {
      if (
        enforceUnique
        || product.stock_qty === null
        || product.stock_qty === undefined
      ) {
        isUnlimited = true;
      } else {
        const heldQty = Number(product.held_qty || 0);
        availableStock = Math.max(Number(product.stock_qty) - heldQty, 0);
      }
    } else if (product.stock_mode === "UNITS") {
      availableStock = Number(product.available_units || 0);
    }

    if (!isUnlimited && availableStock !== null) {
      if (availableStock <= 0) {
        console.log("[cart/add] out_of_stock:", {
          product_id: product.id,
          requested_qty: nextQty,
          available: 0,
        });
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "OUT_OF_STOCK",
          message: "❌ Producto sin stock por el momento.",
          available: 0,
        });
      }
      if (nextQty > availableStock) {
        console.log("[cart/add] out_of_stock:", {
          product_id: product.id,
          requested_qty: nextQty,
          available: availableStock,
        });
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "OUT_OF_STOCK",
          message: `❌ Solo quedan ${availableStock} disponibles.`,
          available: availableStock,
        });
      }
    }
    const unitPrice = Number(product.price);
    const totalPrice = Number((unitPrice * qty).toFixed(2));

    await client.query(
      `INSERT INTO cart_items
        (cart_id, product_id, unit_price_usd, qty, total_price_usd)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty,
                     unit_price_usd = EXCLUDED.unit_price_usd,
                     total_price_usd = (cart_items.qty + EXCLUDED.qty)
                       * EXCLUDED.unit_price_usd,
                     updated_at = now()`,
      [cart.id, product.id, unitPrice, qty, totalPrice]
    );

    await client.query(
      `UPDATE carts
       SET updated_at = now()
       WHERE id = $1`,
      [cart.id]
    );

    await client.query("COMMIT");
    const itemsRes = await client.query(
      `SELECT ci.product_id,
              p.name,
              ci.unit_price_usd,
              ci.qty,
              ci.total_price_usd
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at ASC`,
      [cart.id]
    );
    const items = itemsRes.rows.map((item) => ({
      product_id: item.product_id,
      name: item.name,
      unit_price_usd: Number(item.unit_price_usd),
      qty: Number(item.qty),
      total_price_usd: Number(item.total_price_usd),
    }));
    const total = items.reduce((sum, item) => sum + item.total_price_usd, 0);

    return res.status(201).json({
      items,
      total_usd: Number(total.toFixed(2)),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function clearCart(req, res, next) {
  const telegramId = normalizeTelegramId(req.body.telegram_id);
  if (!telegramId) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  const pool = getPool();
  await ensureProductCategorySchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const cart = await getActiveCart(telegramId, client);

    if (cart) {
      const cartId = cart.id;
      await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
      await client.query(
        `UPDATE carts SET updated_at = now() WHERE id = $1`,
        [cartId]
      );
    }

    await client.query("COMMIT");
    return res.json({ status: "cleared" });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function checkoutCart(req, res, next) {
  const telegramId = normalizeTelegramId(req.body.telegram_id);
  const username = req.body.username || null;
  if (!telegramId) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("[cart/checkout] telegram_id:", telegramId);
    const user = await ensureUser(client, telegramId, username);
    const cart = await getActiveCart(telegramId, client, { forUpdate: true });

    if (!cart) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Tu carrito está vacío" });
    }

    console.log("[cart/checkout] cart:", { id: cart.id, status: cart.status });
    const itemsRes = await client.query(
      `SELECT ci.*,
              p.name,
              p.price,
              p.out_of_stock,
              p.stock_mode,
              p.stock_qty,
              p.unique_purchase
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1
       ORDER BY p.name ASC
       FOR UPDATE OF p`,
      [cart.id]
    );

    if (itemsRes.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("[cart/checkout] items_count:", 0);
      return res.status(400).json({ message: "Tu carrito está vacío" });
    }

    console.log("[cart/checkout] items_count:", itemsRes.rowCount);

    const productIds = Array.from(
      new Set(itemsRes.rows.map((item) => item.product_id))
    );
    const isAdmin = isAdminTelegramId(telegramId);

    if (!isAdmin) {
      const uniqueItems = itemsRes.rows.filter((item) => isUniquePurchaseActive(item));
      for (const item of uniqueItems) {
        if (Number(item.qty) > 1) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            error: "UNIQUE_LIMIT",
            message: "❌ Este producto solo lo puedes reclamar una vez.",
          });
        }
      }
      if (uniqueItems.length > 0) {
        const uniqueProductIds = uniqueItems.map((item) => item.product_id);
        const purchasedRes = await client.query(
          `SELECT 1
           FROM orders o
           WHERE o.user_id = $1
             AND o.product_id = ANY($2)
             AND o.status IN ('PAID', 'DELIVERED')
           LIMIT 1`,
          [user.id, uniqueProductIds]
        );
        if (purchasedRes.rowCount > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            error: "UNIQUE_ALREADY_PURCHASED",
            message: "❌ Este producto solo lo puedes reclamar una vez.",
          });
        }
      }
    }
    const holdsMap = new Map();
    const unitsMap = new Map();

    if (productIds.length > 0) {
      const holdsRes = await client.query(
        `SELECT product_id, COALESCE(SUM(qty), 0)::int AS held_qty
         FROM product_stock_holds
         WHERE status = 'HELD' AND expires_at > now() AND product_id = ANY($1)
         GROUP BY product_id`,
        [productIds]
      );
      for (const row of holdsRes.rows) {
        holdsMap.set(row.product_id, Number(row.held_qty));
      }

      const unitsRes = await client.query(
        `SELECT product_id, COUNT(*)::int AS available_units
         FROM product_stock_units
         WHERE status = 'AVAILABLE' AND product_id = ANY($1)
         GROUP BY product_id`,
        [productIds]
      );
      for (const row of unitsRes.rows) {
        unitsMap.set(row.product_id, Number(row.available_units));
      }
    }

    for (const item of itemsRes.rows) {
      const qty = Number(item.qty);
      if (item.out_of_stock) {
        console.log("[cart/checkout] out_of_stock:", {
          product_id: item.product_id,
        });
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "OUT_OF_STOCK",
          message: "❌ Producto agotado por el momento.",
        });
      }
      if (item.stock_mode === "SIMPLE") {
        if (isUniquePurchaseActive(item)) {
          continue;
        }
        if (item.stock_qty !== null && item.stock_qty !== undefined) {
          const heldQty = holdsMap.get(item.product_id) || 0;
          const available = Math.max(Number(item.stock_qty) - heldQty, 0);
          if (qty > available) {
            console.log("[cart/checkout] out_of_stock:", {
              product_id: item.product_id,
              requested_qty: qty,
              available,
            });
            await client.query("ROLLBACK");
            return res.status(409).json({
              ok: false,
              error: "OUT_OF_STOCK",
              message: `❌ Solo quedan ${available} disponibles.`,
              available,
            });
          }
        }
      } else if (item.stock_mode === "UNITS") {
        const available = unitsMap.get(item.product_id) || 0;
        if (qty > available) {
          console.log("[cart/checkout] out_of_stock:", {
            product_id: item.product_id,
            requested_qty: qty,
            available,
          });
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            error: "OUT_OF_STOCK",
            message: `❌ Solo quedan ${available} disponibles.`,
            available,
          });
        }
      }
    }
    const total = itemsRes.rows.reduce((sum, item) => {
      const unitPrice = Number(item.unit_price_usd ?? item.price);
      if (item.total_price_usd !== null && item.total_price_usd !== undefined) {
        return sum + Number(item.total_price_usd);
      }
      return sum + unitPrice * Number(item.qty);
    }, 0);
    const totalRounded = Number(total.toFixed(2));
    const isFreeOrder = totalRounded <= 0;

    const firstItem = itemsRes.rows[0];

    const expirySeconds = Math.max(
      parseInt(process.env.ORDER_EXPIRY_SECONDS || "", 10)
        || (parseInt(process.env.ORDER_EXPIRY_MINUTES || "", 10) || 0) * 60
        || 900,
      1
    );
    const holdExpirySeconds = isFreeOrder
      ? Math.max(expirySeconds, 365 * 24 * 60 * 60)
      : expirySeconds;

    await syncOrderNumberSequence(client);

    let affiliateId = user.referred_by_affiliate_id;
    if (affiliateId) {
      const affiliateRes = await client.query(
        "SELECT status FROM affiliates WHERE id = $1",
        [affiliateId]
      );
      if (
        affiliateRes.rowCount === 0
        || affiliateRes.rows[0].status !== "APPROVED"
      ) {
        affiliateId = null;
      }
    }

    const orderRes = await client.query(
      `INSERT INTO orders
        (user_id, product_id, affiliate_id, status, unit_price_at_purchase)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        user.id,
        firstItem.product_id,
        affiliateId,
        "WAITING_PAYMENT",
        totalRounded,
      ]
    );
    let orderRow = orderRes.rows[0];
    if (isFreeOrder) {
      const freeOrderRes = await client.query(
        `UPDATE orders
         SET free_order_number = COALESCE(
           free_order_number,
           nextval('orders_free_order_number_seq')
         )
         WHERE id = $1
         RETURNING *`,
        [orderRow.id]
      );
      if (freeOrderRes.rowCount > 0) {
        orderRow = freeOrderRes.rows[0];
      }
    }

    for (const item of itemsRes.rows) {
      const qty = Number(item.qty);
      if (item.stock_mode === "SIMPLE") {
        if (item.stock_qty !== null && item.stock_qty !== undefined) {
          await client.query(
            `INSERT INTO product_stock_holds
              (product_id, order_id, cart_id, telegram_id, qty, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'HELD', now() + ($6 * interval '1 second'))`,
            [
              item.product_id,
              orderRow.id,
              cart.id,
              Number(telegramId),
              qty,
              holdExpirySeconds,
            ]
          );
          console.log("[stock/hold] created", {
            order_id: orderRow.id,
            product_id: item.product_id,
            qty,
            expires_at: new Date(Date.now() + holdExpirySeconds * 1000).toISOString(),
          });
        }
      } else if (item.stock_mode === "UNITS") {
        const holdRes = await client.query(
          `WITH picked AS (
             SELECT id
             FROM product_stock_units
             WHERE product_id = $1 AND status = 'AVAILABLE'
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           UPDATE product_stock_units
           SET status = 'HELD',
               held_by_order_id = $3,
               held_by_telegram_id = $4,
               held_by_username = $5,
               held_at = now()
           WHERE id IN (SELECT id FROM picked)
           RETURNING id`,
          [
            item.product_id,
            qty,
            orderRow.id,
            Number(telegramId),
            username,
          ]
        );

        if (holdRes.rowCount < qty) {
          console.log("[cart/checkout] hold_failed:", {
            product_id: item.product_id,
            requested_qty: qty,
            held: holdRes.rowCount,
          });
          await client.query("ROLLBACK");
          const available = holdRes.rowCount;
          return res.status(409).json({
            ok: false,
            error: "OUT_OF_STOCK",
            message: `❌ Solo quedan ${available} disponibles.`,
            available,
          });
        }
        console.log("[stock/hold] created", {
          order_id: orderRow.id,
          product_id: item.product_id,
          qty: holdRes.rowCount,
          expires_at: new Date(Date.now() + holdExpirySeconds * 1000).toISOString(),
        });
      }
    }

    for (const item of itemsRes.rows) {
      const qty = Number(item.qty);
      const unitPrice = Number(item.unit_price_usd ?? item.price);
      const totalPrice = Number((unitPrice * qty).toFixed(2));
      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, qty, unit_price_usd, total_price_usd, line_total_usd, price_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orderRow.id,
          item.product_id,
          qty,
          unitPrice,
          totalPrice,
          totalPrice,
          unitPrice,
        ]
      );
    }

    await client.query(
      `UPDATE carts
       SET status = 'CHECKED_OUT', updated_at = now()
       WHERE telegram_id = $1 AND status = 'ACTIVE'`,
      [telegramId]
    );

    await client.query(
      `INSERT INTO carts (telegram_id, status)
       VALUES ($1, 'ACTIVE')`,
      [telegramId]
    );

    await client.query("COMMIT");
    return res.json({
      order_id: orderRow.id,
      total_usd: totalRounded,
      free_order: isFreeOrder,
      free_order_number: orderRow.free_order_number || null,
      free_order_label: formatFreeOrderLabel(orderRow.free_order_number),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[cart/checkout] FAILED:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      hint: error?.hint,
    });
    console.error(error);
    return res.status(500).json({
      error: "CHECKOUT_FAILED",
      message: "No se pudo procesar el checkout",
    });
  } finally {
    client.release();
  }
}

module.exports = {
  getCart,
  addToCart,
  clearCart,
  checkoutCart,
};
