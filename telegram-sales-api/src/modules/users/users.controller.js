const path = require("path");
const { getPool } = require("../../db");
const { sendMessage, sendPhoto } = require("../../services/telegram");
const {
  ensureUserWalletSchema,
  ensureWalletGiftSchema,
  getUserWalletByTelegramId,
  getUserWalletHistoryByUserId,
  createWalletTopup,
  resolveWalletTopupId,
  getWalletTopupById,
  submitWalletTopupProof,
  syncExpiredWalletTopups,
  formatWalletTopupNumber,
  recordWalletTopupAdminNotification,
  buildWalletTopupAdminCaption,
  claimWalletGift,
  cleanupWalletGiftMessages,
  finalizeWalletGiftStatus,
  formatGiftUsd,
} = require("../../services/userWallets");
const AFFILIATE_MESSAGES = {
  es: {
    approved: "✅ Tu solicitud para ser afiliado fue aprobada por el admin.",
    rejected: "❌ Tu solicitud para ser afiliado fue rechazada por el admin.",
  },
  en: {
    approved: "✅ Your affiliate request was approved by the admin.",
    rejected: "❌ Your affiliate request was rejected by the admin.",
  },
};
const MAIN_MENU_MESSAGES = {
  es: {
    home_welcome:
      "Bienvenido a:  <code>Noropayments.shop</code> 🛍️\n\n🚀 ¡Tu compra inteligente comienza aquí! 🚀\n\nTenemos todo lo que necesitas y más\n\n✅ Productos exclusivo\n✅ Envíos rápidos\n✅ Precios increíbles\n✅ Atención personalizada\n\n🛒 ¿Qué deseas comprar hoy?\n\n¡Cuéntanos y te guiamos! 🤝",
    menu_shop: "🏪 Tienda",
    menu_methods: "✅ Métodos",
    menu_groups: "💬 Grupos VIP",
    menu_programs: "💻 Programas y Web",
    menu_cart: "🛒 Carrito",
    menu_affiliates: "📢 Afiliados",
    menu_community: "👥 Comunidad",
    menu_support: "🆘 Soporte",
    menu_wallet: "💰 Mi saldo",
    menu_language: "🌐 Idioma",
  },
  en: {
    home_welcome:
      "Welcome to:  <code>Noropayments.shop</code> 🛍️\n\n🚀 Your smart shopping starts here! 🚀\n\nWe have everything you need and more\n\n✅ Exclusive products\n✅ Fast shipping\n✅ Amazing prices\n✅ Personalized attention\n\n🛒 What do you want to buy today?\n\nTell us and we'll guide you! 🤝",
    menu_shop: "🏪 Shop",
    menu_methods: "✅ Methods",
    menu_groups: "💬 VIP Groups",
    menu_programs: "💻 Programs & Web",
    menu_cart: "🛒 Cart",
    menu_affiliates: "📢 Affiliates",
    menu_community: "👥 Community",
    menu_support: "🆘 Support",
    menu_wallet: "💰 My balance",
    menu_language: "🌐 Language",
  },
};
const MAIN_MENU_PHOTO_PATH = path.resolve(
  __dirname,
  "../../../../telegram-sales-bot/assets/bot-noropayments.png"
);

function parseAdminTelegramIds() {
  const value = process.env.ADMIN_TELEGRAM_IDS || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

function parseScammerTelegramIds() {
  const value = process.env.SCAMMER_TELEGRAM_IDS || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

function normalizeLocale(input, languageCode) {
  const raw = (input || "").toString().trim().toLowerCase();
  if (raw === "es" || raw === "en") {
    return raw;
  }
  const lc = (languageCode || "").toString().toLowerCase();
  if (!lc) {
    return "es";
  }
  if (lc.startsWith("es")) {
    return "es";
  }
  return "en";
}

function buildMainMenuKeyboard(locale) {
  const text = MAIN_MENU_MESSAGES[locale] || MAIN_MENU_MESSAGES.es;
  return {
    inline_keyboard: [
      [
        { text: text.menu_shop, callback_data: "shop:page:1" },
        { text: text.menu_methods, callback_data: "category:page:metodos" },
      ],
      [
        { text: text.menu_groups, callback_data: "category:page:vip" },
        { text: text.menu_programs, callback_data: "category:page:programas" },
      ],
      [
        { text: text.menu_cart, callback_data: "home:cart" },
        { text: text.menu_affiliates, callback_data: "home:affiliates" },
      ],
      [
        { text: text.menu_community, callback_data: "home:community" },
        { text: text.menu_support, callback_data: "home:support" },
      ],
      [{ text: text.menu_wallet, callback_data: "home:wallet" }],
      [{ text: text.menu_language, callback_data: "home:soon:idioma" }],
    ],
  };
}

async function getUserLocaleByTelegramId(pool, telegramId) {
  try {
    const userRes = await pool.query(
      "SELECT locale FROM users WHERE telegram_id = $1",
      [telegramId]
    );
    const locale = userRes.rows[0]?.locale;
    if (locale === "en" || locale === "es") {
      return locale;
    }
  } catch (err) {
    // ignore locale errors
  }
  return "es";
}

async function resolveAffiliateId(client, startAffiliateCode, telegramId) {
  if (!startAffiliateCode) {
    return null;
  }
  let affiliateId = null;
  let numericCode = null;
  if (typeof startAffiliateCode === "string" && /^[0-9]+$/.test(startAffiliateCode)) {
    numericCode = Number(startAffiliateCode);
  }

  if (isUuid(startAffiliateCode)) {
    const res = await client.query(
      `SELECT a.id, u.telegram_id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = $1 AND a.status = 'APPROVED'
       LIMIT 1`,
      [startAffiliateCode]
    );

    if (res.rowCount > 0) {
      const row = res.rows[0];
      if (Number(row.telegram_id) !== Number(telegramId)) {
        affiliateId = row.id;
      }
    }
  }

  if (!affiliateId && numericCode !== null) {
    const res = await client.query(
      `SELECT a.id, u.telegram_id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1 AND a.status = 'APPROVED'
       LIMIT 1`,
      [numericCode]
    );
    if (res.rowCount > 0) {
      const row = res.rows[0];
      if (Number(row.telegram_id) !== Number(telegramId)) {
        affiliateId = row.id;
      }
    }
  }

  return affiliateId;
}

async function validateAffiliateCode(client, code, telegramId) {
  if (!code) {
    return { error: "INVALID_CODE" };
  }
  const raw = String(code).trim();
  if (raw.length === 0) {
    return { error: "INVALID_CODE" };
  }
  if (/^[0-9]+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number(numeric) === Number(telegramId)) {
      return { error: "SELF_CODE" };
    }
    const res = await client.query(
      `SELECT a.id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1 AND a.status = 'APPROVED'
       LIMIT 1`,
      [numeric]
    );
    if (res.rowCount === 0) {
      return { error: "INVALID_CODE" };
    }
    return { affiliateId: res.rows[0].id };
  }
  if (isUuid(raw)) {
    const res = await client.query(
      `SELECT a.id, u.telegram_id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = $1 AND a.status = 'APPROVED'
       LIMIT 1`,
      [raw]
    );
    if (res.rowCount === 0) {
      return { error: "INVALID_CODE" };
    }
    if (Number(res.rows[0].telegram_id) === Number(telegramId)) {
      return { error: "SELF_CODE" };
    }
    return { affiliateId: res.rows[0].id };
  }
  return { error: "INVALID_CODE" };
}

async function isUserBanned(client, telegramId) {
  const banRes = await client.query(
    "SELECT 1 FROM user_bans WHERE telegram_id = $1 LIMIT 1",
    [telegramId]
  );
  return banRes.rowCount > 0;
}

async function upsertTelegramUser(req, res, next) {
  const telegramId = Number(req.body.telegram_id);
  const username = req.body.username || null;
  const languageCode = req.body.language_code || null;
  const photoFileId = req.body.telegram_photo_file_id || null;
  const userLocale = normalizeLocale(req.body.locale, languageCode);
  const startAffiliateCode =
    req.body.start_affiliate_code || req.body.start_payload || null;

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (await isUserBanned(client, telegramId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "banned" });
    }

    const affiliateId = await resolveAffiliateId(
      client,
      startAffiliateCode,
      telegramId
    );
    const referredAt = affiliateId ? new Date() : null;

    const upserted = await client.query(
      `INSERT INTO users
        (telegram_id, telegram_username, telegram_photo_file_id, referred_by_affiliate_id, referred_at, locale)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_id)
       DO UPDATE SET telegram_username = EXCLUDED.telegram_username,
                     telegram_photo_file_id = COALESCE(EXCLUDED.telegram_photo_file_id, users.telegram_photo_file_id),
                     locale = COALESCE(EXCLUDED.locale, users.locale),
                     referred_by_affiliate_id = COALESCE(users.referred_by_affiliate_id, EXCLUDED.referred_by_affiliate_id),
                     referred_at = CASE
                       WHEN users.referred_by_affiliate_id IS NULL
                         AND EXCLUDED.referred_by_affiliate_id IS NOT NULL
                       THEN EXCLUDED.referred_at
                       ELSE users.referred_at
                     END
       RETURNING *, (xmax = 0) AS is_new`,
      [telegramId, username, photoFileId, affiliateId, referredAt, userLocale]
    );

    await client.query("COMMIT");
    const row = upserted.rows[0];
    const isNew = row.is_new;
    const affiliateAssigned = isNew
      ? affiliateId
      : row.referred_by_affiliate_id;
    return res.status(isNew ? 201 : 200).json({
      user: row,
      is_new: isNew,
      affiliate_assigned: affiliateAssigned,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function assignAffiliateCode(req, res, next) {
  const telegramId = Number(req.body.telegram_id);
  const code = req.body.code;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!code) {
    return res.status(400).json({ error: "INVALID_CODE" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      `SELECT id, referred_by_affiliate_id
       FROM users
       WHERE telegram_id = $1
       FOR UPDATE`,
      [telegramId]
    );
    if (userRes.rowCount === 0) {
      await client.query(
        `INSERT INTO users (telegram_id)
         VALUES ($1)`,
        [telegramId]
      );
    }

    const currentRes = await client.query(
      `SELECT referred_by_affiliate_id
       FROM users
       WHERE telegram_id = $1
       FOR UPDATE`,
      [telegramId]
    );
    const currentReferrer = currentRes.rows[0]?.referred_by_affiliate_id;
    if (currentReferrer) {
      await client.query("COMMIT");
      return res.status(409).json({ error: "ALREADY_ASSIGNED" });
    }

    const validation = await validateAffiliateCode(client, code, telegramId);
    if (validation.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: validation.error });
    }

    const affiliateId = validation.affiliateId;
    const updateRes = await client.query(
      `UPDATE users
       SET referred_by_affiliate_id = $1,
           referred_at = now()
       WHERE telegram_id = $2
         AND referred_by_affiliate_id IS NULL
       RETURNING referred_by_affiliate_id`,
      [affiliateId, telegramId]
    );
    if (updateRes.rowCount === 0) {
      await client.query("COMMIT");
      return res.status(409).json({ error: "ALREADY_ASSIGNED" });
    }

    await client.query("COMMIT");
    return res.json({ ok: true, affiliate_id: affiliateId });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function getUserByTelegramId(req, res, next) {
  const telegramId = Number(req.params.telegram_id);

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [telegramId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
}

async function getUserWallet(req, res, next) {
  const telegramId = Number(req.params.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  try {
    const pool = getPool();
    await ensureUserWalletSchema(pool);
    await syncExpiredWalletTopups(pool);
    const result = await getUserWalletByTelegramId(pool, telegramId);
    if (!result) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    return res.json({
      user: result.user,
      wallet: result.wallet,
    });
  } catch (error) {
    return next(error);
  }
}

async function getUserWalletHistory(req, res, next) {
  const telegramId = Number(req.params.telegram_id);
  const parsedLimit = Number.parseInt(String(req.query.limit || "20"), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 20;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  try {
    const pool = getPool();
    await ensureUserWalletSchema(pool);
    const result = await getUserWalletByTelegramId(pool, telegramId);
    if (!result) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    const items = await getUserWalletHistoryByUserId(pool, result.user.id, {
      limit,
      visibleToUserOnly: true,
    });
    return res.json({
      user: result.user,
      wallet: result.wallet,
      items,
    });
  } catch (error) {
    return next(error);
  }
}

async function createUserWalletTopup(req, res, next) {
  const telegramId = Number(req.params.telegram_id);
  const amountUsd = Number(req.body?.amount_usd);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!Number.isFinite(amountUsd) || amountUsd < 15) {
    return res.status(400).json({ error: "MIN_TOPUP_15_USD" });
  }
  try {
    const pool = getPool();
    await ensureUserWalletSchema(pool);
    const walletData = await getUserWalletByTelegramId(pool, telegramId);
    if (!walletData) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    const topup = await createWalletTopup(pool, {
      userId: walletData.user.id,
      amountUsd,
    });
    return res.status(201).json({
      topup: {
        ...topup,
        topup_number_label: formatWalletTopupNumber(topup?.topup_number),
      },
      wallet: walletData.wallet,
    });
  } catch (error) {
    return next(error);
  }
}

async function getUserWalletTopup(req, res, next) {
  const rawRef = req.params.id;
  const telegramId = Number(req.query.telegram_id || req.body?.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  try {
    const pool = getPool();
    await ensureUserWalletSchema(pool);
    await syncExpiredWalletTopups(pool);
    const resolvedId = await resolveWalletTopupId(pool, rawRef);
    if (!resolvedId) {
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const topup = await getWalletTopupById(pool, resolvedId);
    if (!topup || Number(topup.telegram_id) !== telegramId) {
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    return res.json({
      topup: {
        ...topup,
        topup_number_label: formatWalletTopupNumber(topup.topup_number),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function submitUserWalletTopupProof(req, res, next) {
  const rawRef = req.params.id;
  const telegramId = Number(req.body?.telegram_id);
  const screenshotFileId = req.body?.screenshot_file_id;
  const screenshotUniqueId = req.body?.screenshot_unique_id;
  const paymentMethod = req.body?.payment_method || null;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!screenshotFileId || !screenshotUniqueId) {
    return res.status(400).json({ error: "SCREENSHOT_REQUIRED" });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    await syncExpiredWalletTopups(client);
    const resolvedId = await resolveWalletTopupId(client, rawRef);
    if (!resolvedId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const topup = await submitWalletTopupProof(client, {
      topupId: resolvedId,
      telegramId,
      screenshotFileId,
      screenshotUniqueId,
      paymentMethod,
    });
    await client.query("COMMIT");

    try {
      const admins = parseAdminTelegramIds();
      if (admins.length > 0) {
        const caption = await buildWalletTopupAdminCaption(topup);
        const keyboard = {
          inline_keyboard: [
            [
              { text: "Panel web", callback_data: `admin_panel:${resolvedId}` },
              { text: "Panel Bot", callback_data: "adminui:wallets" },
            ],
            [
              { text: "Banear Usuario", callback_data: `admin_ban:${telegramId}:${resolvedId}` },
            ],
          ],
        };
        await Promise.all(
          admins.map(async (adminId) => {
            try {
              if (screenshotFileId) {
                const result = await sendPhoto(adminId, {
                  file_id: screenshotFileId,
                  caption,
                  parse_mode: "HTML",
                  reply_markup: keyboard,
                });
                if (result?.message_id) {
                  await recordWalletTopupAdminNotification(
                    pool,
                    resolvedId,
                    adminId,
                    result.message_id,
                    "photo"
                  );
                }
                return;
              }
              const result = await sendMessage(adminId, caption, {
                parse_mode: "HTML",
                reply_markup: keyboard,
              });
              if (result?.message_id) {
                await recordWalletTopupAdminNotification(
                  pool,
                  resolvedId,
                  adminId,
                  result.message_id,
                  "text"
                );
              }
            } catch (_error) {
              try {
                const result = await sendMessage(adminId, caption, {
                  parse_mode: "HTML",
                  reply_markup: keyboard,
                });
                if (result?.message_id) {
                  await recordWalletTopupAdminNotification(
                    pool,
                    resolvedId,
                    adminId,
                    result.message_id,
                    "text"
                  );
                }
              } catch (notifyError) {
                console.error("wallet_topup_admin_notify_failed", notifyError);
              }
            }
          })
        );
      }
    } catch (notifyError) {
      console.error("wallet_topup_admin_notify_failed", notifyError);
    }

    return res.json({
      topup: {
        ...topup,
        topup_number_label: formatWalletTopupNumber(topup?.topup_number),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "NOT_ALLOWED") {
      return res.status(403).json({ error: "NOT_ALLOWED" });
    }
    if (error.code === "SCREENSHOT_ALREADY_SUBMITTED") {
      return res.status(409).json({ error: "SCREENSHOT_ALREADY_SUBMITTED" });
    }
    if (error.code === "DUPLICATE_IMAGE") {
      return res.status(409).json({ error: "DUPLICATE_IMAGE" });
    }
    if (error.code === "TOPUP_EXPIRED") {
      return res.status(409).json({ error: "TOPUP_EXPIRED" });
    }
    if (error.code === "TOPUP_NOT_PAYABLE") {
      return res.status(409).json({ error: "TOPUP_NOT_PAYABLE" });
    }
    if (error.code === "PAYMENT_PROOF_NOT_VALID") {
      return res.status(422).json({
        error: "PAYMENT_PROOF_NOT_VALID",
        message:
          error.messageToUser
          || "⚠️ La imagen no parece un comprobante de pago. Envía una captura donde se vea método y monto.",
        details: error.details || null,
      });
    }
    return next(error);
  } finally {
    client.release();
  }
}

async function claimUserWalletGift(req, res, next) {
  const telegramId = Number(req.body?.telegram_id);
  const claimToken = String(req.body?.claim_token || "").trim();
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!claimToken) {
    return res.status(400).json({ error: "claim_token is required" });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureWalletGiftSchema(pool);
    await client.query("BEGIN");
    const result = await claimWalletGift(client, { telegramId, claimToken });
    await client.query("COMMIT");

    try {
      await cleanupWalletGiftMessages(pool, result.gift.id, telegramId);
      if (result.depleted) {
        await finalizeWalletGiftStatus(pool, result.gift.id);
      }
    } catch (giftFinalizeError) {
      console.error("wallet_gift_post_claim_finalize_failed", giftFinalizeError);
    }

    return res.json({
      ok: true,
      gift: result.gift,
      claim: result.claim,
      wallet: result.wallet,
      user: result.user,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("wallet_gift_claim_rollback_failed", rollbackError);
    }
    if (error.code === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    if (error.code === "WALLET_GIFT_NOT_FOUND") {
      return res.status(404).json({ error: "WALLET_GIFT_NOT_FOUND" });
    }
    if (error.code === "WALLET_GIFT_ALREADY_CLAIMED") {
      return res.status(409).json({ error: "WALLET_GIFT_ALREADY_CLAIMED" });
    }
    if (error.code === "WALLET_GIFT_DEPLETED") {
      return res.status(409).json({ error: "WALLET_GIFT_DEPLETED" });
    }
    if (error.code === "WALLET_GIFT_EXPIRED") {
      return res.status(409).json({ error: "WALLET_GIFT_EXPIRED" });
    }
    return next(error);
  } finally {
    client.release();
  }
}

async function updateUserLocale(req, res) {
  const telegramId = Number(req.params.telegram_id);
  const userLocale = normalizeLocale(req.body && req.body.locale, null);

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      "UPDATE users SET locale = $1 WHERE telegram_id = $2 RETURNING telegram_id, locale",
      [userLocale, telegramId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    return res.json({
      ok: true,
      telegram_id: telegramId,
      locale: result.rows[0].locale,
    });
  } catch (error) {
    return res.status(500).json({ error: "UPDATE_LOCALE_FAILED" });
  }
}

async function getAffiliateStatus(req, res, next) {
  const telegramId = Number(req.query.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT a.*, u.telegram_id, u.telegram_username
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1`,
      [telegramId]
    );
    if (result.rowCount === 0) {
      return res.json({ exists: false });
    }
    const row = result.rows[0];
    const salesRes = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS count
       FROM commissions c
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       WHERE c.affiliate_id = $1
         AND c.status != 'REFUNDED'`,
      [row.id]
    );
    const salesCount = salesRes.rows[0]?.count || 0;
    const earningsRes = await pool.query(
      `SELECT COALESCE(SUM(amount - COALESCE(refunded_amount, 0)), 0) AS total
       FROM commissions
       WHERE affiliate_id = $1`,
      [row.id]
    );
    const adjustmentsTotalRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1`,
      [row.id]
    );
    const earningsTotal =
      Number(earningsRes.rows[0]?.total || 0)
      + Number(adjustmentsTotalRes.rows[0]?.total || 0);
    const lastSaleRes = await pool.query(
      `SELECT MAX(earned_at) AS last_sale_at
       FROM commissions
       WHERE affiliate_id = $1
         AND status != 'REFUNDED'`,
      [row.id]
    );
    const lastSaleAt = lastSaleRes.rows[0]?.last_sale_at || null;
    const last30Res = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS count
       FROM commissions c
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       WHERE c.affiliate_id = $1
         AND c.status != 'REFUNDED'
         AND c.earned_at >= now() - interval '30 days'`,
      [row.id]
    );
    const salesLast30 = last30Res.rows[0]?.count || 0;
    const dailyRes = await pool.query(
      `SELECT COALESCE(SUM(amount - COALESCE(refunded_amount, 0)), 0) AS total
       FROM commissions
       WHERE affiliate_id = $1
         AND status != 'REFUNDED'
         AND earned_at >= date_trunc('day', now())`,
      [row.id]
    );
    const dailyEarnings = Number(dailyRes.rows[0]?.total || 0);
    const dailySalesRes = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS count
       FROM commissions c
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       WHERE c.affiliate_id = $1
         AND c.status != 'REFUNDED'
         AND c.earned_at >= date_trunc('day', now())`,
      [row.id]
    );
    const dailySalesCount = dailySalesRes.rows[0]?.count || 0;
    const streakRes = await pool.query(
      `SELECT DISTINCT date_trunc('day', earned_at)::date AS day
       FROM commissions
       WHERE affiliate_id = $1
         AND status != 'REFUNDED'
       ORDER BY day DESC`,
      [row.id]
    );
    const streakDays = [];
    for (const streakRow of streakRes.rows) {
      if (streakRow.day) {
        streakDays.push(streakRow.day);
      }
    }
    let streakCount = 0;
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daySet = new Set(streakDays.map((day) => new Date(day).getTime()));
      let cursor = today;
      while (daySet.has(cursor.getTime())) {
        streakCount += 1;
        cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
      }
    } catch (err) {
      streakCount = 0;
    }
    const availableRes = await pool.query(
      `SELECT COALESCE(SUM(
        GREATEST(
          (amount - COALESCE(refunded_amount, 0))
          - COALESCE(reserved_amount, 0)
          - COALESCE(paid_out_amount, 0),
          0
        )
      ), 0) AS total
       FROM commissions
       WHERE affiliate_id = $1 AND status != 'REFUNDED'`,
      [row.id]
    );
    const adjustmentsRes = await pool.query(
      `SELECT COALESCE(SUM(
        CASE
          WHEN amount > 0 THEN GREATEST(
            amount
            - COALESCE(reserved_amount, 0)
            - COALESCE(paid_out_amount, 0),
            0
          )
          ELSE amount
        END
      ), 0) AS total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1`,
      [row.id]
    );
    const earningsAvailableGross =
      Number(availableRes.rows[0]?.total || 0)
      + Number(adjustmentsRes.rows[0]?.total || 0);
    const affiliateDebt = Number(row.affiliate_debt || 0);
    const debtRemaining = Math.max(
      Number((affiliateDebt - earningsAvailableGross).toFixed(2)),
      0
    );
    const earningsAvailableNet = Math.max(
      Number((earningsAvailableGross - affiliateDebt).toFixed(2)),
      0
    );
    const referralsRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE referred_by_affiliate_id = $1`,
      [row.id]
    );
    const referralsTotal = referralsRes.rows[0]?.count || 0;
    const pendingPayoutRes = await pool.query(
      `SELECT amount, created_at
       FROM payouts
       WHERE affiliate_id = $1 AND status = 'REQUESTED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [row.id]
    );
    const pendingPayout = pendingPayoutRes.rows[0] || null;
    const payoutMethod = row.wallet_usdt_bsc
      ? "USDT_BSC"
      : row.wallet_nequi
      ? "NEQUI"
      : row.binance_id
      ? "BINANCE_ID"
      : null;
    return res.json({
      exists: true,
      affiliate: {
        id: row.id,
        status: row.status,
        commission_rate: row.commission_rate,
        wallet_usdt_bsc: row.wallet_usdt_bsc,
        wallet_nequi: row.wallet_nequi,
        binance_id: row.binance_id,
        payout_method: payoutMethod,
        created_at: row.created_at,
        approved_at: row.approved_at,
        sales_count: salesCount,
        earnings_total: earningsTotal,
        daily_earnings: dailyEarnings,
        daily_sales: dailySalesCount,
        daily_streak: streakCount,
        earnings_available: earningsAvailableNet,
        earnings_gross: Number(earningsAvailableGross.toFixed(2)),
        affiliate_debt: affiliateDebt,
        debt_remaining: debtRemaining,
        referrals_total: referralsTotal,
        last_sale_at: lastSaleAt,
        sales_last_30: salesLast30,
        pending_payout: pendingPayout,
      },
      user: {
        telegram_id: row.telegram_id,
        telegram_username: row.telegram_username,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getAffiliateTop(req, res, next) {
  const telegramId = Number(req.query.telegram_id);
  const period = String(req.query.period || "week").toLowerCase();
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (period !== "week" && period !== "day" && period !== "global") {
    return res.status(400).json({ error: "INVALID_PERIOD" });
  }
  try {
    const pool = getPool();
    const affiliateRes = await pool.query(
      `SELECT a.id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1 AND a.status = 'APPROVED'`,
      [telegramId]
    );
    if (affiliateRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_APPROVED" });
    }
    const affiliateId = affiliateRes.rows[0].id;
    let rankedRes;
    if (period === "global") {
      rankedRes = await pool.query(
        `WITH stats AS (
           SELECT a.id,
                  u.telegram_username,
                  COALESCE(SUM(CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE(oi.sale_qty, 1) END), 0)::int AS sales_count,
                  COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0) AS earnings_total
             FROM affiliates a
             JOIN users u ON u.id = a.user_id
             LEFT JOIN commissions c
               ON c.affiliate_id = a.id
              AND c.status != 'REFUNDED'
             LEFT JOIN (
               SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
               FROM order_items
               GROUP BY order_id
             ) oi ON oi.order_id = c.order_id
            WHERE a.status = 'APPROVED'
            GROUP BY a.id, u.telegram_username
         ),
         ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (
                    ORDER BY sales_count DESC, earnings_total DESC, telegram_username ASC NULLS LAST
                  ) AS position
             FROM stats
         )
         SELECT *
           FROM ranked
          ORDER BY sales_count DESC, earnings_total DESC, telegram_username ASC NULLS LAST`
      );
    } else {
      const interval = period === "day" ? "1 day" : "7 days";
      rankedRes = await pool.query(
        `WITH stats AS (
           SELECT a.id,
                  u.telegram_username,
                  COALESCE(SUM(CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE(oi.sale_qty, 1) END), 0)::int AS sales_count,
                  COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0) AS earnings_total
             FROM affiliates a
             JOIN users u ON u.id = a.user_id
             LEFT JOIN commissions c
               ON c.affiliate_id = a.id
              AND c.status != 'REFUNDED'
              AND c.earned_at >= (now() - $1::interval)
             LEFT JOIN (
               SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
               FROM order_items
               GROUP BY order_id
             ) oi ON oi.order_id = c.order_id
            WHERE a.status = 'APPROVED'
            GROUP BY a.id, u.telegram_username
         ),
         ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (
                    ORDER BY sales_count DESC, earnings_total DESC, telegram_username ASC NULLS LAST
                  ) AS position
             FROM stats
         )
         SELECT *
           FROM ranked
          ORDER BY sales_count DESC, earnings_total DESC, telegram_username ASC NULLS LAST`,
        [interval]
      );
    }
    const rows = rankedRes.rows || [];
    const top = rows.slice(0, 3).map((row) => ({
      username: row.telegram_username || "-",
      sales_count: row.sales_count || 0,
      earnings_total: Number(row.earnings_total || 0),
    }));
    const me = rows.find((row) => row.id === affiliateId);
    return res.json({
      period,
      top,
      position: me ? me.position : null,
      my_earnings: me ? Number(me.earnings_total || 0) : 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function applyAffiliate(req, res, next) {
  const telegramId = Number(req.body.telegram_id);
  const username = req.body.telegram_username || null;
  const photoFileId = req.body.telegram_photo_file_id || null;
  const method = String(req.body.method || "").toUpperCase();
  const walletUsdtBsc = req.body.wallet_usdt_bsc || null;
  const walletNequi = req.body.wallet_nequi || null;
  const binanceId = req.body.binance_id || null;
  const isWalletProvided = Boolean(walletUsdtBsc);
  const isNequiProvided = Boolean(walletNequi);
  const isBinanceProvided = Boolean(binanceId);

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (method !== "USDT_BSC" && method !== "BINANCE_ID" && method !== "NEQUI") {
    return res.status(400).json({ error: "INVALID_METHOD" });
  }
  if ((isWalletProvided && isBinanceProvided)
    || (isWalletProvided && isNequiProvided)
    || (isNequiProvided && isBinanceProvided)) {
    return res.status(400).json({ error: "ONLY_ONE_METHOD_ALLOWED" });
  }
  if (method === "USDT_BSC" && !walletUsdtBsc) {
    return res.status(400).json({ error: "WALLET_REQUIRED" });
  }
  if (method === "NEQUI" && !walletNequi) {
    return res.status(400).json({ error: "WALLET_NEQUI_REQUIRED" });
  }
  if (method === "BINANCE_ID" && !binanceId) {
    return res.status(400).json({ error: "BINANCE_ID_REQUIRED" });
  }
  const resolvedWallet = method === "USDT_BSC" ? walletUsdtBsc : null;
  const resolvedNequi = method === "NEQUI" ? walletNequi : null;
  const resolvedBinance = method === "BINANCE_ID" ? binanceId : null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (await isUserBanned(client, telegramId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "USER_BANNED" });
    }
    const scammers = parseScammerTelegramIds();
    if (scammers.includes(telegramId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "SCAMMER_REPORTED" });
    }
    const userRes = await client.query(
      `INSERT INTO users (telegram_id, telegram_username, telegram_photo_file_id, locale)
       VALUES ($1, $2, $3, 'es')
       ON CONFLICT (telegram_id)
       DO UPDATE SET telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
                     telegram_photo_file_id = COALESCE(EXCLUDED.telegram_photo_file_id, users.telegram_photo_file_id)
       RETURNING id`,
      [telegramId, username, photoFileId]
    );
    const userId = userRes.rows[0].id;

    const userCheckRes = await client.query(
      `SELECT telegram_username, telegram_photo_file_id
       FROM users
       WHERE id = $1`,
      [userId]
    );
    const userRow = userCheckRes.rows[0] || {};
    if (!userRow.telegram_username) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "USERNAME_REQUIRED" });
    }
    if (!userRow.telegram_photo_file_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "PHOTO_REQUIRED" });
    }

    const existingRes = await client.query(
      `SELECT * FROM affiliates WHERE user_id = $1`,
      [userId]
    );

    if (existingRes.rowCount > 0) {
      const existing = existingRes.rows[0];
      const updateRes = await client.query(
        `UPDATE affiliates
         SET wallet_usdt_bsc = $2,
             wallet_nequi = $3,
             binance_id = $4
         WHERE id = $1
         RETURNING *`,
        [existing.id, resolvedWallet, resolvedNequi, resolvedBinance]
      );
      await client.query("COMMIT");
      return res.json({ status: "updated", affiliate: updateRes.rows[0] });
    }

    const affiliateRes = await client.query(
      `INSERT INTO affiliates (user_id, status, wallet_usdt_bsc, wallet_nequi, binance_id)
       VALUES ($1, 'PENDING', $2, $3, $4)
       RETURNING *`,
      [userId, resolvedWallet, resolvedNequi, resolvedBinance]
    );

    await client.query("COMMIT");

    const admins = parseAdminTelegramIds();
    const destination =
      method === "USDT_BSC"
        ? resolvedWallet
        : method === "NEQUI"
        ? resolvedNequi
        : resolvedBinance;
    const notice = [
      "🆕 <b>Nueva solicitud de afiliado</b>",
      "",
      `🆔 Telegram ID: <code>${telegramId}</code>`,
      `👤 Usuario: <code>${username ? `@${username}` : "-"}</code>`,
      `💳 Método: <b>${method}</b>`,
      `📥 Destino: <code>${destination || "-"}</code>`,
    ].join("\n");
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Aprobar", callback_data: `affiliate_admin:approve:${affiliateRes.rows[0].id}` },
          { text: "❌ Cancelar", callback_data: `affiliate_admin:reject:${affiliateRes.rows[0].id}` },
        ],
      ],
    };
    await Promise.all(
      admins.map(async (adminId) => {
        try {
          await sendMessage(adminId, notice, { parse_mode: "HTML", reply_markup: keyboard });
        } catch (err) {
          // ignore admin notification errors
        }
      })
    );

    return res.status(201).json({ status: "created", affiliate: affiliateRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function requestAffiliatePayout(req, res, next) {
  const telegramId = Number(req.body.telegram_id);
  const requestedAmountRaw = req.body?.amount;
  const requestedAmount = requestedAmountRaw != null
    ? Number(requestedAmountRaw)
    : null;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (requestedAmount !== null && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const affiliateRes = await client.query(
      `SELECT a.id, a.status, a.wallet_usdt_bsc, a.wallet_nequi, a.binance_id, a.affiliate_debt
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1`,
      [telegramId]
    );
    if (affiliateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }
    const affiliate = affiliateRes.rows[0];
    if (affiliate.status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "AFFILIATE_NOT_APPROVED" });
    }
    const method = affiliate.wallet_usdt_bsc
      ? "USDT_BSC"
      : affiliate.wallet_nequi
      ? "NEQUI"
      : "BINANCE_ID";
    const destination =
      affiliate.wallet_usdt_bsc || affiliate.wallet_nequi || affiliate.binance_id || null;
    if (!destination) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DESTINATION_REQUIRED" });
    }

    const commissionsRes = await client.query(
      `SELECT c.id,
              c.amount,
              COALESCE(c.refunded_amount, 0) AS refunded_amount,
              COALESCE(c.reserved_amount, 0) AS reserved_amount,
              COALESCE(c.paid_out_amount, 0) AS paid_out_amount,
              (c.amount - COALESCE(c.refunded_amount, 0)
                - COALESCE(c.reserved_amount, 0)
                - COALESCE(c.paid_out_amount, 0)) AS available_amount
       FROM commissions c
       WHERE c.affiliate_id = $1
         AND c.status != 'REFUNDED'
         AND (c.amount - COALESCE(c.refunded_amount, 0)
           - COALESCE(c.reserved_amount, 0)
           - COALESCE(c.paid_out_amount, 0)) > 0
       ORDER BY c.earned_at ASC
       FOR UPDATE OF c`,
      [affiliate.id]
    );

    const positiveAdjustmentsRes = await client.query(
      `SELECT id,
              amount,
              COALESCE(reserved_amount, 0) AS reserved_amount,
              COALESCE(paid_out_amount, 0) AS paid_out_amount,
              (amount - COALESCE(reserved_amount, 0)
                - COALESCE(paid_out_amount, 0)) AS available_amount
       FROM affiliate_adjustments
       WHERE affiliate_id = $1
         AND amount > 0
         AND (amount - COALESCE(reserved_amount, 0)
           - COALESCE(paid_out_amount, 0)) > 0
       ORDER BY created_at ASC
       FOR UPDATE`,
      [affiliate.id]
    );

    const negativeAdjustmentsRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1
         AND amount < 0`,
      [affiliate.id]
    );

    const commissionAvailableTotal = commissionsRes.rows.reduce(
      (sum, row) => sum + Number(row.available_amount || 0),
      0
    );
    const positiveAdjustmentsTotal = positiveAdjustmentsRes.rows.reduce(
      (sum, row) => sum + Number(row.available_amount || 0),
      0
    );
    const negativeAdjustmentsTotal = Number(negativeAdjustmentsRes.rows[0]?.total || 0);

    const totalGross = Number(
      (commissionAvailableTotal + positiveAdjustmentsTotal + negativeAdjustmentsTotal).toFixed(2)
    );
    if (commissionsRes.rowCount === 0 && positiveAdjustmentsRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "NO_EARNED_COMMISSIONS" });
    }

    if (!totalGross || totalGross <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "NO_EARNED_COMMISSIONS" });
    }

    const debt = Number(affiliate.affiliate_debt || 0);
    const debtAppliedTotal = Math.min(debt, totalGross);
    const availableAfterDebt = Number((totalGross - debtAppliedTotal).toFixed(2));
    if (availableAfterDebt <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DEBT_PENDING" });
    }

    let targetPayout = availableAfterDebt;
    if (requestedAmount !== null) {
      if (requestedAmount > availableAfterDebt) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "INSUFFICIENT_BALANCE" });
      }
      targetPayout = requestedAmount;
    }
    const targetGross = Number((targetPayout + debtAppliedTotal).toFixed(2));
    const targetPositive = targetGross;

    let remaining = targetPositive;
    const selectedCommissions = [];
    const selectedAdjustments = [];

    for (const row of commissionsRes.rows) {
      if (remaining <= 0) {
        break;
      }
      const availableAmount = Number(row.available_amount || 0);
      if (availableAmount <= 0) {
        continue;
      }
      const takeAmount = Number(Math.min(availableAmount, remaining).toFixed(2));
      if (takeAmount <= 0) {
        continue;
      }
      selectedCommissions.push({ id: row.id, amount: takeAmount });
      remaining = Number((remaining - takeAmount).toFixed(2));
    }

    for (const row of positiveAdjustmentsRes.rows) {
      if (remaining <= 0) {
        break;
      }
      const availableAmount = Number(row.available_amount || 0);
      if (availableAmount <= 0) {
        continue;
      }
      const takeAmount = Number(Math.min(availableAmount, remaining).toFixed(2));
      if (takeAmount <= 0) {
        continue;
      }
      selectedAdjustments.push({ id: row.id, amount: takeAmount });
      remaining = Number((remaining - takeAmount).toFixed(2));
    }

    if (remaining > 0.01) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "NO_EARNED_COMMISSIONS" });
    }
    const selectedPositiveTotal = selectedCommissions.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    ) + selectedAdjustments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const selectedGross = Number(selectedPositiveTotal.toFixed(2));

    const debtApplied = Math.min(debtAppliedTotal, selectedGross);
    const payoutAmount = Number((selectedGross - debtApplied).toFixed(2));
    if (payoutAmount <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DEBT_EXCEEDS_BALANCE" });
    }

    const payoutRes = await client.query(
      `INSERT INTO payouts (affiliate_id, amount, method, destination, status, debt_applied)
       VALUES ($1, $2, $3, $4, 'REQUESTED', $5)
       RETURNING *`,
      [affiliate.id, payoutAmount, method, destination, debtApplied]
    );

    const payoutId = payoutRes.rows[0].id;
    const commissionIds = selectedCommissions.map((item) => item.id);
    const commissionAmounts = selectedCommissions.map((item) => item.amount);
    const adjustmentIds = selectedAdjustments.map((item) => item.id);
    const adjustmentAmounts = selectedAdjustments.map((item) => item.amount);

    if (debtApplied > 0) {
      await client.query(
        `UPDATE affiliates
         SET affiliate_debt = affiliate_debt - $2
         WHERE id = $1`,
        [affiliate.id, debtApplied]
      );
    }

    if (commissionIds.length > 0) {
      await client.query(
        `WITH selected AS (
           SELECT UNNEST($2::uuid[]) AS id,
                  UNNEST($3::numeric[]) AS amount
         )
         INSERT INTO payout_items (payout_id, commission_id, amount)
         SELECT $1, id, amount
         FROM selected`,
        [payoutId, commissionIds, commissionAmounts]
      );

      await client.query(
        `WITH selected AS (
           SELECT UNNEST($1::uuid[]) AS id,
                  UNNEST($2::numeric[]) AS amount
         )
         UPDATE commissions c
         SET reserved_amount = c.reserved_amount + selected.amount,
             status = CASE
               WHEN (c.amount - COALESCE(c.refunded_amount, 0)
                 - (c.reserved_amount + selected.amount)
                 - COALESCE(c.paid_out_amount, 0)) <= 0.01
                 THEN 'RESERVED'
               ELSE c.status
             END
         FROM selected
         WHERE c.id = selected.id`,
        [commissionIds, commissionAmounts]
      );
    }

    if (adjustmentIds.length > 0) {
      await client.query(
        `WITH selected AS (
           SELECT UNNEST($2::uuid[]) AS id,
                  UNNEST($3::numeric[]) AS amount
         )
         INSERT INTO payout_adjustments (payout_id, adjustment_id, amount)
         SELECT $1, id, amount
         FROM selected`,
        [payoutId, adjustmentIds, adjustmentAmounts]
      );
      await client.query(
        `WITH selected AS (
           SELECT UNNEST($1::uuid[]) AS id,
                  UNNEST($2::numeric[]) AS amount
         )
         UPDATE affiliate_adjustments a
         SET reserved_amount = a.reserved_amount + selected.amount,
             status = CASE
               WHEN (a.amount - (a.reserved_amount + selected.amount)
                 - COALESCE(a.paid_out_amount, 0)) <= 0.01
                 THEN 'RESERVED'
               ELSE a.status
             END
         FROM selected
         WHERE a.id = selected.id`,
        [adjustmentIds, adjustmentAmounts]
      );
    }

    await client.query("COMMIT");
    return res.status(201).json({ payout: payoutRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function decideAffiliateStatus(req, res, next) {
  const affiliateId = req.params.id;
  const status = String(req.body?.status || "").toUpperCase();
  if (!affiliateId) {
    return res.status(400).json({ error: "AFFILIATE_ID_REQUIRED" });
  }
  if (status !== "APPROVED" && status !== "REJECTED") {
    return res.status(400).json({ error: "INVALID_STATUS" });
  }
  const pool = getPool();
  try {
    const updateRes = await pool.query(
      `UPDATE affiliates
       SET status = $2::affiliate_status,
           approved_at = CASE
             WHEN $2::affiliate_status = 'APPROVED'::affiliate_status THEN COALESCE(approved_at, now())
             WHEN $2::affiliate_status = 'REJECTED'::affiliate_status THEN approved_at
             ELSE approved_at
           END
       WHERE id = $1
       RETURNING *`,
      [affiliateId, status]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }
    const affiliate = updateRes.rows[0];
    try {
      const userRes = await pool.query(
        `SELECT u.telegram_id
         FROM users u
         JOIN affiliates a ON a.user_id = u.id
         WHERE a.id = $1`,
        [affiliateId]
      );
      const telegramId = userRes.rows[0]?.telegram_id;
      if (telegramId) {
        const locale = await getUserLocaleByTelegramId(pool, telegramId);
        const text =
          status === "APPROVED"
            ? (AFFILIATE_MESSAGES[locale]?.approved || AFFILIATE_MESSAGES.es.approved)
            : (AFFILIATE_MESSAGES[locale]?.rejected || AFFILIATE_MESSAGES.es.rejected);
        await sendMessage(telegramId, text);
        const menuText =
          MAIN_MENU_MESSAGES[locale]?.home_welcome ||
          MAIN_MENU_MESSAGES.es.home_welcome;
        const menuKeyboard = buildMainMenuKeyboard(locale);
        setTimeout(() => {
          sendPhoto(telegramId, {
            path: MAIN_MENU_PHOTO_PATH,
            caption: menuText,
            parse_mode: "HTML",
            reply_markup: menuKeyboard,
          }).catch(() => {
            sendMessage(telegramId, menuText, {
              parse_mode: "HTML",
              reply_markup: menuKeyboard,
            }).catch(() => {});
          });
        }, 3000);
      }
    } catch (err) {
      // ignore notify errors
    }
    return res.json({ affiliate });
  } catch (error) {
    return next(error);
  }
}

async function getUserBanStatus(req, res, next) {
  const telegramId = Number(req.params.telegram_id);

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }

  try {
    const pool = getPool();
    const banned = await isUserBanned(pool, telegramId);
    return res.status(200).json({ banned });
  } catch (error) {
    return next(error);
  }
}

async function banUserFromBot(req, res, next) {
  const telegramId = Number(req.params.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  const reason = String(req.body?.reason || "Banned via Telegram admin").trim();
  const adminTelegramId = Number(req.body?.admin_telegram_id);
  const pool = getPool();

  try {
    const existingRes = await pool.query(
      "SELECT 1 FROM user_bans WHERE telegram_id = $1 LIMIT 1",
      [telegramId]
    );
    if (existingRes.rowCount === 0) {
      await pool.query(
        "INSERT INTO user_bans (telegram_id, reason) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING",
        [telegramId, reason || null]
      );
    }

    try {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "USER_BAN_TELEGRAM",
          "user",
          null,
          JSON.stringify({
            telegram_id: telegramId,
            reason: reason || null,
            admin_telegram_id: Number.isFinite(adminTelegramId) ? adminTelegramId : null,
            source: "telegram",
          }),
        ]
      );
    } catch (error) {
      console.error("Failed to insert ban audit log", error);
    }

    return res.json({
      ok: true,
      banned: true,
      already_banned: existingRes.rowCount > 0,
    });
  } catch (error) {
    return next(error);
  }
}

const { buildAffiliateInvoiceMessage } = require("../../services/affiliateInvoiceMessage");

async function decideAffiliateInvoice(req, res, next) {
  const { invoice_id: invoiceId, decision } = req.body || {};
  if (!invoiceId || !decision) {
    return res.status(400).json({ error: "INVALID_REQUEST" });
  }
  const normalizedDecision = String(decision).toUpperCase();
  if (!["PAY", "CANCEL"].includes(normalizedDecision)) {
    return res.status(400).json({ error: "INVALID_DECISION" });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceRes = await client.query(
      `SELECT i.*, a.affiliate_debt
       FROM affiliate_invoices i
       JOIN affiliates a ON a.id = i.affiliate_id
       WHERE i.id = $1
       FOR UPDATE OF i`,
      [invoiceId]
    );
    if (invoiceRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "INVOICE_NOT_FOUND" });
    }
    const invoice = invoiceRes.rows[0];
    const affiliateInfoRes = await client.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY approved_at, id) AS affiliate_number
         FROM affiliates
         WHERE approved_at IS NOT NULL
       )
       SELECT a.id, u.telegram_id, u.telegram_username, ranked.affiliate_number
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN ranked ON ranked.id = a.id
       WHERE a.id = $1`,
      [invoice.affiliate_id]
    );
    const affiliateInfo = affiliateInfoRes.rows[0] || null;
    const now = new Date();
    const expiresAt = invoice.expires_at
      ? new Date(invoice.expires_at)
      : new Date(new Date(invoice.created_at || now).getTime() + 10 * 60 * 1000);
    if (invoice.status === "PENDING" && expiresAt.getTime() <= now.getTime()) {
      const expiredRes = await client.query(
        `UPDATE affiliate_invoices
         SET status = 'EXPIRED', expired_at = now()
         WHERE id = $1
         RETURNING *`,
        [invoiceId]
      );
      await client.query("COMMIT");
      const expiredInvoice = expiredRes.rows[0];
      const message = affiliateInfo
        ? buildAffiliateInvoiceMessage({ affiliate: affiliateInfo, invoice: expiredInvoice })
        : null;
      return res.status(400).json({
        error: "INVOICE_EXPIRED",
        invoice: expiredInvoice,
        message,
      });
    }
    if (invoice.status !== "PENDING") {
      await client.query("COMMIT");
      const message = affiliateInfo
        ? buildAffiliateInvoiceMessage({ affiliate: affiliateInfo, invoice })
        : null;
      return res.json({ status: invoice.status, invoice, message });
    }

    if (normalizedDecision === "CANCEL") {
      const cancelledRes = await client.query(
        `UPDATE affiliate_invoices
         SET status = 'CANCELLED', cancelled_at = now()
         WHERE id = $1
         RETURNING *`,
        [invoiceId]
      );
      await client.query("COMMIT");
      const cancelledInvoice = cancelledRes.rows[0];
      const message = affiliateInfo
        ? buildAffiliateInvoiceMessage({ affiliate: affiliateInfo, invoice: cancelledInvoice })
        : null;
      return res.json({ invoice: cancelledInvoice, message });
    }

    const availableRes = await client.query(
      `SELECT COALESCE(SUM(
        GREATEST(
          (amount - COALESCE(refunded_amount, 0))
          - COALESCE(reserved_amount, 0)
          - COALESCE(paid_out_amount, 0),
          0
        )
      ), 0) AS total
       FROM commissions
       WHERE affiliate_id = $1 AND status != 'REFUNDED'`,
      [invoice.affiliate_id]
    );
    const adjustmentsRes = await client.query(
      `SELECT COALESCE(SUM(
        CASE
          WHEN amount > 0 THEN GREATEST(
            amount
            - COALESCE(reserved_amount, 0)
            - COALESCE(paid_out_amount, 0),
            0
          )
          ELSE amount
        END
      ), 0) AS total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1`,
      [invoice.affiliate_id]
    );
    const availableGross =
      Number(availableRes.rows[0]?.total || 0)
      + Number(adjustmentsRes.rows[0]?.total || 0);
    const affiliateDebt = Number(invoice.affiliate_debt || 0);
    const debtRemaining = Math.max(
      Number((affiliateDebt - availableGross).toFixed(2)),
      0
    );
    if (debtRemaining > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DEBT_PENDING" });
    }
    const availableNet = Math.max(
      Number((availableGross - affiliateDebt).toFixed(2)),
      0
    );

    if (availableNet < Number(invoice.amount || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "INSUFFICIENT_BALANCE" });
    }

    await client.query(
      `INSERT INTO affiliate_adjustments
        (affiliate_id, amount, reason, status)
       VALUES ($1, $2, $3, 'EARNED')`,
      [
        invoice.affiliate_id,
        -Number(invoice.amount),
        invoice.reason ? `Factura: ${invoice.reason}` : "Factura",
      ]
    );

    const paidRes = await client.query(
      `UPDATE affiliate_invoices
       SET status = 'PAID', paid_at = now()
       WHERE id = $1
       RETURNING *`,
      [invoiceId]
    );

    await client.query("COMMIT");
    const paidInvoice = paidRes.rows[0];
    const message = affiliateInfo
      ? buildAffiliateInvoiceMessage({ affiliate: affiliateInfo, invoice: paidInvoice })
      : null;
    return res.json({ invoice: paidInvoice, message });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

module.exports = {
  upsertTelegramUser,
  getUserByTelegramId,
  getUserWallet,
  getUserWalletHistory,
  createUserWalletTopup,
  getUserWalletTopup,
  submitUserWalletTopupProof,
  claimUserWalletGift,
  updateUserLocale,
  getUserBanStatus,
  banUserFromBot,
  getAffiliateStatus,
  getAffiliateTop,
  applyAffiliate,
  assignAffiliateCode,
  requestAffiliatePayout,
  decideAffiliateStatus,
  decideAffiliateInvoice,
};
