const { randomBytes } = require("crypto");
const { getPool } = require("../db");
const { sendMessage, deleteMessage, editMessageCaption, editMessageText } = require("./telegram");
const { validatePaymentProofScreenshot } = require("./paymentProofValidation");
const { calculateLocalAmount } = require("./adminOrderNotification");

let walletSchemaReady = false;
let walletSchemaPromise = null;
let walletGiftSyncLastAt = 0;
let walletGiftSyncPromise = null;
let walletTopupSyncLastAt = 0;
let walletTopupSyncPromise = null;

function getWalletSyncThrottleMs() {
  return Math.max(
    Number.parseInt(process.env.WALLET_SYNC_THROTTLE_MS || "", 10) || 30000,
    1000
  );
}

function getWalletSyncBatchLimit() {
  return Math.max(
    Number.parseInt(process.env.WALLET_SYNC_BATCH_LIMIT || "", 10) || 50,
    1
  );
}

function shouldThrottleWalletSync(executor, lastAt) {
  if (!executor || typeof executor.connect !== "function") {
    return false;
  }
  return Date.now() - lastAt < getWalletSyncThrottleMs();
}

function getWalletTopupExpirySeconds() {
  return Math.max(
    Number.parseInt(process.env.ORDER_EXPIRY_SECONDS || "", 10)
      || (Number.parseInt(process.env.ORDER_EXPIRY_MINUTES || "", 10) || 0) * 60
      || 900,
    60
  );
}

function formatWalletTopupNumber(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "-";
  }
  return `R${String(parsed).padStart(5, "0")}`;
}

function getWalletTopupDisplayNumber(topup) {
  if (!topup || typeof topup !== "object") {
    return null;
  }
  const current = Number.parseInt(String(topup.topup_number || ""), 10);
  if (Number.isFinite(current) && current > 0) {
    return current;
  }
  const released = Number.parseInt(String(topup.released_topup_number || ""), 10);
  if (Number.isFinite(released) && released > 0) {
    return released;
  }
  return null;
}

function withWalletTopupDisplayNumber(row) {
  return row;
}

function formatWalletTopupAdminStatus(value) {
  const key = String(value || "").trim().toUpperCase();
  if (key === "SUBMITTED") return "⏳ Pendiente";
  if (key === "APPROVED") return "✅ Aprobado";
  if (key === "REJECTED") return "❌ Rechazado";
  if (key === "SCAM") return "🚨 Estafa";
  if (key === "EXPIRED") return "⌛ Expirada";
  if (key === "CANCELLED") return "🛑 Cancelada";
  return key || "-";
}

function formatWalletTopupAdminMethod(value) {
  const key = String(value || "").trim().toUpperCase();
  const labels = {
    NEQUI: "NEQUI",
    BINANCE_ID: "BINANCE ID",
    BTC: "BTC",
    LTC: "LTC",
    USDT_TRON: "USDT TRON",
    USDT_BSC: "USDT BSC",
    USDT: "USDT",
    CRYPTO: "CRYPTO",
  };
  return labels[key] || key || "-";
}

function formatBogotaDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).replace(",", " ·");
}

function formatWalletTopupAdminLocalAmount(localTotal) {
  if (!localTotal || !localTotal.currency) {
    return null;
  }
  const currency = String(localTotal.currency || "").toUpperCase();
  const amount = Number(localTotal.amount || 0);
  if (!Number.isFinite(amount)) {
    return null;
  }
  if (currency === "COP") {
    return `🇨🇴 Cambio: ${Math.floor(amount).toLocaleString("es-CO")} COP`;
  }
  if (currency === "BTC" || currency === "LTC") {
    return `💱 Cambio: ${amount.toFixed(8)} ${currency}`;
  }
  if (currency === "USDT") {
    return `💱 Cambio: ${amount.toFixed(2)} ${currency}`;
  }
  return `💱 Cambio: ${amount} ${currency}`;
}

function normalizeWalletTopupPaymentMethod(method) {
  const raw = String(method || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  if (["BTC", "LTC", "USDT_TRON", "USDT_BSC", "USDT"].includes(raw)) {
    return "CRYPTO";
  }
  return raw;
}

async function getWalletTopupPaymentMarkup(executor, paymentMethod) {
  const key = normalizeWalletTopupPaymentMethod(paymentMethod);
  if (!key) {
    return null;
  }
  const res = await executor.query(
    "SELECT markup FROM payment_methods WHERE method_key = $1",
    [key]
  );
  const rawMarkup = res.rows[0]?.markup;
  if (rawMarkup == null || rawMarkup === "") {
    return null;
  }
  const value = Number(String(rawMarkup).trim());
  return Number.isFinite(value) ? value : null;
}

async function resolveWalletTopupTotalsWithMarkup(executor, subtotalUsd, paymentMethod) {
  const baseSubtotal = Number.isFinite(Number(subtotalUsd))
    ? Number(Number(subtotalUsd).toFixed(2))
    : 0;
  let localTotal = await calculateLocalAmount(baseSubtotal, paymentMethod);
  let markupPercent = null;

  if (localTotal && localTotal.amount != null) {
    try {
      const markup = await getWalletTopupPaymentMarkup(executor, paymentMethod);
      if (markup != null && Number.isFinite(Number(markup))) {
        const localCurrency = String(localTotal.currency || "").trim().toUpperCase();
        const localAmount = Number(localTotal.amount);
        const isDollarEquivalent = localCurrency === "USD" || localCurrency === "USDT";
        if (Number.isFinite(localAmount) && !isDollarEquivalent) {
          markupPercent = Number(markup);
          const factor = 1 + markupPercent / 100;
          localTotal = {
            ...localTotal,
            amount: localAmount * factor,
          };
        }
      }
    } catch (error) {
      console.error("Failed to resolve wallet topup totals with markup", error);
    }
  }

  return {
    subtotalUsd: baseSubtotal,
    localTotal,
    markupPercent,
  };
}

async function ensureWalletTopupAdminNotificationSchema(executor = null) {
  const db = executor || getPool();
  await db.query(
    `CREATE TABLE IF NOT EXISTS wallet_topup_admin_notifications (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       topup_id uuid NOT NULL,
       admin_telegram_id bigint NOT NULL,
       message_id bigint NOT NULL,
       message_type text NOT NULL DEFAULT 'photo' CHECK (message_type IN ('photo', 'text')),
       created_at timestamptz NOT NULL DEFAULT now(),
       UNIQUE (topup_id, admin_telegram_id)
     )`
  );
}

async function recordWalletTopupAdminNotification(
  executor,
  topupId,
  adminTelegramId,
  messageId,
  messageType = "photo"
) {
  await ensureWalletTopupAdminNotificationSchema(executor);
  await executor.query(
    `INSERT INTO wallet_topup_admin_notifications (
       topup_id,
       admin_telegram_id,
       message_id,
       message_type
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (topup_id, admin_telegram_id)
     DO UPDATE SET
       message_id = EXCLUDED.message_id,
       message_type = EXCLUDED.message_type,
       created_at = now()`,
    [topupId, adminTelegramId, messageId, messageType]
  );
}

async function listWalletTopupAdminNotifications(executor, topupId) {
  await ensureWalletTopupAdminNotificationSchema(executor);
  const res = await executor.query(
    `SELECT admin_telegram_id, message_id, message_type
     FROM wallet_topup_admin_notifications
     WHERE topup_id = $1`,
    [topupId]
  );
  return res.rows || [];
}

async function buildWalletTopupAdminCaption(topup, executor = null) {
  const db = executor || getPool();
  const topupLabel = formatWalletTopupNumber(getWalletTopupDisplayNumber(topup));
  const username = topup?.telegram_username
    ? `@${String(topup.telegram_username).replace(/^@+/, "")}`
    : "-";
  const totals = await resolveWalletTopupTotalsWithMarkup(
    db,
    Number(topup?.amount_usd || 0),
    topup?.payment_method
  );
  const localTotalLine = formatWalletTopupAdminLocalAmount(totals.localTotal);
  return [
    "💳 <b>Nueva recarga</b>",
    "",
    "🧾 <b>Detalle de la Orden</b>",
    `🆔 Orden: <code>${topupLabel}</code>`,
    "",
    `🆔 Telegram ID: ${topup?.telegram_id || "-"}`,
    `👤 Usuario: ${username}`,
    "",
    "💰 <b>Total:</b>",
    `💲 Monto: <b>$${Number(totals.subtotalUsd || 0).toFixed(0)} USD</b>`,
    ...(localTotalLine ? [localTotalLine] : []),
    ...(totals.markupPercent != null && Number.isFinite(Number(totals.markupPercent))
      ? [`🧮 Markup aplicado: ${Number(totals.markupPercent)}%`]
      : []),
    "",
    "💳 <b>Pago</b>",
    `🏦 Método: <b>${formatWalletTopupAdminMethod(topup?.payment_method)}</b>`,
    `📉 Estado del pago: <b>${formatWalletTopupAdminStatus(topup?.status)}</b>`,
    `⏰ Enviado: <b>${formatBogotaDateTime(topup?.submitted_at)}</b>`,
    `📆 Orden creada: <b>${formatBogotaDateTime(topup?.created_at)}</b>`,
  ].join("\n");
}

function getBotUsername() {
  return String(
    process.env.BOT_USERNAME
      || process.env.NEXT_PUBLIC_BOT_USERNAME
      || process.env.TELEGRAM_BOT_USERNAME
      || ""
  ).replace(/^@+/, "").trim();
}

let cachedWalletGiftBotUsername = "";
let cachedWalletGiftBotUsernameAt = 0;
const WALLET_GIFT_BOT_USERNAME_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveBotUsername() {
  const configured = getBotUsername();
  if (configured) {
    return configured;
  }

  const now = Date.now();
  if (
    cachedWalletGiftBotUsername
    && now - cachedWalletGiftBotUsernameAt < WALLET_GIFT_BOT_USERNAME_CACHE_TTL_MS
  ) {
    return cachedWalletGiftBotUsername;
  }

  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    return "";
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    const username = String(data?.result?.username || "")
      .replace(/^@+/, "")
      .trim();
    if (response.ok && data?.ok && username) {
      cachedWalletGiftBotUsername = username;
      cachedWalletGiftBotUsernameAt = now;
      return username;
    }
  } catch (error) {
    console.error("Failed to resolve bot username for wallet gifts", error);
  }

  return "";
}

function formatGiftUsd(amount) {
  return `$${Number(Number(amount || 0).toFixed(2)).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} USD`;
}

function buildWalletGiftClaimLink(botUsername, claimToken) {
  const token = String(claimToken || "").trim();
  if (!botUsername || !token) {
    return "";
  }
  return `https://t.me/${botUsername}?start=g${token}`;
}

function normalizeTelegramChatId(value) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+$/.test(raw)) {
    return "";
  }
  return raw;
}

let walletGiftSchemaReady = false;
let walletGiftSchemaPromise = null;
const walletGiftCleanupTimers = new Map();

function scheduleWalletGiftTelegramCleanup(giftId, chatId, messageIds, delayMs = 5 * 60 * 1000) {
  const safeGiftId = String(giftId || "").trim();
  const safeChatId = normalizeTelegramChatId(chatId);
  const safeMessageIds = Array.from(
    new Set(
      (Array.isArray(messageIds) ? messageIds : [])
        .map((value) => Number.parseInt(String(value || ""), 10))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
  if (!safeGiftId || !safeChatId || !safeMessageIds.length) {
    return;
  }
  const timerKey = `${safeGiftId}:${safeChatId}:${safeMessageIds.join(",")}`;
  if (walletGiftCleanupTimers.has(timerKey)) {
    clearTimeout(walletGiftCleanupTimers.get(timerKey));
  }
  const timer = setTimeout(async () => {
    walletGiftCleanupTimers.delete(timerKey);
    for (const messageId of safeMessageIds) {
      try {
        await deleteMessage(safeChatId, messageId);
      } catch (_error) {
        // fallback cleanup job handles leftovers
      }
    }
  }, Math.max(Number(delayMs) || 0, 1000));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  walletGiftCleanupTimers.set(timerKey, timer);
}

async function ensureWalletGiftSchema(executor = null) {
  if (walletGiftSchemaReady) {
    return;
  }
  if (walletGiftSchemaPromise) {
    await walletGiftSchemaPromise;
    return;
  }
  const db = executor || getPool();
  walletGiftSchemaPromise = (async () => {
    await ensureUserWalletSchema(db);
    await db.query(
      `CREATE TABLE IF NOT EXISTS wallet_gifts (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         claim_token text NOT NULL UNIQUE,
         button_text text NOT NULL,
         amount_usd numeric(12,2) NOT NULL CHECK (amount_usd > 0),
         max_claims integer NOT NULL CHECK (max_claims > 0),
         claimed_count integer NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
         status text NOT NULL DEFAULT 'ACTIVE'
           CHECK (status IN ('ACTIVE','DEPLETED','EXPIRED','CANCELLED')),
         source_kind text NOT NULL DEFAULT 'PUBLICATION'
           CHECK (source_kind IN ('BROADCAST','PUBLICATION')),
         source_entity_id text,
         source_scope text NOT NULL DEFAULT 'PRIVATE'
           CHECK (source_scope IN ('PRIVATE','CHAT')),
         expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
         depleted_at timestamptz,
         cleanup_after_at timestamptz,
         winners_notice_sent_at timestamptz,
         cleanup_completed_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gifts_status_expires
       ON wallet_gifts(status, expires_at)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gifts_finalize_pending
       ON wallet_gifts(status, updated_at)
       WHERE status IN ('DEPLETED','EXPIRED') AND winners_notice_sent_at IS NULL`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gifts_cleanup_pending
       ON wallet_gifts(cleanup_after_at)
       WHERE cleanup_after_at IS NOT NULL AND cleanup_completed_at IS NULL`
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS wallet_gift_claims (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         gift_id uuid NOT NULL REFERENCES wallet_gifts(id) ON DELETE CASCADE,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         telegram_id bigint NOT NULL,
         telegram_username text,
         amount_usd numeric(12,2) NOT NULL CHECK (amount_usd > 0),
         claimed_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (gift_id, user_id)
       )`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gift_claims_gift
       ON wallet_gift_claims(gift_id, claimed_at ASC)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gift_claims_user
       ON wallet_gift_claims(user_id, claimed_at DESC)`
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS wallet_gift_messages (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         gift_id uuid NOT NULL REFERENCES wallet_gifts(id) ON DELETE CASCADE,
         chat_id bigint NOT NULL,
         chat_type text,
         message_id bigint NOT NULL,
         linked_message_id bigint,
         summary_message_id bigint,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (gift_id, chat_id, message_id)
       )`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_gift_messages_gift
       ON wallet_gift_messages(gift_id, chat_id)`
    );
  })();
  try {
    await walletGiftSchemaPromise;
    walletGiftSchemaReady = true;
  } finally {
    walletGiftSchemaPromise = null;
  }
}

function normalizeWalletGiftButton(button) {
  if (!button || typeof button !== "object") {
    return null;
  }
  const action = String(button.action || button.type || "").trim().toLowerCase();
  if (action !== "gift") {
    return null;
  }
  const text = String(button.text || "").trim().slice(0, 64);
  const amountUsd = Number(button.gift_amount_usd || button.amount_usd || button.amount || 0);
  const maxClaims = Number.parseInt(
    String(button.gift_max_claims || button.max_claims || button.claims || ""),
    10
  );
  const rowRaw = Number(button.row);
  const row = Number.isInteger(rowRaw) && rowRaw >= 0 ? rowRaw : 0;
  if (!text || !Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(maxClaims) || maxClaims <= 0) {
    return null;
  }
  return {
    text,
    row,
    action: "gift",
    gift_amount_usd: Number(amountUsd.toFixed(2)),
    gift_max_claims: maxClaims,
  };
}

async function createWalletGift(
  executor,
  {
    buttonText,
    amountUsd,
    maxClaims,
    sourceKind,
    sourceEntityId = null,
    sourceScope = "PRIVATE",
  }
) {
  await ensureWalletGiftSchema(executor);
  const claimToken = randomBytes(16).toString("hex");
  const result = await executor.query(
    `INSERT INTO wallet_gifts (
       claim_token,
       button_text,
       amount_usd,
       max_claims,
       source_kind,
       source_entity_id,
       source_scope
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      claimToken,
      String(buttonText || "").trim(),
      Number(Number(amountUsd || 0).toFixed(2)),
      maxClaims,
      String(sourceKind || "PUBLICATION").trim().toUpperCase(),
      sourceEntityId ? String(sourceEntityId).trim() : null,
      String(sourceScope || "PRIVATE").trim().toUpperCase(),
    ]
  );
  return result.rows[0] || null;
}

async function recordWalletGiftMessage(
  executor,
  {
    giftId,
    chatId,
    chatType = null,
    messageId,
    linkedMessageId = null,
  }
) {
  await ensureWalletGiftSchema(executor);
  const safeChatId = normalizeTelegramChatId(chatId);
  const safeMessageId = Number.parseInt(String(messageId || ""), 10);
  const safeLinkedMessageId = linkedMessageId == null
    ? null
    : Number.parseInt(String(linkedMessageId || ""), 10);
  if (!giftId || !safeChatId || !Number.isFinite(safeMessageId)) {
    return null;
  }
  const res = await executor.query(
    `INSERT INTO wallet_gift_messages (
       gift_id,
       chat_id,
       chat_type,
       message_id,
       linked_message_id
     )
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (gift_id, chat_id, message_id)
     DO UPDATE SET
       linked_message_id = COALESCE(EXCLUDED.linked_message_id, wallet_gift_messages.linked_message_id),
       updated_at = now()
     RETURNING *`,
    [giftId, safeChatId, chatType || null, safeMessageId, Number.isFinite(safeLinkedMessageId) ? safeLinkedMessageId : null]
  );
  return res.rows[0] || null;
}

async function prepareWalletGiftButtonsForSend(
  executor,
  buttons,
  {
    sourceKind,
    sourceEntityId = null,
    sourceScope = "PRIVATE",
  }
) {
  await ensureWalletGiftSchema(executor);
  const normalizedButtons = Array.isArray(buttons) ? buttons : [];
  let createdGift = null;
  let giftCount = 0;
  const resolved = [];
  for (const button of normalizedButtons) {
    const giftButton = normalizeWalletGiftButton(button);
    if (!giftButton) {
      resolved.push(button);
      continue;
    }
    giftCount += 1;
    if (giftCount > 1) {
      const error = new Error("WALLET_GIFT_BUTTON_LIMIT");
      error.code = "WALLET_GIFT_BUTTON_LIMIT";
      throw error;
    }
    createdGift = await createWalletGift(executor, {
      buttonText: giftButton.text,
      amountUsd: giftButton.gift_amount_usd,
      maxClaims: giftButton.gift_max_claims,
      sourceKind,
      sourceEntityId,
      sourceScope,
    });
    const botUsername = await resolveBotUsername();
    const claimLink = buildWalletGiftClaimLink(botUsername, createdGift?.claim_token);
    if (!claimLink) {
      const error = new Error("BOT_USERNAME_REQUIRED");
      error.code = "BOT_USERNAME_REQUIRED";
      throw error;
    }
    resolved.push({
      text: giftButton.text,
      url: claimLink,
      row: giftButton.row,
      action: "gift",
      gift_id: createdGift.id,
      gift_amount_usd: giftButton.gift_amount_usd,
      gift_max_claims: giftButton.gift_max_claims,
    });
  }
  return {
    buttons: resolved,
    gift: createdGift,
  };
}

async function listWalletGiftClaims(executor, giftId) {
  await ensureWalletGiftSchema(executor);
  const res = await executor.query(
    `SELECT wgc.*,
            u.telegram_username AS user_telegram_username
     FROM wallet_gift_claims wgc
     JOIN users u ON u.id = wgc.user_id
     WHERE gift_id = $1
     ORDER BY claimed_at ASC`,
    [giftId]
  );
  return res.rows || [];
}

async function listWalletGifts(
  executor,
  { status = "", sourceKind = "", page = 1, pageSize = 20 } = {}
) {
  await ensureWalletGiftSchema(executor);
  const safePage = Math.max(Number.parseInt(String(page || 1), 10) || 1, 1);
  const safePageSize = Math.max(
    Math.min(Number.parseInt(String(pageSize || 20), 10) || 20, 100),
    1
  );
  const offset = (safePage - 1) * safePageSize;
  const values = [];
  const filters = [];
  if (status) {
    values.push(String(status).trim().toUpperCase());
    filters.push(`wg.status = $${values.length}`);
  }
  if (sourceKind) {
    values.push(String(sourceKind).trim().toUpperCase());
    filters.push(`wg.source_kind = $${values.length}`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const countRes = await executor.query(
    `SELECT COUNT(*)::int AS total
     FROM wallet_gifts wg
     ${whereClause}`,
    values
  );
  const total = Number(countRes.rows[0]?.total || 0);
  const listRes = await executor.query(
    `SELECT wg.*,
            (wg.amount_usd * wg.claimed_count)::numeric(12,2) AS total_distributed_usd
     FROM wallet_gifts wg
     ${whereClause}
     ORDER BY wg.created_at DESC, wg.id DESC
     LIMIT $${values.length + 1}
     OFFSET $${values.length + 2}`,
    [...values, safePageSize, offset]
  );
  return {
    items: listRes.rows || [],
    total,
    page: safePage,
    page_size: safePageSize,
    total_pages: Math.max(Math.ceil(total / safePageSize), 1),
  };
}

async function getWalletGiftById(executor, giftId) {
  await ensureWalletGiftSchema(executor);
  const giftRes = await executor.query(
    `SELECT wg.*,
            (wg.amount_usd * wg.claimed_count)::numeric(12,2) AS total_distributed_usd
     FROM wallet_gifts wg
     WHERE wg.id = $1
     LIMIT 1`,
    [giftId]
  );
  if (giftRes.rowCount === 0) {
    return null;
  }
  const gift = giftRes.rows[0];
  const claims = await listWalletGiftClaims(executor, giftId);
  return {
    ...gift,
    claims,
  };
}

async function getWalletGiftByClaimToken(executor, claimToken) {
  await ensureWalletGiftSchema(executor);
  const res = await executor.query(
    `SELECT *
     FROM wallet_gifts
     WHERE claim_token = $1
     LIMIT 1`,
    [String(claimToken || "").trim()]
  );
  return res.rows[0] || null;
}

async function claimWalletGift(executor, { claimToken, telegramId }) {
  await ensureWalletGiftSchema(executor);
  const walletData = await getUserWalletByTelegramId(executor, telegramId);
  if (!walletData) {
    const error = new Error("USER_NOT_FOUND");
    error.code = "USER_NOT_FOUND";
    throw error;
  }
  const giftRes = await executor.query(
    `SELECT *
     FROM wallet_gifts
     WHERE claim_token = $1
     FOR UPDATE`,
    [String(claimToken || "").trim()]
  );
  if (giftRes.rowCount === 0) {
    const error = new Error("WALLET_GIFT_NOT_FOUND");
    error.code = "WALLET_GIFT_NOT_FOUND";
    throw error;
  }
  const gift = giftRes.rows[0];
  if (String(gift.status || "").toUpperCase() === "EXPIRED") {
    const error = new Error("WALLET_GIFT_EXPIRED");
    error.code = "WALLET_GIFT_EXPIRED";
    throw error;
  }
  if (String(gift.status || "").toUpperCase() === "DEPLETED") {
    const error = new Error("WALLET_GIFT_DEPLETED");
    error.code = "WALLET_GIFT_DEPLETED";
    throw error;
  }
  if (gift.expires_at && new Date(gift.expires_at).getTime() <= Date.now()) {
    await executor.query(
      `UPDATE wallet_gifts
       SET status = 'EXPIRED',
           updated_at = now(),
           cleanup_after_at = CASE
             WHEN source_scope = 'CHAT' THEN now() + interval '5 minutes'
             ELSE cleanup_after_at
           END
       WHERE id = $1`,
      [gift.id]
    );
    const error = new Error("WALLET_GIFT_EXPIRED");
    error.code = "WALLET_GIFT_EXPIRED";
    throw error;
  }
  const existingClaimRes = await executor.query(
    `SELECT *
     FROM wallet_gift_claims
     WHERE gift_id = $1
       AND user_id = $2
     LIMIT 1`,
    [gift.id, walletData.user.id]
  );
  if (existingClaimRes.rowCount > 0) {
    const error = new Error("WALLET_GIFT_ALREADY_CLAIMED");
    error.code = "WALLET_GIFT_ALREADY_CLAIMED";
    error.claim = existingClaimRes.rows[0];
    throw error;
  }
  if (Number(gift.claimed_count || 0) >= Number(gift.max_claims || 0)) {
    await executor.query(
      `UPDATE wallet_gifts
       SET status = 'DEPLETED',
           depleted_at = COALESCE(depleted_at, now()),
           cleanup_after_at = CASE
             WHEN source_scope = 'CHAT' THEN COALESCE(cleanup_after_at, now() + interval '5 minutes')
             ELSE cleanup_after_at
           END,
           updated_at = now()
       WHERE id = $1`,
      [gift.id]
    );
    const error = new Error("WALLET_GIFT_DEPLETED");
    error.code = "WALLET_GIFT_DEPLETED";
    throw error;
  }
  const tx = await recordWalletTransaction(executor, {
    userId: walletData.user.id,
    amount: gift.amount_usd,
    direction: "CREDIT",
    transactionType: "GIFT_CLAIM",
    referenceType: "wallet_gift",
    referenceId: gift.id,
    note: `Regalo promocional ${formatGiftUsd(gift.amount_usd)}`,
    visibleToUser: true,
  });
  const claimRes = await executor.query(
    `INSERT INTO wallet_gift_claims (
       gift_id,
       user_id,
       telegram_id,
       telegram_username,
       amount_usd
     )
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      gift.id,
      walletData.user.id,
      Number(walletData.user.telegram_id),
      walletData.user.telegram_username || null,
      gift.amount_usd,
    ]
  );
  const nextClaimedCount = Number(gift.claimed_count || 0) + 1;
  const depleted = nextClaimedCount >= Number(gift.max_claims || 0);
  const updatedGiftRes = await executor.query(
    `UPDATE wallet_gifts
     SET claimed_count = $2,
         status = $3,
         depleted_at = CASE WHEN $3 = 'DEPLETED' THEN COALESCE(depleted_at, now()) ELSE depleted_at END,
         cleanup_after_at = CASE
           WHEN $3 = 'DEPLETED' AND source_scope = 'CHAT'
             THEN COALESCE(cleanup_after_at, now() + interval '5 minutes')
           ELSE cleanup_after_at
         END,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [gift.id, nextClaimedCount, depleted ? "DEPLETED" : "ACTIVE"]
  );
  return {
    user: walletData.user,
    wallet: tx.wallet,
    transaction: tx.transaction,
    claim: claimRes.rows[0],
    gift: updatedGiftRes.rows[0] || gift,
    depleted,
  };
}

function buildWalletGiftWinnersMessage(gift, claims, botUsername = "") {
  const safeClaims = Array.isArray(claims) ? claims : [];
  const totalDistributed = Number(gift?.amount_usd || 0) * safeClaims.length;
  const safeBotUsername = String(botUsername || "").replace(/^@+/, "").trim() || "bot";
  if (safeClaims.length === 1) {
    const winner = safeClaims[0] || {};
    const username = winner?.telegram_username
      ? `@${String(winner.telegram_username).replace(/^@+/, "")}`
      : "-";
    return [
      "🎉 <b>Regalo agotado</b>",
      "",
      `💰 Se entrego <b>${formatGiftUsd(winner.amount_usd || gift?.amount_usd || 0)}</b> al usuario`,
      "",
      "<b>Usuario que reclamo:</b>",
      `🆔: <code>${winner.telegram_id || "-"}</code>`,
      `👤 Usuario: ${username}`,
      "",
      `✅ El saldo ya fue acreditado por @${safeBotUsername}`,
    ].join("\n");
  }
  const lines = [
    "🎉 <b>Regalo agotado</b>",
    "",
    `💰 Se repartieron <b>${formatGiftUsd(totalDistributed)}</b> entre <b>${safeClaims.length}</b> usuarios.`,
    "",
    "<b>Usuarios que reclamaron:</b>",
  ];
  if (!safeClaims.length) {
    lines.push("• -");
  } else {
    for (const [index, item] of safeClaims.entries()) {
      const username = item?.telegram_username
        ? `@${String(item.telegram_username).replace(/^@+/, "")}`
        : null;
      const identity = username
        ? `${username} · ${item.telegram_id}`
        : `ID: ${item.telegram_id}`;
      lines.push(
        `${index + 1}. ${identity} · ${formatGiftUsd(item.amount_usd)}`
      );
    }
  }
  lines.push("");
  lines.push(`✅ Los saldos ya fueron acreditados por @${safeBotUsername}`);
  return lines.join("\n");
}

async function finalizeWalletGiftStatus(executor, giftId) {
  await ensureWalletGiftSchema(executor);
  const giftRes = await executor.query(
    `SELECT *
     FROM wallet_gifts
     WHERE id = $1
     FOR UPDATE`,
    [giftId]
  );
  if (giftRes.rowCount === 0) {
    return null;
  }
  const gift = giftRes.rows[0];
  const status = String(gift.status || "").toUpperCase();
  const messagesRes = await executor.query(
    `SELECT *
     FROM wallet_gift_messages
     WHERE gift_id = $1
     ORDER BY created_at ASC`,
    [giftId]
  );
  const messages = messagesRes.rows || [];
  if (status === "DEPLETED" && !gift.winners_notice_sent_at && String(gift.source_scope || "").toUpperCase() === "CHAT") {
    const claims = await listWalletGiftClaims(executor, giftId);
    const winnersText = buildWalletGiftWinnersMessage(gift, claims, await resolveBotUsername());
    for (const row of messages) {
      const chatId = normalizeTelegramChatId(row.chat_id);
      if (!chatId) {
        continue;
      }
      try {
        if (row.message_id) {
          await deleteMessage(chatId, row.message_id);
        }
        if (row.linked_message_id) {
          await deleteMessage(chatId, row.linked_message_id);
        }
      } catch (_error) {
        // ignore missing/deleted original messages
      }
      try {
        const summary = await sendMessage(chatId, winnersText, { parse_mode: "HTML" });
        if (summary?.message_id) {
          await executor.query(
            `UPDATE wallet_gift_messages
             SET summary_message_id = $2,
                 message_id = NULL,
                 linked_message_id = NULL,
                 updated_at = now()
             WHERE id = $1`,
            [row.id, summary.message_id]
          );
          scheduleWalletGiftTelegramCleanup(giftId, chatId, [summary.message_id], 5 * 60 * 1000);
        }
      } catch (error) {
        console.error("wallet_gift_winners_notify_failed", {
          giftId,
          chatId,
          error: error?.message || String(error),
        });
      }
    }
    await executor.query(
      `UPDATE wallet_gifts
       SET winners_notice_sent_at = now(),
           cleanup_after_at = now() + interval '5 minutes',
           updated_at = now()
       WHERE id = $1`,
      [giftId]
    );
  } else if (status === "EXPIRED" && !gift.winners_notice_sent_at && String(gift.source_scope || "").toUpperCase() === "CHAT") {
    for (const row of messages) {
      const chatId = normalizeTelegramChatId(row.chat_id);
      if (!chatId) {
        continue;
      }
      try {
        if (row.message_id) {
          await editMessageText(chatId, row.message_id, "⌛ Regalo expirado", {});
        }
      } catch (_error) {
        try {
          if (row.message_id) {
            await editMessageCaption(chatId, row.message_id, "⌛ Regalo expirado", { parse_mode: "HTML" });
          }
        } catch (_ignored) {
          // ignore
        }
      }
    }
    await executor.query(
      `UPDATE wallet_gifts
       SET winners_notice_sent_at = now(),
           cleanup_after_at = COALESCE(cleanup_after_at, now() + interval '5 minutes'),
           updated_at = now()
       WHERE id = $1`,
      [giftId]
    );
  }
  return gift;
}

async function cleanupWalletGiftMessages(executor, giftId, chatId = null) {
  await ensureWalletGiftSchema(executor);
  const values = [giftId];
  let whereExtra = "";
  if (chatId != null) {
    values.push(Number(chatId));
    whereExtra = `AND chat_id = $2`;
  }
  const res = await executor.query(
    `SELECT *
     FROM wallet_gift_messages
     WHERE gift_id = $1
       ${whereExtra}
     ORDER BY created_at ASC`,
    values
  );
  for (const row of res.rows || []) {
    const safeChatId = normalizeTelegramChatId(row.chat_id);
    if (!safeChatId) {
      continue;
    }
    for (const messageId of [row.message_id, row.linked_message_id, row.summary_message_id]) {
      if (!messageId) {
        continue;
      }
      try {
        await deleteMessage(safeChatId, Number(messageId));
      } catch (_error) {
        // ignore missing/deleted messages
      }
    }
  }
  if (chatId == null) {
    await executor.query(
      `UPDATE wallet_gifts
       SET cleanup_completed_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [giftId]
    );
  }
}

async function syncWalletGifts(executor = null) {
  const db = executor || getPool();
  if (shouldThrottleWalletSync(executor, walletGiftSyncLastAt)) {
    return [];
  }
  if (executor && typeof executor.connect === "function" && walletGiftSyncPromise) {
    return walletGiftSyncPromise;
  }
  const runSync = async () => {
    const batchLimit = getWalletSyncBatchLimit();
    await ensureWalletGiftSchema(db);
    await db.query(
      `UPDATE wallet_gifts
       SET status = 'EXPIRED',
           updated_at = now(),
           cleanup_after_at = CASE
             WHEN source_scope = 'CHAT' THEN COALESCE(cleanup_after_at, now() + interval '5 minutes')
             ELSE cleanup_after_at
           END
       WHERE status = 'ACTIVE'
         AND expires_at <= now()`
    );
    const pendingRes = await db.query(
      `SELECT id
       FROM wallet_gifts
       WHERE status IN ('DEPLETED','EXPIRED')
         AND winners_notice_sent_at IS NULL
       ORDER BY updated_at ASC
       LIMIT $1`,
      [batchLimit]
    );
    for (const row of pendingRes.rows || []) {
      try {
        await finalizeWalletGiftStatus(db, row.id);
      } catch (error) {
        console.error("wallet_gift_finalize_failed", {
          giftId: row.id,
          error: error?.message || String(error),
        });
      }
    }
    const cleanupRes = await db.query(
      `SELECT id
       FROM wallet_gifts
       WHERE cleanup_after_at IS NOT NULL
         AND cleanup_after_at <= now()
         AND cleanup_completed_at IS NULL
       ORDER BY cleanup_after_at ASC
       LIMIT $1`,
      [batchLimit]
    );
    for (const row of cleanupRes.rows || []) {
      try {
        await cleanupWalletGiftMessages(db, row.id);
      } catch (error) {
        console.error("wallet_gift_cleanup_failed", {
          giftId: row.id,
          error: error?.message || String(error),
        });
      }
    }
    walletGiftSyncLastAt = Date.now();
    return [];
  };
  if (executor && typeof executor.connect === "function") {
    walletGiftSyncPromise = runSync().finally(() => {
      walletGiftSyncPromise = null;
    });
    return walletGiftSyncPromise;
  }
  return runSync();
}

async function ensureUserWalletSchema(executor = null) {
  if (walletSchemaReady) {
    return;
  }
  if (walletSchemaPromise) {
    await walletSchemaPromise;
    return;
  }
  const db = executor || getPool();
  walletSchemaPromise = (async () => {
    await db.query(
      `CREATE TABLE IF NOT EXISTS user_wallets (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
         currency text NOT NULL DEFAULT 'USD',
         balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    );

    await db.query(
      `CREATE TABLE IF NOT EXISTS user_wallet_transactions (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         wallet_id uuid NOT NULL REFERENCES user_wallets(id) ON DELETE CASCADE,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         transaction_type text NOT NULL,
         direction text NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
         amount numeric(12,2) NOT NULL CHECK (amount > 0),
         balance_before numeric(12,2) NOT NULL DEFAULT 0,
         balance_after numeric(12,2) NOT NULL DEFAULT 0,
         reference_type text,
         reference_id uuid,
         note text,
         visible_to_user boolean NOT NULL DEFAULT true,
         created_by_admin text,
         created_at timestamptz NOT NULL DEFAULT now()
       )`
    );

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_user_wallet_transactions_user_created
       ON user_wallet_transactions(user_id, created_at DESC)`
    );

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_user_wallet_transactions_reference
       ON user_wallet_transactions(reference_type, reference_id)`
    );

    await db.query(
      `CREATE SEQUENCE IF NOT EXISTS wallet_topups_number_seq START 1`
    );

    await db.query(
      `CREATE TABLE IF NOT EXISTS wallet_topups (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         topup_number bigint UNIQUE,
         released_topup_number bigint,
         amount_usd numeric(12,2) NOT NULL CHECK (amount_usd > 0),
         payment_method text,
         screenshot_file_id text,
         screenshot_unique_id text,
         status text NOT NULL DEFAULT 'CREATED'
           CHECK (status IN ('CREATED','SUBMITTED','APPROVED','REJECTED','CANCELLED','EXPIRED','SCAM')),
         reason text,
         created_at timestamptz NOT NULL DEFAULT now(),
         submitted_at timestamptz,
         approved_at timestamptz,
         rejected_at timestamptz,
         cancelled_at timestamptz,
         expires_at timestamptz NOT NULL DEFAULT (now() + (interval '1 second' * 900))
       )`
    );

    await db.query(
      `ALTER TABLE wallet_topups
       ADD COLUMN IF NOT EXISTS released_topup_number bigint`
    );

    await db.query(
      `ALTER TABLE wallet_topups
       DROP CONSTRAINT IF EXISTS wallet_topups_status_check`
    );

    await db.query(
      `ALTER TABLE wallet_topups
       ADD CONSTRAINT wallet_topups_status_check
       CHECK (status IN ('CREATED','SUBMITTED','APPROVED','REJECTED','CANCELLED','EXPIRED','SCAM'))`
    );

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_topups_status_created
       ON wallet_topups(status, created_at DESC)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_topups_created_expired
       ON wallet_topups(expires_at)
       WHERE status = 'CREATED'`
    );

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_topups_user_created
       ON wallet_topups(user_id, created_at DESC)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_topups_released_number
       ON wallet_topups(released_topup_number)
       WHERE released_topup_number IS NOT NULL`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_topups_releasable
       ON wallet_topups(created_at)
       WHERE status IN ('EXPIRED','REJECTED','SCAM') AND topup_number IS NOT NULL`
    );

    await db.query(
      `CREATE TABLE IF NOT EXISTS available_wallet_topup_numbers (
         topup_number bigint PRIMARY KEY,
         released_at timestamptz NOT NULL DEFAULT now(),
         source_topup_id uuid
       )`
    );

    await db.query(
      `ALTER TABLE order_payments
       ALTER COLUMN screenshot_file_id DROP NOT NULL`
    );

    await db.query(
      `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS paid_with_wallet boolean NOT NULL DEFAULT false`
    );

    await db.query(
      `CREATE INDEX IF NOT EXISTS orders_paid_with_wallet_idx
       ON orders(paid_with_wallet)`
    );

    walletSchemaReady = true;
  })();

  try {
    await walletSchemaPromise;
  } finally {
    walletSchemaPromise = null;
  }
}

async function ensureUserWalletForUser(executor, userId) {
  await ensureUserWalletSchema(executor);
  const result = await executor.query(
    `INSERT INTO user_wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = user_wallets.updated_at
     RETURNING *`,
    [userId]
  );
  return result.rows[0];
}

async function getUserWalletByUserId(executor, userId) {
  await ensureUserWalletSchema(executor);
  const wallet = await ensureUserWalletForUser(executor, userId);
  return wallet || null;
}

async function getUserWalletByTelegramId(executor, telegramIdOrUsername) {
  await ensureUserWalletSchema(executor);
  const rawLookup = String(telegramIdOrUsername || "").trim();
  const normalizedUsername = rawLookup.replace(/^@+/, "").trim().toLowerCase();
  const userRes = await executor.query(
    `SELECT id, telegram_id, telegram_username
     FROM users
     WHERE telegram_id = CASE WHEN $1 ~ '^[0-9]+$' THEN $1::bigint ELSE NULL END
        OR LOWER(COALESCE(telegram_username, '')) = $2
     LIMIT 1`,
    [rawLookup, normalizedUsername]
  );
  if (userRes.rowCount === 0) {
    return null;
  }
  const user = userRes.rows[0];
  const wallet = await ensureUserWalletForUser(executor, user.id);
  return { user, wallet };
}

async function recordWalletTransaction(
  executor,
  {
    userId,
    amount,
    direction,
    transactionType,
    referenceType = null,
    referenceId = null,
    note = null,
    visibleToUser = true,
    createdByAdmin = null,
  }
) {
  await ensureUserWalletSchema(executor);
  const wallet = await ensureUserWalletForUser(executor, userId);
  const walletRes = await executor.query(
    `SELECT *
     FROM user_wallets
     WHERE id = $1
     FOR UPDATE`,
    [wallet.id]
  );
  const lockedWallet = walletRes.rows[0];
  const currentBalance = Number(lockedWallet.balance || 0);
  const safeAmount = Number(Number(amount || 0).toFixed(2));
  const dir = String(direction || "").toUpperCase();
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    const error = new Error("INVALID_WALLET_AMOUNT");
    error.code = "INVALID_WALLET_AMOUNT";
    throw error;
  }
  if (!["CREDIT", "DEBIT"].includes(dir)) {
    const error = new Error("INVALID_WALLET_DIRECTION");
    error.code = "INVALID_WALLET_DIRECTION";
    throw error;
  }
  let nextBalance = currentBalance;
  if (dir === "CREDIT") {
    nextBalance = Number((currentBalance + safeAmount).toFixed(2));
  } else {
    if (currentBalance + 0.0001 < safeAmount) {
      const error = new Error("INSUFFICIENT_WALLET_BALANCE");
      error.code = "INSUFFICIENT_WALLET_BALANCE";
      error.available = currentBalance;
      throw error;
    }
    nextBalance = Number((currentBalance - safeAmount).toFixed(2));
  }

  await executor.query(
    `UPDATE user_wallets
     SET balance = $2,
         updated_at = now()
     WHERE id = $1`,
    [wallet.id, nextBalance]
  );

  const txRes = await executor.query(
    `INSERT INTO user_wallet_transactions (
       wallet_id,
       user_id,
       transaction_type,
       direction,
       amount,
       balance_before,
       balance_after,
       reference_type,
       reference_id,
       note,
       visible_to_user,
       created_by_admin
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      wallet.id,
      userId,
      transactionType,
      dir,
      safeAmount,
      currentBalance,
      nextBalance,
      referenceType,
      referenceId,
      note,
      Boolean(visibleToUser),
      createdByAdmin,
    ]
  );

  return {
    wallet: {
      ...lockedWallet,
      balance: nextBalance,
    },
    transaction: txRes.rows[0],
  };
}

async function getUserWalletHistoryByUserId(
  executor,
  userId,
  { limit = 20, visibleToUserOnly = false } = {}
) {
  await ensureUserWalletSchema(executor);
  const safeLimit = Math.max(Math.min(Number.parseInt(String(limit || 20), 10) || 20, 100), 1);
  const values = [userId];
  const visibilityClause = visibleToUserOnly
    ? `AND visible_to_user = true`
    : ``;
  values.push(safeLimit);
  const res = await executor.query(
    `SELECT *
     FROM user_wallet_transactions
     WHERE user_id = $1
       ${visibilityClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    values
  );
  return res.rows || [];
}

async function createWalletTopup(executor, { userId, amountUsd }) {
  await ensureUserWalletSchema(executor);
  const safeAmount = Number(Number(amountUsd || 0).toFixed(2));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    const error = new Error("INVALID_TOPUP_AMOUNT");
    error.code = "INVALID_TOPUP_AMOUNT";
    throw error;
  }
  const allocatedTopupNumber = await allocateWalletTopupNumber(executor);
  const result = await executor.query(
    `INSERT INTO wallet_topups (
       user_id,
       topup_number,
       amount_usd,
       status,
       expires_at
     )
     VALUES (
       $1,
       $2,
       $3,
       'CREATED',
       now() + ($4 * interval '1 second')
     )
     RETURNING *`,
    [userId, allocatedTopupNumber, safeAmount, getWalletTopupExpirySeconds()]
  );
  return withWalletTopupDisplayNumber(result.rows[0] || null);
}

async function allocateWalletTopupNumber(executor) {
  await ensureUserWalletSchema(executor);
  const recycledRes = await executor.query(
    `WITH picked AS (
       SELECT topup_number
       FROM available_wallet_topup_numbers
       ORDER BY topup_number ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM available_wallet_topup_numbers awtn
     USING picked
     WHERE awtn.topup_number = picked.topup_number
     RETURNING picked.topup_number`,
    []
  );
  if (recycledRes.rowCount > 0) {
    return Number(recycledRes.rows[0].topup_number);
  }
  const seqRes = await executor.query(
    `SELECT nextval('wallet_topups_number_seq') AS topup_number`
  );
  return Number(seqRes.rows[0]?.topup_number || 0);
}

async function releaseWalletTopupNumber(executor, topup) {
  const topupNumber = Number.parseInt(String(topup?.topup_number || ""), 10);
  if (!Number.isFinite(topupNumber) || topupNumber <= 0) {
    return;
  }
  await executor.query(
    `INSERT INTO available_wallet_topup_numbers (topup_number, source_topup_id)
     VALUES ($1, $2)
     ON CONFLICT (topup_number) DO NOTHING`,
    [topupNumber, topup.id || null]
  );
}

function parseWalletTopupLookupRef(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { ref: "", topupNumber: null };
  }
  if (/^[0-9]+$/.test(raw)) {
    return { ref: raw, topupNumber: Number.parseInt(raw, 10) };
  }
  const normalized = raw.toUpperCase();
  if (/^R\d+$/.test(normalized)) {
    return {
      ref: normalized,
      topupNumber: Number.parseInt(normalized.slice(1), 10),
    };
  }
  return { ref: raw, topupNumber: null };
}

async function resolveWalletTopupId(executor, rawRef) {
  await ensureUserWalletSchema(executor);
  const { ref, topupNumber } = parseWalletTopupLookupRef(rawRef);
  if (!ref) {
    return null;
  }
  const exactIdRes = await executor.query(
    `SELECT id
     FROM wallet_topups
     WHERE id::text = $1
     LIMIT 1`,
    [ref]
  );
  if (exactIdRes.rowCount > 0) {
    return exactIdRes.rows[0].id;
  }
  if (Number.isFinite(topupNumber) && topupNumber > 0) {
    const topupRes = await executor.query(
      `SELECT id
       FROM wallet_topups
       WHERE topup_number = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [topupNumber]
    );
    if (topupRes.rowCount > 0) {
      return topupRes.rows[0].id;
    }
  }
  return null;
}

async function getWalletTopupById(executor, topupId) {
  await ensureUserWalletSchema(executor);
  const res = await executor.query(
    `SELECT wt.*,
            u.telegram_id,
            u.telegram_username,
            u.locale
     FROM wallet_topups wt
     JOIN users u ON u.id = wt.user_id
     WHERE wt.id = $1
     LIMIT 1`,
    [topupId]
  );
  return withWalletTopupDisplayNumber(res.rows[0] || null);
}

async function listWalletTopups(
  executor,
  { status = "SUBMITTED", page = 1, pageSize = 20, includeAll = false } = {}
) {
  await ensureUserWalletSchema(executor);
  const safePage = Math.max(Number.parseInt(String(page || 1), 10) || 1, 1);
  const safePageSize = Math.max(
    Math.min(Number.parseInt(String(pageSize || 20), 10) || 20, 100),
    1
  );
  const offset = (safePage - 1) * safePageSize;
  const values = [];
  const filters = [];
  if (status) {
    values.push(String(status).trim().toUpperCase());
    filters.push(`wt.status = $${values.length}`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const countRes = await executor.query(
    `SELECT COUNT(*)::int AS total
     FROM wallet_topups wt
     ${whereClause}`,
    values
  );
  const total = Number(countRes.rows[0]?.total || 0);
  const query = `SELECT wt.*,
                        u.telegram_id,
                        u.telegram_username
                 FROM wallet_topups wt
                 JOIN users u ON u.id = wt.user_id
                 ${whereClause}
                 ORDER BY wt.created_at DESC`;
  const listRes = includeAll
    ? await executor.query(query, values)
    : await executor.query(
      `${query} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, safePageSize, offset]
    );
  return {
    items: (listRes.rows || []).map(withWalletTopupDisplayNumber),
    total,
    page: includeAll ? 1 : safePage,
    page_size: includeAll ? listRes.rows.length : safePageSize,
    total_pages: includeAll ? 1 : Math.max(Math.ceil(total / safePageSize), 1),
  };
}

async function submitWalletTopupProof(
  executor,
  {
    topupId,
    telegramId,
    screenshotFileId,
    screenshotUniqueId,
    paymentMethod,
  }
) {
  await ensureUserWalletSchema(executor);
  const safeTelegramId = Number(telegramId);
  if (!Number.isFinite(safeTelegramId)) {
    const error = new Error("TELEGRAM_ID_REQUIRED");
    error.code = "TELEGRAM_ID_REQUIRED";
    throw error;
  }
  const topupRes = await executor.query(
    `SELECT wt.*, u.telegram_id, u.telegram_username
     FROM wallet_topups wt
     JOIN users u ON u.id = wt.user_id
     WHERE wt.id = $1
     FOR UPDATE`,
    [topupId]
  );
  if (topupRes.rowCount === 0) {
    const error = new Error("WALLET_TOPUP_NOT_FOUND");
    error.code = "WALLET_TOPUP_NOT_FOUND";
    throw error;
  }
  const topup = withWalletTopupDisplayNumber(topupRes.rows[0]);
  if (Number(topup.telegram_id) !== safeTelegramId) {
    const error = new Error("NOT_ALLOWED");
    error.code = "NOT_ALLOWED";
    throw error;
  }
  if (["APPROVED", "REJECTED", "CANCELLED", "EXPIRED"].includes(String(topup.status || ""))) {
    const error = new Error("TOPUP_NOT_PAYABLE");
    error.code = "TOPUP_NOT_PAYABLE";
    throw error;
  }
  if (String(topup.status || "") === "SUBMITTED") {
    const error = new Error("SCREENSHOT_ALREADY_SUBMITTED");
    error.code = "SCREENSHOT_ALREADY_SUBMITTED";
    throw error;
  }
  if (topup.expires_at && new Date(topup.expires_at).getTime() <= Date.now()) {
    await executor.query(
      `UPDATE wallet_topups
       SET status = 'EXPIRED'
       WHERE id = $1`,
      [topupId]
    );
    const error = new Error("TOPUP_EXPIRED");
    error.code = "TOPUP_EXPIRED";
    throw error;
  }
  const duplicateRes = await executor.query(
    `SELECT 1
     FROM wallet_topups wt
     JOIN users u ON u.id = wt.user_id
     WHERE u.telegram_id = $1
       AND wt.screenshot_unique_id = $2
     LIMIT 1`,
    [safeTelegramId, screenshotUniqueId]
  );
  if (duplicateRes.rowCount > 0) {
    const error = new Error("DUPLICATE_IMAGE");
    error.code = "DUPLICATE_IMAGE";
    throw error;
  }
  const proofValidation = await validatePaymentProofScreenshot(
    screenshotFileId,
    paymentMethod
  );
  if (proofValidation && proofValidation.valid === false) {
    const error = new Error("PAYMENT_PROOF_NOT_VALID");
    error.code = "PAYMENT_PROOF_NOT_VALID";
    error.messageToUser =
      "⚠️ La imagen no parece un comprobante de pago. Envía una captura donde se vea método y monto.";
    error.details = proofValidation;
    throw error;
  }
  const updatedRes = await executor.query(
    `UPDATE wallet_topups
     SET payment_method = $2,
         screenshot_file_id = $3,
         screenshot_unique_id = $4,
         status = 'SUBMITTED',
         submitted_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      topupId,
      paymentMethod || null,
      screenshotFileId,
      screenshotUniqueId,
    ]
  );
  return withWalletTopupDisplayNumber({
    ...(updatedRes.rows[0] || {}),
    telegram_id: topup.telegram_id,
    telegram_username: topup.telegram_username,
  });
}

async function approveWalletTopup(
  executor,
  { topupId, createdByAdmin = null }
) {
  await ensureUserWalletSchema(executor);
  const topupRes = await executor.query(
    `SELECT *
     FROM wallet_topups
     WHERE id = $1
     FOR UPDATE`,
    [topupId]
  );
  if (topupRes.rowCount === 0) {
    const error = new Error("WALLET_TOPUP_NOT_FOUND");
    error.code = "WALLET_TOPUP_NOT_FOUND";
    throw error;
  }
  const topup = withWalletTopupDisplayNumber(topupRes.rows[0]);
  if (topup.status === "APPROVED") {
    return { topup, alreadyApproved: true, wallet: await ensureUserWalletForUser(executor, topup.user_id) };
  }
  if (topup.status !== "SUBMITTED") {
    const error = new Error("TOPUP_NOT_APPROVABLE");
    error.code = "TOPUP_NOT_APPROVABLE";
    throw error;
  }
  const tx = await recordWalletTransaction(executor, {
    userId: topup.user_id,
    amount: topup.amount_usd,
    direction: "CREDIT",
    transactionType: "TOPUP_APPROVED",
    referenceType: "wallet_topup",
    referenceId: topup.id,
    note: `Recarga aprobada ${formatWalletTopupNumber(topup.topup_number)}`,
    visibleToUser: true,
    createdByAdmin: createdByAdmin || null,
  });
  const updatedRes = await executor.query(
    `UPDATE wallet_topups
     SET status = 'APPROVED',
         approved_at = now(),
         reason = NULL
     WHERE id = $1
     RETURNING *`,
    [topupId]
  );
  return {
    topup: withWalletTopupDisplayNumber(updatedRes.rows[0] || topup),
    wallet: tx.wallet,
    transaction: tx.transaction,
    alreadyApproved: false,
  };
}

async function rejectWalletTopup(
  executor,
  { topupId, reason = null }
) {
  await ensureUserWalletSchema(executor);
  const topupRes = await executor.query(
    `SELECT *
     FROM wallet_topups
     WHERE id = $1
     FOR UPDATE`,
    [topupId]
  );
  if (topupRes.rowCount === 0) {
    const error = new Error("WALLET_TOPUP_NOT_FOUND");
    error.code = "WALLET_TOPUP_NOT_FOUND";
    throw error;
  }
  const topup = withWalletTopupDisplayNumber(topupRes.rows[0]);
  if (["APPROVED", "REJECTED", "CANCELLED", "EXPIRED"].includes(String(topup.status || ""))) {
    const error = new Error("TOPUP_NOT_REJECTABLE");
    error.code = "TOPUP_NOT_REJECTABLE";
    throw error;
  }
  await releaseWalletTopupNumber(executor, topup);
  const updatedRes = await executor.query(
    `UPDATE wallet_topups
     SET status = 'REJECTED',
         rejected_at = now(),
         reason = $2,
         released_topup_number = COALESCE(released_topup_number, topup_number),
         topup_number = NULL
     WHERE id = $1
     RETURNING *`,
    [topupId, reason || null]
  );
  return withWalletTopupDisplayNumber(updatedRes.rows[0] || null);
}

async function markWalletTopupScam(
  executor,
  { topupId, reason = null }
) {
  await ensureUserWalletSchema(executor);
  const topupRes = await executor.query(
    `SELECT *
     FROM wallet_topups
     WHERE id = $1
     FOR UPDATE`,
    [topupId]
  );
  if (topupRes.rowCount === 0) {
    const error = new Error("WALLET_TOPUP_NOT_FOUND");
    error.code = "WALLET_TOPUP_NOT_FOUND";
    throw error;
  }
  const topup = withWalletTopupDisplayNumber(topupRes.rows[0]);
  if (["APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "SCAM"].includes(String(topup.status || ""))) {
    const error = new Error("TOPUP_NOT_SCAMMABLE");
    error.code = "TOPUP_NOT_SCAMMABLE";
    throw error;
  }
  await releaseWalletTopupNumber(executor, topup);
  const updatedRes = await executor.query(
    `UPDATE wallet_topups
     SET status = 'SCAM',
         rejected_at = now(),
         reason = $2,
         released_topup_number = COALESCE(released_topup_number, topup_number),
         topup_number = NULL
     WHERE id = $1
     RETURNING *`,
    [topupId, reason || "Marcada como estafa"]
  );
  return withWalletTopupDisplayNumber(updatedRes.rows[0] || null);
}

async function normalizeReleasedWalletTopups(executor = null) {
  const db = executor || getPool();
  await ensureUserWalletSchema(db);
  const affectedRes = await db.query(
    `SELECT *
     FROM wallet_topups
     WHERE status IN ('EXPIRED','REJECTED','SCAM')
       AND topup_number IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [getWalletSyncBatchLimit()]
  );
  const normalized = [];
  for (const row of affectedRes.rows || []) {
    const topup = withWalletTopupDisplayNumber(row);
    await releaseWalletTopupNumber(db, topup);
    const updateRes = await db.query(
      `UPDATE wallet_topups
       SET released_topup_number = COALESCE(released_topup_number, topup_number),
           topup_number = NULL
       WHERE id = $1
       RETURNING *`,
      [row.id]
    );
    normalized.push(withWalletTopupDisplayNumber(updateRes.rows[0] || row));
  }
  return normalized;
}

async function syncExpiredWalletTopups(executor = null) {
  const db = executor || getPool();
  if (shouldThrottleWalletSync(executor, walletTopupSyncLastAt)) {
    return [];
  }
  if (executor && typeof executor.connect === "function" && walletTopupSyncPromise) {
    return walletTopupSyncPromise;
  }
  const runSync = async () => {
    const batchLimit = getWalletSyncBatchLimit();
    await ensureUserWalletSchema(db);
    await normalizeReleasedWalletTopups(db);
    const expiredRes = await db.query(
      `SELECT wt.*, u.telegram_id, u.telegram_username
       FROM wallet_topups wt
       JOIN users u ON u.id = wt.user_id
       WHERE wt.status IN ('CREATED')
         AND wt.expires_at <= now()
       ORDER BY wt.expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchLimit]
    );
    const expiredItems = [];
    for (const row of expiredRes.rows || []) {
      const topup = withWalletTopupDisplayNumber(row);
      await releaseWalletTopupNumber(db, topup);
      const updateRes = await db.query(
        `UPDATE wallet_topups
         SET status = 'EXPIRED',
             released_topup_number = COALESCE(released_topup_number, topup_number),
             topup_number = NULL
         WHERE id = $1
         RETURNING *`,
        [row.id]
      );
      expiredItems.push(withWalletTopupDisplayNumber({
        ...row,
        ...(updateRes.rows[0] || {}),
      }));
    }
    for (const topup of expiredItems) {
      if (!topup?.telegram_id) {
        continue;
      }
      try {
        await sendMessage(
          topup.telegram_id,
          `⌛ Tu recarga ${formatWalletTopupNumber(getWalletTopupDisplayNumber(topup))} expiró.\n\n`
            + `💰 Monto: $${Number(topup.amount_usd || 0).toFixed(0)} USD\n`
            + `❌ Ya no puedes enviar comprobante para esa referencia.\n\n`
            + `🔁 Si aún quieres recargar, crea una nueva recarga desde "Mi saldo".`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Mi saldo", callback_data: "home:wallet" }],
              ],
            },
          }
        );
      } catch (error) {
        console.error("wallet_topup_expiry_notify_failed", {
          topupId: topup.id,
          telegramId: topup.telegram_id,
          error: error?.message || String(error),
        });
      }
    }
    walletTopupSyncLastAt = Date.now();
    return expiredItems;
  };
  if (executor && typeof executor.connect === "function") {
    walletTopupSyncPromise = runSync().finally(() => {
      walletTopupSyncPromise = null;
    });
    return walletTopupSyncPromise;
  }
  return runSync();
}

module.exports = {
  ensureUserWalletSchema,
  ensureWalletGiftSchema,
  ensureUserWalletForUser,
  getUserWalletByUserId,
  getUserWalletByTelegramId,
  getUserWalletHistoryByUserId,
  recordWalletTransaction,
  createWalletTopup,
  parseWalletTopupLookupRef,
  resolveWalletTopupId,
  getWalletTopupById,
  listWalletTopups,
  listWalletGifts,
  getWalletGiftById,
  submitWalletTopupProof,
  approveWalletTopup,
  rejectWalletTopup,
  markWalletTopupScam,
  normalizeReleasedWalletTopups,
  syncExpiredWalletTopups,
  getWalletTopupExpirySeconds,
  formatWalletTopupNumber,
  getWalletTopupDisplayNumber,
  ensureWalletTopupAdminNotificationSchema,
  recordWalletTopupAdminNotification,
  listWalletTopupAdminNotifications,
  buildWalletTopupAdminCaption,
  prepareWalletGiftButtonsForSend,
  recordWalletGiftMessage,
  claimWalletGift,
  cleanupWalletGiftMessages,
  finalizeWalletGiftStatus,
  syncWalletGifts,
  formatGiftUsd,
};
