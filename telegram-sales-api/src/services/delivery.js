const { sendMessage, sendPhoto, sendVideo, sendDocument } = require("./telegram");

const DEFAULT_UNITS_TEMPLATE = `━━━━━━━━━━━━━━━━━━
🔐 <b>{{title}}</b>
━━━━━━━━━━━━━━━━━━

👤 <b>Usuario:</b>
<code>{{username}}</code>

🔑 <b>Password:</b>
<code>{{password}}</code>

🗓 <b>Inicio:</b> <code>{{start_at}}</code>
⏳ <b>Expira:</b> <code>{{expires_at}}</code>

📝 <b>Notas:</b>
{{notes}}

━━━━━━━━━━━━━━━━━━
👤 <b>Comprador:</b>
<code>{{buyer_telegram_id}}</code>
━━━━━━━━━━━━━━━━━━`;

const DEFAULT_UNITS_TEMPLATE_EN = `━━━━━━━━━━━━━━━━━━
🔐 <b>{{title}}</b>
━━━━━━━━━━━━━━━━━━

👤 <b>User:</b>
<code>{{username}}</code>

🔑 <b>Password:</b>
<code>{{password}}</code>

🗓 <b>Start:</b> <code>{{start_at}}</code>
⏳ <b>Expires:</b> <code>{{expires_at}}</code>

📝 <b>Notes:</b>
{{notes}}

━━━━━━━━━━━━━━━━━━
👤 <b>Buyer:</b>
<code>{{buyer_telegram_id}}</code>
━━━━━━━━━━━━━━━━━━`;

function normalizeDelay(value, fallbackMs) {
  if (value === undefined || value === null || value === "") {
    return fallbackMs;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return Math.max(parsed, 0);
}

const DELIVERY_INITIAL_DELAY_MS = normalizeDelay(
  process.env.DELIVERY_INITIAL_DELAY_MS,
  10000
);
const DELIVERY_MESSAGE_INTERVAL_MS = normalizeDelay(
  process.env.DELIVERY_MESSAGE_INTERVAL_MS,
  1000
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTemplate(template, data) {
  const rawKeys = new Set(["buyer_username_line"]);
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) =>
    rawKeys.has(key) ? data[key] ?? "" : escapeHtml(data[key] ?? "")
  );
}

function normalizePayload(payload) {
  if (!payload) {
    return {};
  }
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch (error) {
      return {};
    }
  }
  return payload;
}

function buildUnitsMessage(product, unit, telegramId, locale = "es") {
  const payload = normalizePayload(unit.payload);
  const now = new Date();
  const normalizeUnit = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "dia" || raw === "dias") return "days";
    if (raw === "semana" || raw === "semanas") return "weeks";
    if (raw === "mes" || raw === "meses") return "months";
    if (raw === "ano" || raw === "anos" || raw === "año" || raw === "años") return "years";
    return raw;
  };
  const addDuration = (base, value, unit) => {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    const next = new Date(base.getTime());
    switch (normalizeUnit(unit)) {
      case "weeks":
        next.setDate(next.getDate() + amount * 7);
        break;
      case "months":
        next.setMonth(next.getMonth() + amount);
        break;
      case "years":
        next.setFullYear(next.getFullYear() + amount);
        break;
      case "days":
      default:
        next.setDate(next.getDate() + amount);
        break;
    }
    return next;
  };
  const formatDate = (date) => {
    if (!date) {
      return "";
    }
    return date.toISOString().slice(0, 10);
  };
  const durationValue = payload.duration_value || payload.duration || "";
  const durationUnit = payload.duration_unit || "";
  const computedExpires = addDuration(now, durationValue, durationUnit);
  const startAt =
    payload.start_at || payload.starts_at || formatDate(now);
  const expiresAt =
    payload.expires_at || formatDate(computedExpires) || "";
  const rawBuyerUsername = payload.buyer_username || unit.held_by_username || "";
  const cleanedBuyerUsername = String(rawBuyerUsername || "").trim();
  const buyerUsernameLine = cleanedBuyerUsername
    ? `\n👤 <b>Username:</b> <code>@${escapeHtml(
        cleanedBuyerUsername.replace(/^@/, "")
      )}</code>`
    : "";
  const notes = payload.notes ? String(payload.notes).trim() : "";
  const data = {
    title: product.name || "",
    ...payload,
    start_at: startAt,
    expires_at: expiresAt,
    notes: notes || "—",
    buyer_telegram_id: telegramId,
    buyer_username: cleanedBuyerUsername,
    buyer_username_line: buyerUsernameLine,
  };
  let template = product.delivery_template || DEFAULT_UNITS_TEMPLATE;
  if (locale === "en") {
    if (product.delivery_template_en) {
      template = product.delivery_template_en;
    } else if (!product.delivery_template) {
      template = DEFAULT_UNITS_TEMPLATE_EN;
    }
  }
  return renderTemplate(template, data);
}

function resolveMediaPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return {
    file_id: payload.telegram_file_id || payload.file_id,
    url: payload.url,
    path: payload.path,
    filename: payload.filename,
    caption: payload.caption || "",
    parse_mode: payload.caption ? "HTML" : undefined,
  };
}

function resolveTextMessages(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return payload.messages
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry.length > 0);
  }
  const text = payload.text || payload.message || payload.content || payload.body || "";
  if (!text) {
    return [];
  }
  return [String(text)];
}

async function deliverProductToTelegram({ telegramId, product, quantity, units, locale = "es" }) {
  let deliveriesCount = 0;
  const payload = normalizePayload(product.delivery_payload);
  const payloadEn = normalizePayload(product.delivery_payload_en);
  const localizedPayload = locale === "en"
    ? { ...payload, ...payloadEn }
    : payload;

  if (product.stock_mode === "UNITS") {
    if (!Array.isArray(units) || units.length < quantity) {
      throw new Error("UNITS_NOT_AVAILABLE");
    }
    for (const unit of units.slice(0, quantity)) {
      const text = buildUnitsMessage(product, unit, telegramId, locale);
      await sendMessage(telegramId, text, { parse_mode: "HTML" });
      deliveriesCount += 1;
      await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    }
    return deliveriesCount;
  }

  if (product.delivery_type === "TEXT") {
    const messages = resolveTextMessages(localizedPayload);
    if (messages.length === 0) {
      throw new Error("DELIVERY_TEXT_EMPTY");
    }
    const lines = [...messages];
    if (quantity > 1) {
      lines[0] = `x${quantity}\n\n${lines[0]}`;
    }
    for (const message of lines) {
      await sendMessage(telegramId, message, { parse_mode: "HTML" });
      deliveriesCount += 1;
      await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    }
    return deliveriesCount;
  }

  if (product.delivery_type === "LINK") {
    const url = payload.url || "";
    if (!url) {
      throw new Error("DELIVERY_LINK_EMPTY");
    }
    const message =
      quantity > 1 ? `x${quantity}\n\n${url}` : url;
    await sendMessage(telegramId, message, { parse_mode: "HTML" });
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    return deliveriesCount;
  }

  if (product.delivery_type === "EXPIRING_LINK") {
    const url = payload.url || "";
    const expiresAt = payload.expires_at || payload.expires || "";
    if (!url) {
      throw new Error("DELIVERY_LINK_EMPTY");
    }
    const noteLabel = locale === "en" ? "Expires" : "Expira";
    const note = expiresAt ? `\n\n${noteLabel}: ${expiresAt}` : "";
    const message =
      quantity > 1 ? `x${quantity}\n\n${url}${note}` : `${url}${note}`;
    await sendMessage(telegramId, message, { parse_mode: "HTML" });
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    return deliveriesCount;
  }

  if (quantity > 1) {
    const quantityLabel = locale === "en" ? "Quantity" : "Cantidad";
    await sendMessage(telegramId, `${quantityLabel}: x${quantity}`, {
      parse_mode: "HTML",
    });
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
  }

  const mediaPayload = resolveMediaPayload(localizedPayload);
  if (product.delivery_type === "IMAGE") {
    await sendPhoto(telegramId, mediaPayload);
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    return deliveriesCount;
  }
  if (product.delivery_type === "VIDEO") {
    await sendVideo(telegramId, mediaPayload);
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    return deliveriesCount;
  }
  if (product.delivery_type === "FILE") {
    await sendDocument(telegramId, mediaPayload);
    deliveriesCount += 1;
    await sleep(DELIVERY_MESSAGE_INTERVAL_MS);
    return deliveriesCount;
  }

  throw new Error("DELIVERY_TYPE_UNSUPPORTED");
}

async function deliverOrderToTelegram({ dbClient, orderId, telegramId }) {
  try {
    let userLocale = "es";
    try {
      const userRes = await dbClient.query(
        "SELECT locale FROM users WHERE telegram_id = $1",
        [telegramId]
      );
      if (userRes.rowCount > 0 && userRes.rows[0].locale === "en") {
        userLocale = "en";
      }
    } catch (error) {
      // ignore locale errors
    }

    const itemsRes = await dbClient.query(
      `SELECT oi.product_id, oi.qty
       FROM order_items oi
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );

    let items = itemsRes.rows;
    if (itemsRes.rowCount === 0) {
      const orderRes = await dbClient.query(
        `SELECT product_id, unit_price_at_purchase
         FROM orders
         WHERE id = $1`,
        [orderId]
      );
      if (orderRes.rowCount === 0 || !orderRes.rows[0]?.product_id) {
        return { delivered: false, error: "ORDER_ITEMS_NOT_FOUND" };
      }
      const productId = orderRes.rows[0].product_id;
      const unitPrice = Number(orderRes.rows[0].unit_price_at_purchase || 0);
      const qty = 1;
      const total = Number((unitPrice * qty).toFixed(2));
      try {
        await dbClient.query(
          `INSERT INTO order_items
            (order_id, product_id, qty, unit_price_usd, total_price_usd, line_total_usd, price_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, productId, qty, unitPrice, total, total, unitPrice]
        );
      } catch (error) {
        console.warn("[order/delivery] fallback insert failed", {
          orderId,
          product_id: productId,
          message: error?.message,
        });
      }
      console.warn("[order/delivery] order_items missing, fallback used", {
        orderId,
        product_id: productId,
      });
      items = [{ product_id: productId, qty }];
    }

    const productIds = items.map((row) => row.product_id);
    const productsRes = await dbClient.query(
      `SELECT id, name, name_en,
              delivery_type,
              delivery_payload, delivery_payload_en,
              delivery_template, delivery_template_en,
              stock_mode
       FROM products
       WHERE id = ANY($1)`,
      [productIds]
    );

    const productsById = new Map(
      productsRes.rows.map((row) => [row.id, row])
    );

    let deliveriesCount = 0;

    await sleep(DELIVERY_INITIAL_DELAY_MS);

    for (const item of items) {
      const product = productsById.get(item.product_id);
      if (!product) {
        return { delivered: false, error: "PRODUCT_NOT_FOUND" };
      }
      const localizedProduct = userLocale === "en"
        ? {
            ...product,
            name: product.name_en || product.name,
            delivery_payload: product.delivery_payload_en || product.delivery_payload,
          }
        : product;
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        continue;
      }

      let units = null;
      if (product.stock_mode === "UNITS") {
        const unitsRes = await dbClient.query(
          `SELECT id, payload, held_by_username
           FROM product_stock_units
           WHERE held_by_order_id = $1
             AND product_id = $2
             AND status = 'DELIVERED'
           ORDER BY created_at ASC`,
          [orderId, item.product_id]
        );
        if (unitsRes.rowCount < qty) {
          return { delivered: false, error: "UNITS_NOT_AVAILABLE" };
        }
        units = unitsRes.rows;
      }

      deliveriesCount += await deliverProductToTelegram({
        telegramId,
        product: localizedProduct,
        quantity: qty,
        units,
        locale: userLocale,
      });
    }

    console.log("[order-delivery] sent", {
      orderId,
      deliveriesCount,
    });
    return { delivered: true, deliveries_count: deliveriesCount };
  } catch (error) {
    return {
      delivered: false,
      error: error?.message || "DELIVERY_FAILED",
    };
  }
}

module.exports = {
  deliverOrderToTelegram,
  deliverProductToTelegram,
  renderTemplate,
};
