const ADMIN_PANEL_URL =
  process.env.ADMIN_PANEL_URL
  || "http://localhost:3000";

async function ensureAdminOrderNotificationSchema(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS order_admin_notifications (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       order_id uuid NOT NULL,
       admin_telegram_id bigint NOT NULL,
       message_id bigint NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       UNIQUE (order_id, admin_telegram_id)
     )`
  );
}

async function recordAdminOrderNotification(pool, orderId, adminTelegramId, messageId) {
  await ensureAdminOrderNotificationSchema(pool);
  await pool.query(
    `INSERT INTO order_admin_notifications (order_id, admin_telegram_id, message_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id, admin_telegram_id)
     DO UPDATE SET message_id = EXCLUDED.message_id, created_at = now()`,
    [orderId, adminTelegramId, messageId]
  );
}

async function listAdminOrderNotifications(pool, orderId) {
  await ensureAdminOrderNotificationSchema(pool);
  const res = await pool.query(
    `SELECT admin_telegram_id, message_id
     FROM order_admin_notifications
     WHERE order_id = $1`,
    [orderId]
  );
  return res.rows || [];
}

function formatOrderNumber(orderNumber) {
  if (!orderNumber) {
    return "-";
  }
  return String(orderNumber).padStart(5, "0");
}

function formatUsdAmount(amount) {
  const numeric = Number(amount || 0);
  const formatted = Number.isInteger(numeric)
    ? numeric.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${formatted}`;
}

function formatLocalAmount(amount, currency) {
  const numeric = Number(amount || 0);
  if (currency === "BTC" || currency === "LTC") {
    return numeric.toFixed(8);
  }
  if (currency === "USDT") {
    return numeric.toFixed(2);
  }
  return Math.floor(numeric).toLocaleString("es-CO");
}

function formatBogotaDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const text = date.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return text.replace(", ", " · ");
}

function formatPaymentMethod(method) {
  if (!method) {
    return "NO ESPECIFICADO";
  }
  const key = String(method).toUpperCase();
  const map = {
    BTC: "Bitcoin",
    LTC: "Litecoin",
    MP: "Mercado Pago",
    NEQUI: "Nequi",
    BINANCE: "Binance",
    BINANCE_ID: "Binance ID",
    USDT: "USDT",
    USDT_BSC: "USDT BSC",
    USDT_TRON: "USDT Tron",
    PAYPAL: "PayPal",
    WALLET: "Wallet",
  };
  return map[key] || key;
}

function formatPaymentStatus(status) {
  const key = String(status || "").toUpperCase();
  if (key === "APPROVED") return "✅ Aprobado";
  if (key === "REJECTED") return "❌ Rechazado";
  if (key === "PENDING") return "⏳ Pendiente";
  return status || "-";
}

function formatOrderStatus(status) {
  const key = String(status || "").toUpperCase();
  const labels = {
    CREATED: "Creada",
    WAITING_PAYMENT: "Esperando pago",
    PAID: "Pagada",
    DELIVERED: "Entregada",
    CANCELLED: "Cancelada",
    REFUNDED: "Reembolsada",
    EXPIRED: "Expirada",
  };
  return labels[key] || status || "-";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getFiatRate(currency) {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await response.json();
    if (data.result === "success") {
      return data.rates[currency] || null;
    }
  } catch (err) {
    console.error("Failed to get fiat rate", err);
  }
  return null;
}

async function getCryptoRate(symbol) {
  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`
    );
    const data = await response.json();
    return data[symbol]?.usd || null;
  } catch (err) {
    console.error("Failed to get crypto rate", err);
  }
  return null;
}

function normalizePaymentMethod(paymentMethod) {
  const raw = String(paymentMethod || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  if (raw === "MP") {
    return "MERCADO_PAGO";
  }
  if (raw === "BTC") {
    return "BITCOIN";
  }
  if (raw === "USDT_BSC" || raw === "USDT_TRON") {
    return "USDT";
  }
  return raw;
}

async function calculateLocalAmount(usdAmount, paymentMethod) {
  const method = normalizePaymentMethod(paymentMethod);
  const usdBase = Number(usdAmount) || 0;
  let currency = null;
  let rate = null;

  if (method === "NEQUI") {
    currency = "COP";
    rate = await getFiatRate("COP");
    if (rate) {
      return { currency, amount: usdBase * rate };
    }
  } else if (method === "MERCADO_PAGO") {
    currency = "MXN";
    rate = await getFiatRate("MXN");
    if (rate) {
      return { currency, amount: usdBase * rate };
    }
  } else if (method === "BITCOIN") {
    currency = "BTC";
    rate = await getCryptoRate("bitcoin");
    if (rate) {
      return { currency, amount: usdBase / rate };
    }
  } else if (method === "USDT") {
    currency = "USDT";
    return { currency, amount: usdBase };
  } else if (method === "LTC") {
    currency = "LTC";
    rate = await getCryptoRate("litecoin");
    if (rate) {
      return { currency, amount: usdBase / rate };
    }
  }

  return null;
}

function buildOrderNotificationCaption({
  order,
  user,
  items,
  payment,
  subtotalUsd,
  localTotal,
  markupPercent,
}) {
  const orderNumberText = order?.is_test
    ? "Prueba"
    : (
      order?.is_scam
        ? (
          order?.released_order_number
            ? `Estafa: ${formatOrderNumber(order?.released_order_number)}`
            : "Estafa"
        )
        : formatOrderNumber(order?.order_number)
    );
  const telegramId = user?.telegram_id ?? order?.telegram_id ?? "-";
  const usernameRaw = user?.telegram_username ?? order?.telegram_username;
  const username = usernameRaw
    ? `@${String(usernameRaw).replace(/^@/, "")}`
    : "-";
  const productName = items && items.length > 0
    ? items
        .map((item) => {
          const qty = Number(item.qty || 0);
          const name = String(item.name || "Item");
          return qty > 1 ? `${name} x${qty}` : name;
        })
        .join(", ")
    : String(order?.product_name || "-");

  const paymentMethod = payment?.payment_method || order?.payment_method || null;
  const paymentStatusText = order?.is_scam
    ? "🚨 Estafa"
    : escapeHtml(formatPaymentStatus(payment?.review_status));

  const lines = [
    "🧾 Detalle de la Orden",
    `🆔 Orden: <code>${escapeHtml(orderNumberText)}</code>`,
    `📌 Estado: ${
      order?.is_scam
        ? "🚨 Estafa"
        : order?.is_test
          ? `🧪 ${escapeHtml(order?.status || "PRUEBA")}`
          : escapeHtml(formatOrderStatus(order?.status))
    }`,
    "",
    "👤 Usuario",
    `🆔 Telegram ID: ${escapeHtml(telegramId)}`,
    `👤 Username: ${escapeHtml(username)}`,
    "",
    "📦 Producto",
    `🛒 Método: ${escapeHtml(productName)}`,
    `💵 Precio: ${formatUsdAmount(subtotalUsd)} USD`,
    "",
    "💰 Totales",
    `💲 Total USD: ${formatUsdAmount(subtotalUsd)}`,
    ...(order?.paid_with_wallet ? ["Pagado con saldo"] : []),
  ];

  if (localTotal && localTotal.currency) {
    const emoji = localTotal.currency === "COP" ? "🇨🇴" : "💱";
    lines.push(
      `${emoji} Total ${localTotal.currency}: ${formatLocalAmount(
        localTotal.amount,
        localTotal.currency
      )} ${localTotal.currency}`
    );
  }

  if (markupPercent) {
    lines.push(`🧮 Markup aplicado: ${markupPercent}%`);
  }

  lines.push(
    "",
    "💳 Pago",
    `🏦 Método: ${escapeHtml(formatPaymentMethod(paymentMethod))}`,
    `📉 Estado del pago: ${paymentStatusText}`,
    `⏰ Enviado: ${formatBogotaDateTime(payment?.submitted_at)}`,
    "",
    "🗓️ Información adicional",
    `📆 Orden creada: ${formatBogotaDateTime(order?.created_at)}`
  );

  return lines.join("\n");
}

function buildOrderNotificationKeyboard(order) {
  const telegramId = order?.telegram_id ?? "";
  const orderId = order?.id ?? "";
  return {
    inline_keyboard: [
      [
        { text: "Panel Web", callback_data: `admin_panel:${orderId}` },
        { text: "Panel Bot", callback_data: "adminui:home" },
      ],
      [
        { text: "Banear usuario", callback_data: `admin_ban:${telegramId}:${orderId}` },
      ],
    ],
  };
}

module.exports = {
  ADMIN_PANEL_URL,
  ensureAdminOrderNotificationSchema,
  recordAdminOrderNotification,
  listAdminOrderNotifications,
  buildOrderNotificationCaption,
  buildOrderNotificationKeyboard,
  calculateLocalAmount,
};
