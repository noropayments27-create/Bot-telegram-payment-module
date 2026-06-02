const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const net = require("net");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ExcelJS = require("exceljs");
const bcrypt = require("bcryptjs");
const { getPool } = require("../db");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createLoginRequest,
  getLoginRequest,
  setLoginDecision,
  REQUEST_TTL_SECONDS,
  createAdminToken,
  verifyAdminToken,
} = require("../services/adminAuth");
const {
  getFilePath,
  downloadFile,
  deleteMessage,
  sendMessage,
  sendPhoto,
  sendVideo,
  sendAnimation,
  sendSticker,
  sendDocument,
  editMessageCaption,
  editMessageText,
} = require("../services/telegram");
const {
  listAdminOrderNotifications,
  buildOrderNotificationCaption,
  buildOrderNotificationKeyboard,
  calculateLocalAmount: calculateLocalAmountForAdminNotify,
} = require("../services/adminOrderNotification");
const {
  listPaymentMethods,
  normalizeMethodKey,
  togglePaymentMethod,
  upsertPaymentMethod,
  deletePaymentMethod,
} = require("../services/paymentMethods");
const {
  getMaintenanceStatus,
  setMaintenanceStatus,
} = require("../services/maintenance");
const {
  getBotAssets,
  setBotAssets,
  setPaymentMethodsImage,
} = require("../services/botAssets");
const { ensureProductCategorySchema } = require("../services/productSchema");
const { renderReceiptPng } = require("../services/receiptRenderer");
const { consumeStockForOrder, releaseStockForOrder } = require("../services/stock");
const { deliverOrderToTelegram } = require("../services/delivery");
const { getAffiliateLevel } = require("../services/affiliateLevels");
const { getAdminLayout, setAdminLayout } = require("../services/adminLayouts");
const {
  ensureFreeOrderSchema,
  isFreeOrderRow,
  formatFreeOrderLabel,
} = require("../services/freeOrders");
const {
  ensureOrderNumberSchema,
  ensureOrderNumberForOrder,
  releaseOrderNumber,
} = require("../services/orderNumbers");
const {
  validateAdminStartCredentials,
  validateAdminDirectCredentials,
  ensureAdminCredentialsSchema,
} = require("../services/adminCredentials");
const {
  ensureAppErrorLogSchema,
  recordAppError,
  listAppErrors,
} = require("../services/appErrorLogs");
const {
  ensureUserWalletSchema,
  getUserWalletByTelegramId,
  getUserWalletHistoryByUserId,
  createWalletTopup,
  resolveWalletTopupId,
  getWalletTopupById,
  listWalletTopups,
  listWalletGifts,
  getWalletGiftById,
  approveWalletTopup,
  rejectWalletTopup,
  markWalletTopupScam,
  recordWalletTransaction,
  syncExpiredWalletTopups,
  formatWalletTopupNumber,
  getWalletTopupDisplayNumber,
  listWalletTopupAdminNotifications,
  buildWalletTopupAdminCaption,
  ensureWalletGiftSchema,
  prepareWalletGiftButtonsForSend,
  recordWalletGiftMessage,
  syncWalletGifts,
} = require("../services/userWallets");
const {
  ensurePublishTargetsSchema,
  upsertPublishTarget,
  listPublishTargets,
  getPublishTargetSummary,
} = require("../services/publishTargets");
const { sendMail, isMailConfigured } = require("../services/mailer");
const { buildPasswordRecoveryEmailTemplate } = require("../services/emailTemplates");
const {
  isDriveUploadEnabled,
  uploadBackupFileToDrive,
} = require("../services/backupDrive");
const {
  isTelegramBackupEnabled,
  uploadBackupFileToTelegram,
} = require("../services/backupTelegram");
const execFileAsync = promisify(execFile);

const ADMIN_PASSWORD_RESET_PURPOSE = "RESET_PASSWORD";
const ADMIN_PASSWORD_RESET_CHANNEL_TELEGRAM = "TELEGRAM";

function getOrderExpirySeconds() {
  return Math.max(
    parseInt(process.env.ORDER_EXPIRY_SECONDS || "", 10)
      || (parseInt(process.env.ORDER_EXPIRY_MINUTES || "", 10) || 0) * 60
      || 900,
    1
  );
}

async function syncExpiredWaitingPaymentOrders(pool) {
  const expirySeconds = getOrderExpirySeconds();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expiredRes = await client.query(
      `UPDATE orders o
       SET status = 'EXPIRED',
           cancelled_at = COALESCE(cancelled_at, now()),
           cancel_source = 'EXPIRED',
           order_number = NULL,
           test_cleanup_after = CASE
             WHEN o.is_test THEN now() + ($2 * interval '1 second')
             ELSE o.test_cleanup_after
           END
       WHERE o.status = 'WAITING_PAYMENT'
         AND COALESCE(o.unit_price_at_purchase, 0) > 0
         AND o.created_at <= now() - ($1 * interval '1 second')
         AND NOT EXISTS (
           SELECT 1 FROM order_payments op WHERE op.order_id = o.id
         )
       RETURNING o.id`,
      [expirySeconds, getTestOrderCleanupSeconds()]
    );

    const expiredOrderIds = expiredRes.rows.map((row) => row.id).filter(Boolean);
    if (expiredOrderIds.length > 0) {
      await client.query(
        `UPDATE product_stock_units
         SET status = 'AVAILABLE',
             held_by_order_id = NULL,
             held_by_telegram_id = NULL,
             held_by_username = NULL,
             held_at = NULL,
             updated_at = now()
         WHERE held_by_order_id = ANY($1::uuid[])
           AND status = 'HELD'`,
        [expiredOrderIds]
      );

      await client.query(
        `UPDATE product_stock_holds
         SET status = 'EXPIRED',
             updated_at = now()
         WHERE order_id = ANY($1::uuid[])
           AND status = 'HELD'`,
        [expiredOrderIds]
      );
    }

    await client.query("COMMIT");
    return expiredOrderIds.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const ADMIN_PASSWORD_RESET_CHANNEL_EMAIL = "EMAIL";
const ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS = 5 * 60;
const ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS = 10 * 60;
const ADMIN_PASSWORD_RESET_MAX_ATTEMPTS = 5;
const ADMIN_PASSWORD_RESET_START_COOLDOWN_SECONDS = 60;
const ADMIN_PASSWORD_RESET_START_WINDOW_SECONDS = 60 * 60;
const ADMIN_PASSWORD_RESET_START_MAX_PER_WINDOW = 6;

let payoutReceiptSchemaReady = false;
async function ensurePayoutReceiptSchema(pool) {
  if (payoutReceiptSchemaReady) {
    return;
  }
  await pool.query(
    `ALTER TABLE payouts
     ADD COLUMN IF NOT EXISTS receipt_path text,
     ADD COLUMN IF NOT EXISTS receipt_filename text,
     ADD COLUMN IF NOT EXISTS receipt_mime text`
  );
  payoutReceiptSchemaReady = true;
}

const API_ROOT_DIR = path.resolve(__dirname, "../..");
const BACKUP_SCRIPT_PATH = path.join(API_ROOT_DIR, "scripts", "backup_db.sh");
const BACKUP_RESTORE_SCRIPT_PATH = path.join(API_ROOT_DIR, "scripts", "restore_db.sh");
const rawBackupRestoreBody = express.raw({
  type: "application/octet-stream",
  limit: `${Math.max(
    Number.parseInt(process.env.BACKUP_RESTORE_MAX_MB || "", 10) || 200,
    10
  )}mb`,
});
let backupExecutionPromise = null;
let backupRestorePromise = null;
let backupLastRunAt = 0;

function getBackupCooldownSeconds() {
  return Math.max(
    Number.parseInt(process.env.BACKUP_TRIGGER_COOLDOWN_SECONDS || "", 10) || 120,
    10
  );
}

function getBackupRunTimeoutMs() {
  return Math.max(
    Number.parseInt(process.env.BACKUP_RUN_TIMEOUT_MS || "", 10) || 120000,
    30000
  );
}

function getBackupRestoreTimeoutMs() {
  return Math.max(
    Number.parseInt(process.env.BACKUP_RESTORE_TIMEOUT_MS || "", 10) || 600000,
    120000
  );
}

function getBackupRestoreMaxBytes() {
  const configured = Number.parseInt(process.env.BACKUP_RESTORE_MAX_MB || "", 10) || 200;
  return Math.max(configured, 10) * 1024 * 1024;
}

function resolveBackupDir() {
  const raw = String(process.env.BACKUP_DIR || "./backups/postgres").trim();
  if (!raw) {
    return path.join(API_ROOT_DIR, "backups", "postgres");
  }
  return path.isAbsolute(raw) ? raw : path.resolve(API_ROOT_DIR, raw);
}

async function readBackupMetadata(filePath) {
  const stats = await fs.stat(filePath);
  return {
    filename: path.basename(filePath),
    path: filePath,
    size_bytes: Number(stats.size || 0),
    created_at: stats.mtime.toISOString(),
  };
}

function toPublicBackupMetadata(metadata) {
  if (!metadata) {
    return null;
  }
  return {
    filename: metadata.filename || null,
    size_bytes: Number(metadata.size_bytes || 0),
    created_at: metadata.created_at || null,
    drive: metadata.drive || null,
    telegram: metadata.telegram || null,
  };
}

async function getLatestBackupMetadata() {
  const backupDir = resolveBackupDir();
  let files = [];
  try {
    files = await fs.readdir(backupDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const gzipFiles = files
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => path.join(backupDir, name));
  if (gzipFiles.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    gzipFiles.map(async (fullPath) => {
      const stats = await fs.stat(fullPath);
      return { fullPath, mtimeMs: Number(stats.mtimeMs || 0) };
    })
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return readBackupMetadata(withStats[0].fullPath);
}

function parseBackupFileFromOutput(stdout = "") {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines
    .slice()
    .reverse()
    .find((line) => line.endsWith(".sql.gz"));
  if (!candidate) {
    return "";
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(API_ROOT_DIR, candidate);
}

function sanitizeRestoreFilename(value) {
  const raw = String(value || "").trim();
  const base = path.basename(raw).replace(/\s+/g, "_");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!cleaned || !cleaned.toLowerCase().endsWith(".sql.gz")) {
    return "";
  }
  return cleaned;
}

function parseRestoreMetadataFromOutput(stdout = "") {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preBackupLine = lines.find((line) => line.startsWith("[restore] pre-backup:"));
  const preBackupPath = preBackupLine
    ? preBackupLine.replace("[restore] pre-backup:", "").trim()
    : "";
  return {
    pre_backup_path: preBackupPath || null,
  };
}

async function runRestoreNow(uploadedFilePath, sourceFilename) {
  if (backupRestorePromise) {
    const error = new Error("RESTORE_IN_PROGRESS");
    error.status = 409;
    error.payload = { error: "RESTORE_IN_PROGRESS" };
    throw error;
  }
  if (backupExecutionPromise) {
    const error = new Error("BACKUP_IN_PROGRESS");
    error.status = 409;
    error.payload = { error: "BACKUP_IN_PROGRESS" };
    throw error;
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    const error = new Error("DATABASE_URL is required");
    error.status = 500;
    error.payload = { error: "DATABASE_URL_MISSING" };
    throw error;
  }

  const backupDir = resolveBackupDir();
  backupRestorePromise = (async () => {
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BACKUP_DIR: backupDir,
      FORCE_RESTORE: "true",
    };
    const { stdout } = await execFileAsync(
      "/bin/bash",
      [BACKUP_RESTORE_SCRIPT_PATH, uploadedFilePath],
      {
        cwd: API_ROOT_DIR,
        env,
        timeout: getBackupRestoreTimeoutMs(),
        maxBuffer: 1024 * 1024 * 20,
      }
    );
    const metadata = parseRestoreMetadataFromOutput(stdout);
    return {
      source_filename: sourceFilename,
      source_path: uploadedFilePath,
      restored_at: new Date().toISOString(),
      ...metadata,
    };
  })().finally(() => {
    backupRestorePromise = null;
  });

  return backupRestorePromise;
}

async function runBackupNow() {
  if (backupExecutionPromise) {
    return backupExecutionPromise;
  }
  if (backupRestorePromise) {
    const error = new Error("RESTORE_IN_PROGRESS");
    error.status = 409;
    error.payload = { error: "RESTORE_IN_PROGRESS" };
    throw error;
  }

  const now = Date.now();
  const cooldownMs = getBackupCooldownSeconds() * 1000;
  if (backupLastRunAt > 0 && now - backupLastRunAt < cooldownMs) {
    const retryIn = Math.max(Math.ceil((cooldownMs - (now - backupLastRunAt)) / 1000), 1);
    const error = new Error("BACKUP_COOLDOWN");
    error.status = 429;
    error.payload = { error: "BACKUP_COOLDOWN", retry_in: retryIn };
    throw error;
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    const error = new Error("DATABASE_URL is required");
    error.status = 500;
    error.payload = { error: "DATABASE_URL_MISSING" };
    throw error;
  }

  const backupDir = resolveBackupDir();
  backupExecutionPromise = (async () => {
    await fs.mkdir(backupDir, { recursive: true });
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BACKUP_DIR: backupDir,
    };
    const { stdout } = await execFileAsync("/bin/bash", [BACKUP_SCRIPT_PATH], {
      cwd: API_ROOT_DIR,
      env,
      timeout: getBackupRunTimeoutMs(),
      maxBuffer: 1024 * 1024 * 5,
    });
    const outputFile = parseBackupFileFromOutput(stdout);
    let metadata = null;
    if (outputFile) {
      metadata = await readBackupMetadata(outputFile);
    } else {
      metadata = await getLatestBackupMetadata();
    }
    const latest = metadata;
    if (!latest) {
      const error = new Error("BACKUP_FILE_NOT_FOUND");
      error.status = 500;
      throw error;
    }

    if (isDriveUploadEnabled()) {
      try {
        const uploaded = await uploadBackupFileToDrive(latest.path, {
          filename: latest.filename,
        });
        latest.drive = {
          uploaded: true,
          ...uploaded,
        };
      } catch (uploadError) {
        console.error("[backup] drive upload failed", {
          message: uploadError?.message || String(uploadError),
        });
        latest.drive = {
          uploaded: false,
          error: uploadError?.message || "DRIVE_UPLOAD_FAILED",
        };
      }
    }

    if (isTelegramBackupEnabled()) {
      try {
        const uploaded = await uploadBackupFileToTelegram(latest.path, {
          filename: latest.filename,
        });
        latest.telegram = uploaded;
      } catch (uploadError) {
        console.error("[backup] telegram upload failed", {
          message: uploadError?.message || String(uploadError),
        });
        latest.telegram = {
          uploaded: false,
          delivered_count: 0,
          failed_count: 0,
          error: uploadError?.message || "TELEGRAM_UPLOAD_FAILED",
        };
      }
    }

    return latest;
  })()
    .then((metadata) => {
      backupLastRunAt = Date.now();
      return metadata;
    })
    .finally(() => {
      backupExecutionPromise = null;
    });

  return backupExecutionPromise;
}

const MESSAGES = {
  es: {
    payment_received: "🎉 Felicidades, hemos recibido tu pago 🎉 🥳",
    refund_full:
      "✅ Tu reembolso fue procesado correctamente.\n\nMonto reembolsado: {amount}\n\nSi necesitas ayuda, contáctanos.",
    refund_partial:
      "✅ Procesamos un reembolso parcial de tu orden.\n\nMonto reembolsado: {amount}\n\nSi necesitas ayuda, contáctanos.",
  },
  en: {
    payment_received: "🎉 Congratulations, we’ve received your payment 🎉 🥳",
    refund_full:
      "✅ Your refund was processed successfully.\n\nRefunded amount: {amount}\n\nIf you need help, contact us.",
    refund_partial:
      "✅ We processed a partial refund for your order.\n\nRefunded amount: {amount}\n\nIf you need help, contact us.",
  },
};

const SUPPORT_MESSAGES = {
  es: {
    image_allowed: "🖼️ Ya puedes enviar una imagen en este ticket. Solo 1 captura.",
    ticket_closed: "✅ Tu ticket de soporte fue cerrado. Si necesitas más ayuda, abre un nuevo ticket.",
    user_banned: "⛔️ Has sido baneado de soporte por uso indebido de mensajes.",
  },
  en: {
    image_allowed: "🖼️ You can now send one image in this ticket. Only 1 capture.",
    ticket_closed: "✅ Your support ticket was closed. If you need more help, open a new ticket.",
    user_banned: "⛔️ You have been banned from support for misuse of messages.",
  },
};

const AFFILIATE_MESSAGES = {
  es: {
    approved: "✅ Tu solicitud para ser afiliado fue aprobada por el admin.",
    rejected: "❌ Tu solicitud para ser afiliado fue rechazada por el admin.",
    blocked:
      "🔒 Afiliado: {username}\n\n⚠️ Haz sido bloqueado por un admin, tal ves por que infringiste alguna regla. Si crees que es un error comunícate con @Noropayments.",
    unblocked:
      "🔓 Haz sido desbloqueado por un admin. ✅ Sigue trabajando sin romper las reglas.",
    adjustment_credit:
      "✅ Se te agregó saldo.\n\n💵 Monto: {amount}\n📝 Motivo: {reason}",
    adjustment_debit:
      "⚠️ Se te descontó saldo.\n\n💵 Monto: {amount}\n📝 Motivo: {reason}",
    refund_full:
      "⚠️ Se reembolsó una orden referida por ti y se descontó tu comisión.\n\nMonto descontado: {amount}.",
    refund_partial:
      "⚠️ Se realizó un reembolso parcial en una orden referida por ti y se ajustó tu comisión.\n\nMonto descontado: {amount}.",
  },
  en: {
    approved: "✅ Your affiliate request was approved by the admin.",
    rejected: "❌ Your affiliate request was rejected by the admin.",
    blocked:
      "🔒 Affiliate: {username}\n\n⚠️ You have been blocked by an admin, maybe because you violated a rule. If you think this is a mistake, contact @Noropayments.",
    unblocked:
      "🔓 You have been unblocked by an admin. ✅ Keep working without breaking the rules.",
    adjustment_credit:
      "✅ Balance added.\n\n💵 Amount: {amount}\n📝 Reason: {reason}",
    adjustment_debit:
      "⚠️ Balance deducted.\n\n💵 Amount: {amount}\n📝 Reason: {reason}",
    refund_full:
      "⚠️ A referred order was refunded and your commission was deducted.\n\nAmount deducted: {amount}.",
    refund_partial:
      "⚠️ A referred order was partially refunded and your commission was adjusted.\n\nAmount deducted: {amount}.",
  },
};

function buildAffiliateRankUpMessage(levelKey) {
  if (levelKey === "BRONCE") {
    return (
      "🎉 ¡Felicidades! Subiste a <b>Afiliado Bronce</b> 🥉\n\n" +
      "Beneficios próximos: mejores comisiones y materiales."
    );
  }
  if (levelKey === "PLATA") {
    return (
      "🎉 ¡Felicidades! Subiste a <b>Afiliado Plata</b> 🥈\n\n" +
      "Beneficios próximos: mejores comisiones, bonos y materiales."
    );
  }
  if (levelKey === "ORO") {
    return (
      "🏆 ¡Increíble! Subiste a <b>Afiliado Oro</b> 🥇\n\n" +
      "Beneficios próximos: comisiones VIP, prioridad y bonos especiales."
    );
  }
  if (levelKey === "DIAMANTE") {
    return (
      "💎 ¡Excelente! Subiste a <b>Afiliado Diamante</b> 💎\n\n" +
      "Beneficios próximos: bonos premium y soporte prioritario."
    );
  }
  if (levelKey === "ELITE") {
    return (
      "👑 ¡Legendario! Subiste a <b>Afiliado Elite</b> 👑\n\n" +
      "Beneficios próximos: recompensas elite y beneficios exclusivos."
    );
  }
  return "";
}

const router = express.Router();

const DELIVERY_START_DELAY_MS = Math.max(
  Number(process.env.DELIVERY_START_DELAY_MS || 10000) || 10000,
  0
);

let broadcastSchemaReady = false;
async function ensureBroadcastSchema(pool) {
  if (broadcastSchemaReady) {
    return;
  }
  await pool.query(
    `ALTER TABLE broadcasts
     ADD COLUMN IF NOT EXISTS image_path text,
     ADD COLUMN IF NOT EXISTS image_filename text,
     ADD COLUMN IF NOT EXISTS image_mime text,
     ADD COLUMN IF NOT EXISTS buttons jsonb,
     ADD COLUMN IF NOT EXISTS message_entities jsonb,
     ADD COLUMN IF NOT EXISTS saved boolean NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS saved_kind text NOT NULL DEFAULT 'MESSAGE',
     ADD COLUMN IF NOT EXISTS progress_status text NOT NULL DEFAULT 'IDLE',
     ADD COLUMN IF NOT EXISTS progress_target_count integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS progress_sent_count integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS progress_failed_count integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS progress_recipients jsonb,
     ADD COLUMN IF NOT EXISTS progress_cursor integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS progress_last_error text,
     ADD COLUMN IF NOT EXISTS progress_lease_token text,
     ADD COLUMN IF NOT EXISTS progress_lease_expires_at timestamptz,
     ADD COLUMN IF NOT EXISTS progress_started_at timestamptz,
     ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz`
  );
  await pool.query(
    `UPDATE broadcasts
     SET saved_kind = 'MESSAGE'
     WHERE saved_kind IS NULL
        OR saved_kind NOT IN ('MESSAGE', 'GIFT')`
  );
  await pool.query(
    `UPDATE broadcasts
     SET saved_kind = 'GIFT'
     WHERE saved_kind <> 'GIFT'
       AND (
         COALESCE(buttons, '[]'::jsonb) @> '[{"action":"gift"}]'::jsonb
         OR COALESCE(buttons, '[]'::jsonb) @> '[{"type":"gift"}]'::jsonb
       )`
  );
  await pool.query(
    `ALTER TABLE broadcasts
     DROP CONSTRAINT IF EXISTS broadcasts_saved_kind_check`
  );
  await pool.query(
    `ALTER TABLE broadcasts
     ADD CONSTRAINT broadcasts_saved_kind_check
     CHECK (saved_kind IN ('MESSAGE', 'GIFT'))`
  );
  broadcastSchemaReady = true;
}

function normalizeBroadcastMessageEntities(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowedTypes = new Set([
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "code",
    "pre",
    "blockquote",
    "expandable_blockquote",
    "text_link",
    "custom_emoji",
  ]);
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const type = String(item.type || "").trim();
      const offset = Number(item.offset);
      const length = Number(item.length);
      if (!type || !allowedTypes.has(type) || !Number.isInteger(offset) || !Number.isInteger(length)) {
        return null;
      }
      if (offset < 0 || length <= 0) {
        return null;
      }
      const entity = { type, offset, length };
      if (type === "text_link") {
        const url = String(item.url || "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return null;
        }
        entity.url = url;
      }
      if (type === "pre") {
        const language = String(item.language || "").trim();
        if (language) {
          entity.language = language;
        }
      }
      if (type === "custom_emoji") {
        const customEmojiId = String(item.custom_emoji_id || "").trim();
        if (!/^[0-9]+$/.test(customEmojiId)) {
          return null;
        }
        entity.custom_emoji_id = customEmojiId;
      }
      return entity;
    })
    .filter(Boolean);
}

const BROADCAST_BATCH_SIZE = 25;
const BROADCAST_BATCH_DELAY_MS = 75;
const BROADCAST_LEASE_SECONDS = Math.max(
  Number(process.env.BROADCAST_LEASE_SECONDS || 45) || 45,
  10
);
const BROADCAST_RECOVERY_INTERVAL_MS = Math.max(
  Number(process.env.BROADCAST_RECOVERY_INTERVAL_MS || 15000) || 15000,
  5000
);
const _activeBroadcastJobs = new Set();
let _broadcastRecoveryStarted = false;

function normalizeBroadcastRecipientIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter((item) => item && /^-?[0-9]+$/.test(item))
    )
  );
}

function buildBroadcastDeliveryContext(broadcast) {
  const messageEntities = normalizeBroadcastMessageEntities(broadcast.message_entities);
  const usesEntities = messageEntities.length > 0;
  const formattedMessage = usesEntities
    ? String(broadcast.message_text || "")
    : formatBroadcastMessage(broadcast.message_text);
  const buttons = Array.isArray(broadcast.buttons) ? broadcast.buttons : [];
  const replyMarkup = buildInlineKeyboard(buttons);
  const messageOptions = replyMarkup ? { reply_markup: replyMarkup } : {};
  if (usesEntities) {
    messageOptions.entities = messageEntities;
  } else {
    messageOptions.parse_mode = "HTML";
  }
  const storedTelegramMedia = parseStoredTelegramMedia(
    broadcast.image_path,
    broadcast.image_mime
  );
  return {
    usesEntities,
    messageEntities,
    formattedMessage,
    replyMarkup,
    messageOptions,
    storedTelegramMedia,
  };
}

async function sendBroadcastToRecipient(context, broadcast, telegramId) {
  const {
    usesEntities,
    messageEntities,
    formattedMessage,
    replyMarkup,
    messageOptions,
    storedTelegramMedia,
  } = context;

  if (storedTelegramMedia) {
    if (storedTelegramMedia.kind === "sticker") {
      const stickerResult = await sendSticker(telegramId, {
        file_id: storedTelegramMedia.fileId,
        reply_markup: !formattedMessage && replyMarkup ? replyMarkup : undefined,
      });
      if (formattedMessage) {
        const textResult = await sendMessage(telegramId, formattedMessage, messageOptions);
        return {
          messageId: Number(textResult?.message_id || 0) || null,
          linkedMessageId: Number(stickerResult?.message_id || 0) || null,
        };
      }
      return {
        messageId: Number(stickerResult?.message_id || 0) || null,
        linkedMessageId: null,
      };
    }
    const mediaPayload = {
      file_id: storedTelegramMedia.fileId,
      caption: formattedMessage,
      reply_markup: replyMarkup || undefined,
    };
    if (usesEntities) {
      mediaPayload.caption_entities = messageEntities;
    } else {
      mediaPayload.parse_mode = "HTML";
    }
    if (storedTelegramMedia.kind === "video") {
      const result = await sendVideo(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    } else if (storedTelegramMedia.kind === "animation") {
      const result = await sendAnimation(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    } else {
      const result = await sendPhoto(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    }
  }

  if (broadcast.image_path) {
    const mime = String(broadcast.image_mime || "").trim().toLowerCase();
    const mediaPayload = {
      path: broadcast.image_path,
      filename: broadcast.image_filename || undefined,
      caption: formattedMessage,
      reply_markup: replyMarkup || undefined,
    };
    if (usesEntities) {
      mediaPayload.caption_entities = messageEntities;
    } else {
      mediaPayload.parse_mode = "HTML";
    }
    if (mime === "image/gif") {
      const result = await sendAnimation(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    } else if (mime.startsWith("video/")) {
      const result = await sendVideo(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    } else {
      const result = await sendPhoto(telegramId, mediaPayload);
      return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
    }
  }

  const result = await sendMessage(telegramId, formattedMessage, messageOptions);
  return { messageId: Number(result?.message_id || 0) || null, linkedMessageId: null };
}

async function sendPublicationToTargets(pool, payload) {
  await ensurePublishTargetsSchema(pool);
  await ensureWalletGiftSchema(pool);
  const scope = String(payload?.scope || "all").trim().toLowerCase();
  const explicitChatIds = normalizeChatIds(payload?.chat_ids);
  let targets = [];
  if (explicitChatIds.length > 0) {
    const allTargets = await listPublishTargets(pool, {
      scope: "all",
      activeOnly: true,
      adminOnly: true,
      limit: 500,
    });
    const allowed = new Set(explicitChatIds.map((id) => String(id)));
    targets = allTargets.filter((item) => allowed.has(String(item.chat_id)));
  } else {
    targets = await listPublishTargets(pool, {
      scope,
      activeOnly: true,
      adminOnly: true,
      limit: 500,
    });
  }

  const messageText = String(payload?.message || "").trim();
  const messageEntities = normalizeBroadcastMessageEntities(payload?.message_entities);
  const buttons = normalizeBroadcastButtons(payload?.buttons);
  const mediaFileId = String(payload?.media_file_id || "").trim();
  const mediaKind = normalizeBroadcastMediaKind(payload?.media_kind);

  if (!messageText && !mediaFileId) {
    const error = new Error("MESSAGE_REQUIRED");
    error.code = "MESSAGE_REQUIRED";
    throw error;
  }
  if (mediaFileId && !mediaKind) {
    const error = new Error("MEDIA_KIND_INVALID");
    error.code = "MEDIA_KIND_INVALID";
    throw error;
  }

  const prepared = await prepareWalletGiftButtonsForSend(pool, buttons, {
    sourceKind: "PUBLICATION",
    sourceEntityId: String(payload?.publication_id || "").trim() || null,
    sourceScope: "CHAT",
  });

  const context = buildBroadcastDeliveryContext({
    message_text: messageText,
    message_entities: messageEntities,
    buttons: prepared.buttons,
    image_path: mediaFileId ? `tgfile:${mediaFileId}` : null,
    image_mime: mediaFileId ? `tg:${mediaKind}` : null,
  });

  let sentCount = 0;
  let failedCount = 0;
  const failures = [];
  for (const target of targets) {
    const chatId = String(target.chat_id || "").trim();
    if (!chatId) {
      continue;
    }
    try {
      const sendResult = await sendBroadcastToRecipient(
        context,
        { image_path: mediaFileId ? `tgfile:${mediaFileId}` : null, image_mime: mediaFileId ? `tg:${mediaKind}` : null },
        chatId
      );
      if (prepared.gift && sendResult?.messageId) {
        await recordWalletGiftMessage(pool, {
          giftId: prepared.gift.id,
          chatId,
          chatType: target.chat_type || null,
          messageId: sendResult.messageId,
          linkedMessageId: sendResult.linkedMessageId || null,
        });
      }
      sentCount += 1;
    } catch (error) {
      failedCount += 1;
      failures.push({
        chat_id: chatId,
        title: target.chat_title || null,
        type: target.chat_type || null,
        error: String(error?.description || error?.message || error || "SEND_FAILED").slice(0, 200),
      });
    }
    if (targets.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, BROADCAST_BATCH_DELAY_MS));
    }
  }

  return {
    scope,
    gift_id: prepared.gift?.id || null,
    target_count: targets.length,
    sent_count: sentCount,
    failed_count: failedCount,
    failures,
  };
}

let ensurePublicationSchemaPromise = null;
let publicationSchemaReady = false;

async function ensurePublicationSchema(pool) {
  if (publicationSchemaReady) {
    return;
  }
  if (ensurePublicationSchemaPromise) {
    await ensurePublicationSchemaPromise;
    return;
  }
  ensurePublicationSchemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS publications (
        id UUID PRIMARY KEY,
        message_text TEXT NOT NULL DEFAULT '',
        message_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
        buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
        image_path TEXT,
        image_filename TEXT,
        image_mime TEXT,
        saved_kind TEXT NOT NULL DEFAULT 'MESSAGE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `ALTER TABLE publications
       ADD COLUMN IF NOT EXISTS saved_kind text NOT NULL DEFAULT 'MESSAGE'`
    );
    await pool.query(
      `UPDATE publications
       SET saved_kind = 'MESSAGE'
       WHERE saved_kind IS NULL
          OR saved_kind NOT IN ('MESSAGE', 'GIFT')`
    );
    await pool.query(
      `UPDATE publications
       SET saved_kind = 'GIFT'
       WHERE saved_kind <> 'GIFT'
         AND (
           COALESCE(buttons, '[]'::jsonb) @> '[{"action":"gift"}]'::jsonb
           OR COALESCE(buttons, '[]'::jsonb) @> '[{"type":"gift"}]'::jsonb
         )`
    );
    await pool.query(
      `ALTER TABLE publications
       DROP CONSTRAINT IF EXISTS publications_saved_kind_check`
    );
    await pool.query(
      `ALTER TABLE publications
       ADD CONSTRAINT publications_saved_kind_check
       CHECK (saved_kind IN ('MESSAGE', 'GIFT'))`
    );
  })();
  try {
    await ensurePublicationSchemaPromise;
    publicationSchemaReady = true;
  } finally {
    ensurePublicationSchemaPromise = null;
  }
}

async function acquireBroadcastLease(pool, broadcastId, workerToken) {
  const leaseRes = await pool.query(
    `UPDATE broadcasts
     SET progress_lease_token = $2,
         progress_lease_expires_at = now() + ($3 * interval '1 second'),
         progress_status = CASE
           WHEN progress_status = 'QUEUED' THEN 'SENDING'
           ELSE progress_status
         END,
         progress_updated_at = now()
     WHERE id = $1
       AND (
         (
           progress_status IN ('QUEUED', 'SENDING')
           AND (
             progress_lease_token = $2
             OR progress_lease_expires_at IS NULL
             OR progress_lease_expires_at <= now()
           )
         )
         OR (
           progress_status IN ('PAUSING', 'STOPPING')
           AND progress_lease_token = $2
         )
       )
     RETURNING id`,
    [broadcastId, workerToken, BROADCAST_LEASE_SECONDS]
  );
  return leaseRes.rowCount > 0;
}

async function markBroadcastCheckpoint(
  pool,
  broadcastId,
  workerToken,
  recipientIds,
  sentCount,
  failedCount,
  cursor,
  lastError = null
) {
  const updateRes = await pool.query(
    `UPDATE broadcasts
     SET progress_status = CASE
           WHEN progress_status = 'PAUSING' THEN 'PAUSING'
           WHEN progress_status = 'STOPPING' THEN 'STOPPING'
           ELSE 'SENDING'
         END,
         progress_target_count = $3,
         progress_sent_count = $4,
         progress_failed_count = $5,
         progress_cursor = $6,
         progress_recipients = $7::jsonb,
         progress_last_error = $8,
         progress_lease_token = $2,
         progress_lease_expires_at = now() + ($9 * interval '1 second'),
         progress_updated_at = now(),
         progress_started_at = COALESCE(progress_started_at, now())
     WHERE id = $1
       AND progress_lease_token = $2
     RETURNING progress_status`,
    [
      broadcastId,
      workerToken,
      recipientIds.length,
      sentCount,
      failedCount,
      cursor,
      JSON.stringify(recipientIds),
      lastError,
      BROADCAST_LEASE_SECONDS,
    ]
  );
  return updateRes.rows[0]?.progress_status || null;
}

async function finalizePausedBroadcast(pool, broadcastId, workerToken) {
  const updateRes = await pool.query(
    `UPDATE broadcasts
     SET progress_status = 'PAUSED',
         progress_lease_token = NULL,
         progress_lease_expires_at = NULL,
         progress_updated_at = now()
     WHERE id = $1
       AND progress_lease_token = $2
     RETURNING id`,
    [broadcastId, workerToken]
  );
  return updateRes.rowCount > 0;
}

async function finalizeStoppedBroadcast(
  pool,
  broadcastId,
  workerToken,
  recipientIds,
  sentCount,
  failedCount
) {
  const updateRes = await pool.query(
    `UPDATE broadcasts
     SET status = 'FAILED',
         sent_at = now(),
         progress_status = 'STOPPED',
         progress_target_count = $3,
         progress_sent_count = $4,
         progress_failed_count = $5,
         progress_cursor = $6,
         progress_recipients = $7::jsonb,
         progress_last_error = 'Stopped manually by admin',
         progress_lease_token = NULL,
         progress_lease_expires_at = NULL,
         progress_updated_at = now()
     WHERE id = $1
       AND progress_lease_token = $2
     RETURNING *`,
    [
      broadcastId,
      workerToken,
      recipientIds.length,
      sentCount,
      failedCount,
      Math.max(Number(sentCount || 0) + Number(failedCount || 0), 0),
      JSON.stringify(recipientIds),
    ]
  );
  return updateRes.rows[0] || null;
}

async function finalizeBroadcastCheckpoint(
  pool,
  broadcastId,
  workerToken,
  recipientIds,
  sentCount,
  failedCount,
  finalStatus
) {
  const updatedRes = await pool.query(
    `UPDATE broadcasts
     SET status = $3,
         sent_at = now(),
         progress_status = $3,
         progress_target_count = $4,
         progress_sent_count = $5,
         progress_failed_count = $6,
         progress_cursor = $4,
         progress_recipients = $7::jsonb,
         progress_last_error = NULL,
         progress_lease_token = NULL,
         progress_lease_expires_at = NULL,
         progress_updated_at = now()
     WHERE id = $1
       AND progress_lease_token = $2
     RETURNING *`,
    [
      broadcastId,
      workerToken,
      finalStatus,
      recipientIds.length,
      sentCount,
      failedCount,
      JSON.stringify(recipientIds),
    ]
  );
  return updatedRes.rows[0] || null;
}

async function markBroadcastRetryableFailure(pool, broadcastId, workerToken, error) {
  const message = error && error.message ? String(error.message) : String(error || "UNKNOWN");
  await pool.query(
    `UPDATE broadcasts
     SET status = CASE
           WHEN progress_status = 'STOPPING' THEN 'FAILED'
           ELSE status
         END::broadcast_status,
         sent_at = CASE
           WHEN progress_status = 'STOPPING' THEN COALESCE(sent_at, now())
           ELSE sent_at
         END,
         progress_status = CASE
           WHEN progress_status = 'PAUSING' THEN 'PAUSED'
           WHEN progress_status = 'STOPPING' THEN 'STOPPED'
           ELSE 'QUEUED'
         END,
         progress_last_error = CASE
           WHEN progress_status = 'STOPPING' THEN 'Stopped manually by admin'
           ELSE $3
         END,
         progress_lease_token = NULL,
         progress_lease_expires_at = NULL,
         progress_updated_at = now()
     WHERE id = $1
       AND progress_lease_token = $2`,
    [broadcastId, workerToken, message.slice(0, 500)]
  );
}

async function runBroadcastSendJob(pool, broadcastId) {
  if (!broadcastId || _activeBroadcastJobs.has(broadcastId)) {
    return;
  }
  _activeBroadcastJobs.add(broadcastId);
  const workerToken = randomUUID();

  try {
    const leaseAcquired = await acquireBroadcastLease(pool, broadcastId, workerToken);
    if (!leaseAcquired) {
      return;
    }

    const broadcastRes = await pool.query("SELECT * FROM broadcasts WHERE id = $1", [broadcastId]);
    if (broadcastRes.rowCount === 0) {
      return;
    }
    const broadcast = broadcastRes.rows[0];
    const recipientIds = normalizeBroadcastRecipientIds(broadcast.progress_recipients);
    const context = buildBroadcastDeliveryContext(broadcast);
    let cursor = Math.max(Number(broadcast.progress_cursor || 0), 0);
    let sentCount = Math.max(Number(broadcast.progress_sent_count || 0), 0);
    let failedCount = Math.max(Number(broadcast.progress_failed_count || 0), 0);

    if (recipientIds.length === 0) {
      const finalStatus = "FAILED";
      const finalized = await finalizeBroadcastCheckpoint(
        pool,
        broadcastId,
        workerToken,
        recipientIds,
        sentCount,
        failedCount,
        finalStatus
      );
      if (finalized) {
        await pool.query(
          `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            "BROADCAST_SEND_RESULT",
            "broadcast",
            broadcastId,
            JSON.stringify({
              target_count: 0,
              sent_count: sentCount,
              failed_count: failedCount,
            }),
          ]
        );
      }
      return;
    }

    const checkpointStatus = await markBroadcastCheckpoint(
      pool,
      broadcastId,
      workerToken,
      recipientIds,
      sentCount,
      failedCount,
      cursor,
      null
    );
    if (!checkpointStatus) {
      return;
    }
    if (checkpointStatus === "PAUSING") {
      await finalizePausedBroadcast(pool, broadcastId, workerToken);
      return;
    }
    if (checkpointStatus === "STOPPING") {
      await finalizeStoppedBroadcast(
        pool,
        broadcastId,
        workerToken,
        recipientIds,
        sentCount,
        failedCount
      );
      return;
    }

    while (cursor < recipientIds.length) {
      const leaseOk = await acquireBroadcastLease(pool, broadcastId, workerToken);
      if (!leaseOk) {
        return;
      }

      const telegramId = recipientIds[cursor];
      try {
        await sendBroadcastToRecipient(context, broadcast, telegramId);
        sentCount += 1;
      } catch (err) {
        failedCount += 1;
        console.error("Broadcast send failed", {
          broadcastId,
          telegramId,
          error: err && err.message ? err.message : err,
        });
      }

      cursor += 1;
      const savedStatus = await markBroadcastCheckpoint(
        pool,
        broadcastId,
        workerToken,
        recipientIds,
        sentCount,
        failedCount,
        cursor,
        null
      );
      if (!savedStatus) {
        return;
      }
      if (savedStatus === "PAUSING") {
        await finalizePausedBroadcast(pool, broadcastId, workerToken);
        return;
      }
      if (savedStatus === "STOPPING") {
        const stopped = await finalizeStoppedBroadcast(
          pool,
          broadcastId,
          workerToken,
          recipientIds,
          sentCount,
          failedCount
        );
        if (stopped) {
          await pool.query(
            `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [
              "BROADCAST_SEND_RESULT",
              "broadcast",
              broadcastId,
              JSON.stringify({
                target_count: recipientIds.length,
                sent_count: sentCount,
                failed_count: failedCount,
                stopped: true,
              }),
            ]
          );
        }
        return;
      }

      if (cursor < recipientIds.length && cursor % BROADCAST_BATCH_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, BROADCAST_BATCH_DELAY_MS));
      }
    }

    const finalStatus = sentCount > 0 ? "SENT" : "FAILED";
    const finalized = await finalizeBroadcastCheckpoint(
      pool,
      broadcastId,
      workerToken,
      recipientIds,
      sentCount,
      failedCount,
      finalStatus
    );
    if (!finalized) {
      return;
    }

    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "BROADCAST_SEND_RESULT",
        "broadcast",
        broadcastId,
        JSON.stringify({
          target_count: recipientIds.length,
          sent_count: sentCount,
          failed_count: failedCount,
        }),
      ]
    );
  } catch (error) {
    console.error("Broadcast resilient send failed", {
      broadcastId,
      error: error && error.message ? error.message : error,
    });
    await markBroadcastRetryableFailure(pool, broadcastId, workerToken, error);
  } finally {
    _activeBroadcastJobs.delete(broadcastId);
  }
}

function scheduleBroadcastSendJob(pool, broadcastId, delayMs = 0) {
  if (!broadcastId || _activeBroadcastJobs.has(broadcastId)) {
    return;
  }
  const launch = () => {
    void runBroadcastSendJob(pool, broadcastId);
  };
  if (delayMs > 0) {
    setTimeout(launch, delayMs);
  } else {
    setImmediate(launch);
  }
}

function startBroadcastRecoveryLoop() {
  if (_broadcastRecoveryStarted) {
    return;
  }
  _broadcastRecoveryStarted = true;
  const tick = async () => {
    try {
      const pool = getPool();
      await ensureBroadcastSchema(pool);
      await pool.query(
        `UPDATE broadcasts
         SET progress_status = 'PAUSED',
             progress_lease_token = NULL,
             progress_lease_expires_at = NULL,
             progress_updated_at = now()
         WHERE progress_status = 'PAUSING'
           AND (
             progress_lease_expires_at IS NULL
             OR progress_lease_expires_at <= now()
           )`
      );
      await pool.query(
        `UPDATE broadcasts
         SET status = 'FAILED',
             sent_at = COALESCE(sent_at, now()),
             progress_status = 'STOPPED',
             progress_last_error = COALESCE(progress_last_error, 'Stopped manually by admin'),
             progress_lease_token = NULL,
             progress_lease_expires_at = NULL,
             progress_updated_at = now()
         WHERE progress_status = 'STOPPING'
           AND (
             progress_lease_expires_at IS NULL
             OR progress_lease_expires_at <= now()
           )`
      );
      await pool.query(
        `UPDATE broadcasts
         SET status = CASE
               WHEN COALESCE(progress_sent_count, 0) > 0 THEN 'SENT'
               ELSE 'FAILED'
             END::broadcast_status,
             sent_at = COALESCE(sent_at, now()),
             progress_status = CASE
               WHEN COALESCE(progress_sent_count, 0) > 0 THEN 'SENT'
               ELSE 'FAILED'
             END,
             progress_cursor = jsonb_array_length(progress_recipients),
             progress_lease_token = NULL,
             progress_lease_expires_at = NULL,
             progress_updated_at = now()
         WHERE progress_status IN ('QUEUED', 'SENDING')
           AND progress_recipients IS NOT NULL
           AND jsonb_typeof(progress_recipients) = 'array'
           AND COALESCE(progress_cursor, 0) >= jsonb_array_length(progress_recipients)
           AND (
             progress_lease_expires_at IS NULL
             OR progress_lease_expires_at <= now()
           )`
      );
      const pendingRes = await pool.query(
        `SELECT id
         FROM broadcasts
         WHERE progress_status IN ('QUEUED', 'SENDING')
           AND progress_recipients IS NOT NULL
           AND jsonb_typeof(progress_recipients) = 'array'
           AND COALESCE(progress_cursor, 0) < jsonb_array_length(progress_recipients)
           AND (
             progress_lease_expires_at IS NULL
             OR progress_lease_expires_at <= now()
           )
         ORDER BY progress_updated_at NULLS FIRST, created_at ASC
         LIMIT 10`
      );
      for (const row of pendingRes.rows) {
        const broadcastId = String(row.id || "").trim();
        if (!broadcastId) {
          continue;
        }
        scheduleBroadcastSendJob(pool, broadcastId);
      }
    } catch (error) {
      console.error("Broadcast recovery tick failed", error);
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => {
      void tick();
    }, BROADCAST_RECOVERY_INTERVAL_MS);
  }, 5000);
}

function buildBroadcastProgressPayload(row, fallbackResult = null) {
  const rawProgressStatus = String(
    row?.progress_status
      || (row?.status === "SENT" || row?.status === "FAILED" ? row.status : "IDLE")
  ).toUpperCase();
  const targetCount = Number(
    row?.progress_target_count != null
      ? row.progress_target_count
      : fallbackResult?.target_count || 0
  );
  const sentCount = Number(
    row?.progress_sent_count != null
      ? row.progress_sent_count
      : fallbackResult?.sent_count || 0
  );
  const failedCount = Number(
    row?.progress_failed_count != null
      ? row.progress_failed_count
      : fallbackResult?.failed_count || 0
  );
  const cursor = Number(
    row?.progress_cursor != null
      ? row.progress_cursor
      : sentCount + failedCount
  );
  const processedCount = Math.max(cursor, sentCount + failedCount);
  const pendingCount = Math.max(targetCount - processedCount, 0);
  const percent = targetCount > 0
    ? Math.max(0, Math.min(100, Math.round((processedCount / targetCount) * 100)))
    : 0;
  const progressStatus = (
    targetCount > 0
    && pendingCount === 0
    && ["QUEUED", "SENDING", "PAUSING"].includes(rawProgressStatus)
  )
    ? (sentCount > 0 ? "SENT" : "FAILED")
    : rawProgressStatus;
  const isDone = ["SENT", "FAILED", "STOPPED"].includes(progressStatus);

  return {
    status: progressStatus,
    target_count: targetCount,
    sent_count: sentCount,
    failed_count: failedCount,
    cursor,
    processed_count: processedCount,
    pending_count: pendingCount,
    percent,
    is_done: isDone,
    started_at: row?.progress_started_at || null,
    updated_at: row?.progress_updated_at || null,
    last_error: row?.progress_last_error || null,
  };
}

async function getLatestBroadcastSendResult(pool, broadcastId) {
  const auditRes = await pool.query(
    `SELECT meta
     FROM audit_logs
     WHERE entity_type = 'broadcast'
       AND entity_id = $1
       AND admin_action = 'BROADCAST_SEND_RESULT'
     ORDER BY created_at DESC
     LIMIT 1`,
    [broadcastId]
  );
  if (auditRes.rowCount === 0) {
    return null;
  }
  const meta = auditRes.rows[0]?.meta || {};
  return {
    target_count: Number(meta.target_count || 0),
    sent_count: Number(meta.sent_count || 0),
    failed_count: Number(meta.failed_count || 0),
  };
}

async function resolveBroadcastRecipients(pool, broadcastId, broadcast, body = {}) {
  const bodyTelegramIds = normalizeTelegramIds(body && body.telegram_ids);
  const bodyChatIds = normalizeChatIds(body && body.chat_ids);
  const bodyExceptIds = normalizeChatIds(body && body.except_ids);

  const auditRes = await pool.query(
    `SELECT admin_action, meta
     FROM audit_logs
     WHERE entity_type = 'broadcast'
       AND entity_id = $1
       AND admin_action IN (
         'BROADCAST_CUSTOM_RECIPIENTS',
         'BROADCAST_GROUP_CHATS',
         'BROADCAST_EXCLUDED_RECIPIENTS'
       )
     ORDER BY created_at DESC`,
    [broadcastId]
  );

  let savedTelegramIds = [];
  let savedChatIds = [];
  let savedExceptIds = [];
  for (const row of auditRes.rows) {
    const action = row?.admin_action;
    const meta = row?.meta || {};
    if (action === "BROADCAST_CUSTOM_RECIPIENTS" && savedTelegramIds.length === 0) {
      savedTelegramIds = Array.isArray(meta.telegram_ids) ? meta.telegram_ids : [];
    }
    if (action === "BROADCAST_GROUP_CHATS" && savedChatIds.length === 0) {
      savedChatIds = Array.isArray(meta.chat_ids) ? meta.chat_ids : [];
    }
    if (action === "BROADCAST_EXCLUDED_RECIPIENTS" && savedExceptIds.length === 0) {
      savedExceptIds = Array.isArray(meta.except_ids) ? meta.except_ids : [];
    }
  }

  let recipientIds = [];
  const customIds = bodyTelegramIds.length > 0 ? bodyTelegramIds : savedTelegramIds;
  const groupIds = bodyChatIds.length > 0 ? bodyChatIds : savedChatIds;
  const excludedIds = bodyExceptIds.length > 0 ? bodyExceptIds : savedExceptIds;
  const isCustom = customIds.length > 0;
  const isGroups = broadcast.segment === "GROUPS" || groupIds.length > 0;
  const isChannels = broadcast.segment === "CHANNELS" || groupIds.length > 0;

  if (isGroups || isChannels) {
    recipientIds = Array.from(new Set(groupIds.map((id) => String(id))));
  } else if (isCustom) {
    const uniqueIds = Array.from(new Set(customIds.map((id) => String(id))));
    const bannedRes = await pool.query(
      "SELECT telegram_id FROM user_bans WHERE telegram_id = ANY($1::bigint[])",
      [uniqueIds]
    );
    const bannedSet = new Set(bannedRes.rows.map((row) => String(row.telegram_id)));
    recipientIds = uniqueIds.filter((id) => !bannedSet.has(String(id)));
  } else if (broadcast.segment === "BUYERS_AFFILIATES") {
    const usersRes = await pool.query(
      `SELECT DISTINCT u.telegram_id
       FROM users u
       LEFT JOIN user_bans b ON b.telegram_id = u.telegram_id
       LEFT JOIN orders o ON o.user_id = u.id AND o.status IN ('PAID', 'DELIVERED')
       LEFT JOIN affiliates a ON a.user_id = u.id AND a.status = 'APPROVED'
       WHERE b.telegram_id IS NULL
         AND u.telegram_id IS NOT NULL
         AND u.telegram_id <> 90000000000
         AND (o.id IS NOT NULL OR a.id IS NOT NULL)`
    );
    recipientIds = usersRes.rows.map((row) => String(row.telegram_id));
  } else if (broadcast.segment === "BUYERS") {
    const usersRes = await pool.query(
      `SELECT DISTINCT u.telegram_id
       FROM users u
       JOIN orders o ON o.user_id = u.id AND o.status IN ('PAID', 'DELIVERED')
       LEFT JOIN user_bans b ON b.telegram_id = u.telegram_id
       WHERE b.telegram_id IS NULL
         AND u.telegram_id IS NOT NULL
         AND u.telegram_id <> 90000000000`
    );
    recipientIds = usersRes.rows.map((row) => String(row.telegram_id));
  } else if (broadcast.segment === "AFFILIATES") {
    const usersRes = await pool.query(
      `SELECT DISTINCT u.telegram_id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN user_bans b ON b.telegram_id = u.telegram_id
       WHERE a.status = 'APPROVED'
         AND b.telegram_id IS NULL
         AND u.telegram_id IS NOT NULL
         AND u.telegram_id <> 90000000000`
    );
    recipientIds = usersRes.rows.map((row) => String(row.telegram_id));
  } else {
    const usersRes = await pool.query(
      `SELECT u.telegram_id
       FROM users u
       LEFT JOIN user_bans b ON b.telegram_id = u.telegram_id
       WHERE b.telegram_id IS NULL
         AND u.telegram_id IS NOT NULL
         AND u.telegram_id <> 90000000000`
    );
    recipientIds = Array.from(
      new Set(usersRes.rows.map((row) => String(row.telegram_id)))
    );
  }

  if (excludedIds.length > 0) {
    const excludedSet = new Set(excludedIds.map((id) => String(id)));
    recipientIds = recipientIds.filter((id) => !excludedSet.has(String(id)));
  }

  return {
    recipientIds,
    isCustom,
    isGroups,
    isChannels,
  };
}

async function performBroadcastSend(pool, broadcast, recipientIds, options = {}) {
  const broadcastId = broadcast.id;
  const updateProgress = options.updateProgress === true;
  let sentCount = 0;
  let failedCount = 0;
  await ensureWalletGiftSchema(pool);
  const prepared = await prepareWalletGiftButtonsForSend(pool, broadcast.buttons, {
    sourceKind: "BROADCAST",
    sourceEntityId: String(broadcastId || "").trim() || null,
    sourceScope: "PRIVATE",
  });
  const deliveryBroadcast = {
    ...broadcast,
    buttons: prepared.buttons,
  };
  const context = buildBroadcastDeliveryContext(deliveryBroadcast);

  if (updateProgress) {
    await pool.query(
      `UPDATE broadcasts
       SET progress_status = 'SENDING',
           progress_target_count = $2,
           progress_sent_count = 0,
           progress_failed_count = 0,
           progress_cursor = 0,
           progress_updated_at = now()
       WHERE id = $1`,
      [broadcastId, recipientIds.length]
    );
  }

  for (let i = 0; i < recipientIds.length; i += BROADCAST_BATCH_SIZE) {
    const batch = recipientIds.slice(i, i + BROADCAST_BATCH_SIZE);
    for (const telegramId of batch) {
      try {
        const sendResult = await sendBroadcastToRecipient(context, deliveryBroadcast, telegramId);
        if (prepared.gift && sendResult?.messageId) {
          await recordWalletGiftMessage(pool, {
            giftId: prepared.gift.id,
            chatId: telegramId,
            chatType: "private",
            messageId: sendResult.messageId,
            linkedMessageId: sendResult.linkedMessageId || null,
          });
        }
        sentCount += 1;
      } catch (err) {
        failedCount += 1;
        console.error("Broadcast send failed", {
          broadcastId,
          telegramId,
          error: err && err.message ? err.message : err,
        });
      }

      if (updateProgress) {
        await pool.query(
          `UPDATE broadcasts
           SET progress_sent_count = $2,
               progress_failed_count = $3,
               progress_cursor = $4,
               progress_updated_at = now()
           WHERE id = $1`,
          [broadcastId, sentCount, failedCount, sentCount + failedCount]
        );
      }
    }

    if (i + BROADCAST_BATCH_SIZE < recipientIds.length) {
      await new Promise((resolve) => setTimeout(resolve, BROADCAST_BATCH_DELAY_MS));
    }
  }

  const finalStatus = sentCount > 0 ? "SENT" : "FAILED";
  const updatedRes = await pool.query(
    `UPDATE broadcasts
     SET status = $1,
         sent_at = now(),
         progress_status = $1,
         progress_target_count = $3,
         progress_sent_count = $4,
         progress_failed_count = $5,
         progress_cursor = $3,
         progress_updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [finalStatus, broadcastId, recipientIds.length, sentCount, failedCount]
  );

  await pool.query(
    `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      "BROADCAST_SEND_RESULT",
      "broadcast",
      broadcastId,
      JSON.stringify({
        target_count: recipientIds.length,
        sent_count: sentCount,
        failed_count: failedCount,
      }),
    ]
  );

  return {
    broadcast: updatedRes.rows[0],
    result: {
      gift_id: prepared.gift?.id || null,
      target_count: recipientIds.length,
      sent_count: sentCount,
      failed_count: failedCount,
    },
  };
}

let globalCommissionSchemaReady = false;
async function ensureGlobalCommissionSchema(pool) {
  if (globalCommissionSchemaReady) {
    return;
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS global_commission_boost (
       id int PRIMARY KEY DEFAULT 1,
       rate numeric(6,4) NOT NULL DEFAULT 0,
       active boolean NOT NULL DEFAULT false,
       ends_at timestamptz,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `INSERT INTO global_commission_boost (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`
  );
  globalCommissionSchemaReady = true;
}

let globalCommissionTimer = null;
let globalCommissionEndsAt = null;
let globalCommissionWatchStarted = false;

async function getPaymentMethodMarkup(pool, paymentMethod) {
  const rawKey = normalizeMethodKey(paymentMethod);
  if (!rawKey) {
    return null;
  }
  let key = rawKey;
  if (["BTC", "USDT", "USDT_BSC", "USDT_TRON", "LTC"].includes(key)) {
    key = "CRYPTO";
  } else if (key === "MERCADO_PAGO") {
    key = "MERCADOPAGO";
  } else if (key === "BINANCE") {
    key = "BINANCE_ID";
  }
  const res = await pool.query(
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

async function resolveTotalsWithMarkup(pool, subtotalUsd, paymentMethod, localTotal = null) {
  const baseSubtotal = Number.isFinite(Number(subtotalUsd))
    ? Number(Number(subtotalUsd).toFixed(2))
    : 0;
  const methodKey = normalizeMethodKey(paymentMethod);
  let markupPercent = null;
  let totalUsd = baseSubtotal;
  let localTotalWithMarkup = localTotal;

  if (methodKey && localTotal && localTotal.amount != null) {
    try {
      const markup = await getPaymentMethodMarkup(pool, methodKey);
      if (markup != null && Number.isFinite(Number(markup))) {
        const localCurrency = String(localTotal.currency || "")
          .trim()
          .toUpperCase();
        const localAmount = Number(localTotal.amount);
        const isDollarEquivalent =
          localCurrency === "USD" || localCurrency === "USDT";
        if (Number.isFinite(localAmount) && !isDollarEquivalent) {
          markupPercent = Number(markup);
          const factor = 1 + markupPercent / 100;
          localTotalWithMarkup = {
            ...localTotal,
            amount: localAmount * factor,
          };
        }
      }
    } catch (error) {
      console.error("Failed to resolve totals with markup", error);
    }
  }

  return {
    subtotalUsd: baseSubtotal,
    totalUsd,
    markupPercent,
    localTotal: localTotalWithMarkup,
  };
}

async function notifyAffiliates(pool, message) {
  if (!message) {
    return;
  }
  const affiliatesRes = await pool.query(
    `SELECT u.telegram_id
     FROM affiliates a
     JOIN users u ON u.id = a.user_id
     WHERE a.status = 'APPROVED' AND u.telegram_id IS NOT NULL`
  );
  await Promise.all(
    affiliatesRes.rows.map(async (row) => {
      try {
        await sendMessage(row.telegram_id, message);
      } catch (err) {
        // ignore affiliate notification errors
      }
    })
  );
}

async function resetGlobalCommission(pool, reason) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE affiliates SET commission_rate = 0");
    await client.query(
      "ALTER TABLE affiliates ALTER COLUMN commission_rate SET DEFAULT 0"
    );
    await client.query(
      `UPDATE global_commission_boost
       SET rate = 0, active = false, ends_at = NULL, updated_at = now()
       WHERE id = 1`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const message =
    reason === "STOPPED"
      ? `⛔️ BOOST DETENIDO\n\nTus comisiones vuelven a tu porcentaje habitual por nivel.`
      : `✅ BOOST FINALIZADO\n\nTus comisiones vuelven a tu porcentaje habitual por nivel.`;
  await notifyAffiliates(pool, message);
}

async function scheduleGlobalCommissionReset(pool, endsAt) {
  if (globalCommissionTimer) {
    clearTimeout(globalCommissionTimer);
    globalCommissionTimer = null;
  }
  globalCommissionEndsAt = endsAt ? new Date(endsAt) : null;
  if (!globalCommissionEndsAt || Number.isNaN(globalCommissionEndsAt.getTime())) {
    return;
  }
  const ms = globalCommissionEndsAt.getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) {
    await resetGlobalCommission(pool, "AUTO");
    return;
  }
  globalCommissionTimer = setTimeout(() => {
    resetGlobalCommission(pool, "AUTO").catch(() => null);
  }, ms);
}

function startGlobalCommissionWatcher() {
  if (globalCommissionWatchStarted) {
    return;
  }
  globalCommissionWatchStarted = true;
  setInterval(async () => {
    try {
      const pool = getPool();
      await ensureGlobalCommissionSchema(pool);
      const res = await pool.query(
        `SELECT active, ends_at
         FROM global_commission_boost
         WHERE id = 1`
      );
      const row = res.rows[0];
      if (!row || !row.active || !row.ends_at) {
        return;
      }
      const endsAt = new Date(row.ends_at);
      if (Number.isFinite(endsAt.getTime()) && endsAt.getTime() <= Date.now()) {
        await resetGlobalCommission(pool, "AUTO");
      }
    } catch (err) {
      // ignore watcher errors
    }
  }, 60000);
}

startGlobalCommissionWatcher();

let ticketSchemaReady = false;
async function ensureTicketSchema(pool) {
  if (ticketSchemaReady) {
    return;
  }
  await pool.query(
    `ALTER TABLE tickets
     ADD COLUMN IF NOT EXISTS allow_image boolean NOT NULL DEFAULT false`
  );
  ticketSchemaReady = true;
}

let supportBanSchemaReady = false;
async function ensureSupportBanSchema(pool) {
  if (supportBanSchemaReady) {
    return;
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS support_bans (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       telegram_id bigint NOT NULL UNIQUE,
       reason text,
       banned_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  supportBanSchemaReady = true;
}

// Function to get fiat rate (COP/MXN to USD)
async function getFiatRate(currency) {
  try {
    const response = await fetch(`https://open.er-api.com/v6/latest/USD`);
    const data = await response.json();
    if (data.result === "success") {
      return data.rates[currency] || null;
    }
  } catch (err) {
    console.error("Failed to get fiat rate", err);
  }
  return null;
}

// Function to get crypto rate (to USD)
async function getCryptoRate(symbol) {
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`);
    const data = await response.json();
    return data[symbol]?.usd || null;
  } catch (err) {
    console.error("Failed to get crypto rate", err);
  }
  return null;
}

// Function to calculate local amount
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
    console.error("Failed to get user locale", err);
  }
  return "es";
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

async function updateAdminOrderNotifications(pool, orderId) {
  try {
    const notifications = await listAdminOrderNotifications(pool, orderId);
    if (!notifications.length) {
      return;
    }

    const orderRes = await pool.query(
      `SELECT o.*, u.telegram_id, u.telegram_username,
              p.name AS product_name, p.price AS product_price
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (orderRes.rowCount === 0) {
      return;
    }
    const order = orderRes.rows[0];

    const paymentRes = await pool.query(
      "SELECT * FROM order_payments WHERE order_id = $1",
      [orderId]
    );
    const payment = paymentRes.rows[0] || null;

    const itemsRes = await pool.query(
      `SELECT oi.qty, oi.unit_price_usd, oi.line_total_usd, p.name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );
    const items = itemsRes.rows || [];

    let subtotalUsd = 0;
    if (items.length > 0) {
      subtotalUsd = items.reduce((sum, item) => {
        const lineTotal =
          item.line_total_usd != null
            ? Number(item.line_total_usd)
            : Number(item.unit_price_usd || 0) * Number(item.qty || 0);
        return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
      }, 0);
      subtotalUsd = Number(subtotalUsd.toFixed(2));
    } else {
      subtotalUsd = Number(order.unit_price_at_purchase || order.product_price || 0);
    }

    const paymentMethod = payment?.payment_method || order.payment_method;
    let localTotal = null;
    if (paymentMethod) {
      try {
        localTotal = await calculateLocalAmountForAdminNotify(subtotalUsd, paymentMethod);
      } catch (error) {
        console.error("Failed to calculate local total", error);
      }
    }
    const totalsWithMarkup = await resolveTotalsWithMarkup(
      pool,
      subtotalUsd,
      paymentMethod,
      localTotal
    );

    const caption = buildOrderNotificationCaption({
      order,
      user: {
        telegram_id: order.telegram_id,
        telegram_username: order.telegram_username,
      },
      items,
      payment,
      subtotalUsd: totalsWithMarkup.subtotalUsd,
      localTotal: totalsWithMarkup.localTotal,
      markupPercent: totalsWithMarkup.markupPercent,
    });
    const replyMarkup = buildOrderNotificationKeyboard({
      id: order.id,
      telegram_id: order.telegram_id,
    });

    await Promise.all(
      notifications.map((row) =>
        editMessageCaption(
          row.admin_telegram_id,
          row.message_id,
          caption,
          { parse_mode: "HTML", reply_markup: replyMarkup }
        ).catch((error) => {
          console.error("Admin order notify update failed", error);
        })
      )
    );
  } catch (error) {
    console.error("Admin order notify update failed", error);
  }
}

async function updateWalletTopupAdminNotifications(pool, topupId) {
  try {
    const notifications = await listWalletTopupAdminNotifications(pool, topupId);
    if (!notifications.length) {
      return;
    }

    const topup = await getWalletTopupById(pool, topupId);
    if (!topup) {
      return;
    }

    const caption = await buildWalletTopupAdminCaption(topup);
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Panel web", callback_data: `admin_panel:${topupId}` },
          { text: "Panel Bot", callback_data: "adminui:wallets" },
        ],
        [
          { text: "Banear Usuario", callback_data: `admin_ban:${topup.telegram_id}:${topupId}` },
        ],
      ],
    };

    await Promise.all(
      notifications.map((row) => {
        const messageType = String(row.message_type || "photo").toLowerCase();
        if (messageType === "text") {
          return editMessageText(
            row.admin_telegram_id,
            row.message_id,
            caption,
            { parse_mode: "HTML", reply_markup: replyMarkup }
          ).catch((error) => {
            console.error("Wallet topup admin notify text update failed", error);
          });
        }
        return editMessageCaption(
          row.admin_telegram_id,
          row.message_id,
          caption,
          { parse_mode: "HTML", reply_markup: replyMarkup }
        ).catch((error) => {
          console.error("Wallet topup admin notify caption update failed", error);
        });
      })
    );
  } catch (error) {
    console.error("Wallet topup admin notify update failed", error);
  }
}

function parsePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.page_size, 10) || 20, 1), 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function formatOrderNumberForAdmin(order) {
  if (!order || typeof order !== "object") {
    return "-";
  }
  if (order.is_test) {
    return "Prueba";
  }
  if (order.is_scam) {
    if (order.released_order_number) {
      return `Estafa: ${String(order.released_order_number).padStart(5, "0")}`;
    }
    return "Estafa";
  }
  if (order.free_order_number) {
    return formatFreeOrderLabel(order.free_order_number) || "-";
  }
  if (!order.order_number) {
    return "-";
  }
  return String(order.order_number).padStart(5, "0");
}

function parseOrderLookupRef(rawValue) {
  const rawRef = String(rawValue || "").trim();
  if (!rawRef) {
    return { ref: "", orderNumber: null };
  }
  const ref = rawRef.replace(/^#/, "").trim();
  if (!ref) {
    return { ref: "", orderNumber: null };
  }
  if (!/^[0-9]+$/.test(ref)) {
    return { ref, orderNumber: null };
  }
  const normalized = ref.replace(/^0+/, "") || "0";
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ref, orderNumber: null };
  }
  return { ref, orderNumber: parsed };
}

async function resolveOrderLookupId(db, rawRef, orderNumber) {
  const ref = String(rawRef || "").trim();
  const normalizedRef = ref.toLowerCase();
  if (normalizedRef === "prueba" || normalizedRef === "test") {
    const latestTestOrderRes = await db.query(
      `SELECT id
       FROM orders
       WHERE COALESCE(is_test, false) = true
       ORDER BY
         CASE
           WHEN COALESCE(is_scam, false) = false
            AND status IN ('CREATED', 'WAITING_PAYMENT', 'PAID', 'DELIVERED') THEN 0
           ELSE 1
         END,
         created_at DESC,
         id DESC
       LIMIT 1`
    );
    if (latestTestOrderRes.rowCount > 0) {
      return latestTestOrderRes.rows[0].id;
    }
  }

  if (ref) {
    const exactIdRes = await db.query(
      `SELECT id
       FROM orders
       WHERE id::text = $1
       LIMIT 1`,
      [ref]
    );
    if (exactIdRes.rowCount > 0) {
      return exactIdRes.rows[0].id;
    }
  }

  if (orderNumber !== null && orderNumber !== undefined) {
    const exactNumberRes = await db.query(
      `SELECT id
       FROM orders
       WHERE order_number = $1
          OR released_order_number = $1
          OR free_order_number = $1
       ORDER BY
         CASE
           WHEN order_number = $1 THEN 0
           WHEN released_order_number = $1 THEN 1
           WHEN free_order_number = $1 THEN 2
           ELSE 3
         END,
         created_at DESC,
         id DESC
       LIMIT 1`,
      [orderNumber]
    );
    if (exactNumberRes.rowCount > 0) {
      return exactNumberRes.rows[0].id;
    }
  }

  return null;
}

async function getOrderLookupRange(pool) {
  const rangeRes = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM orders`
  );
  const total = Number.parseInt(rangeRes.rows[0]?.total, 10) || 0;
  if (total <= 0) {
    return {
      total: 0,
      min: null,
      max: null,
      min_label: null,
      max_label: null,
    };
  }
  return {
    total,
    min: 1,
    max: total,
    min_label: "00001",
    max_label: String(total).padStart(5, "0"),
  };
}

async function sendOrderNotFound(res, pool, orderLookupNumber) {
  const payload = { error: "ORDER_NOT_FOUND" };
  if (Number.isFinite(orderLookupNumber) && orderLookupNumber > 0) {
    payload.order_lookup = {
      requested: orderLookupNumber,
      requested_label: String(orderLookupNumber).padStart(5, "0"),
      ...(await getOrderLookupRange(pool)),
    };
  }
  return res.status(404).json(payload);
}

function buildScamCustomerNotification(order) {
  const telegramId = String(order?.telegram_id || "-").trim() || "-";
  const username = String(order?.telegram_username || "").trim();
  const usernameLine = username ? `@${username.replace(/^@+/, "")}` : "-";
  return (
    `ID: ${telegramId}\n`
    + `Username: ${usernameLine}\n\n`
    + "⚠️ Tu última orden ha sido marcada como “Estafa” 🚫💰.\n"
    + "A partir de este momento, los administradores del bot te publicarán en su canal de “Ratas” 🐀 y serás expuesto como estafador en más de 400 grupos en Telegram y WhatsApp 📢🔥.\n\n"
    + "❗ Si crees que se trata de un error, comunícate lo antes posible con: @Noropayments 📩\n"
    + "Explícales tu caso antes de que seas reportado públicamente 🚨."
  );
}

function buildWalletTopupScamCustomerNotification(topup) {
  const telegramId = String(topup?.telegram_id || "-").trim() || "-";
  const username = String(topup?.telegram_username || "").trim();
  const usernameLine = username ? `@${username.replace(/^@+/, "")}` : "-";
  return (
    `ID: ${telegramId}\n`
    + `Username: ${usernameLine}\n\n`
    + "⚠️ Tu última recarga ha sido marcada como “Estafa” 🚫💰.\n"
    + "A partir de este momento, los administradores del bot te publicarán en su canal de “Ratas” 🐀 y serás expuesto como estafador en más de 400 grupos en Telegram y WhatsApp 📢🔥.\n\n"
    + "❗ Si crees que se trata de un error, comunícate lo antes posible con: @Noropayments 📩\n"
    + "Explícales tu caso antes de que seas reportado públicamente 🚨."
  );
}

function formatWalletUsd(amount) {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric)) {
    return "$0";
  }
  return `$${numeric.toFixed(2)} USD`;
}

function formatWalletTxType(value) {
  const key = String(value || "").trim().toUpperCase();
  const labels = {
    TOPUP_APPROVED: "Recarga aprobada",
    ORDER_PAYMENT: "Compra con saldo",
    ORDER_REFUND: "Reembolso a saldo",
    ADMIN_ADJUSTMENT: "Ajuste manual",
  };
  return labels[key] || key || "-";
}

function isTestOrderRow(order) {
  return Boolean(order?.is_test);
}

function getTestOrderCleanupSeconds() {
  return Math.max(
    Number.parseInt(process.env.TEST_ORDER_CLEANUP_SECONDS || "", 10) || 120,
    10
  );
}

async function ensureUserByTelegram(client, telegramId, username = null) {
  const existingRes = await client.query(
    `SELECT *
     FROM users
     WHERE telegram_id = $1
     LIMIT 1`,
    [telegramId]
  );
  if (existingRes.rowCount > 0) {
    if (username) {
      await client.query(
        `UPDATE users
         SET telegram_username = $2
         WHERE id = $1
           AND COALESCE(telegram_username, '') <> $2`,
        [existingRes.rows[0].id, username]
      );
      return {
        ...existingRes.rows[0],
        telegram_username: username,
      };
    }
    return existingRes.rows[0];
  }

  const insertRes = await client.query(
    `INSERT INTO users (telegram_id, telegram_username)
     VALUES ($1, $2)
     RETURNING *`,
    [telegramId, username || null]
  );
  return insertRes.rows[0];
}

function buildTestOrderDeliveryCaption(order) {
  const productName = String(order?.product_name || "Producto de prueba").trim() || "Producto de prueba";
  return (
    "🧪 <b>Entrega de prueba completada</b>\n\n"
    + `📦 Producto: <b>${escapeHtml(productName)}</b>\n`
    + "✅ Esta orden era solo de prueba.\n"
    + "🚫 No se descontó stock real ni suma ventas/ganancias.\n"
    + "🧹 Se eliminará automáticamente en 2 minutos."
  );
}

async function deliverTestOrderToTelegram(order) {
  const caption = buildTestOrderDeliveryCaption(order);
  const imageUrl = String(order?.product_image_url || "").trim();
  if (imageUrl) {
    try {
      await sendPhoto(order.telegram_id, {
        url: imageUrl,
        caption,
        parse_mode: "HTML",
      });
      return { delivered: true, method: "photo" };
    } catch (error) {
      console.error("Test order photo delivery failed", error);
    }
  }
  await sendMessage(order.telegram_id, caption, { parse_mode: "HTML" });
  return { delivered: true, method: "text" };
}

async function recalcSkuKeys(client) {
  await client.query("UPDATE products SET sku_key = NULL WHERE sku_key IS NOT NULL");
  await client.query(
    `WITH ordered AS (
       SELECT
         id,
         row_number() OVER (ORDER BY created_at, id) AS rn
       FROM products
       WHERE is_active = true
     ),
     updated AS (
       UPDATE products p
       SET sku_key = lpad(ordered.rn::text, 6, '0')
       FROM ordered
       WHERE p.id = ordered.id
       RETURNING p.id
     )
     SELECT count(*)::int AS updated_count
     FROM updated`
  );
}

async function getNextSkuKey(client) {
  await client.query("SELECT pg_advisory_xact_lock(318622901)");
  const res = await client.query(
    `SELECT (
       COALESCE(
         MAX(CASE WHEN sku_key ~ '^[0-9]+$' THEN sku_key::bigint END),
         0
       ) + 1
     )::bigint AS value
     FROM products`
  );
  return String(res.rows[0].value).padStart(6, "0");
}

function normalizeTelegramIds(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const cleaned = input
    .map((item) => String(item).trim())
    .filter((item) => item && /^[0-9]+$/.test(item));
  return Array.from(new Set(cleaned));
}

function normalizeChatIds(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const cleaned = input
    .map((item) => String(item).trim())
    .filter((item) => item && /^-?[0-9]+$/.test(item));
  return Array.from(new Set(cleaned));
}

function escapeBroadcastHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function restoreAllowedBroadcastHtml(value) {
  let text = String(value || "");

  text = text.replace(
    /&lt;tg-emoji\s+emoji-id=(?:"|')([0-9]+)(?:"|')\s*&gt;/gi,
    (_, emojiId) => `<tg-emoji emoji-id="${emojiId}">`
  );
  text = text.replace(/&lt;\/tg-emoji&gt;/gi, "</tg-emoji>");

  text = text.replace(
    /&lt;a\s+href="(https?:\/\/[^"]+)"\s*&gt;/gi,
    (_, href) => `<a href="${href.replace(/&amp;/g, "&")}">`
  );
  text = text.replace(/&lt;\/a&gt;/gi, "</a>");
  text = text.replace(/&lt;br\s*\/?&gt;/gi, "\n");

  text = text.replace(
    /&lt;(\/?)(strong|b|em|i|u|s|strike|del|blockquote|code|pre)&gt;/gi,
    (_, slash, tag) => {
      const normalized = String(tag).toLowerCase();
      if (normalized === "strong") {
        return `<${slash}b>`;
      }
      if (normalized === "em") {
        return `<${slash}i>`;
      }
      if (normalized === "strike" || normalized === "del") {
        return `<${slash}s>`;
      }
      return `<${slash}${normalized}>`;
    }
  );

  text = text.replace(/&lt;\/?(?:div|p|li|ul|ol)&gt;/gi, "\n");
  return text;
}

function formatBroadcastMessage(raw) {
  let text = escapeBroadcastHtml(raw);
  text = restoreAllowedBroadcastHtml(text);
  text = text.replace(/```([\s\S]+?)```/g, (_, code) => {
    return `<pre><code>${code}</code></pre>`;
  });
  text = text.replace(/`([^`]+?)`/g, "<code>$1</code>");
  text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_]+?)__/g, "<u>$1</u>");
  text = text.replace(/~~([^~]+?)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, "$1<i>$2</i>");
  text = text
    .split("\n")
    .map((line) => {
      const match = line.match(/^&gt;\s?(.*)$/);
      if (!match) {
        return line;
      }
      return `<blockquote>${match[1]}</blockquote>`;
    })
    .join("\n");
  return text;
}

function normalizeBroadcastButtons(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  let fallbackRow = 0;
  return value
    .map((button) => {
      if (!button || typeof button !== "object") {
        return null;
      }
      const text = String(button.text || "").trim();
      const url = String(button.url || "").trim();
      const action = String(button.action || button.type || "").trim().toLowerCase();
      const rawRow = Number(button.row);
      const row =
        Number.isInteger(rawRow) && rawRow >= 0 ? rawRow : fallbackRow;
      fallbackRow += 1;
      if (!text) {
        return null;
      }
      if (action === "gift") {
        const amountUsd = Number(button.gift_amount_usd || button.amount_usd || button.amount || 0);
        const maxClaims = Number.parseInt(
          String(button.gift_max_claims || button.max_claims || button.claims || ""),
          10
        );
        if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(maxClaims) || maxClaims <= 0) {
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
      if (!url || !/^https?:\/\//i.test(url)) {
        return null;
      }
      return { text, url, row };
    })
    .filter(Boolean);
}

function buttonsHaveWalletGift(buttons) {
  if (!Array.isArray(buttons)) {
    return false;
  }
  return buttons.some((button) => {
    if (!button || typeof button !== "object") {
      return false;
    }
    return String(button.action || button.type || "").trim().toLowerCase() === "gift";
  });
}

function normalizeSavedKind(value, buttons = []) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "GIFT" || raw === "WALLET_GIFT") {
    return "GIFT";
  }
  if (raw === "MESSAGE" || raw === "BROADCAST" || raw === "PUBLICATION") {
    return "MESSAGE";
  }
  return buttonsHaveWalletGift(buttons) ? "GIFT" : "MESSAGE";
}

function parseImageDataUrl(value) {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) {
    return null;
  }
  const mime = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    return null;
  }
  return { mime, buffer };
}

function getImageExtension(mime) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return map[mime] || "jpg";
}

function normalizeBroadcastMediaKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "photo" || kind === "animation" || kind === "video" || kind === "sticker") {
    return kind;
  }
  return "";
}

function parseStoredTelegramMedia(imagePath, imageMime) {
  const pathValue = String(imagePath || "").trim();
  if (!pathValue.startsWith("tgfile:")) {
    return null;
  }
  const fileId = pathValue.slice("tgfile:".length).trim();
  if (!fileId) {
    return null;
  }
  const rawMime = String(imageMime || "").trim().toLowerCase();
  const maybeKind = rawMime.startsWith("tg:") ? rawMime.slice(3) : "";
  const kind =
    maybeKind === "animation" || maybeKind === "video" || maybeKind === "photo" || maybeKind === "sticker"
      ? maybeKind
      : "photo";
  return { fileId, kind };
}

function buildInlineKeyboard(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return null;
  }
  const grouped = new Map();
  let fallbackRow = 0;
  for (const button of buttons) {
    if (!button || typeof button !== "object") {
      continue;
    }
    const text = String(button.text || "").trim();
    const url = String(button.url || "").trim();
    if (!text || !/^https?:\/\//i.test(url)) {
      continue;
    }
    const rawRow = Number(button.row);
    const rowKey =
      Number.isInteger(rawRow) && rawRow >= 0 ? rawRow : fallbackRow;
    fallbackRow += 1;
    if (!grouped.has(rowKey)) {
      grouped.set(rowKey, []);
    }
    const row = grouped.get(rowKey);
    if (Array.isArray(row) && row.length < 4) {
      row.push({ text, url });
    }
  }
  const inlineKeyboard = Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
    .filter((row) => Array.isArray(row) && row.length > 0);
  if (inlineKeyboard.length === 0) {
    return null;
  }
  return {
    inline_keyboard: inlineKeyboard,
  };
}

function mapBroadcastSegment(segment, hasCustomRecipients) {
  if (segment === "GROUPS") {
    return "GROUPS";
  }
  if (segment === "CHANNELS") {
    return "CHANNELS";
  }
  if (segment === "BUYERS") {
    return "BUYERS";
  }
  if (segment === "AFFILIATES") {
    return "AFFILIATES";
  }
  if (segment === "BUYERS_AFFILIATES") {
    return "BUYERS_AFFILIATES";
  }
  if (hasCustomRecipients) {
    return "CUSTOM";
  }
  if (segment === "ALL") {
    return "ALL_USERS";
  }
  return segment;
}

function normalizeBroadcastSegmentInput(segment) {
  if (!segment) {
    return "";
  }
  if (segment === "ALL_USERS") {
    return "ALL";
  }
  if (segment === "CUSTOM") {
    return "ALL";
  }
  return segment;
}

const RECEIPT_TRANSLATIONS = {
  es: {
    title: "🧾 Recibo de pago",
    order_id: "🆔 ID de orden",
    order_number: "🧾 Número de orden",
    product: "📦 Producto",
    price: "💰 Precio",
    date: "📅 Fecha (Hora COL)",
    status: "📊 Estado",
    paid: "✅ PAGADO",
    reference: "🔗 Referencia",
    total: "💵 Total",
    total_in: "💵 Total en",
    rate: "💱 Tasa aplicada",
    commission: "💸 Comisión",
    referred_by: "👤 Referido de",
  },
  en: {
    title: "🧾 Receipt",
    order_id: "🆔 Order ID",
    order_number: "🧾 Order number",
    product: "📦 Product",
    price: "💰 Price",
    date: "📅 Date (Hora COL)",
    status: "📊 Status",
    paid: "✅ PAID",
    reference: "🔗 Reference",
    total: "💵 Total",
    total_in: "💵 Total in",
    rate: "💱 Applied rate",
    commission: "💸 Commission",
    referred_by: "👤 Referred by",
  },
};

function formatBogotaDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
  }
  return date.toLocaleString("es-CO", { timeZone: "America/Bogota" });
}

function buildReceiptMessage(
  order,
  paymentProof,
  locale = "es",
  subtotalUsd,
  totalUsd,
  localTotal,
  markupPercent,
  commissionAmount,
  referredBy
) {
  const translations = RECEIPT_TRANSLATIONS[locale] || RECEIPT_TRANSLATIONS.es;
  const price =
    subtotalUsd !== undefined && subtotalUsd !== null
      ? subtotalUsd
      : order.unit_price_at_purchase || order.product_price;
  const createdAtText = formatBogotaDate(order.paid_at || new Date());
  const orderNumberText = order.order_number
    ? String(order.order_number).padStart(5, "0")
    : "-";
  const priceNumber = Number(price || 0);
  const totalUsdNumber = Number(totalUsd ?? priceNumber);
  const priceText =
    Number.isFinite(priceNumber) && priceNumber <= 0
      ? "Gratis"
      : `$${priceNumber.toLocaleString(locale === "es" ? "es-CO" : "en-US", {
          maximumFractionDigits: 0,
        })} USD`;
  const lines = [
    `🎉 ${translations.title} 🎉`,
    "",
    `${translations.order_number}: ${orderNumberText}`,
    "",
    `${translations.order_id}: ${order.id}`,
    "",
    `${translations.product}: ${order.product_name || order.product_id}`,
    "",
    `${translations.price}: ${priceText}`,
    "",
    `${translations.date}: ${createdAtText}`,
    "",
    `${translations.status}: ${translations.paid}`,
  ];
  if (paymentProof && paymentProof.screenshot_file_id) {
    lines.push("");
    lines.push(`${translations.reference}: ${paymentProof.screenshot_file_id}`);
  }
  if (markupPercent != null && Number.isFinite(Number(markupPercent))) {
    lines.push("");
    lines.push(`🧮 Markup aplicado: ${Number(markupPercent)}%`);
  }
  if (Number.isFinite(totalUsdNumber) && Math.abs(totalUsdNumber - priceNumber) > 0.0001) {
    lines.push(
      `${translations.total}: $${totalUsdNumber.toLocaleString(
        locale === "es" ? "es-CO" : "en-US",
        { maximumFractionDigits: 2, minimumFractionDigits: 0 }
      )} USD`
    );
  }
  if (localTotal && localTotal.currency && localTotal.amount != null) {
    const currency = localTotal.currency;
    const amount =
      currency === "COP" || currency === "MXN"
        ? Math.floor(localTotal.amount).toLocaleString(locale === "es" ? "es-CO" : "en-US")
        : Number(localTotal.amount).toFixed(currency === "BTC" || currency === "LTC" ? 8 : 2)
            .replace(/\.?0+$/, "");
    lines.push("");
    lines.push(`${translations.total_in} ${currency}: ${amount} ${currency}`);
    const rateBase = totalUsdNumber || 0;
    if (rateBase > 0) {
      const rateValue = Number(localTotal.amount) / rateBase;
      if (Number.isFinite(rateValue) && rateValue > 0) {
        const rateText =
          currency === "BTC" || currency === "LTC"
            ? rateValue.toFixed(8)
            : rateValue.toFixed(2);
        lines.push(`${translations.rate}: 1 USD = ${rateText} ${currency}`);
      }
    }
  }
  if (commissionAmount != null) {
    lines.push("");
    lines.push(
      `${translations.commission}: $${Number(commissionAmount || 0).toFixed(2)} USD`
    );
  }
  if (referredBy) {
    lines.push(`${translations.referred_by}: ${referredBy}`);
  }
  lines.push("");
  lines.push("✅ ¡Gracias por tu compra!");
  return lines.join("\n");
}

function formatUsd(amount) {
  const value = Number(amount || 0);
  return `$${value.toFixed(2)}`;
}

function formatUsdWithCurrency(amount) {
  const value = Number(amount || 0);
  const fixed = value.toFixed(2);
  const trimmed = fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `$${trimmed} USD`;
}

async function getOrderTotalUsd(client, orderId, fallback) {
  const itemsRes = await client.query(
    `SELECT COALESCE(SUM(line_total_usd), 0) AS total
     FROM order_items
     WHERE order_id = $1`,
    [orderId]
  );
  const total = Number(itemsRes.rows[0]?.total || 0);
  if (total > 0) {
    return Number(total.toFixed(2));
  }
  return Number(Number(fallback || 0).toFixed(2));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `"${key}":${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function maskPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const masked = { ...payload };
  if (masked.password) {
    masked.password = "***";
  }
  if (masked.token) {
    masked.token = "***";
  }
  return masked;
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  const str = String(value);
  if (str.length <= 4) {
    return "****";
  }
  return `${"*".repeat(Math.max(str.length - 4, 4))}${str.slice(-4)}`;
}

async function getActiveHolds(client, product) {
  if (!product) {
    return { holds: [], heldQty: 0 };
  }
  if (product.stock_mode === "UNITS") {
    const holdsRes = await client.query(
      `SELECT held_by_order_id AS order_id,
              COUNT(*)::int AS qty,
              MIN(created_at) AS created_at
       FROM product_stock_units
       WHERE product_id = $1 AND status = 'HELD'
       GROUP BY held_by_order_id
       ORDER BY created_at ASC`,
      [product.id]
    );
    const holds = holdsRes.rows.map((row) => ({
      id: `units-held-${row.order_id || "none"}`,
      product_id: product.id,
      order_id: row.order_id,
      qty: Number(row.qty || 0),
      status: "HELD",
      expires_at: null,
      created_at: row.created_at,
    }));
    const heldQty = holds.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    return { holds, heldQty };
  }
  const holdsRes = await client.query(
    `SELECT id, product_id, order_id, qty, status, expires_at, created_at
     FROM product_stock_holds
     WHERE product_id = $1
       AND expires_at IS NOT NULL
       AND expires_at > now()
       AND status NOT IN ('CONSUMED','EXPIRED')
     ORDER BY expires_at ASC`,
    [product.id]
  );
  const heldQty = holdsRes.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  return { holds: holdsRes.rows, heldQty };
}

async function resolveProductByIdentifier(client, productId, skuKey) {
  if (!productId && !skuKey) {
    return null;
  }
  if (productId) {
    const res = await client.query("SELECT * FROM products WHERE id = $1", [
      productId,
    ]);
    return res.rows[0] || null;
  }
  const res = await client.query("SELECT * FROM products WHERE sku_key = $1", [
    skuKey,
  ]);
  return res.rows[0] || null;
}

function parseAdminTelegramIds() {
  const value = process.env.ADMIN_TELEGRAM_IDS || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

function generateNumericOtp(length = 6) {
  const size = Number(length) > 0 ? Number(length) : 6;
  const min = 10 ** (size - 1);
  const max = 10 ** size;
  return String(Math.floor(Math.random() * (max - min) + min));
}

function normalizeOtpInput(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function normalizeResetChannel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === ADMIN_PASSWORD_RESET_CHANNEL_EMAIL) {
    return ADMIN_PASSWORD_RESET_CHANNEL_EMAIL;
  }
  if (normalized === ADMIN_PASSWORD_RESET_CHANNEL_TELEGRAM) {
    return ADMIN_PASSWORD_RESET_CHANNEL_TELEGRAM;
  }
  return "";
}

function buildGenericResetStartResponse(channel = "") {
  const normalized = normalizeResetChannel(channel);
  return {
    ok: true,
    challenge_id: null,
    channel: normalized || null,
    delivery_hint: null,
    expires_in: ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS,
    generic: true,
    message:
      "Si existe una cuenta con ese usuario o correo, enviaremos un codigo por el canal configurado.",
  };
}

function maskEmail(email) {
  const value = String(email || "").trim();
  if (!value.includes("@")) {
    return value;
  }
  const [local, domain] = value.split("@");
  const safeLocal = local.length <= 2
    ? `${local.slice(0, 1)}*`
    : `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}`;
  return `${safeLocal}@${domain}`;
}

function maskTelegramId(telegramId) {
  const value = String(telegramId || "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= 4) {
    return value;
  }
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

function normalizeRecoveryEmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw.length > 190) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return null;
  }
  return raw;
}

function normalizeRecoveryTelegramId(value) {
  const raw = String(value || "").replace(/\D/g, "").trim();
  if (!raw) {
    return null;
  }
  if (raw.length < 5 || raw.length > 19) {
    return null;
  }
  if (raw.length === 19 && raw > "9223372036854775807") {
    return null;
  }
  return raw;
}

async function resolveCurrentAdminAccount(pool, reqAdmin = null) {
  const adminId = String(reqAdmin?.admin_id || "").trim();
  if (adminId) {
    const byIdRes = await pool.query(
      `SELECT id, username, auth_version, telegram_id, recovery_email, is_active
       FROM admin_accounts
       WHERE id::text = $1
         AND is_active = true
       LIMIT 1`,
      [adminId]
    );
    if (byIdRes.rowCount > 0) {
      return byIdRes.rows[0];
    }
  }

  const envUsername = String(process.env.ADMIN_USERNAME || "").trim();
  if (envUsername) {
    const byUsernameRes = await pool.query(
      `SELECT id, username, auth_version, telegram_id, recovery_email, is_active
       FROM admin_accounts
       WHERE lower(btrim(username)) = lower(btrim($1))
         AND is_active = true
       LIMIT 1`,
      [envUsername]
    );
    if (byUsernameRes.rowCount > 0) {
      return byUsernameRes.rows[0];
    }
  }

  const fallbackRes = await pool.query(
    `SELECT id, username, auth_version, telegram_id, recovery_email, is_active
     FROM admin_accounts
     WHERE is_active = true
     ORDER BY created_at ASC
     LIMIT 1`
  );
  return fallbackRes.rows[0] || null;
}

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const candidate = forwarded[0] || String(req.ip || "").trim();
  return net.isIP(candidate) ? candidate : null;
}

function getRequestUserAgent(req) {
  const userAgent = String(req.headers["user-agent"] || "").trim();
  return userAgent || null;
}

async function writeAdminAuthAudit(pool, req, action, options = {}) {
  try {
    const adminId = options?.adminId || null;
    const metadata = options?.metadata && typeof options.metadata === "object"
      ? options.metadata
      : {};
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        adminId,
        String(action || "").trim() || "AUTH_EVENT",
        getRequestIp(req),
        getRequestUserAgent(req),
        JSON.stringify(metadata),
      ]
    );
  } catch (error) {
    console.warn("[admin/audit] auth audit write failed", {
      action,
      error: error?.message || String(error),
    });
  }
}

function validateNewAdminPassword(password) {
  const raw = String(password || "");
  if (raw.length < 8) {
    return { ok: false, reason: "PASSWORD_TOO_SHORT" };
  }
  if (!/[A-Z]/.test(raw)) {
    return { ok: false, reason: "PASSWORD_NEEDS_UPPERCASE" };
  }
  if (!/[a-z]/.test(raw)) {
    return { ok: false, reason: "PASSWORD_NEEDS_LOWERCASE" };
  }
  if (!/[0-9]/.test(raw)) {
    return { ok: false, reason: "PASSWORD_NEEDS_NUMBER" };
  }
  return { ok: true };
}

router.post("/auth/start", async (req, res, next) => {
  const pool = getPool();
  const { username, password } = req.body || {};
  const providedUsername = String(username || "").trim();
  const providedPassword = String(password || "");

  if (!providedUsername || !providedPassword) {
    return res.status(400).json({ error: "MISSING_CREDENTIALS" });
  }

  try {
    const result = await validateAdminStartCredentials(
      pool,
      providedUsername,
      providedPassword
    );
    if (!result.configured) {
      await writeAdminAuthAudit(pool, req, "AUTH_START_FAILED_NOT_CONFIGURED", {
        metadata: { username: providedUsername || null },
      });
      return res.status(500).json({ error: "ADMIN_AUTH_NOT_CONFIGURED" });
    }
    if (!result.ok) {
      console.warn("[admin/auth] invalid credentials", {
        username: providedUsername,
        source: result.source || "unknown",
      });
      await writeAdminAuthAudit(pool, req, "AUTH_START_FAILED_INVALID_CREDENTIALS", {
        metadata: {
          username: providedUsername || null,
          source: result.source || "unknown",
        },
      });
      return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }

    const admins = parseAdminTelegramIds();
    if (admins.length === 0) {
      await writeAdminAuthAudit(pool, req, "AUTH_START_FAILED_NO_ADMIN_TELEGRAM", {
        adminId: result?.admin?.id || null,
        metadata: {
          username: providedUsername || null,
          source: result.source || "unknown",
        },
      });
      return res.status(500).json({ error: "NO_ADMIN_TELEGRAM_IDS" });
    }

    const requestClaims = {
      sub: "admin",
      mode: "approval",
      admin_id: result?.admin?.id || null,
      username: result?.admin?.username || null,
      auth_version: Number(result?.admin?.auth_version || 1),
    };
    const { requestId } = createLoginRequest(requestClaims);
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "✅ SÍ",
            callback_data: `admin_auth:${requestId}:APPROVE`,
          },
          {
            text: "❌ NO",
            callback_data: `admin_auth:${requestId}:DENY`,
          },
        ],
      ],
    };

    const notifyAdmins = async () => {
      await Promise.all(
        admins.map((adminId) =>
          sendMessage(
            adminId,
            "¿Estas intentando Ingresar en el panel del Bot?",
            { reply_markup: replyMarkup }
          )
            .then((sentMessage) => {
              const messageId = Number(sentMessage?.message_id || 0);
              if (messageId <= 0) {
                return;
              }
              setTimeout(() => {
                deleteMessage(adminId, messageId).catch(() => {
                  // ignore delete errors if message was already removed
                });
              }, 60 * 1000);
            })
            .catch((error) => {
              console.error("Telegram 2FA notification failed", error);
            })
        )
      );
    };

    setImmediate(() => {
      notifyAdmins().catch((error) => {
        console.error("Telegram 2FA notification failed", error);
      });
    });

    await writeAdminAuthAudit(pool, req, "AUTH_START_REQUEST_CREATED", {
      adminId: result?.admin?.id || null,
      metadata: {
        username: providedUsername || null,
        source: result.source || "unknown",
        request_id: requestId,
      },
    });

    return res.json({ request_id: requestId, expires_in: REQUEST_TTL_SECONDS });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/direct", async (req, res, next) => {
  const pool = getPool();
  const { password } = req.body || {};
  const providedPassword = String(password || "");

  if (!providedPassword) {
    return res.status(400).json({ error: "MISSING_PASSWORD" });
  }

  try {
    const result = await validateAdminDirectCredentials(pool, providedPassword);
    if (!result.configured) {
      await writeAdminAuthAudit(pool, req, "AUTH_DIRECT_FAILED_NOT_CONFIGURED");
      return res.status(500).json({ error: "ADMIN_AUTH_NOT_CONFIGURED" });
    }
    if (!result.ok) {
      await writeAdminAuthAudit(pool, req, "AUTH_DIRECT_FAILED_INVALID_CREDENTIALS");
      return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }

    const token = createAdminToken(
      {
        sub: "admin",
        mode: "direct",
        admin_id: result?.admin?.id || null,
        username: result?.admin?.username || null,
        auth_version: Number(result?.admin?.auth_version || 1),
      },
      60 * 10
    );
    await writeAdminAuthAudit(pool, req, "AUTH_DIRECT_SUCCESS", {
      adminId: result?.admin?.id || null,
      metadata: {
        username: result?.admin?.username || null,
        source: result.source || "unknown",
      },
    });
    return res.json({ token });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/password-reset/start", async (req, res, next) => {
  const pool = getPool();
  const loginIdentifier = String(req.body?.username || req.body?.identifier || "").trim();
  const requestedChannel = normalizeResetChannel(req.body?.channel);

  if (!loginIdentifier) {
    return res.status(400).json({ error: "USERNAME_REQUIRED" });
  }
  if (req.body?.channel && !requestedChannel) {
    return res.status(400).json({ error: "INVALID_RECOVERY_CHANNEL" });
  }

  try {
    await ensureAdminCredentialsSchema(pool);
    const accountRes = await pool.query(
      `SELECT id, username, telegram_id, recovery_email, is_active
       FROM admin_accounts
       WHERE (
         lower(btrim(username)) = lower(btrim($1))
         OR lower(btrim(COALESCE(recovery_email, ''))) = lower(btrim($1))
       )
       ORDER BY
         CASE WHEN lower(btrim(username)) = lower(btrim($1)) THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`,
      [loginIdentifier]
    );
    const account = accountRes.rows[0];
    if (!account || !account.is_active) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_FAILED_ADMIN_NOT_FOUND", {
        metadata: { login_identifier: loginIdentifier || null },
      });
      return res.json(buildGenericResetStartResponse(requestedChannel));
    }

    let selectedChannel = requestedChannel;
    if (!selectedChannel) {
      if (account.telegram_id) {
        selectedChannel = ADMIN_PASSWORD_RESET_CHANNEL_TELEGRAM;
      } else if (account.recovery_email) {
        selectedChannel = ADMIN_PASSWORD_RESET_CHANNEL_EMAIL;
      }
    }

    if (!selectedChannel) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_FAILED_NO_CHANNEL", {
        adminId: account.id,
        metadata: { username: account.username || null },
      });
      return res.json(buildGenericResetStartResponse(requestedChannel));
    }

    if (
      selectedChannel === ADMIN_PASSWORD_RESET_CHANNEL_TELEGRAM
      && !account.telegram_id
    ) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_FAILED_TELEGRAM_NOT_CONFIGURED", {
        adminId: account.id,
        metadata: { username: account.username || null },
      });
      return res.json(buildGenericResetStartResponse(requestedChannel));
    }
    if (
      selectedChannel === ADMIN_PASSWORD_RESET_CHANNEL_EMAIL
      && !account.recovery_email
    ) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_FAILED_EMAIL_NOT_CONFIGURED", {
        adminId: account.id,
        metadata: { username: account.username || null },
      });
      return res.json(buildGenericResetStartResponse(requestedChannel));
    }
    if (
      selectedChannel === ADMIN_PASSWORD_RESET_CHANNEL_EMAIL
      && !isMailConfigured()
    ) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_FAILED_SMTP_NOT_CONFIGURED", {
        adminId: account.id,
        metadata: { username: account.username || null },
      });
      return res.json(buildGenericResetStartResponse(requestedChannel));
    }

    const windowSince = new Date(Date.now() - (ADMIN_PASSWORD_RESET_START_WINDOW_SECONDS * 1000));
    const throttleRes = await pool.query(
      `SELECT
         MAX(created_at) AS last_created_at,
         COUNT(*) FILTER (WHERE created_at >= $3) AS requests_in_window
       FROM admin_auth_otps
       WHERE admin_id = $1
         AND purpose = $2`,
      [account.id, ADMIN_PASSWORD_RESET_PURPOSE, windowSince]
    );
    const throttleRow = throttleRes.rows[0] || {};
    const lastCreatedAt = throttleRow.last_created_at
      ? new Date(throttleRow.last_created_at).getTime()
      : 0;
    const requestsInWindow = Number(throttleRow.requests_in_window || 0);

    if (lastCreatedAt > 0) {
      const elapsedSeconds = Math.floor((Date.now() - lastCreatedAt) / 1000);
      if (elapsedSeconds < ADMIN_PASSWORD_RESET_START_COOLDOWN_SECONDS) {
        const retryIn = Math.max(ADMIN_PASSWORD_RESET_START_COOLDOWN_SECONDS - elapsedSeconds, 1);
        await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_RATE_LIMIT_COOLDOWN", {
          adminId: account.id,
          metadata: {
            username: account.username || null,
            retry_in: retryIn,
          },
        });
        return res.status(429).json({
          error: "OTP_START_COOLDOWN",
          retry_in: retryIn,
        });
      }
    }

    if (requestsInWindow >= ADMIN_PASSWORD_RESET_START_MAX_PER_WINDOW) {
      const retryIn = ADMIN_PASSWORD_RESET_START_WINDOW_SECONDS;
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_RATE_LIMIT_WINDOW", {
        adminId: account.id,
        metadata: {
          username: account.username || null,
          retry_in: retryIn,
          requests_in_window: requestsInWindow,
        },
      });
      return res.status(429).json({
        error: "OTP_START_RATE_LIMIT",
        retry_in: retryIn,
      });
    }

    await pool.query(
      `UPDATE admin_auth_otps
       SET used_at = now()
       WHERE admin_id = $1
         AND purpose = $2
         AND used_at IS NULL`,
      [account.id, ADMIN_PASSWORD_RESET_PURPOSE]
    );

    const otpCode = generateNumericOtp(6);
    const codeHash = await bcrypt.hash(otpCode, 10);
    const expiresAt = new Date(Date.now() + ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS * 1000);

    const otpRes = await pool.query(
      `INSERT INTO admin_auth_otps (
         admin_id,
         purpose,
         channel,
         code_hash,
         expires_at,
         max_attempts
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        account.id,
        ADMIN_PASSWORD_RESET_PURPOSE,
        selectedChannel,
        codeHash,
        expiresAt,
        ADMIN_PASSWORD_RESET_MAX_ATTEMPTS,
      ]
    );
    const challengeId = otpRes.rows[0]?.id;

    const messageText =
      "🔐 Código de recuperación del panel admin\n\n"
      + `Código: <code>${otpCode}</code>\n`
      + `Vence en ${Math.floor(ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS / 60)} minutos.\n\n`
      + "Si no solicitaste este cambio, ignora este mensaje.";

    try {
      if (selectedChannel === ADMIN_PASSWORD_RESET_CHANNEL_EMAIL) {
        const emailPayload = buildPasswordRecoveryEmailTemplate({
          code: otpCode,
          expiresInMinutes: Math.floor(ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS / 60),
          brandName: "NoroPayments",
          panelUrl: process.env.ADMIN_PANEL_URL || "",
          supportHandle: process.env.RECOVERY_EMAIL_SUPPORT_HANDLE || "@noropayments",
          logoUrl: process.env.RECOVERY_EMAIL_LOGO_URL || "",
        });
        await sendMail({
          to: account.recovery_email,
          subject: emailPayload.subject,
          text: emailPayload.text,
          html: emailPayload.html,
        });
      } else {
        await sendMessage(account.telegram_id, messageText, { parse_mode: "HTML" });
      }
    } catch (err) {
      await pool.query("DELETE FROM admin_auth_otps WHERE id = $1", [challengeId]);
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_DELIVERY_FAILED", {
        adminId: account.id,
        metadata: {
          username: account.username || null,
          channel: selectedChannel,
        },
      });
      return res.json(buildGenericResetStartResponse(selectedChannel));
    }

    await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_START_CODE_SENT", {
      adminId: account.id,
      metadata: {
        username: account.username || null,
        channel: selectedChannel,
        challenge_id: challengeId,
      },
    });

    return res.json({
      challenge_id: challengeId,
      channel: selectedChannel,
      delivery_hint:
        selectedChannel === ADMIN_PASSWORD_RESET_CHANNEL_EMAIL
          ? maskEmail(account.recovery_email)
          : maskTelegramId(account.telegram_id),
      expires_in: ADMIN_PASSWORD_RESET_OTP_TTL_SECONDS,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/password-reset/verify", async (req, res, next) => {
  const pool = getPool();
  const challengeId = String(req.body?.challenge_id || "").trim();
  const code = normalizeOtpInput(req.body?.code);

  if (!challengeId || !code) {
    return res.status(400).json({ error: "CHALLENGE_AND_CODE_REQUIRED" });
  }

  try {
    await ensureAdminCredentialsSchema(pool);
    const otpRes = await pool.query(
      `SELECT o.id,
              o.admin_id,
              o.code_hash,
              o.expires_at,
              o.attempts,
              o.max_attempts,
              o.used_at,
              o.channel,
              a.username,
              a.is_active
       FROM admin_auth_otps o
       JOIN admin_accounts a ON a.id = o.admin_id
       WHERE o.id = $1
         AND o.purpose = $2
       LIMIT 1`,
      [challengeId, ADMIN_PASSWORD_RESET_PURPOSE]
    );
    const otp = otpRes.rows[0];
    if (!otp || !otp.is_active) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_NOT_FOUND", {
        metadata: { challenge_id: challengeId || null },
      });
      return res.status(404).json({ error: "OTP_NOT_FOUND" });
    }
    if (otp.used_at) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_ALREADY_USED", {
        adminId: otp.admin_id,
        metadata: { challenge_id: challengeId || null },
      });
      return res.status(409).json({ error: "OTP_ALREADY_USED" });
    }
    if (new Date(otp.expires_at).getTime() <= Date.now()) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_EXPIRED", {
        adminId: otp.admin_id,
        metadata: { challenge_id: challengeId || null },
      });
      return res.status(409).json({ error: "OTP_EXPIRED" });
    }
    if (Number(otp.attempts || 0) >= Number(otp.max_attempts || ADMIN_PASSWORD_RESET_MAX_ATTEMPTS)) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_MAX_ATTEMPTS", {
        adminId: otp.admin_id,
        metadata: { challenge_id: challengeId || null },
      });
      return res.status(429).json({ error: "OTP_MAX_ATTEMPTS" });
    }

    const codeOk = await bcrypt.compare(code, otp.code_hash);
    if (!codeOk) {
      const failedRes = await pool.query(
        `UPDATE admin_auth_otps
         SET attempts = attempts + 1
         WHERE id = $1
         RETURNING attempts, max_attempts`,
        [otp.id]
      );
      const attempts = Number(failedRes.rows[0]?.attempts || 0);
      const maxAttempts = Number(failedRes.rows[0]?.max_attempts || ADMIN_PASSWORD_RESET_MAX_ATTEMPTS);
      if (attempts >= maxAttempts) {
        await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_MAX_ATTEMPTS", {
          adminId: otp.admin_id,
          metadata: { challenge_id: challengeId || null },
        });
        return res.status(429).json({ error: "OTP_MAX_ATTEMPTS" });
      }
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_FAILED_INVALID_CODE", {
        adminId: otp.admin_id,
        metadata: {
          challenge_id: challengeId || null,
          attempts_left: Math.max(maxAttempts - attempts, 0),
        },
      });
      return res.status(401).json({
        error: "OTP_INVALID",
        attempts_left: Math.max(maxAttempts - attempts, 0),
      });
    }

    await pool.query(
      `UPDATE admin_auth_otps
       SET used_at = now()
       WHERE id = $1`,
      [otp.id]
    );

    const resetToken = createAdminToken(
      {
        sub: "admin",
        purpose: "PASSWORD_RESET",
        admin_id: otp.admin_id,
        username: otp.username,
      },
      ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS
    );
    await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_VERIFY_SUCCESS", {
      adminId: otp.admin_id,
      metadata: {
        challenge_id: challengeId || null,
        channel: otp.channel || null,
      },
    });
    return res.json({
      reset_token: resetToken,
      channel: otp.channel,
      expires_in: ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/password-reset/complete", async (req, res, next) => {
  const pool = getPool();
  const resetToken = String(req.body?.reset_token || "").trim();
  const newPassword = String(req.body?.new_password || "");

  if (!resetToken || !newPassword) {
    return res.status(400).json({ error: "RESET_TOKEN_AND_PASSWORD_REQUIRED" });
  }

  try {
    const tokenPayload = verifyAdminToken(resetToken);
    if (
      !tokenPayload
      || tokenPayload.sub !== "admin"
      || tokenPayload.purpose !== "PASSWORD_RESET"
      || !tokenPayload.admin_id
    ) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_COMPLETE_FAILED_INVALID_TOKEN");
      return res.status(401).json({ error: "INVALID_RESET_TOKEN" });
    }

    const passwordValidation = validateNewAdminPassword(newPassword);
    if (!passwordValidation.ok) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_COMPLETE_FAILED_INVALID_PASSWORD", {
        adminId: tokenPayload.admin_id,
        metadata: { reason: passwordValidation.reason },
      });
      return res.status(400).json({ error: passwordValidation.reason });
    }

    await ensureAdminCredentialsSchema(pool);
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    const updateRes = await pool.query(
      `UPDATE admin_accounts
       SET password_hash = $2,
           auth_version = COALESCE(auth_version, 1) + 1,
           updated_at = now()
       WHERE id = $1
         AND is_active = true
       RETURNING id, username, auth_version`,
      [tokenPayload.admin_id, newPasswordHash]
    );
    if (updateRes.rowCount === 0) {
      await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_COMPLETE_FAILED_ADMIN_NOT_FOUND", {
        adminId: tokenPayload.admin_id,
      });
      return res.status(404).json({ error: "ADMIN_NOT_FOUND" });
    }

    await pool.query(
      `UPDATE admin_auth_otps
       SET used_at = COALESCE(used_at, now())
       WHERE admin_id = $1
         AND purpose = $2
         AND (used_at IS NULL OR used_at > now())`,
      [
        tokenPayload.admin_id,
        ADMIN_PASSWORD_RESET_PURPOSE,
      ]
    );

    await writeAdminAuthAudit(pool, req, "PASSWORD_RESET_COMPLETE_SUCCESS", {
      adminId: tokenPayload.admin_id,
      metadata: {
        username: updateRes.rows[0]?.username || null,
        auth_version: Number(updateRes.rows[0]?.auth_version || 1),
      },
    });

    return res.json({
      ok: true,
      username: updateRes.rows[0]?.username || null,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/status", (req, res) => {
  const requestId = String(req.query.request_id || "");
  if (!requestId) {
    return res.status(400).json({ error: "REQUEST_ID_REQUIRED" });
  }

  const entry = getLoginRequest(requestId);
  if (!entry) {
    return res.json({ status: "EXPIRED" });
  }

  if (entry.status === "APPROVED") {
    return res.json({ status: entry.status, token: entry.token });
  }

  return res.json({ status: entry.status });
});

router.post("/auth/decision", (req, res) => {
  const secret = req.header("x-bot-secret");
  const expectedSecret = process.env.BOT_TO_API_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const { request_id: requestId, decision } = req.body || {};
  if (!requestId || !decision) {
    return res.status(400).json({ error: "INVALID_REQUEST" });
  }

  const entry = setLoginDecision(String(requestId), String(decision).toUpperCase());
  if (!entry) {
    return res.status(404).json({ error: "REQUEST_NOT_FOUND" });
  }

  return res.json({ status: entry.status });
});

router.use(requireAdmin);

router.get("/publish-targets", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensurePublishTargetsSchema(pool);
    const scope = String(req.query.scope || "all").trim().toLowerCase();
    const activeOnly = String(req.query.include_inactive || "").trim() !== "1";
    const targets = await listPublishTargets(pool, {
      scope,
      activeOnly,
      adminOnly: false,
      limit: 500,
    });
    const summary = await getPublishTargetSummary(pool);
    return res.json({ items: targets, summary });
  } catch (error) {
    return next(error);
  }
});

router.post("/publications/send", async (req, res, next) => {
  const pool = getPool();
  try {
    const result = await sendPublicationToTargets(pool, req.body || {});
    return res.json({ ok: true, result });
  } catch (error) {
    if (error?.code === "MESSAGE_REQUIRED") {
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }
    if (error?.code === "MEDIA_KIND_INVALID") {
      return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
    }
    if (error?.code === "BOT_USERNAME_REQUIRED") {
      return res.status(400).json({ error: "BOT_USERNAME_REQUIRED" });
    }
    if (error?.code === "WALLET_GIFT_BUTTON_LIMIT") {
      return res.status(400).json({ error: "WALLET_GIFT_BUTTON_LIMIT" });
    }
    return next(error);
  }
});

router.get("/publications", async (req, res, next) => {
  const pool = getPool();
  const { page, pageSize, offset } = parsePagination(req.query);
  try {
    await ensurePublicationSchema(pool);
    const countRes = await pool.query("SELECT COUNT(*)::int AS total FROM publications");
    const listRes = await pool.query(
      `SELECT *
       FROM publications
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    return res.json({
      items: listRes.rows,
      page,
      page_size: pageSize,
      total: countRes.rows[0]?.total || 0,
      total_pages: Math.ceil((countRes.rows[0]?.total || 0) / pageSize) || 1,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/publications/:id", async (req, res, next) => {
  const pool = getPool();
  const publicationId = String(req.params.id || "").trim();
  try {
    await ensurePublicationSchema(pool);
    const publicationRes = await pool.query(
      "SELECT * FROM publications WHERE id = $1",
      [publicationId]
    );
    if (publicationRes.rowCount === 0) {
      return res.status(404).json({ error: "PUBLICATION_NOT_FOUND" });
    }
    return res.json({ publication: publicationRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/publications", async (req, res, next) => {
  const pool = getPool();
  const messageText = req.body && req.body.message ? String(req.body.message).trim() : "";
  const messageEntities = normalizeBroadcastMessageEntities(req.body && req.body.message_entities);
  const buttons = normalizeBroadcastButtons(req.body && req.body.buttons);
  const mediaFileId = req.body && req.body.media_file_id
    ? String(req.body.media_file_id).trim()
    : "";
  const mediaKind = normalizeBroadcastMediaKind(req.body && req.body.media_kind);
  const savedKind = normalizeSavedKind(req.body && req.body.saved_kind, buttons);

  if (!messageText && !mediaFileId) {
    return res.status(400).json({ error: "MESSAGE_REQUIRED" });
  }
  if (mediaFileId && !mediaKind) {
    return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
  }

  try {
    await ensurePublicationSchema(pool);
    const publicationId = randomUUID();
    const insertRes = await pool.query(
      `INSERT INTO publications (
         id,
         message_text,
         message_entities,
         buttons,
         image_path,
         image_filename,
         image_mime,
         saved_kind
       )
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NULL, $6, $7)
       RETURNING *`,
      [
        publicationId,
        messageText,
        JSON.stringify(messageEntities),
        JSON.stringify(buttons),
        mediaFileId ? `tgfile:${mediaFileId}` : null,
        mediaFileId ? `tg:${mediaKind}` : null,
        savedKind,
      ]
    );
    return res.status(201).json({ publication: insertRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch("/publications/:id", async (req, res, next) => {
  const pool = getPool();
  const publicationId = String(req.params.id || "").trim();
  const messageText = req.body && Object.prototype.hasOwnProperty.call(req.body, "message")
    ? String(req.body.message || "").trim()
    : null;
  const hasMessageEntitiesInput = Boolean(
    req.body && Object.prototype.hasOwnProperty.call(req.body, "message_entities")
  );
  const messageEntities = hasMessageEntitiesInput
    ? normalizeBroadcastMessageEntities(req.body.message_entities)
    : null;
  const buttons = req.body && Object.prototype.hasOwnProperty.call(req.body, "buttons")
    ? normalizeBroadcastButtons(req.body.buttons)
    : null;
  const mediaFileId = req.body && req.body.media_file_id
    ? String(req.body.media_file_id).trim()
    : "";
  const mediaKind = normalizeBroadcastMediaKind(req.body && req.body.media_kind);
  const clearImage = Boolean(req.body && req.body.clear_image);
  const hasSavedKindInput = Boolean(
    req.body && Object.prototype.hasOwnProperty.call(req.body, "saved_kind")
  );

  if (mediaFileId && !mediaKind) {
    return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
  }

  try {
    await ensurePublicationSchema(pool);
    const currentRes = await pool.query(
      "SELECT * FROM publications WHERE id = $1",
      [publicationId]
    );
    if (currentRes.rowCount === 0) {
      return res.status(404).json({ error: "PUBLICATION_NOT_FOUND" });
    }
    const current = currentRes.rows[0];
    const nextMessage = messageText !== null ? messageText : String(current.message_text || "").trim();
    const nextButtons = buttons !== null ? buttons : (current.buttons || []);
    const nextEntities = hasMessageEntitiesInput ? messageEntities : (current.message_entities || []);
    const nextSavedKind = hasSavedKindInput
      ? normalizeSavedKind(req.body.saved_kind, nextButtons)
      : buttons !== null
      ? normalizeSavedKind(null, nextButtons)
      : normalizeSavedKind(current.saved_kind, nextButtons);
    const nextImagePath = mediaFileId
      ? `tgfile:${mediaFileId}`
      : clearImage
      ? null
      : current.image_path;
    const nextImageMime = mediaFileId
      ? `tg:${mediaKind}`
      : clearImage
      ? null
      : current.image_mime;

    if (!nextMessage && !nextImagePath) {
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }

    const updateRes = await pool.query(
      `UPDATE publications
       SET message_text = $2,
           message_entities = $3::jsonb,
           buttons = $4::jsonb,
           image_path = $5,
           image_filename = NULL,
           image_mime = $6,
           saved_kind = $7,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        publicationId,
        nextMessage,
        JSON.stringify(nextEntities),
        JSON.stringify(nextButtons),
        nextImagePath,
        nextImageMime,
        nextSavedKind,
      ]
    );
    return res.json({ publication: updateRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.delete("/publications/:id", async (req, res, next) => {
  const pool = getPool();
  const publicationId = String(req.params.id || "").trim();
  try {
    await ensurePublicationSchema(pool);
    const deleteRes = await pool.query(
      "DELETE FROM publications WHERE id = $1 RETURNING *",
      [publicationId]
    );
    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ error: "PUBLICATION_NOT_FOUND" });
    }
    return res.json({ ok: true, publication: deleteRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/publications/:id/send", async (req, res, next) => {
  const pool = getPool();
  const publicationId = String(req.params.id || "").trim();
  try {
    await ensurePublicationSchema(pool);
    const publicationRes = await pool.query(
      "SELECT * FROM publications WHERE id = $1",
      [publicationId]
    );
    if (publicationRes.rowCount === 0) {
      return res.status(404).json({ error: "PUBLICATION_NOT_FOUND" });
    }
    const publication = publicationRes.rows[0];
    const result = await sendPublicationToTargets(pool, {
      ...req.body,
      publication_id: publicationId,
      message: publication.message_text || "",
      message_entities: publication.message_entities || [],
      buttons: publication.buttons || [],
      media_file_id: String(publication.image_path || "").startsWith("tgfile:")
        ? String(publication.image_path || "").slice("tgfile:".length)
        : "",
      media_kind: String(publication.image_mime || "").startsWith("tg:")
        ? String(publication.image_mime || "").slice("tg:".length)
        : "",
    });
    return res.json({ ok: true, publication, result });
  } catch (error) {
    if (error?.code === "MESSAGE_REQUIRED") {
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }
    if (error?.code === "MEDIA_KIND_INVALID") {
      return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
    }
    if (error?.code === "BOT_USERNAME_REQUIRED") {
      return res.status(400).json({ error: "BOT_USERNAME_REQUIRED" });
    }
    if (error?.code === "WALLET_GIFT_BUTTON_LIMIT") {
      return res.status(400).json({ error: "WALLET_GIFT_BUTTON_LIMIT" });
    }
    return next(error);
  }
});

router.post("/app-errors", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureAppErrorLogSchema(pool);
    const { source, level, code, route, message, stack, context } = req.body || {};
    if (!["api", "bot", "admin"].includes(String(source || "").trim().toLowerCase())) {
      return res.status(400).json({ error: "SOURCE_INVALID" });
    }
    if (!String(message || "").trim()) {
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }
    await recordAppError(
      { source, level, code, route, message, stack, context },
      pool
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/wallets/topups", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureUserWalletSchema(pool);
    await syncExpiredWalletTopups(pool);
    const statusRaw = String(req.query.status || "SUBMITTED").trim().toUpperCase();
    const status = statusRaw === "ALL" ? "" : statusRaw;
    const { page, pageSize } = parsePagination(req.query);
    const result = await listWalletTopups(pool, {
      status,
      page,
      pageSize,
      includeAll: String(req.query.include_all || "").trim() === "1",
    });
    result.items = (result.items || []).map((item) => ({
      ...item,
      topup_number_label: formatWalletTopupNumber(item.topup_number),
    }));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get("/wallets/topups/:id", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureUserWalletSchema(pool);
    await syncExpiredWalletTopups(pool);
    const resolvedId = await resolveWalletTopupId(pool, req.params.id);
    if (!resolvedId) {
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const topup = await getWalletTopupById(pool, resolvedId);
    if (!topup) {
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
});

router.get("/wallets/topups/:id/payment-proof", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureUserWalletSchema(pool);
    const resolvedId = await resolveWalletTopupId(pool, req.params.id);
    if (!resolvedId) {
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const topup = await getWalletTopupById(pool, resolvedId);
    if (!topup || !topup.screenshot_file_id) {
      return res.status(404).json({ error: "NO_PAYMENT_PROOF" });
    }
    const filePath = await getFilePath(topup.screenshot_file_id);
    const { buffer, contentType } = await downloadFile(filePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.post("/wallets/topups/:id/approve", async (req, res, next) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    await syncExpiredWalletTopups(client);
    const resolvedId = await resolveWalletTopupId(client, req.params.id);
    if (!resolvedId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const result = await approveWalletTopup(client, {
      topupId: resolvedId,
      createdByAdmin: req.admin?.sub || null,
    });
    await client.query("COMMIT");
    await updateWalletTopupAdminNotifications(pool, resolvedId);

    try {
      const topup = await getWalletTopupById(pool, resolvedId);
      if (topup?.telegram_id) {
        await sendMessage(
          topup.telegram_id,
          `✅ Tu recarga fue aprobada.\n\n`
            + `🔗 Referencia: ${formatWalletTopupNumber(getWalletTopupDisplayNumber(topup))}\n\n`
            + `💵 Monto acreditado: $${Number(topup.amount_usd || 0).toFixed(0)} USD\n`
            + `💰 Saldo actual: $${Number(result.wallet?.balance || 0).toFixed(0)} USD`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "💰 Mi saldo", callback_data: "home:wallet" },
                  { text: "🏠 Inicio", callback_data: "home:show" },
                ],
              ],
            },
          }
        );
      }
    } catch (notifyError) {
      console.error("Wallet topup approval notify failed", notifyError);
    }

    return res.json({
      ok: true,
      topup: {
        ...result.topup,
        topup_number_label: formatWalletTopupNumber(result.topup?.topup_number),
      },
      wallet: result.wallet,
      already_approved: Boolean(result.alreadyApproved),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "TOPUP_NOT_APPROVABLE") {
      return res.status(409).json({ error: "TOPUP_NOT_APPROVABLE" });
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/wallets/topups/:id/reject", async (req, res, next) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    await syncExpiredWalletTopups(client);
    const resolvedId = await resolveWalletTopupId(client, req.params.id);
    if (!resolvedId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const rejected = await rejectWalletTopup(client, {
      topupId: resolvedId,
      reason: req.body?.reason || null,
    });
    await client.query("COMMIT");
    await updateWalletTopupAdminNotifications(pool, resolvedId);

    try {
      const topup = await getWalletTopupById(pool, resolvedId);
      if (topup?.telegram_id) {
        await sendMessage(
          topup.telegram_id,
          `❌ Tu recarga ${formatWalletTopupNumber(getWalletTopupDisplayNumber(topup))} fue rechazada.\n\n`
            + (rejected?.reason ? `Motivo: ${rejected.reason}` : "Si necesitas ayuda, escríbenos a /soporte")
        );
      }
    } catch (notifyError) {
      console.error("Wallet topup rejection notify failed", notifyError);
    }

    return res.json({
      ok: true,
      topup: {
        ...rejected,
        topup_number_label: formatWalletTopupNumber(rejected?.topup_number),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "TOPUP_NOT_REJECTABLE") {
      return res.status(409).json({ error: "TOPUP_NOT_REJECTABLE" });
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/wallets/topups/:id/scam", async (req, res, next) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    await syncExpiredWalletTopups(client);
    const resolvedId = await resolveWalletTopupId(client, req.params.id);
    if (!resolvedId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "WALLET_TOPUP_NOT_FOUND" });
    }
    const scammed = await markWalletTopupScam(client, {
      topupId: resolvedId,
      reason: req.body?.reason || null,
    });
    await client.query("COMMIT");
    await updateWalletTopupAdminNotifications(pool, resolvedId);

    let notification = {
      sent: false,
      method: null,
      error: null,
    };
    try {
      const topup = await getWalletTopupById(pool, resolvedId);
      if (topup?.telegram_id) {
        try {
          await sendPhoto(topup.telegram_id, {
            url: "https://i.ibb.co/ZDbLWHM/images.jpg",
            caption: buildWalletTopupScamCustomerNotification(topup),
          });
          notification = {
            sent: true,
            method: "photo",
            error: null,
          };
        } catch (err) {
          console.error("Wallet topup scam notification failed", err);
          try {
            await sendMessage(
              topup.telegram_id,
              buildWalletTopupScamCustomerNotification(topup)
            );
            notification = {
              sent: true,
              method: "text",
              error: err?.message || "PHOTO_SEND_FAILED",
            };
          } catch (fallbackErr) {
            console.error("Wallet topup scam notification fallback failed", fallbackErr);
            notification = {
              sent: false,
              method: null,
              error:
                fallbackErr?.message
                || err?.message
                || "SCAM_NOTIFICATION_FAILED",
            };
          }
        }
      }
    } catch (notifyError) {
      console.error("Wallet topup scam notify failed", notifyError);
    }

    return res.json({
      ok: true,
      topup: {
        ...scammed,
        topup_number_label: formatWalletTopupNumber(scammed?.topup_number),
      },
      notification,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "TOPUP_NOT_SCAMMABLE") {
      return res.status(409).json({ error: "TOPUP_NOT_SCAMMABLE" });
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/wallet-gifts", async (req, res, next) => {
  try {
    const pool = getPool();
    await ensureWalletGiftSchema(pool);
    await syncWalletGifts(pool);
    const page = Math.max(Number.parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const pageSize = Math.max(
      Math.min(Number.parseInt(String(req.query.page_size || "20"), 10) || 20, 100),
      1
    );
    const statusRaw = String(req.query.status || "").trim().toUpperCase();
    const sourceKindRaw = String(req.query.source_kind || "").trim().toUpperCase();
    const status = statusRaw && statusRaw !== "ALL" ? statusRaw : "";
    const sourceKind = sourceKindRaw && sourceKindRaw !== "ALL" ? sourceKindRaw : "";
    const result = await listWalletGifts(pool, {
      status,
      sourceKind,
      page,
      pageSize,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/wallet-gifts/:id", async (req, res, next) => {
  try {
    const pool = getPool();
    await ensureWalletGiftSchema(pool);
    await syncWalletGifts(pool);
    const gift = await getWalletGiftById(pool, req.params.id);
    if (!gift) {
      return res.status(404).json({ error: "WALLET_GIFT_NOT_FOUND" });
    }
    res.json({ gift });
  } catch (error) {
    next(error);
  }
});

router.get("/wallets/users/:lookup", async (req, res, next) => {
  const lookup = String(req.params.lookup || "").trim();
  if (!lookup) {
    return res.status(400).json({ error: "LOOKUP_REQUIRED" });
  }
  const pool = getPool();
  try {
    await ensureUserWalletSchema(pool);
    const result = await getUserWalletByTelegramId(pool, lookup);
    if (!result) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    const limit = Math.max(Math.min(Number.parseInt(String(req.query.limit || "20"), 10) || 20, 100), 1);
    const history = await getUserWalletHistoryByUserId(pool, result.user.id, {
      limit,
      visibleToUserOnly: false,
    });
    return res.json({
      user: result.user,
      wallet: result.wallet,
      history,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/wallets/users/:telegram_id/adjust", async (req, res, next) => {
  const telegramId = Number(req.params.telegram_id);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || "").trim() || null;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "TELEGRAM_ID_REQUIRED" });
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    const result = await getUserWalletByTelegramId(client, telegramId);
    if (!result) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }
    const tx = await recordWalletTransaction(client, {
      userId: result.user.id,
      amount: Math.abs(amount),
      direction: amount > 0 ? "CREDIT" : "DEBIT",
      transactionType: "ADMIN_ADJUSTMENT",
      referenceType: "admin_adjustment",
      note: reason,
      visibleToUser: Boolean(reason),
      createdByAdmin: req.admin?.sub || null,
    });
    await client.query("COMMIT");
    if (reason) {
      try {
        await sendMessage(
          telegramId,
          `${amount > 0 ? "✅" : "⚠️"} Ajuste de saldo aplicado.\n\n`
            + `Movimiento: ${amount > 0 ? "+" : "-"}${formatWalletUsd(Math.abs(amount)).replace(" USD", "")}\n`
            + `Motivo: ${reason}\n`
            + `Saldo actual: ${formatWalletUsd(tx.wallet?.balance)}`
        );
      } catch (notifyError) {
        console.error("Wallet adjustment notify failed", notifyError);
      }
    }
    return res.json({
      ok: true,
      wallet: tx.wallet,
      transaction: tx.transaction,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "INSUFFICIENT_WALLET_BALANCE") {
      return res.status(409).json({
        error: "INSUFFICIENT_WALLET_BALANCE",
        available: error.available ?? null,
      });
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/auth/recovery-profile", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureAdminCredentialsSchema(pool);
    const account = await resolveCurrentAdminAccount(pool, req.admin);
    if (!account) {
      return res.status(404).json({ error: "ADMIN_NOT_FOUND" });
    }

    return res.json({
      id: account.id,
      username: account.username,
      auth_version: Number(account.auth_version || 1),
      telegram_id: account.telegram_id || null,
      recovery_email: account.recovery_email || null,
      recovery_email_masked: account.recovery_email
        ? maskEmail(account.recovery_email)
        : null,
      channels: {
        telegram: Boolean(account.telegram_id),
        email: Boolean(account.recovery_email),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/auth/recovery-profile", async (req, res, next) => {
  const pool = getPool();
  const hasTelegramField = Object.prototype.hasOwnProperty.call(req.body || {}, "telegram_id");
  const hasEmailField = Object.prototype.hasOwnProperty.call(req.body || {}, "recovery_email");

  if (!hasTelegramField && !hasEmailField) {
    return res.status(400).json({ error: "NO_FIELDS_TO_UPDATE" });
  }

  try {
    await ensureAdminCredentialsSchema(pool);
    const account = await resolveCurrentAdminAccount(pool, req.admin);
    if (!account) {
      return res.status(404).json({ error: "ADMIN_NOT_FOUND" });
    }

    let nextTelegramId = account.telegram_id ? String(account.telegram_id) : null;
    let nextRecoveryEmail = account.recovery_email || null;

    if (hasTelegramField) {
      const input = req.body?.telegram_id;
      if (input === null || String(input).trim() === "") {
        nextTelegramId = null;
      } else {
        const normalizedTelegram = normalizeRecoveryTelegramId(input);
        if (!normalizedTelegram) {
          return res.status(400).json({ error: "INVALID_TELEGRAM_ID" });
        }
        nextTelegramId = normalizedTelegram;
      }
    }

    if (hasEmailField) {
      const input = req.body?.recovery_email;
      if (input === null || String(input).trim() === "") {
        nextRecoveryEmail = null;
      } else {
        const normalizedEmail = normalizeRecoveryEmail(input);
        if (!normalizedEmail) {
          return res.status(400).json({ error: "INVALID_RECOVERY_EMAIL" });
        }
        nextRecoveryEmail = normalizedEmail;
      }
    }

    const updateRes = await pool.query(
      `UPDATE admin_accounts
       SET telegram_id = CASE
             WHEN $2::text IS NULL OR btrim($2::text) = '' THEN NULL
             ELSE $2::bigint
           END,
           recovery_email = $3,
           updated_at = now()
       WHERE id = $1
         AND is_active = true
       RETURNING id, username, auth_version, telegram_id, recovery_email`,
      [account.id, nextTelegramId || null, nextRecoveryEmail]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "ADMIN_NOT_FOUND" });
    }

    const updated = updateRes.rows[0];
    await writeAdminAuthAudit(pool, req, "AUTH_RECOVERY_PROFILE_UPDATED", {
      adminId: updated.id,
      metadata: {
        telegram_updated: hasTelegramField,
        recovery_email_updated: hasEmailField,
        channels: {
          telegram: Boolean(updated.telegram_id),
          email: Boolean(updated.recovery_email),
        },
      },
    });

    return res.json({
      id: updated.id,
      username: updated.username,
      auth_version: Number(updated.auth_version || 1),
      telegram_id: updated.telegram_id || null,
      recovery_email: updated.recovery_email || null,
      recovery_email_masked: updated.recovery_email
        ? maskEmail(updated.recovery_email)
        : null,
      channels: {
        telegram: Boolean(updated.telegram_id),
        email: Boolean(updated.recovery_email),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/users/total", async (req, res, next) => {
  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT COUNT(DISTINCT telegram_id)::int AS total FROM users"
    );
    const total = result.rows[0]?.total || 0;
    return res.json({ total });
  } catch (error) {
    return next(error);
  }
});

router.get("/maintenance", async (req, res, next) => {
  const pool = getPool();
  try {
    const active = await getMaintenanceStatus(pool);
    return res.json({ active });
  } catch (error) {
    return next(error);
  }
});

router.post("/maintenance", async (req, res, next) => {
  const pool = getPool();
  try {
    const requested = req.body?.active;
    let nextActive = requested;
    if (typeof nextActive !== "boolean") {
      const current = await getMaintenanceStatus(pool);
      nextActive = !current;
    }
    const active = await setMaintenanceStatus(pool, nextActive);
    return res.json({ active });
  } catch (error) {
    return next(error);
  }
});

router.get("/ops/backup/latest", async (req, res, next) => {
  try {
    const latest = await getLatestBackupMetadata();
    return res.json({
      has_backup: Boolean(latest),
      latest: toPublicBackupMetadata(latest),
      running: Boolean(backupExecutionPromise),
      restore_running: Boolean(backupRestorePromise),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/ops/backup/run", async (req, res, next) => {
  try {
    const metadata = await runBackupNow();
    return res.json({
      ok: true,
      backup: toPublicBackupMetadata(metadata),
    });
  } catch (error) {
    if (error?.payload?.error === "BACKUP_COOLDOWN") {
      return res.status(429).json(error.payload);
    }
    if (error?.payload?.error === "RESTORE_IN_PROGRESS") {
      return res.status(409).json(error.payload);
    }
    if (error?.payload?.error === "DATABASE_URL_MISSING") {
      return res.status(500).json(error.payload);
    }
    return next(error);
  }
});

router.post("/ops/backup/restore", rawBackupRestoreBody, async (req, res, next) => {
  try {
    const confirm = String(req.query?.confirm || "").trim().toUpperCase();
    if (confirm !== "REEMPLAZAR") {
      return res.status(400).json({ error: "INVALID_RESTORE_CONFIRM" });
    }

    const filename = sanitizeRestoreFilename(req.query?.filename);
    if (!filename) {
      return res.status(400).json({ error: "BACKUP_RESTORE_INVALID_FILENAME" });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "BACKUP_RESTORE_FILE_REQUIRED" });
    }

    const maxBytes = getBackupRestoreMaxBytes();
    if (req.body.length > maxBytes) {
      return res.status(413).json({
        error: "BACKUP_RESTORE_TOO_LARGE",
        max_mb: Math.floor(maxBytes / (1024 * 1024)),
      });
    }

    const backupDir = resolveBackupDir();
    const uploadsDir = path.join(backupDir, "restore-uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const storedFilename = `${timestamp}_${filename}`;
    const storedPath = path.join(uploadsDir, storedFilename);
    await fs.writeFile(storedPath, req.body);

    const restored = await runRestoreNow(storedPath, filename);

    return res.json({
      ok: true,
      restore: {
        ...restored,
        size_bytes: req.body.length,
      },
    });
  } catch (error) {
    if (error?.payload?.error === "RESTORE_IN_PROGRESS") {
      return res.status(409).json(error.payload);
    }
    if (error?.payload?.error === "BACKUP_IN_PROGRESS") {
      return res.status(409).json(error.payload);
    }
    if (error?.payload?.error === "DATABASE_URL_MISSING") {
      return res.status(500).json(error.payload);
    }
    return next(error);
  }
});

router.get("/ops/backup/latest/download", async (req, res, next) => {
  try {
    const latest = await getLatestBackupMetadata();
    if (!latest) {
      return res.status(404).json({ error: "BACKUP_NOT_FOUND" });
    }
    const buffer = await fs.readFile(latest.path);
    res.set("Content-Type", "application/gzip");
    res.set("Content-Disposition", `attachment; filename="${latest.filename}"`);
    res.set("Cache-Control", "private, max-age=60");
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.get("/bot-assets", async (req, res, next) => {
  const pool = getPool();
  try {
    const assets = await getBotAssets(pool);
    return res.json({ assets });
  } catch (error) {
    return next(error);
  }
});

router.post("/bot-assets", async (req, res, next) => {
  const pool = getPool();
  try {
    const assets = await setBotAssets(pool, req.body || {});
    return res.json({ assets });
  } catch (error) {
    return next(error);
  }
});

router.post("/bot-assets/payment-methods-image", async (req, res, next) => {
  const pool = getPool();
  try {
    const imageUrl = req.body?.image_url || "";
    const value = await setPaymentMethodsImage(pool, imageUrl);
    return res.json({ image_url: value });
  } catch (error) {
    return next(error);
  }
});

router.get("/layouts/:key", async (req, res, next) => {
  const pool = getPool();
  const key = String(req.params.key || "").trim();
  if (!key) {
    return res.status(400).json({ error: "LAYOUT_KEY_REQUIRED" });
  }
  try {
    const layout = await getAdminLayout(pool, key);
    return res.json({ layout });
  } catch (error) {
    return next(error);
  }
});

router.post("/layouts/:key", async (req, res, next) => {
  const pool = getPool();
  const key = String(req.params.key || "").trim();
  if (!key) {
    return res.status(400).json({ error: "LAYOUT_KEY_REQUIRED" });
  }
  try {
    const layout = await setAdminLayout(pool, key, req.body || {});
    return res.json({ layout });
  } catch (error) {
    return next(error);
  }
});

router.get("/payment-methods", async (req, res, next) => {
  const pool = getPool();
  try {
    const methods = await listPaymentMethods(pool);
    return res.json({ methods });
  } catch (error) {
    return next(error);
  }
});

router.post("/payment-methods/:key/toggle", async (req, res, next) => {
  const pool = getPool();
  const key = normalizeMethodKey(req.params.key);
  if (!key) {
    return res.status(400).json({ error: "PAYMENT_METHOD_INVALID" });
  }
  try {
    const methods = await togglePaymentMethod(pool, key);
    return res.json({ methods });
  } catch (error) {
    return next(error);
  }
});

router.post("/payment-methods", async (req, res, next) => {
  const pool = getPool();
  try {
    const methods = await upsertPaymentMethod(pool, req.body || {});
    if (!methods) {
      return res.status(400).json({ error: "PAYMENT_METHOD_INVALID" });
    }
    return res.json({ methods });
  } catch (error) {
    return next(error);
  }
});

router.delete("/payment-methods/:key", async (req, res, next) => {
  const pool = getPool();
  try {
    const methods = await deletePaymentMethod(pool, req.params.key);
    if (!methods) {
      return res.status(400).json({ error: "PAYMENT_METHOD_INVALID" });
    }
    return res.json({ methods });
  } catch (error) {
    return next(error);
  }
});

router.post("/products/:id/name", async (req, res, next) => {
  const productId = req.params.id;
  const name = req.body && typeof req.body.name === "string"
    ? req.body.name.trim()
    : "";
  const pool = getPool();

  if (!productId) {
    return res.status(400).json({ error: "PRODUCT_ID_REQUIRED" });
  }
  if (!name) {
    return res.status(400).json({ error: "NAME_REQUIRED" });
  }

  try {
    const updateRes = await pool.query(
      `UPDATE products
       SET name = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [productId, name]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }

    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "PRODUCT_NAME_UPDATE",
        "product",
        productId,
        JSON.stringify({ name }),
      ]
    );

    return res.json({ product: updateRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/products/recalculate", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureProductCategorySchema(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE products IN EXCLUSIVE MODE");
      await recalcSkuKeys(client);
      await client.query("COMMIT");
      return res.json({ status: "ok" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/products", async (req, res, next) => {
  const pool = getPool();
  const allowedDeliveryTypes = [
    "FILE",
    "TEXT",
    "IMAGE",
    "VIDEO",
    "LINK",
    "EXPIRING_LINK",
  ];
  const allowedStockModes = ["SIMPLE", "UNITS"];

  const categoryKey = String(req.body?.category_key || "").toUpperCase();
  const displayName = typeof req.body?.display_name === "string"
    ? req.body.display_name.trim()
    : "";
  const rawName = typeof req.body?.name === "string"
    ? req.body.name.trim()
    : "";
  const baseName = rawName || displayName;

  if (!baseName) {
    return res.status(400).json({ error: "NAME_REQUIRED" });
  }

  const name = baseName;

  const priceValue = req.body?.price;
  const parsedPrice = Number(priceValue ?? 0);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: "PRICE_INVALID" });
  }

  const deliveryType = String(req.body?.delivery_type || "TEXT").toUpperCase();
  if (!allowedDeliveryTypes.includes(deliveryType)) {
    return res.status(400).json({ error: "DELIVERY_TYPE_INVALID" });
  }

  const stockMode = String(req.body?.stock_mode || "SIMPLE").toUpperCase();
  if (!allowedStockModes.includes(stockMode)) {
    return res.status(400).json({ error: "STOCK_MODE_INVALID" });
  }

  const stockQtyRaw = req.body?.stock_qty;
  const stockQty = stockMode === "UNITS"
    ? null
    : stockQtyRaw === "" || stockQtyRaw === null || stockQtyRaw === undefined
      ? null
      : Number(stockQtyRaw);
  if (stockMode === "SIMPLE" && stockQty !== null) {
    if (!Number.isFinite(stockQty) || stockQty < 0) {
      return res.status(400).json({ error: "STOCK_INVALID" });
    }
  }

  const showStock = req.body?.show_stock === undefined
    ? true
    : Boolean(req.body?.show_stock);
  const uniquePurchase = Boolean(req.body?.unique_purchase);
  const outOfStock = req.body?.out_of_stock === undefined
    ? false
    : Boolean(req.body?.out_of_stock);
  let skuKey = typeof req.body?.sku_key === "string" && req.body.sku_key.trim()
    ? req.body.sku_key.trim()
    : "";
  if (skuKey && !/^\d+$/.test(skuKey)) {
    skuKey = "";
  }
  const description = typeof req.body?.description === "string"
    ? req.body.description.trim()
    : "";
  const nameEn = Object.prototype.hasOwnProperty.call(req.body || {}, "name_en")
    ? String(req.body?.name_en || "").trim()
    : null;
  const descriptionEn = Object.prototype.hasOwnProperty.call(req.body || {}, "description_en")
    ? String(req.body?.description_en || "").trim()
    : null;
  const imageUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "image_url")
    ? String(req.body?.image_url || "").trim()
    : "";
  const imageFileId = Object.prototype.hasOwnProperty.call(req.body || {}, "image_file_id")
    ? String(req.body?.image_file_id || "").trim()
    : "";
  const deliveryPayload = req.body?.delivery_payload && typeof req.body.delivery_payload === "object"
    ? req.body.delivery_payload
    : {};
  const deliveryPayloadEn = req.body?.delivery_payload_en && typeof req.body.delivery_payload_en === "object"
    ? req.body.delivery_payload_en
    : null;

  try {
    await ensureProductCategorySchema(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!skuKey) {
        skuKey = await getNextSkuKey(client);
      }
      const insertRes = await client.query(
        `INSERT INTO products
          (sku_key, name, description, name_en, description_en, image_url, image_file_id, price, is_active,
           delivery_type, delivery_payload, delivery_payload_en, stock_mode, stock_qty, show_stock,
           unique_purchase, out_of_stock, category_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          skuKey,
          name,
          description,
          nameEn,
          descriptionEn,
          imageUrl || null,
          imageFileId || null,
          parsedPrice,
          deliveryType,
          deliveryPayload,
          deliveryPayloadEn,
          stockMode,
          stockQty,
          showStock,
          uniquePurchase,
          outOfStock,
          categoryKey || "TIENDA",
        ]
      );

      const created = insertRes.rows[0];
      await client.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "PRODUCT_CREATE",
          "product",
          created.id,
          JSON.stringify({ name: created.name }),
        ]
      );
      await client.query("COMMIT");
      return res.status(201).json({ product: created });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/products/:id/update", async (req, res, next) => {
  const productId = req.params.id;
  const pool = getPool();
  const allowedDeliveryTypes = [
    "FILE",
    "TEXT",
    "IMAGE",
    "VIDEO",
    "LINK",
    "EXPIRING_LINK",
  ];
  const allowedStockModes = ["SIMPLE", "UNITS"];

  if (!productId) {
    return res.status(400).json({ error: "PRODUCT_ID_REQUIRED" });
  }

  const displayName = typeof req.body?.display_name === "string"
    ? req.body.display_name.trim()
    : "";
  const categoryKey = String(req.body?.category_key || "").toUpperCase();
  if (!displayName) {
    return res.status(400).json({ error: "NAME_REQUIRED" });
  }

  const name = displayName;

  const priceValue = req.body?.price;
  const parsedPrice = Number(priceValue ?? 0);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: "PRICE_INVALID" });
  }

  const description = typeof req.body?.description === "string"
    ? req.body.description.trim()
    : "";
  const nameEn = Object.prototype.hasOwnProperty.call(req.body || {}, "name_en")
    ? String(req.body?.name_en || "").trim()
    : null;
  const descriptionEn = Object.prototype.hasOwnProperty.call(req.body || {}, "description_en")
    ? String(req.body?.description_en || "").trim()
    : null;
  const imageUrlProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "image_url");
  const imageUrl = imageUrlProvided
    ? String(req.body?.image_url || "").trim()
    : null;
  const imageFileIdProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "image_file_id");
  const imageFileId = imageFileIdProvided
    ? String(req.body?.image_file_id || "").trim()
    : null;

  const showStock = req.body?.show_stock === undefined
    ? true
    : Boolean(req.body?.show_stock);
  const uniquePurchase = Boolean(req.body?.unique_purchase);
  const outOfStockProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "out_of_stock");
  const outOfStock = outOfStockProvided ? Boolean(req.body?.out_of_stock) : null;

  const stockMode = String(req.body?.stock_mode || "").toUpperCase();
  if (!allowedStockModes.includes(stockMode)) {
    return res.status(400).json({ error: "STOCK_MODE_INVALID" });
  }

  const deliveryType = req.body?.delivery_type
    ? String(req.body.delivery_type).toUpperCase()
    : null;
  const deliveryPayload = req.body?.delivery_payload && typeof req.body.delivery_payload === "object"
    ? req.body.delivery_payload
    : null;
  const deliveryPayloadEn = req.body?.delivery_payload_en && typeof req.body.delivery_payload_en === "object"
    ? req.body.delivery_payload_en
    : null;
  if (deliveryType && !allowedDeliveryTypes.includes(deliveryType)) {
    return res.status(400).json({ error: "DELIVERY_TYPE_INVALID" });
  }

  try {
    await ensureProductCategorySchema(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(
        "SELECT name, code FROM products WHERE id = $1",
        [productId]
      );
      if (currentRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
      }
      const updateRes = await client.query(
        `UPDATE products
         SET name = $2,
             description = $3,
             name_en = COALESCE($4, name_en),
             description_en = COALESCE($5, description_en),
             image_url = CASE WHEN $14 THEN $15 ELSE image_url END,
             image_file_id = CASE WHEN $18 THEN $19 ELSE image_file_id END,
             price = $6,
             show_stock = $7,
             unique_purchase = $8,
             stock_mode = $9::stock_mode_enum,
             stock_qty = CASE WHEN $9::stock_mode_enum = 'UNITS' THEN NULL ELSE stock_qty END,
             delivery_type = COALESCE($10, delivery_type),
             delivery_payload = COALESCE($11::jsonb, delivery_payload),
             delivery_payload_en = COALESCE($12::jsonb, delivery_payload_en),
             category_key = COALESCE($13, category_key),
             out_of_stock = CASE WHEN $16 THEN $17 ELSE out_of_stock END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          productId,
          name,
          description,
          nameEn,
          descriptionEn,
          parsedPrice,
          showStock,
          uniquePurchase,
          stockMode,
          deliveryType,
          deliveryPayload ? JSON.stringify(deliveryPayload) : null,
          deliveryPayloadEn ? JSON.stringify(deliveryPayloadEn) : null,
          categoryKey || null,
          imageUrlProvided,
          imageUrl || null,
          outOfStockProvided,
          outOfStock,
          imageFileIdProvided,
          imageFileId || null,
        ]
      );

      if (updateRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
      }

      try {
        await client.query(
          `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            "PRODUCT_UPDATE",
            "product",
            productId,
            JSON.stringify({
              name,
              price: parsedPrice,
              show_stock: showStock,
              unique_purchase: uniquePurchase,
              stock_mode: stockMode,
            }),
          ]
        );
      } catch (error) {
        if (process.env.NODE_ENV !== "test") {
          console.warn("Audit log insert failed:", error?.message || error);
        }
      }

      await client.query("COMMIT");
      return res.json({ product: updateRes.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    return next(error);
  }
});

router.post("/products/:id/deactivate", async (req, res, next) => {
  const productId = req.params.id;
  const pool = getPool();

  if (!productId) {
    return res.status(400).json({ error: "PRODUCT_ID_REQUIRED" });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(
        `SELECT *
         FROM products
         WHERE id = $1
         FOR UPDATE`,
        [productId]
      );
      if (currentRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
      }

      const ordersRes = await client.query(
        `SELECT 1
         FROM orders
         WHERE product_id = $1
         LIMIT 1`,
        [productId]
      );

      let action = "deleted";
      let productRow = currentRes.rows[0];
      let auditAction = "PRODUCT_DELETE";
      let auditMeta = { deleted: true };

      if (ordersRes.rowCount > 0) {
        const updateRes = await client.query(
          `UPDATE products
           SET is_active = false,
               code = NULL,
               sku_key = NULL,
               updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [productId]
        );

        if (updateRes.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
        }

        action = "deactivated";
        productRow = updateRes.rows[0];
        auditAction = "PRODUCT_DEACTIVATE";
        auditMeta = { is_active: false, reason: "HAS_ORDERS" };
      } else {
        const deleteRes = await client.query(
          `DELETE FROM products
           WHERE id = $1
           RETURNING *`,
          [productId]
        );

        if (deleteRes.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
        }

        productRow = deleteRes.rows[0];
      }

      await recalcSkuKeys(client);
      await client.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          auditAction,
          "product",
          productId,
          JSON.stringify(auditMeta),
        ]
      );

      await client.query("COMMIT");
      return res.json({ product: productRow, action });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

router.get("/stock/holds/active", async (req, res, next) => {
  const productId = req.query.product_id;
  const skuKey = req.query.sku_key;
  const pool = getPool();

  try {
    const product = await resolveProductByIdentifier(pool, productId, skuKey);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }

    const { holds, heldQty } = await getActiveHolds(pool, product);

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("ETag", "");

    return res.json({
      holds_active: holds,
      held_qty: heldQty,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/stock/holds/debug", async (req, res, next) => {
  const orderId = req.query.order_id;
  const productId = req.query.product_id;
  const pool = getPool();

  if (!orderId && !productId) {
    return res.status(400).json({ error: "ORDER_ID_OR_PRODUCT_ID_REQUIRED" });
  }

  try {
    let byOrder = [];
    let byProduct = [];

    if (orderId) {
      const byOrderRes = await pool.query(
        `SELECT id, product_id, order_id, qty, status, expires_at, created_at
         FROM product_stock_holds
         WHERE order_id = $1
         ORDER BY created_at DESC`,
        [orderId]
      );
      byOrder = byOrderRes.rows;
    }

    if (productId) {
      const byProductRes = await pool.query(
        `SELECT id, product_id, order_id, qty, status, expires_at, created_at
         FROM product_stock_holds
         WHERE product_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [productId]
      );
      byProduct = byProductRes.rows;
    }

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("ETag", "");

    return res.json({
      by_order: byOrder,
      by_product_last10: byProduct,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/stock/inspect", async (req, res, next) => {
  const productId = req.query.product_id;
  const skuKey = req.query.sku_key;
  const limitUnitsSample = Math.min(
    Math.max(parseInt(req.query.limit_units_sample, 10) || 20, 1),
    100
  );
  const pool = getPool();

  try {
    await ensureProductCategorySchema(pool);
    const product = await resolveProductByIdentifier(pool, productId, skuKey);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }

    let availableStock = null;
    let heldQty = 0;
    if (product.stock_mode === "SIMPLE") {
      const active = await getActiveHolds(pool, product);
      heldQty = active.heldQty;
      if (product.stock_qty !== null && product.stock_qty !== undefined) {
        availableStock = Math.max(Number(product.stock_qty) - heldQty, 0);
      }
    } else if (product.stock_mode === "UNITS") {
      const unitsRes = await pool.query(
        `SELECT COUNT(*)::int AS available_units
         FROM product_stock_units
         WHERE product_id = $1 AND status = 'AVAILABLE'`,
        [product.id]
      );
      availableStock = Number(unitsRes.rows[0]?.available_units || 0);
    }

    const activeHolds = await getActiveHolds(pool, product);

    const unitsSummaryRes = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM product_stock_units
       WHERE product_id = $1
       GROUP BY status`,
      [product.id]
    );

    const unitsSampleRes = await pool.query(
      `SELECT id, status, created_at
       FROM product_stock_units
       WHERE product_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [product.id, limitUnitsSample]
    );

    const unitsSummaryMap = new Map(
      unitsSummaryRes.rows.map((row) => [
        row.status === "DELIVERED" ? "CONSUMED" : row.status,
        row.count,
      ])
    );
    const unitsSummaryMapped =
      product.stock_mode === "UNITS"
        ? ["AVAILABLE", "HELD", "CONSUMED"].map((status) => ({
            status,
            count: unitsSummaryMap.get(status) || 0,
          }))
        : [];

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("ETag", "");
    return res.json({
      product: {
        id: product.id,
        code: product.code,
        sku_key: product.sku_key,
        category_key: product.category_key,
        name: product.name,
        name_en: product.name_en,
        description: product.description,
        description_en: product.description_en,
        image_url: product.image_url,
        image_file_id: product.image_file_id,
        price: product.price,
        show_stock: product.show_stock,
        stock_mode: product.stock_mode,
        stock_qty: product.stock_qty,
        unique_purchase: product.unique_purchase,
        out_of_stock: product.out_of_stock,
        delivery_type: product.delivery_type,
        delivery_payload: product.delivery_payload,
        delivery_payload_en: product.delivery_payload_en,
        delivery_template: product.delivery_template,
        delivery_template_en: product.delivery_template_en,
      },
      available_stock: availableStock,
      held_qty: activeHolds.heldQty,
      holds_active: activeHolds.holds,
      units_summary_mapped: unitsSummaryMapped,
      units_sample: unitsSampleRes.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders/:id/inspect", async (req, res, next) => {
  const orderId = req.params.id;
  const pool = getPool();

  try {
    const orderRes = await pool.query(
      `SELECT o.*, u.telegram_id
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }

    const itemsRes = await pool.query(
      `SELECT oi.*, p.name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );

    const holdsRes = await pool.query(
      `SELECT id, product_id, qty, status, expires_at, created_at
       FROM product_stock_holds
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [orderId]
    );

    const unitsRes = await pool.query(
      `SELECT id, product_id, status, held_at, delivered_at, created_at
       FROM product_stock_units
       WHERE held_by_order_id = $1
       ORDER BY created_at ASC`,
      [orderId]
    );

    return res.json({
      order: orderRes.rows[0],
      items: itemsRes.rows,
      holds: holdsRes.rows,
      units: unitsRes.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/stock/holds/:id/release", async (req, res, next) => {
  const holdId = req.params.id;
  const { confirm } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: "CONFIRM_REQUIRED" });
  }

  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (holdId.startsWith("units-held-")) {
      const orderId = holdId.replace("units-held-", "");
      const productId = req.query.product_id;

      if (!orderId || orderId === "none") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
      }
      if (!productId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "PRODUCT_ID_REQUIRED" });
      }

      const releaseRes = await client.query(
        `UPDATE product_stock_units
         SET status = 'AVAILABLE',
             held_by_order_id = NULL,
             held_by_telegram_id = NULL,
             held_by_username = NULL,
             held_at = NULL,
             updated_at = now()
         WHERE product_id = $1
           AND held_by_order_id = $2
           AND status = 'HELD'`,
        [productId, orderId]
      );

      if (releaseRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "HOLD_NOT_ACTIVE" });
      }

      await client.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "STOCK_HOLD_RELEASE",
          "order",
          orderId,
          JSON.stringify({
            hold_id: holdId,
            order_id: orderId,
            product_id: productId,
            qty: releaseRes.rowCount,
            mode: "UNITS",
            reason: "ADMIN_MANUAL_RELEASE",
            admin: req.admin?.mode || null,
          }),
        ]
      );

      const orderNumberCandidateRes = await client.query(
        `SELECT unit_price_at_purchase
         FROM orders
         WHERE id = $1`,
        [orderId]
      );
      if (
        orderNumberCandidateRes.rowCount > 0
        && Number(orderNumberCandidateRes.rows[0].unit_price_at_purchase || 0) > 0
      ) {
        await ensureOrderNumberForOrder(client, orderId);
      }

      const cancelRes = await client.query(
        `UPDATE orders
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancel_source = 'ADMIN',
             order_number = order_number
         WHERE id = $1 AND status = 'WAITING_PAYMENT'`,
        [orderId]
      );
      const orderCancelled = cancelRes.rowCount > 0;

      if (orderCancelled) {
        await client.query(
          `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            "HOLD_RELEASE_CANCEL_ORDER",
            "order",
            orderId,
            JSON.stringify({
              hold_id: holdId,
              order_id: orderId,
              product_id: productId,
              mode: "UNITS",
              reason: "HOLD_RELEASE",
              admin: req.admin?.mode || null,
            }),
          ]
        );
      }

      await client.query("COMMIT");
      return res.json({
        ok: true,
        released_qty: releaseRes.rowCount,
        order_cancelled: orderCancelled,
      });
    }

    const holdRes = await client.query(
      `SELECT *
       FROM product_stock_holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "HOLD_NOT_FOUND" });
    }

    const hold = holdRes.rows[0];
    if (hold.status === "CONSUMED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "HOLD_ALREADY_CONSUMED" });
    }
    if (hold.status === "EXPIRED" || (hold.expires_at && hold.expires_at <= new Date())) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "HOLD_ALREADY_EXPIRED" });
    }

    await client.query(
      `UPDATE product_stock_holds
       SET status = 'EXPIRED', expires_at = now(), updated_at = now()
       WHERE id = $1`,
      [holdId]
    );

    if (hold.order_id && hold.product_id) {
      await client.query(
        `UPDATE product_stock_units
         SET status = 'AVAILABLE',
             held_by_order_id = NULL,
             held_by_telegram_id = NULL,
             held_by_username = NULL,
             held_at = NULL,
             updated_at = now()
         WHERE held_by_order_id = $1
           AND product_id = $2
           AND status = 'HELD'`,
        [hold.order_id, hold.product_id]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "STOCK_HOLD_RELEASE",
        "product_stock_hold",
        hold.id,
        JSON.stringify({
          hold_id: hold.id,
          order_id: hold.order_id,
          product_id: hold.product_id,
          qty: hold.qty,
          mode: "SIMPLE",
          reason: "ADMIN_MANUAL_RELEASE",
          admin: req.admin?.mode || null,
        }),
      ]
    );

    let orderCancelled = false;
    if (hold.order_id) {
      const orderNumberCandidateRes = await client.query(
        `SELECT unit_price_at_purchase
         FROM orders
         WHERE id = $1`,
        [hold.order_id]
      );
      if (
        orderNumberCandidateRes.rowCount > 0
        && Number(orderNumberCandidateRes.rows[0].unit_price_at_purchase || 0) > 0
      ) {
        await ensureOrderNumberForOrder(client, hold.order_id);
      }
      const cancelRes = await client.query(
        `UPDATE orders
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancel_source = 'ADMIN',
             order_number = order_number
         WHERE id = $1 AND status = 'WAITING_PAYMENT'`,
        [hold.order_id]
      );
      orderCancelled = cancelRes.rowCount > 0;
      if (orderCancelled) {
        await client.query(
          `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            "HOLD_RELEASE_CANCEL_ORDER",
            "order",
            hold.order_id,
            JSON.stringify({
              hold_id: hold.id,
              order_id: hold.order_id,
              product_id: hold.product_id,
              mode: "SIMPLE",
              reason: "HOLD_RELEASE",
              admin: req.admin?.mode || null,
            }),
          ]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({
      ok: true,
      released_qty: hold.qty,
      status: "EXPIRED",
      order_cancelled: orderCancelled,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/stock/units", async (req, res, next) => {
  const productId = req.query.product_id;
  const skuKey = req.query.sku_key;
  const status = req.query.status;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const pool = getPool();

  try {
    const product = await resolveProductByIdentifier(pool, productId, skuKey);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }

    const values = [product.id];
    const filters = ["product_id = $1"];

    if (status) {
      values.push(status);
      filters.push(`status = $${values.length}`);
    }

    values.push(limit);
    values.push(offset);

    const listRes = await pool.query(
      `SELECT id, payload, status, created_at
       FROM product_stock_units
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    const summaryRes = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM product_stock_units
       WHERE product_id = $1
       GROUP BY status`,
      [product.id]
    );

    const summaryMap = new Map(
      summaryRes.rows.map((row) => [
        row.status === "DELIVERED" ? "CONSUMED" : row.status,
        row.count,
      ])
    );
    const summary = ["AVAILABLE", "HELD", "CONSUMED"].map((key) => ({
      status: key,
      count: summaryMap.get(key) || 0,
    }));

    const sample = listRes.rows.map((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      const username = payload.username || payload.user || "";
      const password = payload.password || "";
      const preview = stableStringify(payload);
      const durationValue = payload.duration_value || payload.duration || "";
      const durationUnit = payload.duration_unit || "";
      return {
        id: row.id,
        status: row.status === "DELIVERED" ? "CONSUMED" : row.status,
        created_at: row.created_at,
        username: username ? String(username) : "",
        password_masked: password ? maskSecret(password) : "",
        duration_value: durationValue ? String(durationValue) : "",
        duration_unit: durationUnit ? String(durationUnit) : "",
        payload_preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
      };
    });

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("ETag", "");
    return res.json({ summary, sample, limit, offset });
  } catch (error) {
    return next(error);
  }
});

router.post("/stock/units/add", async (req, res, next) => {
  const productId = req.body?.product_id;
  const skuKey = req.body?.sku_key;
  const pool = getPool();

  try {
    const product = await resolveProductByIdentifier(pool, productId, skuKey);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }
    if (product.stock_mode !== "UNITS") {
      return res.status(400).json({ error: "PRODUCT_NOT_UNITS" });
    }

    let payload = {};
    if (req.body?.payload) {
      if (typeof req.body.payload === "string") {
        try {
          payload = JSON.parse(req.body.payload);
        } catch (error) {
          return res.status(400).json({ error: "PAYLOAD_INVALID_JSON" });
        }
      } else if (typeof req.body.payload === "object") {
        payload = req.body.payload;
      }
    }

    const normalizedPayload = {
      title: req.body?.title || payload.title,
      username: req.body?.username || payload.username,
      password: req.body?.password || payload.password,
      duration_value:
        req.body?.duration_value
        || req.body?.duration
        || payload.duration_value
        || payload.duration,
      duration_unit: req.body?.duration_unit || payload.duration_unit,
      notes: req.body?.notes || payload.notes,
      ...payload,
    };

    const normalizedUsername = String(normalizedPayload.username || "").trim();
    const normalizedPassword = String(normalizedPayload.password || "").trim();
    const normalizedDurationValue = String(
      normalizedPayload.duration_value || ""
    ).trim();
    const normalizedDurationUnit = String(
      normalizedPayload.duration_unit || ""
    ).trim();
    if (!normalizedUsername || !normalizedPassword || !normalizedDurationValue) {
      return res.status(400).json({ error: "UNIT_FIELDS_REQUIRED" });
    }
    if (!normalizedDurationUnit) {
      return res.status(400).json({ error: "UNIT_DURATION_UNIT_REQUIRED" });
    }
    if (normalizedUsername || normalizedPassword || normalizedDurationValue) {
      const dupRes = await pool.query(
        `SELECT 1
         FROM product_stock_units
         WHERE product_id = $1
           AND COALESCE(payload->>'username', payload->>'user', '') = $2
           AND COALESCE(payload->>'password', '') = $3
           AND COALESCE(payload->>'duration_value', payload->>'duration', '') = $4
           AND COALESCE(payload->>'duration_unit', '') = $5
         LIMIT 1`,
        [
          product.id,
          normalizedUsername,
          normalizedPassword,
          normalizedDurationValue,
          normalizedDurationUnit,
        ]
      );
      if (dupRes.rowCount > 0) {
        return res.status(409).json({ error: "DUPLICATE_IN_DB" });
      }
    }

    const payloadKey = stableStringify(normalizedPayload);
    const existingRes = await pool.query(
      `SELECT 1 FROM product_stock_units
       WHERE product_id = $1 AND payload = $2::jsonb
       LIMIT 1`,
      [product.id, normalizedPayload]
    );
    if (existingRes.rowCount > 0) {
      return res.status(409).json({ error: "DUPLICATE_IN_DB" });
    }

    const insertRes = await pool.query(
      `INSERT INTO product_stock_units (product_id, payload, status)
       VALUES ($1, $2::jsonb, 'AVAILABLE')
       RETURNING *`,
      [product.id, normalizedPayload]
    );

    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "STOCK_UNITS_ADD",
        "product",
        product.id,
        JSON.stringify({
          sku_key: product.sku_key,
          payload_key: payloadKey,
        }),
      ]
    );

    return res.json({ unit: insertRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/stock/units/:id/delete", async (req, res, next) => {
  const unitId = req.params.id;
  const pool = getPool();

  if (!unitId) {
    return res.status(400).json({ error: "UNIT_ID_REQUIRED" });
  }

  try {
    const unitRes = await pool.query(
      `SELECT id, product_id, status, payload
       FROM product_stock_units
       WHERE id = $1`,
      [unitId]
    );
    if (unitRes.rowCount === 0) {
      return res.status(404).json({ error: "UNIT_NOT_FOUND" });
    }
    const unit = unitRes.rows[0];
    if (unit.status !== "AVAILABLE") {
      return res.status(409).json({ error: "UNIT_NOT_AVAILABLE" });
    }

    await pool.query(
      `DELETE FROM product_stock_units
       WHERE id = $1`,
      [unitId]
    );

    try {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "STOCK_UNITS_DELETE",
          "product",
          unit.product_id,
          JSON.stringify({
            unit_id: unit.id,
            payload_key: stableStringify(unit.payload || {}),
          }),
        ]
      );
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("Audit log insert failed:", error?.message || error);
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/stock/simple/set", async (req, res, next) => {
  const productId = req.body && req.body.product_id;
  const skuKey = req.body && req.body.sku_key;
  const simpleStock = req.body && req.body.stock_qty;
  const hasUniquePurchase = req.body
    && Object.prototype.hasOwnProperty.call(req.body, "unique_purchase");
  const uniquePurchase = hasUniquePurchase
    ? Boolean(req.body && req.body.unique_purchase)
    : null;
  const unlimited = Boolean(req.body && req.body.unlimited) || Boolean(uniquePurchase);
  const pool = getPool();

  if (!unlimited && (simpleStock === undefined || simpleStock === null || simpleStock === "")) {
    return res.status(400).json({ error: "STOCK_REQUIRED" });
  }

  let parsedStock = null;
  if (!unlimited) {
    parsedStock = Number(simpleStock);
    if (!Number.isFinite(parsedStock) || parsedStock < 0) {
      return res.status(400).json({ error: "STOCK_INVALID" });
    }
  }
  if (uniquePurchase) {
    parsedStock = null;
  }

  try {
    const product = await resolveProductByIdentifier(pool, productId, skuKey);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }
    if (product.stock_mode !== "SIMPLE") {
      return res.status(400).json({ error: "PRODUCT_NOT_SIMPLE" });
    }

    const updateRes = await pool.query(
      `UPDATE products
       SET stock_qty = $2,
           unique_purchase = COALESCE($3, unique_purchase),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [product.id, parsedStock, uniquePurchase]
    );

    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "STOCK_SIMPLE_SET",
        "product",
        product.id,
        JSON.stringify({
          stock_qty: parsedStock,
          sku_key: product.sku_key,
          unique_purchase: updateRes.rows[0].unique_purchase,
        }),
      ]
    );

    return res.json({ product: updateRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/products/:id/stock-mode", async (req, res, next) => {
  const productId = req.params.id;
  const mode = String(req.body?.stock_mode || "").toUpperCase();
  const pool = getPool();

  if (!productId) {
    return res.status(400).json({ error: "PRODUCT_ID_REQUIRED" });
  }
  if (mode !== "SIMPLE" && mode !== "UNITS") {
    return res.status(400).json({ error: "INVALID_STOCK_MODE" });
  }

  try {
    const updateRes = await pool.query(
      `UPDATE products
       SET stock_mode = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [productId, mode]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }
    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "PRODUCT_STOCK_MODE_UPDATE",
        "product",
        productId,
        JSON.stringify({ stock_mode: mode }),
      ]
    );
    return res.json({ product: updateRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders", async (req, res, next) => {
  const status = req.query.status;
  const includeAll = String(req.query.include_all || "").trim() === "1";
  const { page, pageSize, offset } = parsePagination(req.query);
  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);

  const filters = [];
  const values = [];

  if (includeAll) {
    if (status === "FREE") {
      filters.push(
        "(o.free_order_number IS NOT NULL OR COALESCE(o.unit_price_at_purchase, 0) <= 0)"
      );
      filters.push("COALESCE(o.is_scam, false) = false");
    } else if (status === "SCAM") {
      filters.push("COALESCE(o.is_scam, false) = true");
    } else if (status) {
      values.push(status);
      filters.push(`o.status = $${values.length}`);
      filters.push("COALESCE(o.is_scam, false) = false");
      if (status === "EXPIRED") {
        filters.push(
          "(o.free_order_number IS NULL AND COALESCE(o.unit_price_at_purchase, 0) > 0)"
        );
      }
    }
  } else if (status === "FREE") {
    filters.push(
      "(o.free_order_number IS NOT NULL OR COALESCE(o.unit_price_at_purchase, 0) <= 0)"
    );
    filters.push("COALESCE(o.is_scam, false) = false");
  } else if (status === "SCAM") {
    filters.push("COALESCE(o.is_scam, false) = true");
  } else if (status) {
    values.push(status);
    filters.push(`o.status = $${values.length}`);
    filters.push("COALESCE(o.is_scam, false) = false");
    if (status === "EXPIRED") {
      filters.push(
        "(o.free_order_number IS NULL AND COALESCE(o.unit_price_at_purchase, 0) > 0)"
      );
    } else {
      filters.push(
        "(op.id IS NOT NULL OR o.free_order_number IS NOT NULL OR COALESCE(o.unit_price_at_purchase, 0) <= 0)"
      );
    }
  } else {
    filters.push(`o.status != 'EXPIRED'`);
    filters.push(
      "(op.id IS NOT NULL OR o.free_order_number IS NOT NULL OR COALESCE(o.unit_price_at_purchase, 0) <= 0)"
    );
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderClause =
    status === "EXPIRED" ? "ORDER BY o.created_at ASC" : "ORDER BY o.created_at DESC";

  try {
    await syncExpiredWaitingPaymentOrders(pool);
    await pool.query(
      `UPDATE orders
       SET free_order_number = COALESCE(
         free_order_number,
         nextval('orders_free_order_number_seq')
       )
       WHERE free_order_number IS NULL
         AND COALESCE(unit_price_at_purchase, 0) <= 0`
    );

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM orders o
       LEFT JOIN order_payments op ON op.order_id = o.id
       ${whereClause}`,
      values
    );
    const total = countRes.rows[0].total;

    const baseQuery = `SELECT o.id, o.status, o.created_at,
                              o.order_number,
                              o.released_order_number,
                              o.free_order_number,
                              o.is_scam,
                              o.is_test,
                              o.test_cleanup_after,
                              o.scam_flagged_at,
                              o.scam_reason,
                              o.unit_price_at_purchase,
                              u.telegram_id, u.telegram_username,
                              p.id AS product_id, p.code AS product_code, p.name AS product_name,
                              (op.id IS NOT NULL) AS has_payment_proof,
                              op.review_status AS payment_review_status,
                              (
                                o.free_order_number IS NOT NULL
                                OR COALESCE(o.unit_price_at_purchase, 0) <= 0
                              ) AS is_free_order
                       FROM orders o
                       JOIN users u ON u.id = o.user_id
                       JOIN products p ON p.id = o.product_id
                       LEFT JOIN order_payments op ON op.order_id = o.id
                       ${whereClause}
                       ${orderClause}`;
    const listRes = includeAll
      ? await pool.query(baseQuery, values)
      : await pool.query(
        `${baseQuery}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset]
      );
    const resultPageSize = includeAll ? listRes.rows.length : pageSize;
    const resultTotalPages = includeAll ? 1 : (Math.ceil(total / pageSize) || 1);

    res.json({
      items: listRes.rows,
      page: includeAll ? 1 : page,
      page_size: resultPageSize,
      total,
      total_pages: resultTotalPages,
    });
  } catch (error) {
    if (error?.code === "BOT_USERNAME_REQUIRED") {
      return res.status(400).json({ error: "BOT_USERNAME_REQUIRED" });
    }
    if (error?.code === "WALLET_GIFT_BUTTON_LIMIT") {
      return res.status(400).json({ error: "WALLET_GIFT_BUTTON_LIMIT" });
    }
    next(error);
  }
});

router.get("/orders/status-counts", async (req, res, next) => {
  const includeAll = String(req.query.include_all || "").trim() === "1";
  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  try {
    await syncExpiredWaitingPaymentOrders(pool);
    const countsQuery = includeAll
      ? `SELECT CASE
                WHEN COALESCE(o.is_scam, false) THEN 'SCAM'
                ELSE o.status::text
              END AS status,
              COUNT(*)::int AS count
         FROM orders o
         WHERE NOT (
           o.status = 'EXPIRED'
           AND (
             o.free_order_number IS NOT NULL
             OR COALESCE(o.unit_price_at_purchase, 0) <= 0
           )
         )
         GROUP BY 1`
      : `SELECT CASE
                WHEN COALESCE(o.is_scam, false) THEN 'SCAM'
                ELSE o.status::text
              END AS status,
              COUNT(*)::int AS count
         FROM orders o
         LEFT JOIN order_payments op ON op.order_id = o.id
         WHERE (
           o.status = 'EXPIRED'
           AND (
             o.free_order_number IS NULL
             AND COALESCE(o.unit_price_at_purchase, 0) > 0
           )
         )
            OR (
              o.status != 'EXPIRED'
              AND (
                op.id IS NOT NULL
                OR o.free_order_number IS NOT NULL
                OR COALESCE(o.unit_price_at_purchase, 0) <= 0
              )
            )
         GROUP BY 1`;
    const countsRes = await pool.query(countsQuery);
    const freeCountRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       WHERE o.free_order_number IS NOT NULL
          OR COALESCE(o.unit_price_at_purchase, 0) <= 0`
    );
    const counts = {};
    for (const row of countsRes.rows) {
      counts[row.status] = row.count || 0;
    }
    counts.FREE = Number(freeCountRes.rows[0]?.count || 0);
    return res.json({ counts });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/test", async (req, res, next) => {
  const telegramId = Number(req.body?.telegram_id);
  const usernameRaw = String(req.body?.username || "").trim();
  const username = usernameRaw ? usernameRaw.replace(/^@+/, "") : null;
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "TELEGRAM_ID_REQUIRED" });
  }

  const pool = getPool();
  await ensureProductCategorySchema(pool);
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const user = await ensureUserByTelegram(client, telegramId, username);
    const productRes = await client.query(
      `SELECT id,
              code,
              name,
              price,
              image_url
       FROM products
       WHERE is_active = true
         AND COALESCE(price, 0) > 0
       ORDER BY random()
       LIMIT 1`
    );
    if (productRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "NO_ACTIVE_PRODUCT_FOR_TEST_ORDER" });
    }

    const product = productRes.rows[0];
    const unitPrice = Number(product.price || 0);
    const orderInsertRes = await client.query(
      `INSERT INTO orders
        (user_id, product_id, affiliate_id, status, unit_price_at_purchase, is_test)
       VALUES ($1, $2, NULL, 'WAITING_PAYMENT', $3, true)
       RETURNING *`,
      [user.id, product.id, unitPrice]
    );
    const order = orderInsertRes.rows[0];

    await client.query(
      `INSERT INTO order_items
        (order_id, product_id, qty, unit_price_usd, total_price_usd, line_total_usd, price_usd)
       VALUES ($1, $2, 1, $3, $3, $3, $3)`,
      [order.id, product.id, unitPrice]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      order: {
        ...order,
        total: unitPrice,
        order_number_label: "Prueba",
      },
      product: product,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/logs", async (req, res, next) => {
  const category = String(req.query.category || "payments").trim().toLowerCase();
  const parsedLimit = Number.parseInt(String(req.query.limit || "10"), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 50)
    : 10;
  const pool = getPool();

  try {
    if (["api", "bot", "admin"].includes(category)) {
      const rows = await listAppErrors(category, limit, pool);
      const items = rows.map((row) => ({
        created_at: row.created_at,
        action: `${String(row.source || category).toUpperCase()}_${String(row.level || "error").toUpperCase()}`,
        ref_id: row.code || "-",
        message: [
          row.route ? `[${row.route}]` : "",
          row.message || "",
        ]
          .filter(Boolean)
          .join(" "),
      }));
      return res.json({ category, limit, items });
    }

    if (category === "payments") {
      const actions = ["ORDER_MARK_PAID", "ORDER_REJECT", "ORDER_REFUND"];
      const logsRes = await pool.query(
        `SELECT created_at,
                admin_action AS action,
                entity_id::text AS ref_id,
                meta
         FROM audit_logs
         WHERE admin_action = ANY($1::text[])
         ORDER BY created_at DESC
         LIMIT $2`,
        [actions, limit]
      );
      const items = logsRes.rows.map((row) => ({
        created_at: row.created_at,
        action: row.action,
        ref_id: row.ref_id,
        message: row.meta ? JSON.stringify(row.meta) : "",
      }));
      return res.json({ category, limit, items });
    }

    if (category === "support") {
      await ensureTicketSchema(pool);
      await ensureSupportBanSchema(pool);
      const logsRes = await pool.query(
        `WITH ticket_events AS (
           SELECT tm.created_at,
                  'TICKET_MESSAGE'::text AS action,
                  t.id::text AS ref_id,
                  CASE
                    WHEN tm.telegram_file_id IS NOT NULL
                      AND (tm.message_text IS NULL OR tm.message_text = '')
                    THEN '[image]'
                    ELSE COALESCE(tm.message_text, '')
                  END AS message
           FROM ticket_messages tm
           JOIN tickets t ON t.id = tm.ticket_id
         ),
         support_ban_events AS (
           SELECT sb.banned_at AS created_at,
                  'SUPPORT_BAN'::text AS action,
                  sb.telegram_id::text AS ref_id,
                  COALESCE(sb.reason, 'support ban') AS message
           FROM support_bans sb
         )
         SELECT created_at, action, ref_id, message
         FROM (
           SELECT * FROM ticket_events
           UNION ALL
           SELECT * FROM support_ban_events
         ) events
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({ category, limit, items: logsRes.rows });
    }

    if (category === "errors") {
      await ensureBroadcastSchema(pool);
      const logsRes = await pool.query(
        `WITH broadcast_failures AS (
           SELECT COALESCE(sent_at, created_at) AS created_at,
                  'BROADCAST_FAILED'::text AS action,
                  id::text AS ref_id,
                  COALESCE(message_text, '') AS message
           FROM broadcasts
           WHERE status = 'FAILED'
         ),
         payment_rejections AS (
           SELECT COALESCE(op.reviewed_by_admin_at, o.created_at) AS created_at,
                  'PAYMENT_REJECTED'::text AS action,
                  o.id::text AS ref_id,
                  COALESCE(op.payment_method, '') AS message
           FROM order_payments op
           JOIN orders o ON o.id = op.order_id
           WHERE op.review_status = 'REJECTED'
         )
         SELECT created_at, action, ref_id, message
         FROM (
           SELECT * FROM broadcast_failures
           UNION ALL
           SELECT * FROM payment_rejections
         ) events
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({ category, limit, items: logsRes.rows });
    }

    return res.status(400).json({ error: "CATEGORY_INVALID" });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders/:id", async (req, res, next) => {
  const { ref: orderLookupRef, orderNumber: orderLookupNumber } =
    parseOrderLookupRef(req.params.id);
  if (!orderLookupRef) {
    return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
  }
  const pool = getPool();
  await ensureFreeOrderSchema(pool);

  try {
    await syncExpiredWaitingPaymentOrders(pool);
    const resolvedOrderId = await resolveOrderLookupId(
      pool,
      orderLookupRef,
      orderLookupNumber
    );
    if (!resolvedOrderId) {
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }
    const orderRes = await pool.query(
      `SELECT o.*, u.telegram_id, u.telegram_username,
              b.telegram_id AS banned_telegram_id,
              p.id AS linked_product_id, p.code AS product_code,
              p.name AS product_name, p.price AS product_price
       FROM orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN user_bans b ON b.telegram_id = u.telegram_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [resolvedOrderId]
    );

    if (orderRes.rowCount === 0) {
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }
    let order = orderRes.rows[0];
    if (
      !order.free_order_number
      && Number(order.unit_price_at_purchase || 0) <= 0
    ) {
      const assignFreeNumberRes = await pool.query(
        `UPDATE orders
         SET free_order_number = COALESCE(
           free_order_number,
           nextval('orders_free_order_number_seq')
         )
         WHERE id = $1
         RETURNING *`,
        [order.id]
      );
      if (assignFreeNumberRes.rowCount > 0) {
        order = {
          ...order,
          ...assignFreeNumberRes.rows[0],
        };
      }
    }
    const orderId = order.id;

    const paymentRes = await pool.query(
      "SELECT * FROM order_payments WHERE order_id = $1",
      [orderId]
    );

    const commissionRes = await pool.query(
      "SELECT * FROM commissions WHERE order_id = $1",
      [orderId]
    );
    let commission = commissionRes.rows[0] || null;
    if (commission?.affiliate_id) {
      const affiliateRes = await pool.query(
        `SELECT u.telegram_id, u.telegram_username
         FROM affiliates a
         JOIN users u ON u.id = a.user_id
         WHERE a.id = $1`,
        [commission.affiliate_id]
      );
      const affiliateUser = affiliateRes.rows[0] || null;
      const adminIds = parseAdminTelegramIds();
      const adminId = adminIds.length > 0 ? adminIds[0] : null;
      const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
      const isPlaceholderAffiliate =
        affiliateUser?.telegram_id === 90000000000
        || affiliateUser?.telegram_username === "admin_affiliate";
      commission = {
        ...commission,
        affiliate_telegram_id: isPlaceholderAffiliate
          ? adminId
          : affiliateUser?.telegram_id || null,
        affiliate_username: isPlaceholderAffiliate
          ? adminUsername
          : affiliateUser?.telegram_username || null,
      };
    }

    const itemsRes = await pool.query(
      `SELECT
         oi.product_id,
         p.code,
         COALESCE(p.name, 'Producto eliminado') AS name,
         p.image_url,
         oi.qty,
         COALESCE(oi.unit_price_usd, p.price) AS unit_price_usd,
         COALESCE(
           oi.line_total_usd,
           COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
         ) AS line_total_usd
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );

    const items = itemsRes.rows.map((row) => ({
      product_id: row.product_id,
      code: row.code,
      name: row.name,
      image_url: row.image_url || null,
      qty: row.qty,
      unit_price_usd: row.unit_price_usd,
      line_total_usd: row.line_total_usd,
    }));

    let subtotalUsd = 0;
    if (items.length > 0) {
      subtotalUsd = items.reduce((sum, item) => {
        const lineTotal =
          item.line_total_usd != null
            ? Number(item.line_total_usd)
            : Number(item.unit_price_usd || 0) * Number(item.qty || 0);
        return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
      }, 0);
      subtotalUsd = Number(subtotalUsd.toFixed(2));
    } else {
      subtotalUsd = Number(order.unit_price_at_purchase || order.product_price || 0);
    }

    let localTotal = null;
    const paymentMethod =
      paymentRes.rows[0]?.payment_method || order.payment_method;
    if (paymentMethod) {
      try {
        const localData = await calculateLocalAmount(subtotalUsd, paymentMethod);
        if (localData) {
          localTotal = {
            currency: localData.currency,
            amount: localData.amount,
          };
        }
      } catch (error) {
        console.error("Failed to calculate local total", error);
      }
    }
    const totalsWithMarkup = await resolveTotalsWithMarkup(
      pool,
      subtotalUsd,
      paymentMethod,
      localTotal
    );

    const orderIsFree = isFreeOrderRow(order);
    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number,
        released_order_number: order.released_order_number || null,
        free_order_number: order.free_order_number || null,
        free_order_label: formatFreeOrderLabel(order.free_order_number),
        is_free_order: orderIsFree,
        is_scam: Boolean(order.is_scam),
        is_test: Boolean(order.is_test),
        test_cleanup_after: order.test_cleanup_after || null,
        scam_flagged_at: order.scam_flagged_at,
        scam_reason: order.scam_reason,
        status: order.status,
        unit_price_at_purchase: order.unit_price_at_purchase,
        created_at: order.created_at,
        paid_at: order.paid_at,
        refunded_amount: order.refunded_amount,
        refunded_at: order.refunded_at,
        refund_reason: order.refund_reason,
        paid_with_wallet: Boolean(order.paid_with_wallet),
      },
      user: {
        telegram_id: order.telegram_id,
        telegram_username: order.telegram_username,
        banned: Boolean(order.banned_telegram_id),
      },
      product: {
        id: order.product_id,
        code: order.product_code,
        name: order.product_name,
        price: order.product_price,
        image_url: order.product_image_url || null,
      },
      items,
      payment: paymentRes.rows[0] || null,
      commission,
      totals: {
        subtotal_usd: totalsWithMarkup.subtotalUsd,
        total_usd: totalsWithMarkup.totalUsd,
        markup_percent: totalsWithMarkup.markupPercent,
      },
      local_total: totalsWithMarkup.localTotal,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/users/:telegram_id/ban-toggle", async (req, res, next) => {
  const telegramId = Number(req.params.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  const pool = getPool();

  try {
    const banRes = await pool.query(
      "SELECT 1 FROM user_bans WHERE telegram_id = $1 LIMIT 1",
      [telegramId]
    );
    if (banRes.rowCount > 0) {
      await pool.query("DELETE FROM user_bans WHERE telegram_id = $1", [
        telegramId,
      ]);
      return res.json({ banned: false });
    }

    await pool.query(
      "INSERT INTO user_bans (telegram_id, reason) VALUES ($1, $2)",
      [telegramId, "Banned from admin panel"]
    );
    return res.json({ banned: true });
  } catch (error) {
    return next(error);
  }
});

async function handlePaymentProof(req, res, next, asAttachment) {
  const orderId = req.params.id;
  const pool = getPool();

  try {
    const paymentRes = await pool.query(
      "SELECT screenshot_file_id FROM order_payments WHERE order_id = $1",
      [orderId]
    );

    if (paymentRes.rowCount === 0) {
      return res.status(404).json({ error: "NO_PAYMENT_PROOF" });
    }

    const fileId = paymentRes.rows[0].screenshot_file_id;
    const filePath = await getFilePath(fileId);
    const { buffer, contentType } = await downloadFile(filePath);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    if (asAttachment) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="order_${orderId}_payment_proof.jpg"`
      );
    }
    return res.send(buffer);
  } catch (error) {
    next(error);
  }
}

router.get("/orders/:id/payment-proof", async (req, res, next) => {
  await handlePaymentProof(req, res, next, false);
});

router.get("/orders/:id/payment-proof/download", async (req, res, next) => {
  await handlePaymentProof(req, res, next, true);
});

router.get("/orders/:id/receipt", async (req, res, next) => {
  const orderId = req.params.id;
  const pool = getPool();

  try {
    const orderRes = await pool.query(
      `SELECT o.*, u.telegram_id, u.telegram_username,
              p.name AS product_name,
              p.price AS product_price,
              op.payment_method,
              op.review_status
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN products p ON p.id = o.product_id
       LEFT JOIN order_payments op ON op.order_id = o.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }

    const order = orderRes.rows[0];
    const isApproved =
      order.status === "PAID"
      || order.status === "DELIVERED"
      || order.review_status === "APPROVED";
    if (!isApproved) {
      return res.status(400).json({ error: "ORDER_NOT_PAID" });
    }

    const paymentRes = await pool.query(
      "SELECT * FROM order_payments WHERE order_id = $1",
      [orderId]
    );
    if (paymentRes.rowCount === 0) {
      return res.status(404).json({ error: "NO_PAYMENT_PROOF" });
    }

    let items = [];
    let subtotal = Number(order.unit_price_at_purchase || 0);
    let commissionAmount = 0;
    let referredBy = "N/A";
    try {
      const itemsRes = await pool.query(
        `SELECT
           p.name,
           oi.qty,
           oi.unit_price_usd,
           oi.line_total_usd
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1
         ORDER BY oi.created_at ASC`,
        [orderId]
      );
      if (itemsRes.rowCount > 0) {
        subtotal = 0;
        items = itemsRes.rows.map((row) => {
          const itemName = row.qty > 1 ? `${row.name} x${row.qty}` : row.name;
          const lineTotal =
            row.line_total_usd != null
              ? Number(row.line_total_usd)
              : Number(row.unit_price_usd || 0) * Number(row.qty || 0);
          subtotal += Number.isFinite(lineTotal) ? lineTotal : 0;
          return {
            name: itemName,
            price: row.line_total_usd,
          };
        });
        subtotal = Number(subtotal.toFixed(2));
      }
    } catch (err) {
      console.error("Receipt items query failed", err);
    }

    if (items.length === 0) {
      items = [{ name: order.product_name, price: order.product_price }];
      subtotal = Number(order.unit_price_at_purchase || order.product_price || 0);
    }

    try {
      const commissionRes = await pool.query(
        `SELECT c.amount, u.telegram_username, u.telegram_id
         FROM commissions c
         JOIN affiliates a ON a.id = c.affiliate_id
         JOIN users u ON u.id = a.user_id
         WHERE c.order_id = $1`,
        [orderId]
      );
      if (commissionRes.rowCount > 0) {
        const row = commissionRes.rows[0];
        commissionAmount = Number(row.amount || 0);
        const adminIds = parseAdminTelegramIds();
        const adminId = adminIds.length > 0 ? adminIds[0] : null;
        const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
        const isPlaceholderAffiliate =
          row.telegram_id === 90000000000 || row.telegram_username === "admin_affiliate";
        if (isPlaceholderAffiliate) {
          referredBy = adminUsername
            ? `@${adminUsername}`
            : adminId
            ? String(adminId)
            : "N/A";
        } else {
          referredBy = row.telegram_username
            ? `@${row.telegram_username}`
            : row.telegram_id
            ? String(row.telegram_id)
            : "N/A";
        }
      }
    } catch (err) {
      console.error("Receipt commission query failed", err);
    }

    const orderNumberText = order.order_number
      ? String(order.order_number).padStart(5, "0")
      : "-";

    let localTotal = null;
    try {
      const localData = await calculateLocalAmount(subtotal, order.payment_method);
      if (localData) {
        localTotal = {
          currency: localData.currency,
          amount: localData.amount,
        };
      }
    } catch (err) {
      console.error("Failed to calculate local total", err);
    }
    const totalsWithMarkup = await resolveTotalsWithMarkup(
      pool,
      subtotal,
      order.payment_method,
      localTotal
    );

    const receiptPng = await renderReceiptPng({
      orderId: order.id,
      orderNumber: orderNumberText,
      telegramId: order.telegram_id,
      username: order.telegram_username,
      dateTime: formatBogotaDate(order.paid_at || new Date()),
      items,
      subtotal: totalsWithMarkup.subtotalUsd,
      commission: commissionAmount,
      total: totalsWithMarkup.totalUsd,
      referredBy,
      localTotal: totalsWithMarkup.localTotal,
      locale: "es",
    });

    try {
      const buffer = await fs.readFile(receiptPng.pngPath);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } finally {
      await receiptPng.cleanup();
    }
  } catch (error) {
    return next(error);
  }
});

router.get("/orders/:id/receipt/download", async (req, res, next) => {
  const orderId = req.params.id;
  const pool = getPool();

  try {
    const receiptRes = await pool.query(
      `SELECT order_number
       FROM orders
       WHERE id = $1`,
      [orderId]
    );
    if (receiptRes.rowCount === 0) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }

    const receiptResponse = await pool.query(
      `SELECT o.*, u.telegram_id, u.telegram_username,
              p.name AS product_name,
              p.price AS product_price,
              op.payment_method,
              op.review_status
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN products p ON p.id = o.product_id
       LEFT JOIN order_payments op ON op.order_id = o.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (receiptResponse.rowCount === 0) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }

    const order = receiptResponse.rows[0];
    const isApproved =
      order.status === "PAID"
      || order.status === "DELIVERED"
      || order.review_status === "APPROVED";
    if (!isApproved) {
      return res.status(400).json({ error: "ORDER_NOT_PAID" });
    }

    let items = [];
    let subtotal = Number(order.unit_price_at_purchase || 0);
    let commissionAmount = 0;
    let referredBy = "N/A";
    try {
      const itemsRes = await pool.query(
        `SELECT
           p.name,
           oi.qty,
           oi.unit_price_usd,
           oi.line_total_usd
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1
         ORDER BY oi.created_at ASC`,
        [orderId]
      );
      if (itemsRes.rowCount > 0) {
        subtotal = 0;
        items = itemsRes.rows.map((row) => {
          const itemName = row.qty > 1 ? `${row.name} x${row.qty}` : row.name;
          const lineTotal =
            row.line_total_usd != null
              ? Number(row.line_total_usd)
              : Number(row.unit_price_usd || 0) * Number(row.qty || 0);
          subtotal += Number.isFinite(lineTotal) ? lineTotal : 0;
          return {
            name: itemName,
            price: row.line_total_usd,
          };
        });
        subtotal = Number(subtotal.toFixed(2));
      }
    } catch (err) {
      console.error("Receipt items query failed", err);
    }

    if (items.length === 0) {
      items = [{ name: order.product_name, price: order.product_price }];
      subtotal = Number(order.unit_price_at_purchase || order.product_price || 0);
    }

    try {
      const commissionRes = await pool.query(
        `SELECT c.amount, u.telegram_username, u.telegram_id
         FROM commissions c
         JOIN affiliates a ON a.id = c.affiliate_id
         JOIN users u ON u.id = a.user_id
         WHERE c.order_id = $1`,
        [orderId]
      );
      if (commissionRes.rowCount > 0) {
        const row = commissionRes.rows[0];
        commissionAmount = Number(row.amount || 0);
        const adminIds = parseAdminTelegramIds();
        const adminId = adminIds.length > 0 ? adminIds[0] : null;
        const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
        const isPlaceholderAffiliate =
          row.telegram_id === 90000000000 || row.telegram_username === "admin_affiliate";
        if (isPlaceholderAffiliate) {
          referredBy = adminUsername
            ? `@${adminUsername}`
            : adminId
            ? String(adminId)
            : "N/A";
        } else {
          referredBy = row.telegram_username
            ? `@${row.telegram_username}`
            : row.telegram_id
            ? String(row.telegram_id)
            : "N/A";
        }
      }
    } catch (err) {
      console.error("Receipt commission query failed", err);
    }

    const orderNumberText = order.order_number
      ? String(order.order_number).padStart(5, "0")
      : "-";

    let localTotal = null;
    try {
      const localData = await calculateLocalAmount(subtotal, order.payment_method);
      if (localData) {
        localTotal = {
          currency: localData.currency,
          amount: localData.amount,
        };
      }
    } catch (err) {
      console.error("Failed to calculate local total", err);
    }
    const totalsWithMarkup = await resolveTotalsWithMarkup(
      pool,
      subtotal,
      order.payment_method,
      localTotal
    );

    const receiptPng = await renderReceiptPng({
      orderId: order.id,
      orderNumber: orderNumberText,
      telegramId: order.telegram_id,
      username: order.telegram_username,
      dateTime: formatBogotaDate(order.paid_at || new Date()),
      items,
      subtotal: totalsWithMarkup.subtotalUsd,
      commission: commissionAmount,
      total: totalsWithMarkup.totalUsd,
      referredBy,
      localTotal: totalsWithMarkup.localTotal,
      locale: "es",
    });

    try {
      const buffer = await fs.readFile(receiptPng.pngPath);
      const filename = `recibo-${orderNumberText}.png`;
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } finally {
      await receiptPng.cleanup();
    }
  } catch (error) {
    return next(error);
  }
});

router.get("/summary", async (req, res, next) => {
  const pool = getPool();
  await ensureFreeOrderSchema(pool);

  try {
    const newOrdersRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       LEFT JOIN order_payments op ON op.order_id = o.id
       WHERE o.status = 'WAITING_PAYMENT'
         AND COALESCE(o.is_test, false) = false
         AND (
           (op.id IS NOT NULL AND op.review_status = 'PENDING')
           OR (
             op.id IS NULL
             AND (
               o.free_order_number IS NOT NULL
               OR COALESCE(o.unit_price_at_purchase, 0) <= 0
             )
           )
         )`
    );

    const customersRes = await pool.query(
       `SELECT COUNT(DISTINCT o.user_id)::int AS count
       FROM orders o
       WHERE o.status IN ('PAID', 'DELIVERED')
         AND COALESCE(o.is_test, false) = false`
    );

    const usersTotalRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users`
    );

    const salesRes = await pool.query(
       `SELECT COUNT(*)::int AS count
       FROM orders o
       WHERE o.status IN ('PAID', 'DELIVERED')
         AND COALESCE(o.is_test, false) = false`
    );

    const revenueRes = await pool.query(
       `SELECT COALESCE(SUM(oi.line_total_usd), 0)::numeric AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status IN ('PAID', 'DELIVERED')
         AND COALESCE(o.is_test, false) = false`
    );

    const productsRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM products
       WHERE is_active = true`
    );

    const unreadTicketsRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tickets t
       WHERE t.status = 'OPEN'
         AND NOT EXISTS (
           SELECT 1 FROM ticket_messages tm
           WHERE tm.ticket_id = t.id AND tm.sender = 'ADMIN'
         )`
    );

    const pendingPayoutsRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payouts
       WHERE status = 'REQUESTED'`
    );

    const affiliatesRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM affiliates`
    );

    const pendingAffiliatesRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM affiliates
       WHERE status = 'PENDING'`
    );

    return res.json({
      new_orders: newOrdersRes.rows[0]?.count || 0,
      users_total: usersTotalRes.rows[0]?.count || 0,
      customers: customersRes.rows[0]?.count || 0,
      total_sales: salesRes.rows[0]?.count || 0,
      total_revenue_usd: Number(revenueRes.rows[0]?.total || 0).toFixed(2),
      active_products: productsRes.rows[0]?.count || 0,
      unread_tickets: unreadTicketsRes.rows[0]?.count || 0,
      pending_payouts: pendingPayoutsRes.rows[0]?.count || 0,
      affiliates: affiliatesRes.rows[0]?.count || 0,
      pending_affiliates: pendingAffiliatesRes.rows[0]?.count || 0,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/stats/sales-insights", async (req, res, next) => {
  const pool = getPool();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const toIsoDate = (date) => date.toISOString().slice(0, 10);
  const utcDate = (date) => new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const startOfUtcWeek = (date) => {
    const base = utcDate(date);
    const offset = (base.getUTCDay() + 6) % 7;
    base.setUTCDate(base.getUTCDate() - offset);
    return base;
  };
  const addUtcMonths = (date, diff) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + diff, 1));
  const monthDiff = (newer, older) =>
    (newer.getUTCFullYear() - older.getUTCFullYear()) * 12
    + (newer.getUTCMonth() - older.getUTCMonth());
  const clampOffset = (rawValue, maxValue) => {
    const parsed = Number(rawValue);
    const normalized = Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : 0;
    return Math.min(normalized, Math.max(maxValue, 0));
  };

  try {
    const now = new Date();
    const currentDayStart = utcDate(now);
    const currentWeekStart = startOfUtcWeek(now);
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const firstSaleRes = await pool.query(
      `SELECT MIN(first_sale_at) AS first_sale_at
       FROM (
         SELECT COALESCE(o.paid_at, o.delivered_at, o.created_at) AS first_sale_at,
                COALESCE(
                  SUM(
                    COALESCE(
                      oi.line_total_usd,
                      COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
                    )
                  ),
                  0
                )::numeric AS revenue_usd
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE o.status IN ('PAID', 'DELIVERED')
           AND o.free_order_number IS NULL
           AND COALESCE(o.is_test, false) = false
         GROUP BY o.id, COALESCE(o.paid_at, o.delivered_at, o.created_at)
         HAVING COALESCE(
           SUM(
             COALESCE(
               oi.line_total_usd,
               COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
             )
           ),
           0
         ) > 0
       ) sales`
    );
    const firstSaleAtRaw = firstSaleRes.rows[0]?.first_sale_at || null;
    const firstSaleAt = firstSaleAtRaw ? new Date(firstSaleAtRaw) : null;

    const firstWeekStart = firstSaleAt ? startOfUtcWeek(firstSaleAt) : currentWeekStart;
    const firstMonthStart = firstSaleAt
      ? new Date(Date.UTC(firstSaleAt.getUTCFullYear(), firstSaleAt.getUTCMonth(), 1))
      : currentMonthStart;

    const monthMaxOffset = Math.max(monthDiff(currentMonthStart, firstMonthStart), 0);
    const weekMaxOffset = Math.max(
      Math.floor((currentWeekStart.getTime() - firstWeekStart.getTime()) / weekMs),
      0
    );

    const monthOffset = clampOffset(req.query?.month_offset, monthMaxOffset);
    const weekOffset = clampOffset(req.query?.week_offset, weekMaxOffset);

    const monthStart = addUtcMonths(currentMonthStart, -monthOffset);
    const monthEnd = addUtcMonths(monthStart, 1);
    const weekStart = new Date(currentWeekStart.getTime() - weekOffset * weekMs);
    const weekEnd = new Date(weekStart.getTime() + weekMs);
    const dayEnd = new Date(currentDayStart.getTime() + dayMs);

    const rangeSumQuery = async (start, end) =>
      pool.query(
        `SELECT COALESCE(
           SUM(
             COALESCE(
               oi.line_total_usd,
               COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
             )
           ),
           0
         )::numeric AS total
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE o.status IN ('PAID', 'DELIVERED')
           AND COALESCE(o.is_test, false) = false
           AND COALESCE(o.paid_at, o.delivered_at, o.created_at) >= $1
           AND COALESCE(o.paid_at, o.delivered_at, o.created_at) < $2`,
        [start.toISOString(), end.toISOString()]
      );

    const [todayRes, monthRes, weekRes, bestDayRes] = await Promise.all([
      rangeSumQuery(currentDayStart, dayEnd),
      rangeSumQuery(monthStart, monthEnd),
      rangeSumQuery(weekStart, weekEnd),
      pool.query(
        `SELECT day::text AS day,
                total::numeric AS total
         FROM (
           SELECT date_trunc('day', COALESCE(o.paid_at, o.delivered_at, o.created_at))::date AS day,
                  COALESCE(
                    SUM(
                      COALESCE(
                        oi.line_total_usd,
                        COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
                      )
                    ),
                    0
                  )::numeric AS total
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
           WHERE o.status IN ('PAID', 'DELIVERED')
             AND COALESCE(o.is_test, false) = false
           GROUP BY 1
         ) daily
         ORDER BY total DESC, day DESC
         LIMIT 1`
      ),
    ]);

    const bestDay = bestDayRes.rows[0] || null;

    return res.json({
      first_sale_date: firstSaleAt ? toIsoDate(firstSaleAt) : null,
      today_earnings_usd: Number(todayRes.rows[0]?.total || 0).toFixed(2),
      month: {
        offset: monthOffset,
        max_offset: monthMaxOffset,
        start_date: toIsoDate(monthStart),
        end_date: toIsoDate(new Date(monthEnd.getTime() - dayMs)),
        earnings_usd: Number(monthRes.rows[0]?.total || 0).toFixed(2),
        has_older: monthOffset < monthMaxOffset,
        has_newer: monthOffset > 0,
      },
      week: {
        offset: weekOffset,
        max_offset: weekMaxOffset,
        start_date: toIsoDate(weekStart),
        end_date: toIsoDate(new Date(weekEnd.getTime() - dayMs)),
        earnings_usd: Number(weekRes.rows[0]?.total || 0).toFixed(2),
        has_older: weekOffset < weekMaxOffset,
        has_newer: weekOffset > 0,
      },
      best_day: bestDay
        ? {
            date: bestDay.day || null,
            earnings_usd: Number(bestDay.total || 0).toFixed(2),
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/stats/top-products-month", async (req, res, next) => {
  const pool = getPool();
  const rawLimit = Number(req.query?.limit || 5);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 5;
  const rawMonthOffset = Number(req.query?.month_offset || 0);
  const monthOffsetRequested = Number.isFinite(rawMonthOffset)
    ? Math.max(Math.trunc(rawMonthOffset), 0)
    : 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const monthDiff = (newer, older) =>
    (newer.getUTCFullYear() - older.getUTCFullYear()) * 12
    + (newer.getUTCMonth() - older.getUTCMonth());
  const addUtcMonths = (date, diff) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + diff, 1));
  const toIsoDate = (date) => date.toISOString().slice(0, 10);

  try {
    const now = new Date();
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const firstSaleRes = await pool.query(
      `SELECT MIN(COALESCE(paid_at, delivered_at, created_at)) AS first_sale_at
       FROM orders
       WHERE status IN ('PAID', 'DELIVERED')
         AND COALESCE(is_test, false) = false`
    );
    const firstSaleRaw = firstSaleRes.rows[0]?.first_sale_at || null;
    const firstSaleAt = firstSaleRaw ? new Date(firstSaleRaw) : null;
    const firstMonthStart = firstSaleAt
      ? new Date(Date.UTC(firstSaleAt.getUTCFullYear(), firstSaleAt.getUTCMonth(), 1))
      : currentMonthStart;

    const monthMaxOffset = Math.max(monthDiff(currentMonthStart, firstMonthStart), 0);
    const monthOffset = Math.min(monthOffsetRequested, monthMaxOffset);
    const monthStart = addUtcMonths(currentMonthStart, -monthOffset);
    const monthEnd = addUtcMonths(monthStart, 1);

    const topProductsRes = await pool.query(
      `SELECT
         COALESCE(oi.product_id::text, '') AS product_id,
         COALESCE(p.name, 'Producto eliminado') AS name,
         COALESCE(SUM(COALESCE(oi.qty, 1)), 0)::int AS sold_count,
         COUNT(DISTINCT oi.order_id)::int AS orders_count,
         COALESCE(
           SUM(
             COALESCE(
               oi.line_total_usd,
               COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
             )
           ),
           0
         )::numeric AS revenue_usd
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.status IN ('PAID', 'DELIVERED')
         AND COALESCE(o.is_test, false) = false
         AND COALESCE(o.paid_at, o.delivered_at, o.created_at) >= $1
         AND COALESCE(o.paid_at, o.delivered_at, o.created_at) < $2
       GROUP BY oi.product_id, p.name
       ORDER BY sold_count DESC, orders_count DESC, revenue_usd DESC, name ASC
       LIMIT $3`,
      [monthStart.toISOString(), monthEnd.toISOString(), limit]
    );

    return res.json({
      month_start_date: toIsoDate(monthStart),
      month_end_date: toIsoDate(new Date(monthEnd.getTime() - dayMs)),
      month_offset: monthOffset,
      month_max_offset: monthMaxOffset,
      limit,
      items: topProductsRes.rows.map((row) => ({
        product_id: row.product_id || null,
        name: row.name,
        sold_count: Number(row.sold_count || 0),
        orders_count: Number(row.orders_count || 0),
        revenue_usd: Number(row.revenue_usd || 0).toFixed(2),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

function formatDateDmy(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function buildSalesExportRows(pool, query = {}) {
  const periodRaw = String(query?.period || "month").trim().toLowerCase();
  const period = periodRaw === "week" ? "week" : "month";
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const toIsoDate = (date) => date.toISOString().slice(0, 10);
  const utcDate = (date) => new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const startOfUtcWeek = (date) => {
    const base = utcDate(date);
    const offset = (base.getUTCDay() + 6) % 7;
    base.setUTCDate(base.getUTCDate() - offset);
    return base;
  };
  const addUtcMonths = (date, diff) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + diff, 1));
  const monthDiff = (newer, older) =>
    (newer.getUTCFullYear() - older.getUTCFullYear()) * 12
    + (newer.getUTCMonth() - older.getUTCMonth());
  const clampOffset = (rawValue, maxValue) => {
    const parsed = Number(rawValue);
    const normalized = Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : 0;
    return Math.min(normalized, Math.max(maxValue, 0));
  };

  const now = new Date();
  const currentWeekStart = startOfUtcWeek(now);
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const firstSaleRes = await pool.query(
    `SELECT MIN(first_sale_at) AS first_sale_at
     FROM (
       SELECT COALESCE(o.paid_at, o.delivered_at, o.created_at) AS first_sale_at,
              COALESCE(
                SUM(
                  COALESCE(
                    oi.line_total_usd,
                    COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
                  )
                ),
                0
              )::numeric AS revenue_usd
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.status IN ('PAID', 'DELIVERED')
         AND o.free_order_number IS NULL
       GROUP BY o.id, COALESCE(o.paid_at, o.delivered_at, o.created_at)
       HAVING COALESCE(
         SUM(
           COALESCE(
             oi.line_total_usd,
             COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
           )
         ),
         0
       ) > 0
     ) sales`
  );

  const firstSaleRaw = firstSaleRes.rows[0]?.first_sale_at || null;
  const firstSaleAt = firstSaleRaw ? new Date(firstSaleRaw) : null;
  const firstWeekStart = firstSaleAt ? startOfUtcWeek(firstSaleAt) : currentWeekStart;
  const firstMonthStart = firstSaleAt
    ? new Date(Date.UTC(firstSaleAt.getUTCFullYear(), firstSaleAt.getUTCMonth(), 1))
    : currentMonthStart;

  const monthMaxOffset = Math.max(monthDiff(currentMonthStart, firstMonthStart), 0);
  const weekMaxOffset = Math.max(
    Math.floor((currentWeekStart.getTime() - firstWeekStart.getTime()) / weekMs),
    0
  );

  const monthOffset = clampOffset(query?.month_offset, monthMaxOffset);
  const weekOffset = clampOffset(query?.week_offset, weekMaxOffset);

  let rangeStart;
  let rangeEnd;
  if (period === "week") {
    rangeStart = new Date(currentWeekStart.getTime() - weekOffset * weekMs);
    rangeEnd = new Date(rangeStart.getTime() + weekMs);
  } else {
    rangeStart = addUtcMonths(currentMonthStart, -monthOffset);
    rangeEnd = addUtcMonths(rangeStart, 1);
  }

  const rowsRes = await pool.query(
    `SELECT o.id,
            o.order_number,
            CASE
              WHEN o.status = 'DELIVERED' THEN 'ENTREGADA'
              WHEN o.status = 'PAID' THEN 'PAGADA'
              ELSE o.status::text
            END AS status_label,
            COALESCE(o.paid_at, o.delivered_at, o.created_at) AS paid_at,
            u.telegram_id,
            u.telegram_username,
            COALESCE(SUM(COALESCE(oi.qty, 1)), 0)::int AS sold_units,
            COALESCE(
              SUM(
                COALESCE(
                  oi.line_total_usd,
                  COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
                )
              ),
              0
            )::numeric AS revenue_usd,
            COALESCE(
              string_agg(
                CASE
                  WHEN COALESCE(oi.qty, 1) > 1
                    THEN COALESCE(p.name, 'Producto') || ' x' || COALESCE(oi.qty, 1)::text
                  ELSE COALESCE(p.name, 'Producto')
                END,
                ' | '
                ORDER BY COALESCE(p.name, 'Producto')
              ),
              ''
            ) AS products
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON p.id = oi.product_id
     LEFT JOIN users u ON u.id = o.user_id
     WHERE o.status IN ('PAID', 'DELIVERED')
       AND o.free_order_number IS NULL
       AND COALESCE(o.paid_at, o.delivered_at, o.created_at) >= $1
       AND COALESCE(o.paid_at, o.delivered_at, o.created_at) < $2
     GROUP BY o.id,
              o.order_number,
              CASE
                WHEN o.status = 'DELIVERED' THEN 'ENTREGADA'
                WHEN o.status = 'PAID' THEN 'PAGADA'
                ELSE o.status::text
              END,
              COALESCE(o.paid_at, o.delivered_at, o.created_at),
              u.telegram_id,
              u.telegram_username
     HAVING COALESCE(
       SUM(
         COALESCE(
           oi.line_total_usd,
           COALESCE(oi.unit_price_usd, p.price, 0) * COALESCE(oi.qty, 1)
         )
       ),
       0
     ) > 0
     ORDER BY paid_at ASC, o.id ASC`,
    [rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const normalizedRows = rowsRes.rows.map((row) => {
    const revenueUsd = Number(row.revenue_usd || 0);
    return {
      periodo: `${formatDateDmy(rangeStart)} - ${formatDateDmy(new Date(rangeEnd.getTime() - dayMs))}`,
      fecha: formatDateDmy(row.paid_at),
      referencia: row.order_number != null ? String(row.order_number).padStart(5, "0") : "",
      order_id: row.id,
      estado: row.status_label,
      telegram_id: row.telegram_id || "",
      username: row.telegram_username || "",
      ventas: Number(row.sold_units || 0),
      ingreso_usd: `$${revenueUsd.toFixed(2)}`,
      productos: row.products || "",
      _revenue_numeric: revenueUsd,
    };
  });

  return {
    period,
    rangeStart,
    rangeEnd,
    rows: normalizedRows,
    startDate: toIsoDate(rangeStart),
    endDate: toIsoDate(new Date(rangeEnd.getTime() - dayMs)),
  };
}

router.get("/stats/sales-export.csv", async (req, res, next) => {
  const pool = getPool();
  const csvCell = (value) => {
    const text = String(value ?? "");
    if (text.includes('"') || text.includes(",") || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  try {
    const exportData = await buildSalesExportRows(pool, req.query || {});
    if (!exportData.rows.length) {
      return res.status(404).json({
        error: "NO_SALES_FOR_PERIOD",
        period: exportData.period,
        start_date: exportData.startDate,
        end_date: exportData.endDate,
      });
    }

    const header = [
      "periodo",
      "fecha",
      "referencia",
      "order_id",
      "estado",
      "telegram_id",
      "username",
      "ventas",
      "ingreso_usd",
      "productos",
    ];
    const lines = [header.map(csvCell).join(",")];
    let totalRevenue = 0;

    for (const row of exportData.rows) {
      totalRevenue += Number(row._revenue_numeric || 0);
      lines.push(
        [
          row.periodo,
          row.fecha,
          row.referencia,
          row.order_id,
          row.estado,
          row.telegram_id,
          row.username,
          row.ventas,
          row.ingreso_usd,
          row.productos,
        ].map(csvCell).join(",")
      );
    }

    lines.push(
      [
        "TOTAL GANANCIAS",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        `$${totalRevenue.toFixed(2)}`,
        "",
      ].map(csvCell).join(",")
    );

    const filenamePeriod = exportData.period === "week" ? "semana" : "mes";
    const filename = `ganancias-${filenamePeriod}-${exportData.startDate}.csv`;
    const csv = `\ufeff${lines.join("\n")}`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error) {
    return next(error);
  }
});

router.get("/stats/sales-export.xlsx", async (req, res, next) => {
  const pool = getPool();
  try {
    const exportData = await buildSalesExportRows(pool, req.query || {});
    if (!exportData.rows.length) {
      return res.status(404).json({
        error: "NO_SALES_FOR_PERIOD",
        period: exportData.period,
        start_date: exportData.startDate,
        end_date: exportData.endDate,
      });
    }

    const rows = [
      [
        "periodo",
        "fecha",
        "referencia",
        "order_id",
        "estado",
        "telegram_id",
        "username",
        "ventas",
        "ingreso_usd",
        "productos",
      ],
    ];

    let totalRevenue = 0;
    for (const row of exportData.rows) {
      totalRevenue += Number(row._revenue_numeric || 0);
      rows.push([
        row.periodo,
        row.fecha,
        row.referencia,
        row.order_id,
        row.estado,
        row.telegram_id,
        row.username,
        row.ventas,
        row.ingreso_usd,
        row.productos,
      ]);
    }

    rows.push(["TOTAL GANANCIAS", "", "", "", "", "", "", "", `$${totalRevenue.toFixed(2)}`, ""]);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Ganancias");
    worksheet.addRows(rows);
    const buffer = await workbook.xlsx.writeBuffer();

    const filenamePeriod = exportData.period === "week" ? "semana" : "mes";
    const filename = `ganancias-${filenamePeriod}-${exportData.startDate}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.post("/stats/reset", async (req, res, next) => {
  const confirm = req.body?.confirm ? String(req.body.confirm).trim() : "";
  const normalized = confirm.toLowerCase();
  if (normalized !== "reset" && normalized !== "reiniciar") {
    return res.status(400).json({ error: "CONFIRM_REQUIRED" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE orders
       SET status = 'CANCELLED',
           paid_at = NULL,
           delivered_at = NULL,
           order_number = NULL,
           free_order_number = NULL`
    );

    await client.query(
      `UPDATE product_stock_units
       SET status = 'AVAILABLE',
           held_by_order_id = NULL,
           held_by_telegram_id = NULL,
           held_by_username = NULL,
           held_at = NULL,
           updated_at = now()
       WHERE status = 'HELD'`
    );

    await client.query(
      `UPDATE product_stock_holds
       SET status = 'EXPIRED',
           expires_at = now(),
           updated_at = now()
       WHERE status = 'HELD'`
    );

    await client.query("DELETE FROM payouts");
    await client.query("DELETE FROM commissions");
    await client.query("DELETE FROM payout_adjustments");
    await client.query("DELETE FROM affiliate_adjustments");
    await client.query("DELETE FROM affiliate_invoices");
    await client.query("DELETE FROM order_payments");
    await client.query("DELETE FROM order_items");
    await client.query("DELETE FROM ticket_messages");
    await client.query("DELETE FROM tickets");
    await client.query("DELETE FROM broadcasts");
    await client.query("SELECT setval('orders_order_number_seq', 1, false)");
    await client.query("SELECT setval('orders_free_order_number_seq', 1, false)");

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, meta)
       VALUES ($1, $2, $3::jsonb)`,
      ["STATS_RESET", "stats", JSON.stringify({ confirm })]
    );

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/orders/:id/mark-paid", async (req, res, next) => {
  const { ref: orderLookupRef, orderNumber: orderLookupNumber } =
    parseOrderLookupRef(req.params.id);
  if (!orderLookupRef) {
    return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
  }
  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);
  const client = await pool.connect();
  let affiliateLevelBefore = null;
  let commissionInserted = false;
  try {
    await client.query("BEGIN");
    const resolvedOrderId = await resolveOrderLookupId(
      client,
      orderLookupRef,
      orderLookupNumber
    );
    if (!resolvedOrderId) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const orderRes = await client.query(
      `SELECT o.*, u.telegram_id, u.telegram_username,
              p.name AS product_name,
              p.price AS product_price,
              p.image_url AS product_image_url,
              p.delivery_type,
              p.delivery_payload,
              p.delivery_template,
              p.stock_mode,
              op.payment_method
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN products p ON p.id = o.product_id
       LEFT JOIN order_payments op ON op.order_id = o.id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [resolvedOrderId]
    );

    if (orderRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const order = orderRes.rows[0];
    const orderId = order.id;
    const isFreeOrder = isFreeOrderRow(order);

    if (order.status !== "WAITING_PAYMENT") {
      await client.query("ROLLBACK");
      if (order.status === "PAID" && !order.delivered_at) {
        console.log("[admin/approve] retry_delivery", { order_id: orderId });
        const deliveryResult = isTestOrderRow(order)
          ? await deliverTestOrderToTelegram(order)
          : await deliverOrderToTelegram({
            dbClient: pool,
            orderId: order.id,
            telegramId: order.telegram_id,
          });
        if (deliveryResult.delivered) {
          await pool.query(
            `UPDATE orders
             SET status = 'DELIVERED',
                 delivered_at = now(),
                 test_cleanup_after = CASE
                   WHEN is_test THEN now() + ($2 * interval '1 second')
                   ELSE test_cleanup_after
                 END
             WHERE id = $1`,
            [order.id, getTestOrderCleanupSeconds()]
          );
        }
        return res.json({
          status: "delivery_retry",
          delivered: Boolean(deliveryResult.delivered),
          delivery_error: deliveryResult.error || null,
        });
      }
      console.log("[admin/approve] already_finalized", {
        order_id: orderId,
        status: order.status,
      });
      return res.status(409).json({ error: "ORDER_ALREADY_FINALIZED" });
    }

    const paymentRes = await client.query(
      "SELECT * FROM order_payments WHERE order_id = $1",
      [orderId]
    );

    if (paymentRes.rowCount === 0 && !isFreeOrder) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "NO_PAYMENT_PROOF" });
    }

    if (!isTestOrderRow(order)) {
      try {
        await consumeStockForOrder(client, order.id);
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "INSUFFICIENT_STOCK") {
          return res.status(409).json({
            ok: false,
            code: "INSUFFICIENT_STOCK",
            message: "Stock insuficiente para aprobar la orden.",
            available: error.available ?? null,
          });
        }
        throw error;
      }
      console.log("[admin/approve] consumed_stock", { order_id: orderId });
    }

    if (!isFreeOrder && !isTestOrderRow(order)) {
      await ensureOrderNumberForOrder(client, orderId);
    }

    const updatedOrderRes = await client.query(
      `UPDATE orders
       SET status = 'PAID',
           paid_at = now(),
           order_number = CASE
             WHEN is_test THEN NULL
             ELSE order_number
           END
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );

    if (paymentRes.rowCount > 0) {
      await client.query(
        `UPDATE order_payments
         SET review_status = 'APPROVED', reviewed_by_admin_at = now()
         WHERE order_id = $1`,
        [orderId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "ORDER_MARK_PAID",
        "order",
        orderId,
        JSON.stringify({ admin: req.admin?.sub || null }),
      ]
    );

    if (order.affiliate_id && !isTestOrderRow(order)) {
      const statsRes = await client.query(
        `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS sales_count,
                COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0) AS earnings_total,
                MAX(c.earned_at) AS last_sale_at
         FROM commissions c
         LEFT JOIN (
           SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
           FROM order_items
           GROUP BY order_id
         ) oi ON oi.order_id = c.order_id
         WHERE c.affiliate_id = $1
           AND c.status != 'REFUNDED'`,
        [order.affiliate_id]
      );
      const stats = statsRes.rows[0] || {};
      const salesTotal = stats.sales_count || 0;
      const earningsTotal = Number(stats.earnings_total || 0);
      const boostRes = await client.query(
        "SELECT commission_rate FROM affiliates WHERE id = $1",
        [order.affiliate_id]
      );
      const boostRate = Number(boostRes.rows[0]?.commission_rate || 0);
      let daysSinceLastSale = null;
      if (stats.last_sale_at) {
        const lastSaleTime = new Date(stats.last_sale_at).getTime();
        daysSinceLastSale = Math.max(
          Math.floor((Date.now() - lastSaleTime) / (24 * 60 * 60 * 1000)),
          0
        );
      }
      let baseRate = 0.2;
      let boostEffective = boostRate;
      affiliateLevelBefore = getAffiliateLevel({
        salesTotal,
        earningsTotal,
        daysSinceLastSale,
      });
      if (salesTotal > 0) {
        baseRate = affiliateLevelBefore.rate;
      } else {
        boostEffective = 0;
      }
      const rate = Math.min(baseRate + boostEffective, 1);
      const amount = Number(
        (Number(order.unit_price_at_purchase) * rate).toFixed(2)
      );

      const commissionInsertRes = await client.query(
        `INSERT INTO commissions (order_id, affiliate_id, rate, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, order.affiliate_id, rate, amount]
      );
      commissionInserted = commissionInsertRes.rowCount > 0;

      if (commissionInserted && amount > 0) {
        const debtRes = await client.query(
          `SELECT affiliate_debt
           FROM affiliates
           WHERE id = $1
           FOR UPDATE`,
          [order.affiliate_id]
        );
        const debt = Number(debtRes.rows[0]?.affiliate_debt || 0);
        const appliedDebt = Math.min(debt, amount);
        if (appliedDebt > 0) {
          await client.query(
            `UPDATE affiliates
             SET affiliate_debt = affiliate_debt - $2
             WHERE id = $1`,
            [order.affiliate_id, appliedDebt]
          );
          await client.query(
            `INSERT INTO affiliate_adjustments
              (affiliate_id, amount, reason, status, created_by_admin_id)
             VALUES ($1, $2, $3, 'EARNED', NULL)`,
            [
              order.affiliate_id,
              -Number(appliedDebt.toFixed(2)),
              "Pago automatico de deuda",
            ]
          );
        }
      }

      // Commission rate is based on level + optional boost, no per-affiliate override.
    }

    await client.query("COMMIT");

    await updateAdminOrderNotifications(pool, orderId);

    const telegramId = order.telegram_id;
    order.paid_at = updatedOrderRes.rows[0].paid_at;

    // Get user locale for receipt and notifications
    let userLocale = "es";
    try {
      const userRes = await pool.query(
        "SELECT locale FROM users WHERE telegram_id = $1",
        [telegramId]
      );
      if (userRes.rowCount > 0) {
        userLocale = userRes.rows[0].locale || "es";
      }
    } catch (err) {
      console.error("Failed to get user locale", err);
    }

    try {
      const freeApprovedMessage =
        userLocale === "en"
          ? (
            "🎁 <b>Thank you for trusting us</b>\n\n" +
            "✅ Your free order was approved.\n" +
            "📦 You will receive your content shortly.\n\n" +
            "💬 If you liked the experience,\n" +
            "please recommend us to your friends.\n\n" +
            "🙏 Your support helps us keep growing."
          )
          : (
            "🎁 <b>¡Gracias por confiar en nosotros!</b>\n\n" +
            "✅ Tu orden gratis fue aprobada.\n" +
            "📦 En breve recibirás tu contenido.\n\n" +
            "💬 Si te gustó la experiencia,\n" +
            "recomiéndanos con tus amigos.\n\n" +
            "🙏 Tu apoyo nos ayuda a seguir creciendo."
          );
      await sendMessage(
        telegramId,
        isFreeOrder
          ? freeApprovedMessage
          : (MESSAGES[userLocale]?.payment_received || MESSAGES.es.payment_received),
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("Telegram congratulations failed", err);
    }

    if (order.affiliate_id && !isTestOrderRow(order)) {
      try {
        const affiliateUserRes = await pool.query(
          `SELECT u.telegram_id
           FROM affiliates a
           JOIN users u ON u.id = a.user_id
           WHERE a.id = $1`,
          [order.affiliate_id]
        );
        if (affiliateUserRes.rowCount > 0) {
          const affiliateTelegramId = affiliateUserRes.rows[0].telegram_id;
          try {
            const commissionRes = await pool.query(
              `SELECT amount
               FROM commissions
               WHERE order_id = $1
                 AND affiliate_id = $2`,
              [orderId, order.affiliate_id]
            );
            if (commissionRes.rowCount > 0) {
              const commissionAmount = Number(commissionRes.rows[0].amount || 0);
              if (commissionAmount > 0) {
                const orderNumberText = formatOrderNumberForAdmin(updatedOrderRes.rows[0]);
                const commissionMessage =
                  "🎉 ¡Nueva comisión generada!\n\n" +
                  "Un cliente realizó una compra usando tu enlace de afiliado y ha sido aprobada ✅\n\n" +
                  `💵 Comisión obtenida: $${commissionAmount.toFixed(2)} USD\n` +
                  `🆔 ID de orden: ${orderNumberText}\n\n` +
                  "Sigue compartiendo tu enlace y aumenta tus ganancias 🚀";
                await sendMessage(affiliateTelegramId, commissionMessage);
              }
            }
          } catch (err) {
            console.error("Affiliate commission notification failed", err);
          }
          if (commissionInserted && affiliateLevelBefore) {
            const levelStatsRes = await pool.query(
              `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS sales_count,
                      COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0) AS earnings_total,
                      MAX(c.earned_at) AS last_sale_at
               FROM commissions c
               LEFT JOIN (
                 SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
                 FROM order_items
                 GROUP BY order_id
               ) oi ON oi.order_id = c.order_id
               WHERE c.affiliate_id = $1
                 AND c.status != 'REFUNDED'`,
              [order.affiliate_id]
            );
            const levelStats = levelStatsRes.rows[0] || {};
            const newSalesTotal = Number(levelStats.sales_count || 0);
            const newEarningsTotal = Number(levelStats.earnings_total || 0);
            let newDaysSinceLastSale = null;
            if (levelStats.last_sale_at) {
              const lastSaleTime = new Date(levelStats.last_sale_at).getTime();
              newDaysSinceLastSale = Math.max(
                Math.floor((Date.now() - lastSaleTime) / (24 * 60 * 60 * 1000)),
                0
              );
            }
            const affiliateLevelAfter = getAffiliateLevel({
              salesTotal: newSalesTotal,
              earningsTotal: newEarningsTotal,
              daysSinceLastSale: newDaysSinceLastSale,
            });
            if (affiliateLevelAfter.index > affiliateLevelBefore.index) {
              const rankMessage = buildAffiliateRankUpMessage(affiliateLevelAfter.key);
              if (rankMessage) {
                await sendMessage(affiliateTelegramId, rankMessage, {
                  parse_mode: "HTML",
                });
              }
            }
          }
        }
      } catch (err) {
        console.error("Affiliate rank notification failed", err);
      }
    }

    if (!isFreeOrder && !isTestOrderRow(order)) {
      let receipt = "";
      try {
        let items = [];
        let subtotal = Number(order.unit_price_at_purchase || 0);
        let commissionAmount = 0;
        let referredBy = "N/A";
        try {
          const itemsRes = await pool.query(
            `SELECT
               p.name,
               oi.qty,
               oi.unit_price_usd,
               oi.line_total_usd
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             WHERE oi.order_id = $1
             ORDER BY oi.created_at ASC`,
            [orderId]
          );
          if (itemsRes.rowCount > 0) {
            subtotal = 0;
            items = itemsRes.rows.map((row) => {
              const itemName = row.qty > 1 ? `${row.name} x${row.qty}` : row.name;
              const lineTotal =
                row.line_total_usd != null
                  ? Number(row.line_total_usd)
                  : Number(row.unit_price_usd || 0) * Number(row.qty || 0);
              subtotal += Number.isFinite(lineTotal) ? lineTotal : 0;
              return {
                name: itemName,
                price: row.line_total_usd,
              };
            });
            subtotal = Number(subtotal.toFixed(2));
          }
        } catch (err) {
          console.error("Receipt items query failed", err);
        }

        if (items.length === 0) {
          items = [{ name: order.product_name, price: order.product_price }];
          subtotal = Number(order.unit_price_at_purchase || order.product_price || 0);
        }

        try {
          const commissionRes = await pool.query(
            `SELECT c.amount, u.telegram_username, u.telegram_id
             FROM commissions c
             JOIN affiliates a ON a.id = c.affiliate_id
             JOIN users u ON u.id = a.user_id
             WHERE c.order_id = $1`,
            [orderId]
          );
          if (commissionRes.rowCount > 0) {
            const row = commissionRes.rows[0];
            commissionAmount = Number(row.amount || 0);
            const adminIds = parseAdminTelegramIds();
            const adminId = adminIds.length > 0 ? adminIds[0] : null;
            const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
            const isPlaceholderAffiliate =
              row.telegram_id === 90000000000 || row.telegram_username === "admin_affiliate";
            if (isPlaceholderAffiliate) {
              referredBy = adminUsername ? `@${adminUsername}` : adminId ? String(adminId) : "N/A";
            } else {
              referredBy = row.telegram_username
                ? `@${row.telegram_username}`
                : row.telegram_id
                ? String(row.telegram_id)
                : "N/A";
            }
          }
        } catch (err) {
          console.error("Receipt commission query failed", err);
        }

        const orderNumberText = order.order_number
          ? String(order.order_number).padStart(5, "0")
          : "-";

        // Calculate local amount for receipt
        let localTotal = null;
        try {
          const localData = await calculateLocalAmount(subtotal, order.payment_method);
          if (localData) {
            localTotal = {
              currency: localData.currency,
              amount: localData.amount,
            };
          }
        } catch (err) {
          console.error("Failed to calculate local total", err);
        }
        const totalsWithMarkup = await resolveTotalsWithMarkup(
          pool,
          subtotal,
          order.payment_method,
          localTotal
        );

        receipt = buildReceiptMessage(
          order,
          paymentRes.rows[0],
          userLocale,
          totalsWithMarkup.subtotalUsd,
          totalsWithMarkup.totalUsd,
          totalsWithMarkup.localTotal,
          totalsWithMarkup.markupPercent,
          commissionAmount,
          referredBy
        );

        const receiptPng = await renderReceiptPng({
          orderId: order.id,
          orderNumber: orderNumberText,
          telegramId,
          username: order.telegram_username,
          dateTime: formatBogotaDate(order.paid_at || new Date()),
          items,
          subtotal: totalsWithMarkup.subtotalUsd,
          commission: commissionAmount,
          total: totalsWithMarkup.totalUsd,
          referredBy,
          localTotal: totalsWithMarkup.localTotal,
          locale: userLocale,
        });

        try {
          try {
            await sendPhoto(telegramId, { path: receiptPng.pngPath });
          } catch (photoError) {
            console.error("Telegram receipt photo failed", photoError);
            await sendDocument(telegramId, { path: receiptPng.pngPath });
          }
        } finally {
          await receiptPng.cleanup();
        }
      } catch (err) {
        console.error("Telegram receipt failed", err);
        if (
          err
          && (
            err.message === "playwright_not_installed"
            || String(err.message || "").toLowerCase().includes("executable doesn't exist")
          )
        ) {
          console.error("Playwright browsers missing. Run: npx playwright install");
        }
        try {
          const fallbackReceipt =
            receipt
            || (
              userLocale === "en"
                ? "✅ Payment approved.\nYour receipt image could not be generated, but your order was processed successfully."
                : "✅ Pago aprobado.\nNo se pudo generar la imagen del recibo, pero tu orden fue procesada correctamente."
            );
          await sendMessage(telegramId, fallbackReceipt, { parse_mode: "HTML" });
        } catch (fallbackError) {
          console.error("Telegram receipt fallback failed", fallbackError);
        }
      }

      try {
        const notice =
          userLocale === "en"
            ? "⌚️ You will receive your content shortly."
            : "⌚️ En breve momento estarás recibiendo tu contenido.";
        await sendMessage(telegramId, notice);
      } catch (err) {
        console.error("Telegram content notice failed", err);
      }
    }

    if (isTestOrderRow(order)) {
      let deliveryResult = { delivered: false, error: null };
      try {
        deliveryResult = await deliverTestOrderToTelegram(order);
      } catch (error) {
        console.error("Test order delivery failed", error);
        deliveryResult = {
          delivered: false,
          error: error?.message || "TEST_DELIVERY_FAILED",
        };
      }

      const finalOrderRes = await pool.query(
        `UPDATE orders
         SET status = CASE
               WHEN $2::boolean THEN 'DELIVERED'::order_status
               ELSE status
             END,
             delivered_at = CASE
               WHEN $2::boolean THEN now()
               ELSE delivered_at
             END,
             test_cleanup_after = now() + ($3 * interval '1 second')
         WHERE id = $1
         RETURNING *`,
        [order.id, Boolean(deliveryResult.delivered), getTestOrderCleanupSeconds()]
      );
      await updateAdminOrderNotifications(pool, order.id);
      return res.json({
        ok: true,
        delivered: Boolean(deliveryResult.delivered),
        delivery_error: deliveryResult.error || null,
        test_order: true,
        order: finalOrderRes.rows[0] || updatedOrderRes.rows[0],
      });
    }

    console.log("[order-delivery] scheduled", {
      orderId: order.id,
      delayMs: DELIVERY_START_DELAY_MS,
    });
    setTimeout(async () => {
      console.log("[order-delivery] starting", { orderId: order.id });
      try {
        const deliveryResult = await deliverOrderToTelegram({
          dbClient: pool,
          orderId: order.id,
          telegramId,
        });
        if (deliveryResult.delivered) {
          await pool.query(
            `UPDATE orders
             SET status = 'DELIVERED', delivered_at = now()
             WHERE id = $1`,
            [order.id]
          );
        } else {
          console.error(
            "[order/delivery] failed:",
            deliveryResult.error || "DELIVERY_FAILED"
          );
        }
      } catch (error) {
        console.error("Telegram delivery failed", error);
      }
    }, DELIVERY_START_DELAY_MS);

    return res.json({ order: updatedOrderRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/orders/:id/refund", async (req, res, next) => {
  const { ref: orderLookupRef, orderNumber: orderLookupNumber } =
    parseOrderLookupRef(req.params.id);
  if (!orderLookupRef) {
    return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
  }
  const { amount, reason } = req.body || {};
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureUserWalletSchema(client);
    const resolvedOrderId = await resolveOrderLookupId(
      client,
      orderLookupRef,
      orderLookupNumber
    );
    if (!resolvedOrderId) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const orderRes = await client.query(
      `SELECT o.*, u.telegram_id, u.telegram_username, u.locale
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [resolvedOrderId]
    );

    if (orderRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const order = orderRes.rows[0];
    const orderId = order.id;
    if (order.status !== "PAID" && order.status !== "DELIVERED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ORDER_NOT_REFUNDABLE" });
    }

    const orderTotal = await getOrderTotalUsd(
      client,
      orderId,
      order.unit_price_at_purchase || order.product_price
    );

    if (!orderTotal || orderTotal <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ORDER_TOTAL_INVALID" });
    }

    const alreadyRefunded = Number(order.refunded_amount || 0);
    const remaining = Number((orderTotal - alreadyRefunded).toFixed(2));
    if (remaining <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ORDER_ALREADY_REFUNDED" });
    }

    let refundAmount = remaining;
    if (amount !== undefined && amount !== null && amount !== "") {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "INVALID_REFUND_AMOUNT" });
      }
      refundAmount = Math.min(parsedAmount, remaining);
    }

    refundAmount = Number(refundAmount.toFixed(2));
    if (refundAmount <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "INVALID_REFUND_AMOUNT" });
    }

    const newRefundedAmount = Number((alreadyRefunded + refundAmount).toFixed(2));
    const fullyRefunded = newRefundedAmount >= orderTotal - 0.01;
    const refundType = fullyRefunded ? "FULL" : "PARTIAL";

    const commissionRes = await client.query(
      `SELECT c.*, a.user_id AS affiliate_user_id
       FROM commissions c
       JOIN affiliates a ON a.id = c.affiliate_id
       WHERE c.order_id = $1
       FOR UPDATE OF c`,
      [orderId]
    );

    let commissionRefunded = 0;
    let affiliateUserId = null;

    if (commissionRes.rowCount > 0) {
      const commission = commissionRes.rows[0];
      affiliateUserId = commission.affiliate_user_id;

      if (Number(commission.reserved_amount || 0) > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "COMMISSION_RESERVED" });
      }

      const commissionAmount = Number(commission.amount || 0);
      const currentRefunded = Number(commission.refunded_amount || 0);
      const refundRatio = refundAmount / orderTotal;
      const rawCommissionRefund = commissionAmount * refundRatio;
      const refundForCommission = Number(rawCommissionRefund.toFixed(2));
      const remainingCommission = Math.max(commissionAmount - currentRefunded, 0);
      const appliedRefund = Math.min(remainingCommission, refundForCommission);

      if (appliedRefund > 0) {
        commissionRefunded = Number(appliedRefund.toFixed(2));
        const updatedRefunded = Number((currentRefunded + commissionRefunded).toFixed(2));
        const commissionFullyRefunded = updatedRefunded >= commissionAmount - 0.01;

        await client.query(
          `UPDATE commissions
           SET refunded_amount = $2,
               refunded_at = now(),
               refund_reason = $3,
               status = CASE
                 WHEN $4 THEN 'REFUNDED'
                 ELSE status
               END
           WHERE id = $1`,
          [commission.id, updatedRefunded, reason || null, commissionFullyRefunded]
        );

        const paidOutAmount = Number(commission.paid_out_amount || 0);
        const refundDebt = Math.min(commissionRefunded, paidOutAmount);
        if (refundDebt > 0) {
          await client.query(
            `UPDATE affiliates
             SET affiliate_debt = affiliate_debt + $2
             WHERE id = $1`,
            [commission.affiliate_id, refundDebt]
          );
        }
      }
    }

    await client.query(
      `UPDATE orders
       SET refunded_amount = $2,
           refund_reason = $3,
           refunded_at = CASE WHEN $4 THEN now() ELSE refunded_at END,
           status = CASE WHEN $4 THEN 'REFUNDED' ELSE status END
       WHERE id = $1`,
      [orderId, newRefundedAmount, reason || null, fullyRefunded]
    );

    await client.query(
      `INSERT INTO order_refunds (order_id, amount, refund_type, reason, refunded_by_admin)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, refundAmount, refundType, reason || null, req.admin?.sub || null]
    );

    const walletTx = await recordWalletTransaction(client, {
      userId: order.user_id,
      amount: refundAmount,
      direction: "CREDIT",
      transactionType: "ORDER_REFUND",
      referenceType: "order",
      referenceId: orderId,
      note: reason || `Reembolso ${refundType === "FULL" ? "completo" : "parcial"} de orden`,
      visibleToUser: true,
      createdByAdmin: req.admin?.sub || null,
    });

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "ORDER_REFUND",
        "order",
        orderId,
        JSON.stringify({
          admin: req.admin?.sub || null,
          amount: refundAmount,
          refund_type: refundType,
          commission_refund: commissionRefunded,
          wallet_balance_after: walletTx.wallet?.balance ?? null,
        }),
      ]
    );

    await client.query("COMMIT");

    const locale = order.locale || "es";
    const refundMessage =
      `✅ Tu reembolso fue acreditado a tu saldo interno.\n\n`
      + `💵 Monto: ${formatUsdWithCurrency(refundAmount)}\n`
      + `💰 Saldo actual: ${formatWalletUsd(walletTx.wallet?.balance)}`
      + (reason ? `\n📝 Motivo: ${reason}` : "");

    try {
      await sendMessage(order.telegram_id, refundMessage);
    } catch (err) {
      console.error("Customer refund notification failed", err);
    }

    if (affiliateUserId && commissionRefunded > 0) {
      try {
        const affiliateUserRes = await pool.query(
          "SELECT telegram_id, locale FROM users WHERE id = $1",
          [affiliateUserId]
        );
        if (affiliateUserRes.rowCount > 0) {
          const affiliateRow = affiliateUserRes.rows[0];
          const affiliateLocale = affiliateRow.locale || "es";
          const affiliateMessage =
            (AFFILIATE_MESSAGES[affiliateLocale]?.[
              fullyRefunded ? "refund_full" : "refund_partial"
            ] || AFFILIATE_MESSAGES.es[fullyRefunded ? "refund_full" : "refund_partial"])
              .replace("{amount}", formatUsdWithCurrency(commissionRefunded));
          await sendMessage(affiliateRow.telegram_id, affiliateMessage);
        }
      } catch (err) {
        console.error("Affiliate refund notification failed", err);
      }
    }

    return res.json({
      ok: true,
      refund: {
        order_id: orderId,
        amount: refundAmount,
        refund_type: refundType,
        commission_refund: commissionRefunded,
        fully_refunded: fullyRefunded,
      },
      wallet: walletTx.wallet,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/orders/:id/reject", async (req, res, next) => {
  const { ref: orderLookupRef, orderNumber: orderLookupNumber } =
    parseOrderLookupRef(req.params.id);
  if (!orderLookupRef) {
    return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
  }
  const { mode, reason } = req.body || {};
  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);
  const client = await pool.connect();

  if (!mode || (mode !== "retry" && mode !== "cancel")) {
    return res.status(400).json({ error: "INVALID_MODE" });
  }

  try {
    await client.query("BEGIN");
    const resolvedOrderId = await resolveOrderLookupId(
      client,
      orderLookupRef,
      orderLookupNumber
    );
    if (!resolvedOrderId) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const orderRes = await client.query(
      `SELECT o.*, u.telegram_id
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1
       FOR UPDATE`,
      [resolvedOrderId]
    );

    if (orderRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const orderRow = orderRes.rows[0];
    const isFreeOrder = isFreeOrderRow(orderRow);
    const orderId = orderRow.id;
    const paymentRes = await client.query(
      "SELECT * FROM order_payments WHERE order_id = $1",
      [orderId]
    );

    if (paymentRes.rowCount === 0 && !isFreeOrder) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "NO_PAYMENT_PROOF" });
    }

    const nextStatus = mode === "retry" ? "CREATED" : "CANCELLED";

    if (!isFreeOrder && nextStatus === "CANCELLED" && !isTestOrderRow(orderRow)) {
      await ensureOrderNumberForOrder(client, orderId);
    }

    const updatedOrderRes = await client.query(
      `UPDATE orders
       SET status = $2::order_status,
           cancelled_at = CASE WHEN $2::order_status = 'CANCELLED'::order_status THEN now() ELSE cancelled_at END,
           cancel_source = CASE WHEN $2::order_status = 'CANCELLED'::order_status THEN 'ADMIN' ELSE cancel_source END,
           order_number = CASE
             WHEN is_test THEN NULL
             ELSE order_number
           END,
           test_cleanup_after = CASE
             WHEN is_test THEN now() + ($3 * interval '1 second')
             ELSE test_cleanup_after
           END
       WHERE id = $1
       RETURNING *`,
      [orderId, nextStatus, getTestOrderCleanupSeconds()]
    );

    await releaseStockForOrder(client, orderId);

    if (paymentRes.rowCount > 0) {
      await client.query(
        `UPDATE order_payments
         SET review_status = 'REJECTED', reviewed_by_admin_at = now()
         WHERE order_id = $1`,
        [orderId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "ORDER_REJECT",
        "order",
        orderId,
        JSON.stringify({ admin: req.admin?.sub || null, mode }),
      ]
    );

    await client.query("COMMIT");

    await updateAdminOrderNotifications(pool, orderId);

    const telegramId = orderRow.telegram_id;
    const reasonText = reason ? `\nMotivo: ${reason}` : "";
    const message = isFreeOrder
      ? (
        mode === "retry"
          ? `Tu orden gratis fue enviada nuevamente a revisión.${reasonText}`
          : `Tu orden gratis fue rechazada. Contacta soporte.${reasonText}`
      )
      : (
        mode === "retry"
          ? `Tu pago fue rechazado. Envia una nueva Captura.${reasonText}`
          : `Tu orden fue cancelada. Contacta soporte.${reasonText}`
      );

    try {
      await sendMessage(telegramId, message);
    } catch (err) {
      console.error("Telegram notification failed", err);
    }

    return res.json({ order: updatedOrderRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/orders/:id/scam", async (req, res, next) => {
  const { ref: orderLookupRef, orderNumber: orderLookupNumber } =
    parseOrderLookupRef(req.params.id);
  if (!orderLookupRef) {
    return res.status(400).json({ error: "ORDER_ID_REQUIRED" });
  }
  const { reason } = req.body || {};
  const pool = getPool();
  await ensureFreeOrderSchema(pool);
  await ensureOrderNumberSchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const resolvedOrderId = await resolveOrderLookupId(
      client,
      orderLookupRef,
      orderLookupNumber
    );
    if (!resolvedOrderId) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const orderRes = await client.query(
      `SELECT o.*, u.telegram_id, u.telegram_username, u.locale
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [resolvedOrderId]
    );

    if (orderRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendOrderNotFound(res, pool, orderLookupNumber);
    }

    const order = orderRes.rows[0];
    const orderId = order.id;
    if (isFreeOrderRow(order)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ORDER_SCAM_FREE_NOT_ALLOWED" });
    }
    if (order.is_scam) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "ORDER_ALREADY_SCAM" });
    }
    if (["PAID", "DELIVERED", "REFUNDED"].includes(String(order.status || "").toUpperCase())) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "ORDER_SCAM_NOT_ALLOWED" });
    }

    const paymentRes = await client.query(
      `SELECT *
       FROM order_payments
       WHERE order_id = $1
       FOR UPDATE`,
      [orderId]
    );
    const paymentReviewStatus = String(paymentRes.rows[0]?.review_status || "").toUpperCase();
    if (paymentReviewStatus === "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "ORDER_SCAM_NOT_ALLOWED" });
    }

    await releaseStockForOrder(client, orderId);

    const releasedOrderNumber = !isTestOrderRow(order)
      ? (Number(order.order_number || 0) || null)
      : null;
    if (releasedOrderNumber) {
      await releaseOrderNumber(client, releasedOrderNumber, orderId, "SCAM");
    }

    const updatedOrderRes = await client.query(
      `UPDATE orders
       SET status = 'CANCELLED',
           cancelled_at = COALESCE(cancelled_at, now()),
           cancel_source = 'ADMIN',
           is_scam = true,
           scam_flagged_at = now(),
           scam_reason = $2,
           released_order_number = COALESCE(released_order_number, $3),
           order_number = NULL,
           test_cleanup_after = CASE
             WHEN is_test THEN now() + ($4 * interval '1 second')
             ELSE test_cleanup_after
           END
       WHERE id = $1
       RETURNING *`,
      [
        orderId,
        reason || "Marcada como estafa por admin.",
        releasedOrderNumber,
        getTestOrderCleanupSeconds(),
      ]
    );

    if (paymentRes.rowCount > 0) {
      await client.query(
        `UPDATE order_payments
         SET review_status = 'REJECTED',
             reviewed_by_admin_at = now()
         WHERE order_id = $1`,
        [orderId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "ORDER_SCAM",
        "order",
        orderId,
        JSON.stringify({
          admin: req.admin?.sub || null,
          reason: reason || null,
          released_order_number: releasedOrderNumber,
        }),
      ]
    );

    await client.query("COMMIT");

    await updateAdminOrderNotifications(pool, orderId);

    let notification = {
      sent: false,
      method: null,
      error: null,
    };
    try {
      await sendPhoto(order.telegram_id, {
        url: "https://i.ibb.co/ZDbLWHM/images.jpg",
        caption: buildScamCustomerNotification(order),
      });
      notification = {
        sent: true,
        method: "photo",
        error: null,
      };
    } catch (err) {
      console.error("Telegram scam notification failed", err);
      try {
        await sendMessage(order.telegram_id, buildScamCustomerNotification(order));
        notification = {
          sent: true,
          method: "text",
          error: err?.message || "PHOTO_SEND_FAILED",
        };
      } catch (fallbackErr) {
        console.error("Telegram scam notification fallback failed", fallbackErr);
        notification = {
          sent: false,
          method: null,
          error: fallbackErr?.message || err?.message || "SCAM_NOTIFICATION_FAILED",
        };
      }
    }

    return res.json({ order: updatedOrderRes.rows[0], notification });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/affiliates", async (req, res, next) => {
  const status = req.query.status;
  const { page, pageSize, offset } = parsePagination(req.query);
  const pool = getPool();

  const filters = [];
  const values = [];

  if (status) {
    values.push(status);
    filters.push(`a.status = $${values.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM affiliates a ${whereClause}`,
      values
    );
    const total = countRes.rows[0].total;

    const listRes = await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY approved_at, id) AS affiliate_number
         FROM affiliates
         WHERE approved_at IS NOT NULL
       )
       SELECT a.id, a.status, a.commission_rate,
              a.wallet_usdt_bsc, a.binance_id,
              a.created_at, a.approved_at,
              u.telegram_id, u.telegram_username,
              ranked.affiliate_number,
              COALESCE(SUM(
                GREATEST(
                  (c.amount - COALESCE(c.refunded_amount, 0))
                  - COALESCE(c.reserved_amount, 0)
                  - COALESCE(c.paid_out_amount, 0),
                  0
                )
              ) FILTER (WHERE c.status != 'REFUNDED'), 0)
                + COALESCE(adj.adjustments_total, 0) AS available_balance,
              COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0)
                + COALESCE(adj_all.adjustments_total, 0) AS earnings_total,
              COALESCE(SUM(CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE(oi.sale_qty, 1) END), 0)::int AS sales_count,
              MAX(c.earned_at) AS last_sale_at
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN ranked ON ranked.id = a.id
       LEFT JOIN (
         SELECT affiliate_id,
                COALESCE(SUM(
                  CASE
                    WHEN amount > 0 THEN GREATEST(
                      amount
                      - COALESCE(reserved_amount, 0)
                      - COALESCE(paid_out_amount, 0),
                      0
                    )
                    ELSE amount
                  END
                ), 0) AS adjustments_total
         FROM affiliate_adjustments
         GROUP BY affiliate_id
       ) adj ON adj.affiliate_id = a.id
       LEFT JOIN (
         SELECT affiliate_id, COALESCE(SUM(amount), 0) AS adjustments_total
         FROM affiliate_adjustments
         GROUP BY affiliate_id
       ) adj_all ON adj_all.affiliate_id = a.id
       LEFT JOIN commissions c ON c.affiliate_id = a.id AND c.status != 'REFUNDED'
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       ${whereClause}
       GROUP BY a.id, u.telegram_id, u.telegram_username, ranked.affiliate_number, adj.adjustments_total, adj_all.adjustments_total
       ORDER BY a.created_at ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, offset]
    );

    const adminIds = parseAdminTelegramIds();
    const adminId = adminIds.length > 0 ? adminIds[0] : null;
    const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
    const items = listRes.rows.map((row) => {
      const isPlaceholderAffiliate =
        row.telegram_id === 90000000000 || row.telegram_username === "admin_affiliate";
      if (!isPlaceholderAffiliate) {
        return row;
      }
      return {
        ...row,
        telegram_id: adminId || row.telegram_id,
        telegram_username: adminUsername || row.telegram_username,
      };
    });
    res.json({
      items,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 1,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/affiliates/commission-rate", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureGlobalCommissionSchema(pool);
    const boostRes = await pool.query(
      `SELECT rate, active, ends_at
       FROM global_commission_boost
       WHERE id = 1`
    );
    const boostRow = boostRes.rows[0] || {};
    const boostEndsAt = boostRow.ends_at || null;
    const boostActive = Boolean(boostRow.active);
    if (boostActive && boostEndsAt) {
      const endsAtDate = new Date(boostEndsAt);
      if (Number.isFinite(endsAtDate.getTime()) && endsAtDate.getTime() <= Date.now()) {
        await resetGlobalCommission(pool, "AUTO");
      } else {
        await scheduleGlobalCommissionReset(pool, boostEndsAt);
      }
    }
    const defaultRes = await pool.query(
      `SELECT column_default
       FROM information_schema.columns
       WHERE table_name = 'affiliates' AND column_name = 'commission_rate'`
    );
    let rate = null;
    if (defaultRes.rowCount > 0) {
      const raw = defaultRes.rows[0].column_default || "";
      const match = String(raw).match(/([0-9]+(?:\.[0-9]+)?)/);
      if (match) {
        rate = Number(match[1]);
      }
    }
    if (rate === null) {
      const fallbackRes = await pool.query(
        `SELECT commission_rate
         FROM affiliates
         ORDER BY created_at ASC
         LIMIT 1`
      );
      if (fallbackRes.rowCount > 0) {
        rate = Number(fallbackRes.rows[0].commission_rate || 0);
      }
    }
    const ratePercent = rate != null ? Number((rate * 100).toFixed(2)) : null;
    return res.json({
      rate: rate ?? null,
      rate_percent: ratePercent,
      boost_active: boostActive,
      boost_ends_at: boostEndsAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/users/:telegram_id/photo", async (req, res, next) => {
  const telegramId = Number(req.params.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "INVALID_TELEGRAM_ID" });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: "BOT_TOKEN_NOT_CONFIGURED" });
  }
  try {
    const pool = getPool();
    const userRes = await pool.query(
      "SELECT telegram_photo_file_id FROM users WHERE telegram_id = $1",
      [telegramId]
    );
    const fileId = userRes.rows[0]?.telegram_photo_file_id || null;
    if (!fileId) {
      return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    }
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    );
    if (!fileRes.ok) {
      return res.status(502).json({ error: "TELEGRAM_GETFILE_FAILED" });
    }
    const filePayload = await fileRes.json();
    const filePath = filePayload?.result?.file_path;
    if (!filePath) {
      return res.status(404).json({ error: "PHOTO_PATH_NOT_FOUND" });
    }
    const photoRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`
    );
    if (!photoRes.ok) {
      return res.status(502).json({ error: "TELEGRAM_PHOTO_FAILED" });
    }
    const buffer = Buffer.from(await photoRes.arrayBuffer());
    const contentType =
      photoRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.post("/affiliates/commission-rate", async (req, res, next) => {
  const {
    commission_rate: commissionRateInput,
    duration_minutes: durationMinutesInput,
  } = req.body || {};
  let commissionRate = null;
  if (commissionRateInput !== undefined && commissionRateInput !== null && commissionRateInput !== "") {
    const rateValue = Number(commissionRateInput);
    if (!Number.isFinite(rateValue) || rateValue < 0) {
      return res.status(400).json({ error: "INVALID_COMMISSION_RATE" });
    }
    commissionRate = rateValue > 1 ? rateValue / 100 : rateValue;
  }
  if (commissionRate === null) {
    return res.status(400).json({ error: "COMMISSION_RATE_REQUIRED" });
  }
  const durationMinutes = Number(durationMinutesInput);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    return res.status(400).json({ error: "INVALID_DURATION" });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureGlobalCommissionSchema(pool);
    await client.query("BEGIN");
    const previousRes = await client.query(
      `SELECT commission_rate
       FROM affiliates
       ORDER BY created_at ASC
       LIMIT 1`
    );
    const previousRate = Number(previousRes.rows[0]?.commission_rate || 0);
    await client.query(
      "UPDATE affiliates SET commission_rate = $1",
      [commissionRate]
    );
    await client.query(
      `ALTER TABLE affiliates ALTER COLUMN commission_rate SET DEFAULT ${commissionRate}`
    );
    const endsAt = commissionRate > 0
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;
    await client.query(
      `UPDATE global_commission_boost
       SET rate = $1,
           active = $2,
           ends_at = $3,
           updated_at = now()
       WHERE id = 1`,
      [commissionRate, commissionRate > 0, endsAt]
    );
    await client.query("COMMIT");
    await scheduleGlobalCommissionReset(pool, endsAt);
    const ratePercent = Number((commissionRate * 100).toFixed(2));
    const previousPercent = Number((previousRate * 100).toFixed(2));
    try {
      let message = "";
      if (commissionRate > 0) {
        const hours = Math.floor(durationMinutes / 60);
        const minutes = durationMinutes % 60;
        const durationText =
          hours > 0 && minutes > 0
            ? `${hours}h ${minutes}m`
            : hours > 0
            ? `${hours}h`
            : `${minutes}m`;
        message =
          `🚀 BOOST ACTIVADO\n\n` +
          `Porcentaje extra por venta: +${ratePercent}%\n` +
          `Duración: ${durationText}\n\n` +
          `Aplica a todas tus ventas mientras esté activo.`;
      } else if (previousRate > 0) {
        message =
          `✅ BOOST FINALIZADO\n\n` +
          `Tus comisiones vuelven a tu porcentaje habitual por nivel.`;
      }
      if (message) {
        await notifyAffiliates(pool, message);
      }
    } catch (err) {
      // ignore broadcast errors
    }
    return res.json({
      ok: true,
      commission_rate: commissionRate,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/affiliates/commission-rate/stop", async (req, res, next) => {
  const pool = getPool();
  try {
    await ensureGlobalCommissionSchema(pool);
    await resetGlobalCommission(pool, "STOPPED");
    await scheduleGlobalCommissionReset(pool, null);
    return res.json({ ok: true, commission_rate: 0 });
  } catch (error) {
    return next(error);
  }
});

router.post("/affiliates", async (req, res, next) => {
  const {
    telegram_id: telegramIdInput,
    telegram_username: telegramUsername,
    status,
    commission_rate: commissionRateInput,
    wallet_usdt_bsc: walletUsdtBsc,
    binance_id: binanceId,
  } = req.body || {};
  const telegramId = Number(telegramIdInput);
  const pool = getPool();

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "TELEGRAM_ID_REQUIRED" });
  }
  if (walletUsdtBsc && binanceId) {
    return res.status(400).json({ error: "ONLY_ONE_METHOD_ALLOWED" });
  }
  const resolvedWalletUsdtBsc = walletUsdtBsc || null;
  const resolvedBinanceId = binanceId || null;
  const finalWalletUsdtBsc = resolvedBinanceId ? null : resolvedWalletUsdtBsc;
  const finalBinanceId = resolvedWalletUsdtBsc ? null : resolvedBinanceId;

  const allowedStatuses = ["PENDING", "APPROVED", "REJECTED"];
  const normalizedStatus = status ? String(status).toUpperCase() : "PENDING";
  if (!allowedStatuses.includes(normalizedStatus)) {
    return res.status(400).json({ error: "INVALID_STATUS" });
  }

  let commissionRate = null;
  if (commissionRateInput !== undefined && commissionRateInput !== null && commissionRateInput !== "") {
    const rateValue = Number(commissionRateInput);
    if (!Number.isFinite(rateValue) || rateValue < 0) {
      return res.status(400).json({ error: "INVALID_COMMISSION_RATE" });
    }
    commissionRate = rateValue > 1 ? rateValue / 100 : rateValue;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      `INSERT INTO users (telegram_id, telegram_username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username)
       RETURNING id`,
      [telegramId, telegramUsername || null]
    );
    const userId = userRes.rows[0].id;

    const existingRes = await client.query(
      "SELECT id FROM affiliates WHERE user_id = $1",
      [userId]
    );
    if (existingRes.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "AFFILIATE_ALREADY_EXISTS" });
    }

    const affiliateRes = await client.query(
      `INSERT INTO affiliates (user_id, status, commission_rate, wallet_usdt_bsc, binance_id, approved_at)
       VALUES ($1, $2, COALESCE($3, commission_rate), $4, $5,
         CASE WHEN $2 = 'APPROVED' THEN now() ELSE NULL END)
       RETURNING *`,
      [userId, normalizedStatus, commissionRate, finalWalletUsdtBsc, finalBinanceId]
    );

    await client.query("COMMIT");
    return res.status(201).json({ affiliate: affiliateRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/affiliates/:id", async (req, res, next) => {
  const affiliateId = req.params.id;
  const pool = getPool();

  try {
    const affiliateRes = await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY approved_at, id) AS affiliate_number
         FROM affiliates
         WHERE approved_at IS NOT NULL
       )
       SELECT a.*, u.telegram_id, u.telegram_username,
              ranked.affiliate_number,
              COALESCE(SUM(c.amount - COALESCE(c.refunded_amount, 0)), 0)
                + COALESCE(adj_all.adjustments_total, 0) AS earnings_total,
              COALESCE(SUM(CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE(oi.sale_qty, 1) END), 0)::int AS sales_count,
              MAX(c.earned_at) AS last_sale_at
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN ranked ON ranked.id = a.id
       LEFT JOIN (
         SELECT affiliate_id, COALESCE(SUM(amount), 0) AS adjustments_total
         FROM affiliate_adjustments
         GROUP BY affiliate_id
       ) adj_all ON adj_all.affiliate_id = a.id
       LEFT JOIN commissions c ON c.affiliate_id = a.id AND c.status != 'REFUNDED'
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       WHERE a.id = $1
       GROUP BY a.id, u.telegram_id, u.telegram_username, ranked.affiliate_number, adj_all.adjustments_total`,
      [affiliateId]
    );

    if (affiliateRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    const balanceRes = await pool.query(
      `SELECT COALESCE(SUM(
        GREATEST(
          (amount - COALESCE(refunded_amount, 0))
          - COALESCE(reserved_amount, 0)
          - COALESCE(paid_out_amount, 0),
          0
        )
      ), 0) AS available_balance
       FROM commissions
       WHERE affiliate_id = $1 AND status != 'REFUNDED'`,
      [affiliateId]
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
      ), 0) AS adjustments_total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1`,
      [affiliateId]
    );

    const adjustmentsListRes = await pool.query(
      `SELECT id,
              amount,
              reason,
              status,
              created_by_admin_id,
              created_at
       FROM affiliate_adjustments
       WHERE affiliate_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [affiliateId]
    );

    await pool.query(
      `UPDATE affiliate_invoices
       SET status = 'EXPIRED', expired_at = now()
       WHERE affiliate_id = $1
         AND status = 'PENDING'
         AND COALESCE(expires_at, created_at + interval '10 minutes') <= now()`,
      [affiliateId]
    );

    const invoicesRes = await pool.query(
      `SELECT id,
              amount,
              reason,
              status,
              created_by_admin_id,
              created_at,
              paid_at,
              cancelled_at,
              expires_at,
              expired_at
       FROM affiliate_invoices
       WHERE affiliate_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [affiliateId]
    );

    const commissionsRes = await pool.query(
      `SELECT c.id,
              c.order_id,
              c.amount,
              c.refunded_amount,
              c.status,
              c.earned_at,
              c.paid_out_at,
              op.reviewed_by_admin_at AS payment_approved_at,
              o.order_number,
              u.telegram_id AS buyer_telegram_id,
              u.telegram_username AS buyer_username
       FROM commissions c
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN order_payments op ON op.order_id = o.id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE c.affiliate_id = $1
       ORDER BY c.earned_at DESC
       LIMIT 50`,
      [affiliateId]
    );

    const rankRes = await pool.query(
      `WITH sales AS (
         SELECT a.id,
                COALESCE(SUM(CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE(oi.sale_qty, 1) END), 0)::int AS sales_count
         FROM affiliates a
         LEFT JOIN commissions c ON c.affiliate_id = a.id AND c.status != 'REFUNDED'
         LEFT JOIN (
           SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
           FROM order_items
           GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       GROUP BY a.id
      ),
       ranked AS (
         SELECT id,
                sales_count,
                RANK() OVER (ORDER BY sales_count DESC, id) AS sales_rank
         FROM sales
       )
       SELECT sales_rank FROM ranked WHERE id = $1`,
      [affiliateId]
    );

    const streakRes = await pool.query(
      `SELECT DISTINCT date_trunc('day', earned_at)::date AS day
       FROM commissions
       WHERE affiliate_id = $1
         AND status != 'REFUNDED'
       ORDER BY day DESC`,
      [affiliateId]
    );

    const referralsRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE referred_by_affiliate_id = $1`,
      [affiliateId]
    );

    const salesTodayRes = await pool.query(
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
      [affiliateId]
    );

    const salesWeekRes = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(oi.sale_qty, 1)), 0)::int AS count
       FROM commissions c
       LEFT JOIN (
         SELECT order_id, COALESCE(SUM(qty), 0) AS sale_qty
         FROM order_items
         GROUP BY order_id
       ) oi ON oi.order_id = c.order_id
       WHERE c.affiliate_id = $1
         AND c.status != 'REFUNDED'
         AND c.earned_at >= now() - interval '7 days'`,
      [affiliateId]
    );

    const salesMonthRes = await pool.query(
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
      [affiliateId]
    );

    const row = affiliateRes.rows[0];

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

    const adminIds = parseAdminTelegramIds();
    const adminId = adminIds.length > 0 ? adminIds[0] : null;
    const adminUsername = process.env.ADMIN_TELEGRAM_USERNAME || null;
    const isPlaceholderAffiliate =
      row.telegram_id === 90000000000 || row.telegram_username === "admin_affiliate";
    const displayTelegramId = isPlaceholderAffiliate ? adminId : row.telegram_id;
    const displayUsername = isPlaceholderAffiliate ? adminUsername : row.telegram_username;

    return res.json({
      affiliate: {
        ...row,
        sales_rank: rankRes.rows[0]?.sales_rank || null,
        daily_streak: streakCount,
        referrals_total: referralsRes.rows[0]?.count || 0,
        sales_today: salesTodayRes.rows[0]?.count || 0,
        sales_week: salesWeekRes.rows[0]?.count || 0,
        sales_month: salesMonthRes.rows[0]?.count || 0,
      },
      user: {
        telegram_id: displayTelegramId,
        telegram_username: displayUsername,
      },
      available_balance:
        Number(balanceRes.rows[0].available_balance || 0)
        + Number(adjustmentsRes.rows[0].adjustments_total || 0),
      adjustments: adjustmentsListRes.rows,
      invoices: invoicesRes.rows,
      commissions: commissionsRes.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/affiliates/:id/invoices/watch", async (req, res, next) => {
  const affiliateId = req.params.id;
  const pool = getPool();
  const sinceRaw = req.query.since;
  const sinceMs = Number(sinceRaw);
  const sinceDate =
    Number.isFinite(sinceMs) && sinceMs > 0 ? new Date(sinceMs) : new Date(0);
  const timeoutMs = 20000;
  const intervalMs = 1000;
  const startedAt = Date.now();

  try {
    await pool.query(
      `UPDATE affiliate_invoices
       SET status = 'EXPIRED', expired_at = now()
       WHERE affiliate_id = $1
         AND status = 'PENDING'
         AND COALESCE(expires_at, created_at + interval '10 minutes') <= now()`,
      [affiliateId]
    );
    while (Date.now() - startedAt < timeoutMs) {
      const watchRes = await pool.query(
        `SELECT id,
                affiliate_id,
                amount,
                reason,
                status,
                created_at,
                paid_at,
                cancelled_at,
                expires_at,
                expired_at
         FROM affiliate_invoices
         WHERE affiliate_id = $1
           AND status IN ('PAID', 'CANCELLED', 'EXPIRED')
           AND COALESCE(paid_at, cancelled_at, expired_at, created_at) > $2
         ORDER BY COALESCE(paid_at, cancelled_at, expired_at, created_at) DESC
         LIMIT 1`,
        [affiliateId, sinceDate]
      );

      if (watchRes.rowCount > 0) {
        return res.json({ changed: true, invoice: watchRes.rows[0] });
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return res.json({ changed: false });
  } catch (error) {
    return next(error);
  }
});

router.patch("/affiliates/:id", async (req, res, next) => {
  const affiliateId = req.params.id;
  const {
    status,
    commission_rate: commissionRateInput,
    wallet_usdt_bsc: walletUsdtBsc,
    binance_id: binanceId,
  } = req.body || {};
  const pool = getPool();
  if (walletUsdtBsc && binanceId) {
    return res.status(400).json({ error: "ONLY_ONE_METHOD_ALLOWED" });
  }

  const allowedStatuses = ["PENDING", "APPROVED", "REJECTED"];
  let normalizedStatus = null;
  if (status !== undefined && status !== null && status !== "") {
    normalizedStatus = String(status).toUpperCase();
    if (!allowedStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ error: "INVALID_STATUS" });
    }
  }

  let commissionRate = null;
  if (commissionRateInput !== undefined && commissionRateInput !== null && commissionRateInput !== "") {
    const rateValue = Number(commissionRateInput);
    if (!Number.isFinite(rateValue) || rateValue < 0) {
      return res.status(400).json({ error: "INVALID_COMMISSION_RATE" });
    }
    commissionRate = rateValue > 1 ? rateValue / 100 : rateValue;
  }
  const resolvedWalletUsdtBsc = walletUsdtBsc !== undefined ? walletUsdtBsc : null;
  const resolvedBinanceId = binanceId !== undefined ? binanceId : null;
  const finalWalletUsdtBsc = resolvedBinanceId ? null : resolvedWalletUsdtBsc;
  const finalBinanceId = resolvedWalletUsdtBsc ? null : resolvedBinanceId;

  try {
    const userRes = await pool.query(
      `SELECT a.status, u.telegram_id, u.telegram_username
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = $1`,
      [affiliateId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    const previousStatus = userRes.rows[0].status;
    const telegramId = userRes.rows[0].telegram_id;
    const telegramUsername = userRes.rows[0].telegram_username;

    const updateRes = await pool.query(
      `UPDATE affiliates
       SET status = COALESCE($2, status),
           commission_rate = COALESCE($3, commission_rate),
           wallet_usdt_bsc = CASE
             WHEN $4::text IS NULL AND $5::text IS NULL THEN wallet_usdt_bsc
             WHEN $4::text IS NOT NULL THEN $4::text
             WHEN $5::text IS NOT NULL THEN NULL
             ELSE wallet_usdt_bsc
           END,
           binance_id = CASE
             WHEN $4::text IS NULL AND $5::text IS NULL THEN binance_id
             WHEN $5::text IS NOT NULL THEN $5::text
             WHEN $4::text IS NOT NULL THEN NULL
             ELSE binance_id
           END,
           approved_at = CASE
             WHEN $2 = 'APPROVED' THEN COALESCE(approved_at, now())
             WHEN $2 = 'PENDING' THEN NULL
             WHEN $2 = 'REJECTED' THEN approved_at
             ELSE approved_at
           END
       WHERE id = $1
       RETURNING *`,
      [affiliateId, normalizedStatus, commissionRate, finalWalletUsdtBsc, finalBinanceId]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    const updated = updateRes.rows[0];
    if (normalizedStatus === "APPROVED" || normalizedStatus === "REJECTED") {
      try {
        if (telegramId) {
          const userLocale = await getUserLocaleByTelegramId(pool, telegramId);
          const displayName = telegramUsername
            ? `@${telegramUsername.replace(/^@/, "")}`
            : `ID ${telegramId}`;
          let text = "";
          if (previousStatus === "APPROVED" && normalizedStatus === "REJECTED") {
            text =
              (AFFILIATE_MESSAGES[userLocale]?.blocked
                || AFFILIATE_MESSAGES.es.blocked).replace("{username}", displayName);
          } else if (
            previousStatus === "REJECTED" && normalizedStatus === "APPROVED"
          ) {
            text = AFFILIATE_MESSAGES[userLocale]?.unblocked
              || AFFILIATE_MESSAGES.es.unblocked;
          } else if (normalizedStatus === "APPROVED") {
            text = AFFILIATE_MESSAGES[userLocale]?.approved
              || AFFILIATE_MESSAGES.es.approved;
          } else if (normalizedStatus === "REJECTED") {
            text = AFFILIATE_MESSAGES[userLocale]?.rejected
              || AFFILIATE_MESSAGES.es.rejected;
          }
          if (text) {
            await sendMessage(telegramId, text);
          }
        }
      } catch (err) {
        console.error("Affiliate notification failed", err);
      }
    }

    return res.json({ affiliate: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/affiliates/:id/adjustments", async (req, res, next) => {
  const affiliateId = req.params.id;
  const amountRaw = req.body?.amount;
  const reason = String(req.body?.reason || "").trim();
  const pool = getPool();

  if (!affiliateId) {
    return res.status(400).json({ error: "AFFILIATE_REQUIRED" });
  }

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }
  const adminIds = parseAdminTelegramIds();
  const adminTelegramId = adminIds.length > 0 ? adminIds[0] : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const affiliateRes = await client.query(
      `SELECT a.id, a.affiliate_debt, u.telegram_id, u.telegram_username
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [affiliateId]
    );
    if (affiliateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }
    const affiliateRow = affiliateRes.rows[0];

    if (amount < 0) {
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
        [affiliateId]
      );
      const adjustmentsTotalRes = await client.query(
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
        [affiliateId]
      );
      const availableGross =
        Number(availableRes.rows[0]?.total || 0)
        + Number(adjustmentsTotalRes.rows[0]?.total || 0);
      const affiliateDebtRes = await client.query(
        "SELECT affiliate_debt FROM affiliates WHERE id = $1",
        [affiliateId]
      );
      const affiliateDebt = Number(affiliateDebtRes.rows[0]?.affiliate_debt || 0);
      const availableNet = Math.max(availableGross - affiliateDebt, 0);
      if (availableNet < Math.abs(amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "INSUFFICIENT_BALANCE" });
      }
    }

    const insertRes = await client.query(
      `INSERT INTO affiliate_adjustments
        (affiliate_id, amount, reason, status, created_by_admin_id)
       VALUES ($1, $2, $3, 'EARNED', $4)
       RETURNING *`,
      [affiliateId, amount, reason || null, adminTelegramId]
    );

    if (amount > 0) {
      const debt = Number(affiliateRow.affiliate_debt || 0);
      const appliedDebt = Math.min(debt, amount);
      if (appliedDebt > 0) {
        await client.query(
          `UPDATE affiliates
           SET affiliate_debt = affiliate_debt - $2
           WHERE id = $1`,
          [affiliateId, appliedDebt]
        );
        await client.query(
          `INSERT INTO affiliate_adjustments
            (affiliate_id, amount, reason, status, created_by_admin_id)
           VALUES ($1, $2, $3, 'EARNED', $4)`,
          [affiliateId, -Number(appliedDebt.toFixed(2)), "Pago automatico de deuda", adminTelegramId]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "AFFILIATE_ADJUSTMENT",
        "affiliate",
        affiliateId,
        JSON.stringify({
          amount,
          reason,
          admin_telegram_id: adminTelegramId,
        }),
      ]
    );

    await client.query("COMMIT");

    if (reason) {
      try {
        const telegramId = affiliateRow.telegram_id;
        if (telegramId) {
          const locale = await getUserLocaleByTelegramId(pool, telegramId);
          const messageKey = amount >= 0 ? "adjustment_credit" : "adjustment_debit";
          const formattedAmount = formatUsdWithCurrency(Math.abs(amount));
          const text = (AFFILIATE_MESSAGES[locale]?.[messageKey]
            || AFFILIATE_MESSAGES.es[messageKey])
            .replace("{amount}", formattedAmount)
            .replace("{reason}", reason);
          await sendMessage(telegramId, text);
        }
      } catch (err) {
        console.error("Affiliate adjustment notification failed", err);
      }
    }

    return res.status(201).json({ adjustment: insertRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/affiliates/:id/invoices", async (req, res, next) => {
  const affiliateId = req.params.id;
  const amountRaw = req.body?.amount;
  const reason = String(req.body?.reason || "").trim();
  const pool = getPool();

  if (!affiliateId) {
    return res.status(400).json({ error: "AFFILIATE_REQUIRED" });
  }

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }

  const adminIds = parseAdminTelegramIds();
  const adminTelegramId = adminIds.length > 0 ? adminIds[0] : null;

  try {
    const affiliateRes = await pool.query(
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
      [affiliateId]
    );
    if (affiliateRes.rowCount === 0) {
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    const affiliate = affiliateRes.rows[0];
    const invoiceRes = await pool.query(
      `INSERT INTO affiliate_invoices
        (affiliate_id, amount, reason, status, created_by_admin_id)
       VALUES ($1, $2, $3, 'PENDING', $4)
       RETURNING *`,
      [affiliateId, amount, reason || null, adminTelegramId]
    );

    const invoice = invoiceRes.rows[0];
    const { buildAffiliateInvoiceMessage } = require("../services/affiliateInvoiceMessage");
    const message = buildAffiliateInvoiceMessage({ affiliate, invoice });
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Pagar", callback_data: `affiliate_invoice:${invoice.id}:PAY` },
          { text: "❌ Cancelar", callback_data: `affiliate_invoice:${invoice.id}:CANCEL` },
        ],
      ],
    };

    if (affiliate.telegram_id) {
      const assets = await getBotAssets(pool);
      const invoiceImageUrl = assets.affiliate_invoice_image_url || null;
      if (invoiceImageUrl) {
        sendPhoto(affiliate.telegram_id, {
          url: invoiceImageUrl,
          caption: message,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }).catch((err) => {
          console.error("Affiliate invoice photo failed", err);
          sendMessage(affiliate.telegram_id, message, {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          }).catch((fallbackErr) => {
            console.error("Affiliate invoice notification failed", fallbackErr);
          });
        });
      } else {
        sendMessage(affiliate.telegram_id, message, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }).catch((fallbackErr) => {
          console.error("Affiliate invoice notification failed", fallbackErr);
        });
      }
    }

    await pool.query(
      `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "AFFILIATE_INVOICE_CREATE",
        "affiliate",
        affiliateId,
        JSON.stringify({
          invoice_id: invoice.id,
          amount,
          reason: reason || null,
          admin_telegram_id: adminTelegramId,
        }),
      ]
    );

    return res.status(201).json({ invoice });
  } catch (error) {
    return next(error);
  }
});

router.delete("/affiliates/:id", async (req, res, next) => {
  const affiliateId = req.params.id;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const affiliateRes = await client.query(
      "SELECT id FROM affiliates WHERE id = $1",
      [affiliateId]
    );
    if (affiliateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    await client.query(
      `DELETE FROM payout_items
       WHERE payout_id IN (SELECT id FROM payouts WHERE affiliate_id = $1)
          OR commission_id IN (SELECT id FROM commissions WHERE affiliate_id = $1)`,
      [affiliateId]
    );
    await client.query("DELETE FROM payouts WHERE affiliate_id = $1", [affiliateId]);
    await client.query("DELETE FROM commissions WHERE affiliate_id = $1", [
      affiliateId,
    ]);
    await client.query("DELETE FROM affiliates WHERE id = $1", [affiliateId]);

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/payouts", async (req, res, next) => {
  const status = req.query.status;
  const { page, pageSize, offset } = parsePagination(req.query);
  const pool = getPool();

  const filters = [];
  const values = [];

  if (status) {
    values.push(status);
    filters.push(`p.status = $${values.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM payouts p ${whereClause}`,
      values
    );
    const total = countRes.rows[0].total;

    const listRes = await pool.query(
      `WITH numbered AS (
         SELECT p.*,
                ROW_NUMBER() OVER (ORDER BY p.created_at, p.id) AS payout_number
         FROM payouts p
       )
       SELECT numbered.*, u.telegram_id, u.telegram_username
       FROM numbered
       JOIN affiliates a ON a.id = numbered.affiliate_id
       JOIN users u ON u.id = a.user_id
       ${whereClause.replace(/\bp\./g, "numbered.")}
       ORDER BY numbered.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, offset]
    );

    res.json({
      items: listRes.rows,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 1,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/payouts/status-counts", async (req, res, next) => {
  const pool = getPool();
  try {
    const countsRes = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM payouts
       GROUP BY status`
    );
    const counts = {};
    for (const row of countsRes.rows) {
      counts[row.status] = row.count || 0;
    }
    return res.json({ counts });
  } catch (error) {
    return next(error);
  }
});

router.get("/payouts/:id", async (req, res, next) => {
  const payoutId = req.params.id;
  if (!/^[0-9a-fA-F-]{36}$/.test(payoutId || "")) {
    return res.status(400).json({ error: "INVALID_PAYOUT_ID" });
  }
  const pool = getPool();

  try {
    await ensurePayoutReceiptSchema(pool);
    const payoutRes = await pool.query(
      `WITH numbered AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY created_at, id) AS payout_number
         FROM payouts
       )
       SELECT p.*, a.status AS affiliate_status, a.commission_rate,
              a.wallet_usdt_bsc, a.wallet_nequi, a.binance_id,
              u.telegram_id, u.telegram_username,
              numbered.payout_number
       FROM payouts p
       JOIN affiliates a ON a.id = p.affiliate_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN numbered ON numbered.id = p.id
       WHERE p.id = $1`,
      [payoutId]
    );

    if (payoutRes.rowCount === 0) {
      return res.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    }

    const payout = payoutRes.rows[0];
    const balanceRes = await pool.query(
      `SELECT COALESCE(SUM(
        GREATEST(
          (amount - COALESCE(refunded_amount, 0))
          - COALESCE(reserved_amount, 0)
          - COALESCE(paid_out_amount, 0),
          0
        )
      ), 0) AS available_balance
       FROM commissions
       WHERE affiliate_id = $1 AND status != 'REFUNDED'`,
      [payout.affiliate_id]
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
      ), 0) AS adjustments_total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1`,
      [payout.affiliate_id]
    );

    const availableBalance =
      Number(balanceRes.rows[0].available_balance || 0)
      + Number(adjustmentsRes.rows[0].adjustments_total || 0);
    return res.json({
      payout,
        affiliate: {
          id: payout.affiliate_id,
          status: payout.affiliate_status,
          commission_rate: payout.commission_rate,
          wallet_usdt_bsc: payout.wallet_usdt_bsc,
          wallet_nequi: payout.wallet_nequi,
          binance_id: payout.binance_id,
        },
      user: {
        telegram_id: payout.telegram_id,
        telegram_username: payout.telegram_username,
      },
      available_balance: Math.max(availableBalance, 0),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/payouts/:id/receipt", async (req, res, next) => {
  const payoutId = req.params.id;
  if (!/^[0-9a-fA-F-]{36}$/.test(payoutId || "")) {
    return res.status(400).json({ error: "INVALID_PAYOUT_ID" });
  }
  const pool = getPool();
  try {
    await ensurePayoutReceiptSchema(pool);
    const payoutRes = await pool.query(
      `SELECT receipt_path, receipt_filename, receipt_mime
       FROM payouts
       WHERE id = $1`,
      [payoutId]
    );
    if (payoutRes.rowCount === 0) {
      return res.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    }
    const receipt = payoutRes.rows[0];
    if (!receipt.receipt_path) {
      return res.status(404).json({ error: "RECEIPT_NOT_FOUND" });
    }
    const buffer = await fs.readFile(receipt.receipt_path);
    res.set("Content-Type", receipt.receipt_mime || "image/png");
    res.set("Cache-Control", "private, max-age=300");
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.get("/payouts/:id/receipt/download", async (req, res, next) => {
  const payoutId = req.params.id;
  if (!/^[0-9a-fA-F-]{36}$/.test(payoutId || "")) {
    return res.status(400).json({ error: "INVALID_PAYOUT_ID" });
  }
  const pool = getPool();
  try {
    await ensurePayoutReceiptSchema(pool);
    const payoutRes = await pool.query(
      `SELECT receipt_path, receipt_filename, receipt_mime
       FROM payouts
       WHERE id = $1`,
      [payoutId]
    );
    if (payoutRes.rowCount === 0) {
      return res.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    }
    const receipt = payoutRes.rows[0];
    if (!receipt.receipt_path) {
      return res.status(404).json({ error: "RECEIPT_NOT_FOUND" });
    }
    const buffer = await fs.readFile(receipt.receipt_path);
    const filename = receipt.receipt_filename || `recibo-retiro-${payoutId}.png`;
    res.set("Content-Type", receipt.receipt_mime || "image/png");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.post("/payouts", async (req, res, next) => {
  const { affiliate_id: affiliateId, method, destination, amount } = req.body || {};
  const pool = getPool();

  if (!affiliateId) {
    return res.status(400).json({ error: "AFFILIATE_REQUIRED" });
  }

  if (!method || (method !== "USDT_BSC" && method !== "BINANCE_ID" && method !== "NEQUI")) {
    return res.status(400).json({ error: "INVALID_METHOD" });
  }
  if (amount != null && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const affiliateRes = await client.query(
      "SELECT id, wallet_usdt_bsc, wallet_nequi, binance_id, affiliate_debt FROM affiliates WHERE id = $1",
      [affiliateId]
    );

    if (affiliateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "AFFILIATE_NOT_FOUND" });
    }

    const affiliate = affiliateRes.rows[0];
    const debt = Number(affiliate.affiliate_debt || 0);
    const resolvedDestination =
      destination ||
      (method === "USDT_BSC"
        ? affiliate.wallet_usdt_bsc
        : method === "NEQUI"
        ? affiliate.wallet_nequi
        : affiliate.binance_id);

    if (!resolvedDestination) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DESTINATION_REQUIRED" });
    }

    const commissionsRes = await client.query(
      `SELECT id,
              amount,
              COALESCE(refunded_amount, 0) AS refunded_amount,
              COALESCE(reserved_amount, 0) AS reserved_amount,
              COALESCE(paid_out_amount, 0) AS paid_out_amount,
              (amount - COALESCE(refunded_amount, 0)
                - COALESCE(reserved_amount, 0)
                - COALESCE(paid_out_amount, 0)) AS available_amount
       FROM commissions
       WHERE affiliate_id = $1
         AND status != 'REFUNDED'
         AND (amount - COALESCE(refunded_amount, 0)
           - COALESCE(reserved_amount, 0)
           - COALESCE(paid_out_amount, 0)) > 0
       ORDER BY earned_at ASC
       FOR UPDATE`,
      [affiliateId]
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
      [affiliateId]
    );

    const negativeAdjustmentsRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM affiliate_adjustments
       WHERE affiliate_id = $1
         AND amount < 0`,
      [affiliateId]
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

    const debtAppliedTotal = Math.min(debt, totalGross);
    const availableAfterDebt = Number((totalGross - debtAppliedTotal).toFixed(2));
    if (availableAfterDebt <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "DEBT_PENDING" });
    }

    let targetPayout = availableAfterDebt;
    if (amount != null) {
      const requestedAmount = Number(amount);
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
      [affiliateId, payoutAmount, method, resolvedDestination, debtApplied]
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
        [affiliateId, debtApplied]
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
    next(error);
  } finally {
    client.release();
  }
});

router.post("/payouts/:id/mark-sent", async (req, res, next) => {
  const payoutId = req.params.id;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensurePayoutReceiptSchema(pool);
    await client.query("BEGIN");

    const payoutRes = await client.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY approved_at, id) AS affiliate_number
         FROM affiliates
         WHERE approved_at IS NOT NULL
       ),
       numbered AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY created_at, id) AS payout_number
         FROM payouts
       )
       SELECT p.*, u.telegram_id, u.telegram_username,
              ranked.affiliate_number, numbered.payout_number
       FROM payouts p
       JOIN affiliates a ON a.id = p.affiliate_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN ranked ON ranked.id = a.id
       LEFT JOIN numbered ON numbered.id = p.id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [payoutId]
    );

    if (payoutRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    }

    const payout = payoutRes.rows[0];

    if (payout.status === "SENT") {
      await client.query("COMMIT");
      return res.status(200).json({ status: "already_sent" });
    }

    if (payout.status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "PAYOUT_CANCELLED" });
    }

    const updatedRes = await client.query(
      `UPDATE payouts
       SET status = 'SENT', sent_at = now()
       WHERE id = $1
       RETURNING *`,
      [payoutId]
    );

    const payoutItemsRes = await client.query(
      `SELECT commission_id, amount
       FROM payout_items
       WHERE payout_id = $1`,
      [payoutId]
    );

    let commissionsRes = { rowCount: 0 };
    if (payoutItemsRes.rowCount > 0) {
      const commissionIds = payoutItemsRes.rows.map((row) => row.commission_id);
      const commissionAmounts = payoutItemsRes.rows.map((row) => Number(row.amount || 0));
      commissionsRes = await client.query(
        `WITH selected AS (
           SELECT UNNEST($1::uuid[]) AS id,
                  UNNEST($2::numeric[]) AS amount
         )
         UPDATE commissions c
         SET reserved_amount = GREATEST(c.reserved_amount - selected.amount, 0),
             paid_out_amount = LEAST(
               c.paid_out_amount + selected.amount,
               (c.amount - COALESCE(c.refunded_amount, 0))
             ),
             paid_out_at = CASE
               WHEN (c.amount - COALESCE(c.refunded_amount, 0))
                 - LEAST(
                   c.paid_out_amount + selected.amount,
                   (c.amount - COALESCE(c.refunded_amount, 0))
                 ) <= 0.01
                 THEN COALESCE(c.paid_out_at, now())
               ELSE c.paid_out_at
             END,
             status = CASE
               WHEN (c.amount - COALESCE(c.refunded_amount, 0))
                 - LEAST(
                   c.paid_out_amount + selected.amount,
                   (c.amount - COALESCE(c.refunded_amount, 0))
                 ) <= 0.01
                 THEN 'PAID_OUT'::commission_status
               WHEN GREATEST(c.reserved_amount - selected.amount, 0) > 0.01
                 THEN 'RESERVED'::commission_status
               ELSE 'EARNED'::commission_status
             END
         FROM selected
         WHERE c.id = selected.id
           AND c.status != 'REFUNDED'`,
        [commissionIds, commissionAmounts]
      );
    }

    const payoutAdjustmentsRes = await client.query(
      `SELECT adjustment_id, amount
       FROM payout_adjustments
       WHERE payout_id = $1`,
      [payoutId]
    );
    if (payoutAdjustmentsRes.rowCount > 0) {
      const positiveAdjustments = payoutAdjustmentsRes.rows.filter(
        (row) => Number(row.amount || 0) > 0
      );
      if (positiveAdjustments.length > 0) {
        const adjustmentIds = positiveAdjustments.map((row) => row.adjustment_id);
        const adjustmentAmounts = positiveAdjustments.map((row) => Number(row.amount || 0));
        await client.query(
          `WITH selected AS (
             SELECT UNNEST($1::uuid[]) AS id,
                    UNNEST($2::numeric[]) AS amount
           )
           UPDATE affiliate_adjustments a
           SET reserved_amount = GREATEST(a.reserved_amount - selected.amount, 0),
               paid_out_amount = LEAST(a.paid_out_amount + selected.amount, a.amount),
               status = CASE
                 WHEN a.amount - LEAST(a.paid_out_amount + selected.amount, a.amount) <= 0.01
                   THEN 'PAID_OUT'::commission_status
                 WHEN GREATEST(a.reserved_amount - selected.amount, 0) > 0.01
                   THEN 'RESERVED'::commission_status
                 ELSE 'EARNED'::commission_status
               END
           FROM selected
           WHERE a.id = selected.id`,
          [adjustmentIds, adjustmentAmounts]
        );
      }
    }

    await client.query("COMMIT");

    const message = "✅💸 ¡Tu pago se ha enviado exitosamente! 🙌\n\n🧾 En breve recibirás tu recibo de pago.";
    try {
      await sendMessage(payout.telegram_id, message);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const affiliateNumber = payout.affiliate_number
        ? `#${payout.affiliate_number}`
        : "#-";
      const paidToUsername = payout.telegram_username || "N/A";
      const botUsername = (process.env.BOT_USERNAME || process.env.NEXT_PUBLIC_BOT_USERNAME || "")
        .replace(/^@/, "");
      const payoutNumber = payout.payout_number
        ? String(payout.payout_number).padStart(5, "0")
        : "-";
      const receiptPng = await renderReceiptPng({
        orderId: payout.id,
        orderNumber: payoutNumber,
        orderNumberLabel: "Numero de pago:",
        receiptTitle: "RECIBO DE RETIRO",
        telegramId: payout.telegram_id,
        username: payout.telegram_username,
        dateTime: formatBogotaDate(payout.sent_at || new Date()),
        items: [{ name: "Retiro", price: payout.amount }],
        subtotal: payout.amount,
        commission: 0,
        total: payout.amount,
        referredBy: "N/A",
        templateName: "recibo_retiro.html",
        totalLabel: "Total retirado",
        thankYou: "Gracias<br>Por trabajar con nosotros<br>Sigue adelante",
        affiliateNumber,
        paidToUsername,
        paidToTelegramId: payout.telegram_id,
        botUsername: botUsername || undefined,
        locale: "es",
      });
      try {
        const receiptsDir = path.resolve(__dirname, "..", "..", "uploads", "payout-receipts");
        await fs.mkdir(receiptsDir, { recursive: true });
        const filename = `payout-${payout.id}.png`;
        const storedPath = path.join(receiptsDir, filename);
        await fs.copyFile(receiptPng.pngPath, storedPath);
        await client.query(
          `UPDATE payouts
           SET receipt_path = $1,
               receipt_filename = $2,
               receipt_mime = $3
           WHERE id = $4`,
          [storedPath, filename, "image/png", payout.id]
        );
        try {
          await sendPhoto(payout.telegram_id, { path: storedPath });
        } catch (photoError) {
          console.error("Telegram payout receipt photo failed", photoError);
          await sendDocument(payout.telegram_id, { path: storedPath });
        }
      } finally {
        await receiptPng.cleanup();
      }
    } catch (err) {
      console.error("Telegram payout receipt failed", err);
    }

    return res.json({
      payout: updatedRes.rows[0],
      commissions_updated: commissionsRes.rowCount,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/payouts/:id/cancel", async (req, res, next) => {
  const payoutId = req.params.id;
  const { reason } = req.body || {};
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const payoutRes = await client.query(
      `SELECT p.*, u.telegram_id
       FROM payouts p
       JOIN affiliates a ON a.id = p.affiliate_id
       JOIN users u ON u.id = a.user_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [payoutId]
    );

    if (payoutRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    }

    const payout = payoutRes.rows[0];

    if (payout.status === "SENT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ALREADY_SENT" });
    }

    if (payout.status === "CANCELLED") {
      await client.query("COMMIT");
      return res.status(200).json({ status: "already_cancelled" });
    }

    const updatedRes = await client.query(
      `UPDATE payouts
       SET status = 'CANCELLED'
       WHERE id = $1
       RETURNING *`,
      [payoutId]
    );

    if (payout.debt_applied && Number(payout.debt_applied) > 0) {
      await client.query(
        `UPDATE affiliates
         SET affiliate_debt = affiliate_debt + $2
         WHERE id = $1`,
        [payout.affiliate_id, payout.debt_applied]
      );
    }

    const payoutItemsRes = await client.query(
      `SELECT commission_id, amount
       FROM payout_items
       WHERE payout_id = $1`,
      [payoutId]
    );

    if (payoutItemsRes.rowCount > 0) {
      const commissionIds = payoutItemsRes.rows.map((row) => row.commission_id);
      const commissionAmounts = payoutItemsRes.rows.map((row) => Number(row.amount || 0));
      await client.query(
        `WITH selected AS (
           SELECT UNNEST($1::uuid[]) AS id,
                  UNNEST($2::numeric[]) AS amount
         )
         UPDATE commissions c
         SET reserved_amount = GREATEST(c.reserved_amount - selected.amount, 0),
             status = CASE
               WHEN (c.amount - COALESCE(c.refunded_amount, 0)
                 - COALESCE(c.paid_out_amount, 0)) <= 0.01
                 THEN 'PAID_OUT'::commission_status
               WHEN GREATEST(c.reserved_amount - selected.amount, 0) > 0.01
                 THEN 'RESERVED'::commission_status
               ELSE 'EARNED'::commission_status
             END
         FROM selected
         WHERE c.id = selected.id
           AND c.status != 'REFUNDED'`,
        [commissionIds, commissionAmounts]
      );
    }

    await client.query(
      `DELETE FROM payout_items
       WHERE payout_id = $1`,
      [payoutId]
    );

    const payoutAdjustmentsRes = await client.query(
      `SELECT adjustment_id, amount
       FROM payout_adjustments
       WHERE payout_id = $1`,
      [payoutId]
    );
    if (payoutAdjustmentsRes.rowCount > 0) {
      const positiveAdjustments = payoutAdjustmentsRes.rows.filter(
        (row) => Number(row.amount || 0) > 0
      );
      if (positiveAdjustments.length > 0) {
        const adjustmentIds = positiveAdjustments.map((row) => row.adjustment_id);
        const adjustmentAmounts = positiveAdjustments.map((row) => Number(row.amount || 0));
        await client.query(
          `WITH selected AS (
             SELECT UNNEST($1::uuid[]) AS id,
                    UNNEST($2::numeric[]) AS amount
           )
           UPDATE affiliate_adjustments a
           SET reserved_amount = GREATEST(a.reserved_amount - selected.amount, 0),
               status = CASE
                 WHEN a.amount - COALESCE(a.paid_out_amount, 0) <= 0.01
                   THEN 'PAID_OUT'::commission_status
                 WHEN GREATEST(a.reserved_amount - selected.amount, 0) > 0.01
                   THEN 'RESERVED'::commission_status
                 ELSE 'EARNED'::commission_status
               END
           FROM selected
           WHERE a.id = selected.id`,
          [adjustmentIds, adjustmentAmounts]
        );
      }
    }

    await client.query(
      `DELETE FROM payout_adjustments
       WHERE payout_id = $1`,
      [payoutId]
    );

    await client.query("COMMIT");

    const reasonText = reason ? `\nMotivo: ${reason}` : "";
    const message = `❌ Tu retiro fue cancelado.${reasonText}`;
    try {
      await sendMessage(payout.telegram_id, message);
    } catch (err) {
      console.error("Telegram notification failed", err);
    }

    return res.json({ payout: updatedRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/tickets", async (req, res, next) => {
  const status = req.query.status;
  const { page, pageSize, offset } = parsePagination(req.query);
  const pool = getPool();

  const filters = [];
  const values = [];

  if (status) {
    values.push(status);
    filters.push(`t.status = $${values.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    await ensureTicketSchema(pool);
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tickets t ${whereClause}`,
      values
    );
    const total = countRes.rows[0].total;

    const listRes = await pool.query(
      `SELECT t.id, t.status, t.created_at, t.closed_at, t.allow_image,
              u.telegram_id, u.telegram_username,
              lm.created_at AS last_message_at,
              lm.message_text AS last_message_preview,
              EXISTS (
                SELECT 1 FROM ticket_messages tm
                WHERE tm.ticket_id = t.id AND tm.sender = 'ADMIN'
              ) AS has_admin_reply
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT message_text, created_at
         FROM ticket_messages
         WHERE ticket_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON true
       ${whereClause}
       ORDER BY COALESCE(lm.created_at, t.created_at) DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, offset]
    );

    res.json({
      items: listRes.rows,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 1,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/tickets/:id", async (req, res, next) => {
  const ticketId = req.params.id;
  const pool = getPool();

  try {
    await ensureTicketSchema(pool);
    const ticketRes = await pool.query(
      `SELECT t.*, u.telegram_id, u.telegram_username
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId]
    );

    if (ticketRes.rowCount === 0) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }

    const messagesRes = await pool.query(
      `SELECT id, sender, message_text, telegram_file_id, created_at
       FROM ticket_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [ticketId]
    );

    const ticket = ticketRes.rows[0];

    return res.json({
      ticket: {
        id: ticket.id,
        status: ticket.status,
        subject: ticket.subject,
        created_at: ticket.created_at,
        closed_at: ticket.closed_at,
        allow_image: ticket.allow_image,
      },
      user: {
        telegram_id: ticket.telegram_id,
        telegram_username: ticket.telegram_username,
      },
      messages: messagesRes.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/tickets/messages/:id/image", async (req, res, next) => {
  const messageId = req.params.id;
  const pool = getPool();

  try {
    const msgRes = await pool.query(
      `SELECT telegram_file_id
       FROM ticket_messages
       WHERE id = $1`,
      [messageId]
    );
    if (msgRes.rowCount === 0 || !msgRes.rows[0].telegram_file_id) {
      return res.status(404).json({ error: "MESSAGE_IMAGE_NOT_FOUND" });
    }

    const fileId = msgRes.rows[0].telegram_file_id;
    const filePath = await getFilePath(fileId);
    const file = await downloadFile(filePath);

    res.set("Content-Type", file.contentType || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=300");
    return res.send(file.buffer);
  } catch (error) {
    next(error);
  }
});

router.post("/tickets/:id/reply", async (req, res, next) => {
  const ticketId = req.params.id;
  const messageText = req.body && req.body.message ? String(req.body.message).trim() : "";
  const imageDataUrl = req.body && req.body.image_data_url
    ? String(req.body.image_data_url).trim()
    : "";
  const imagePayload = imageDataUrl ? parseImageDataUrl(imageDataUrl) : null;

  if (!messageText && !imagePayload) {
    return res.status(400).json({ error: "MESSAGE_REQUIRED" });
  }
  if (imageDataUrl && !imagePayload) {
    return res.status(400).json({ error: "IMAGE_INVALID" });
  }
  if (imagePayload && imagePayload.buffer.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: "IMAGE_TOO_LARGE" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureTicketSchema(pool);
    await client.query("BEGIN");

    const ticketRes = await client.query(
      `SELECT t.*, u.telegram_id
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1
       FOR UPDATE`,
      [ticketId]
    );

    if (ticketRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }

    const ticket = ticketRes.rows[0];
    if (ticket.status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "TICKET_NOT_OPEN" });
    }

    let telegramFileId = null;
    if (imagePayload) {
      const extension = getImageExtension(imagePayload.mime);
      const filename = `ticket-${ticketId}.${extension}`;
      const tempPath = path.join(
        path.resolve(__dirname, "..", "..", "uploads", "tickets"),
        filename
      );
      await fs.mkdir(path.dirname(tempPath), { recursive: true });
      await fs.writeFile(tempPath, imagePayload.buffer);
      let sentPhoto;
      try {
        sentPhoto = await sendPhoto(ticket.telegram_id, {
          path: tempPath,
          filename,
          caption: messageText
            ? `<b>🤖 Soporte</b>\n\nRespuesta:\n\n${messageText}`
            : undefined,
          parse_mode: "HTML",
        });
      } finally {
        try {
          await fs.unlink(tempPath);
        } catch (err) {
          // ignore cleanup errors
        }
      }
      if (sentPhoto && Array.isArray(sentPhoto.photo) && sentPhoto.photo.length > 0) {
        telegramFileId = sentPhoto.photo[sentPhoto.photo.length - 1].file_id;
      }
    } else {
      const text = `<b>🤖 Soporte</b>\n\nRespuesta:\n\n${messageText}`;
      await sendMessage(ticket.telegram_id, text, { parse_mode: "HTML" });
    }

    const msgRes = await client.query(
      `INSERT INTO ticket_messages (ticket_id, sender, message_text, telegram_file_id)
       VALUES ($1, 'ADMIN', $2, $3)
       RETURNING *`,
      [ticketId, messageText || null, telegramFileId]
    );

    await client.query("COMMIT");

    return res.json({ ok: true, message: msgRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/tickets/:id/allow-image", async (req, res, next) => {
  const ticketId = req.params.id;
  const pool = getPool();

  try {
    await ensureTicketSchema(pool);
    const ticketRes = await pool.query(
      `SELECT t.id, t.status, u.telegram_id
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId]
    );
    if (ticketRes.rowCount === 0) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }
    const ticket = ticketRes.rows[0];
    if (ticket.status !== "OPEN") {
      return res.status(400).json({ error: "TICKET_NOT_OPEN" });
    }

    const updateRes = await pool.query(
      `UPDATE tickets
       SET allow_image = true
       WHERE id = $1
       RETURNING *`,
      [ticketId]
    );

    const userLocale = await getUserLocaleByTelegramId(pool, ticket.telegram_id);
    try {
      const text =
        SUPPORT_MESSAGES[userLocale]?.image_allowed
        || SUPPORT_MESSAGES.es.image_allowed;
      await sendMessage(ticket.telegram_id, text);
    } catch (err) {
      console.error("Telegram notification failed", err);
    }

    return res.json({ ok: true, ticket: updateRes.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/tickets/:id/ban-user", async (req, res, next) => {
  const ticketId = req.params.id;
  const pool = getPool();

  try {
    await ensureSupportBanSchema(pool);
    const ticketRes = await pool.query(
      `SELECT u.telegram_id
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId]
    );
    if (ticketRes.rowCount === 0) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }
    const telegramId = ticketRes.rows[0].telegram_id;
    if (!telegramId) {
      return res.status(400).json({ error: "TELEGRAM_ID_REQUIRED" });
    }

    const banRes = await pool.query(
      "SELECT 1 FROM support_bans WHERE telegram_id = $1 LIMIT 1",
      [telegramId]
    );
    if (banRes.rowCount > 0) {
      await pool.query("DELETE FROM support_bans WHERE telegram_id = $1", [
        telegramId,
      ]);
      return res.json({ ok: true, banned: false });
    }

    await pool.query(
      "INSERT INTO support_bans (telegram_id, reason) VALUES ($1, $2)",
      [telegramId, "Banned from support tickets"]
    );

    const userLocale = await getUserLocaleByTelegramId(pool, telegramId);
    try {
      const text =
        SUPPORT_MESSAGES[userLocale]?.user_banned
        || SUPPORT_MESSAGES.es.user_banned;
      await sendMessage(telegramId, text);
    } catch (err) {
      console.error("Telegram notification failed", err);
    }

    return res.json({ ok: true, banned: true });
  } catch (error) {
    next(error);
  }
});

router.post("/tickets/:id/close", async (req, res, next) => {
  const ticketId = req.params.id;
  const pool = getPool();

  try {
    const ticketRes = await pool.query(
      `UPDATE tickets
       SET status = 'CLOSED', closed_at = now()
       WHERE id = $1
       RETURNING *`,
      [ticketId]
    );

    if (ticketRes.rowCount === 0) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }

    const userRes = await pool.query(
      `SELECT u.telegram_id
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId]
    );
    const telegramId = userRes.rows[0]?.telegram_id;
    if (telegramId) {
      const userLocale = await getUserLocaleByTelegramId(pool, telegramId);
      const text =
        SUPPORT_MESSAGES[userLocale]?.ticket_closed
        || SUPPORT_MESSAGES.es.ticket_closed;
      try {
        await sendMessage(telegramId, text);
      } catch (err) {
        console.error("Telegram notification failed", err);
      }
    }

    return res.json({ ticket: ticketRes.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/broadcasts", async (req, res, next) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const countRes = await pool.query("SELECT COUNT(*)::int AS total FROM broadcasts");
    const total = countRes.rows[0].total;

    const listRes = await pool.query(
      `SELECT b.*,
              EXISTS (
                SELECT 1
                FROM audit_logs a
                WHERE a.entity_type = 'broadcast'
                  AND a.entity_id = b.id
                  AND a.admin_action = 'BROADCAST_CUSTOM_RECIPIENTS'
              ) AS has_custom_recipients,
              EXISTS (
                SELECT 1
                FROM audit_logs a
                WHERE a.entity_type = 'broadcast'
                  AND a.entity_id = b.id
                  AND a.admin_action = 'BROADCAST_GROUP_CHATS'
              ) AS has_group_recipients,
              COALESCE(send_stats.sent_count, 0) AS last_sent_count,
              COALESCE(send_stats.failed_count, 0) AS last_failed_count,
              COALESCE(send_stats.target_count, 0) AS last_target_count
       FROM broadcasts b
       LEFT JOIN LATERAL (
         SELECT
           NULLIF(a.meta->>'sent_count', '')::int AS sent_count,
           NULLIF(a.meta->>'failed_count', '')::int AS failed_count,
           NULLIF(a.meta->>'target_count', '')::int AS target_count
         FROM audit_logs a
         WHERE a.entity_type = 'broadcast'
           AND a.entity_id = b.id
           AND a.admin_action = 'BROADCAST_SEND_RESULT'
         ORDER BY a.created_at DESC
         LIMIT 1
       ) send_stats ON TRUE
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    const items = listRes.rows.map((row) => ({
      ...row,
      segment: mapBroadcastSegment(
        row.segment,
        row.has_custom_recipients || row.has_group_recipients
      ),
    }));

    return res.json({
      items,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 1,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/broadcasts/:id", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query("SELECT * FROM broadcasts WHERE id = $1", [
      broadcastId,
    ]);

    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }

    const auditRes = await pool.query(
      `SELECT admin_action, meta
       FROM audit_logs
       WHERE entity_type = 'broadcast'
         AND entity_id = $1
         AND admin_action IN (
           'BROADCAST_CUSTOM_RECIPIENTS',
           'BROADCAST_GROUP_CHATS',
           'BROADCAST_EXCLUDED_RECIPIENTS',
           'BROADCAST_SEND_RESULT'
         )
       ORDER BY created_at DESC`,
      [broadcastId]
    );

    let customTelegramIds = [];
    let groupChatIds = [];
    let excludedIds = [];
    let sendResult = null;
    for (const row of auditRes.rows) {
      const action = row?.admin_action;
      const meta = row?.meta || {};
      if (action === "BROADCAST_CUSTOM_RECIPIENTS" && customTelegramIds.length === 0) {
        customTelegramIds = Array.isArray(meta.telegram_ids) ? meta.telegram_ids : [];
      }
      if (action === "BROADCAST_GROUP_CHATS" && groupChatIds.length === 0) {
        groupChatIds = Array.isArray(meta.chat_ids) ? meta.chat_ids : [];
      }
      if (action === "BROADCAST_EXCLUDED_RECIPIENTS" && excludedIds.length === 0) {
        excludedIds = Array.isArray(meta.except_ids) ? meta.except_ids : [];
      }
      if (!sendResult && action === "BROADCAST_SEND_RESULT") {
        sendResult = {
          target_count: Number(meta.target_count || 0),
          sent_count: Number(meta.sent_count || 0),
          failed_count: Number(meta.failed_count || 0),
        };
      }
    }

    const broadcast = broadcastRes.rows[0];

    return res.json({
      broadcast: {
        ...broadcast,
        segment: mapBroadcastSegment(
          broadcast.segment,
          customTelegramIds.length > 0 || groupChatIds.length > 0
        ),
        telegram_ids: customTelegramIds,
        chat_ids: groupChatIds,
        except_ids: excludedIds,
        last_result: sendResult,
        // Back-compat alias (deprecated):
        custom_telegram_ids: customTelegramIds,
      },
      progress: buildBroadcastProgressPayload(broadcast, sendResult),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/broadcasts/:id/progress", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query(
      `SELECT id, status, progress_status, progress_target_count, progress_sent_count,
              progress_failed_count, progress_cursor, progress_last_error,
              progress_started_at, progress_updated_at
       FROM broadcasts
       WHERE id = $1`,
      [broadcastId]
    );

    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }

    const broadcast = broadcastRes.rows[0];
    const sendResult = await getLatestBroadcastSendResult(pool, broadcastId);

    return res.json({
      broadcast_id: broadcastId,
      status: broadcast.status,
      progress: buildBroadcastProgressPayload(broadcast, sendResult),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/broadcasts/:id/pause", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const updateRes = await pool.query(
      `UPDATE broadcasts
       SET progress_status = CASE
             WHEN progress_status = 'QUEUED' THEN 'PAUSED'
             WHEN progress_status = 'SENDING' THEN 'PAUSING'
             ELSE progress_status
           END,
           progress_lease_token = CASE
             WHEN progress_status = 'QUEUED' THEN NULL
             ELSE progress_lease_token
           END,
           progress_lease_expires_at = CASE
             WHEN progress_status = 'QUEUED' THEN NULL
             ELSE progress_lease_expires_at
           END,
           progress_last_error = NULL,
           progress_updated_at = now()
       WHERE id = $1
         AND progress_status IN ('QUEUED', 'SENDING', 'PAUSED', 'PAUSING')
       RETURNING *`,
      [broadcastId]
    );

    if (updateRes.rowCount === 0) {
      const existsRes = await pool.query("SELECT 1 FROM broadcasts WHERE id = $1", [broadcastId]);
      if (existsRes.rowCount === 0) {
        return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
      }
      return res.status(409).json({ error: "BROADCAST_NOT_PAUSABLE" });
    }

    return res.json({
      ok: true,
      broadcast: updateRes.rows[0],
      progress: buildBroadcastProgressPayload(updateRes.rows[0]),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/broadcasts/:id/resume", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const updateRes = await pool.query(
      `UPDATE broadcasts
       SET progress_status = 'QUEUED',
           progress_last_error = NULL,
           progress_lease_token = NULL,
           progress_lease_expires_at = NULL,
           progress_updated_at = now()
       WHERE id = $1
         AND progress_status = 'PAUSED'
       RETURNING *`,
      [broadcastId]
    );

    if (updateRes.rowCount === 0) {
      const currentRes = await pool.query(
        "SELECT progress_status FROM broadcasts WHERE id = $1",
        [broadcastId]
      );
      if (currentRes.rowCount === 0) {
        return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
      }
      const currentStatus = String(currentRes.rows[0]?.progress_status || "").toUpperCase();
      if (["QUEUED", "SENDING", "PAUSING", "STOPPING"].includes(currentStatus)) {
        return res.status(409).json({ error: "BROADCAST_ALREADY_SENDING" });
      }
      return res.status(409).json({ error: "BROADCAST_NOT_PAUSED" });
    }

    scheduleBroadcastSendJob(pool, broadcastId);

    return res.json({
      ok: true,
      broadcast: updateRes.rows[0],
      progress: buildBroadcastProgressPayload(updateRes.rows[0]),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/broadcasts/:id/stop", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const updateRes = await pool.query(
      `UPDATE broadcasts
       SET status = CASE
             WHEN progress_status IN ('QUEUED', 'PAUSED') THEN 'FAILED'
             ELSE status
           END::broadcast_status,
           sent_at = CASE
             WHEN progress_status IN ('QUEUED', 'PAUSED') THEN now()
             ELSE sent_at
           END,
           progress_status = CASE
             WHEN progress_status IN ('QUEUED', 'PAUSED') THEN 'STOPPED'
             WHEN progress_status IN ('SENDING', 'PAUSING') THEN 'STOPPING'
             ELSE progress_status
           END,
           progress_last_error = 'Stopped manually by admin',
           progress_lease_token = CASE
             WHEN progress_status IN ('QUEUED', 'PAUSED') THEN NULL
             ELSE progress_lease_token
           END,
           progress_lease_expires_at = CASE
             WHEN progress_status IN ('QUEUED', 'PAUSED') THEN NULL
             ELSE progress_lease_expires_at
           END,
           progress_updated_at = now()
       WHERE id = $1
         AND progress_status IN ('QUEUED', 'SENDING', 'PAUSED', 'PAUSING', 'STOPPING', 'STOPPED')
       RETURNING *`,
      [broadcastId]
    );

    if (updateRes.rowCount === 0) {
      const existsRes = await pool.query("SELECT 1 FROM broadcasts WHERE id = $1", [broadcastId]);
      if (existsRes.rowCount === 0) {
        return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
      }
      return res.status(409).json({ error: "BROADCAST_NOT_STOPPABLE" });
    }

    return res.json({
      ok: true,
      broadcast: updateRes.rows[0],
      progress: buildBroadcastProgressPayload(updateRes.rows[0]),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/broadcasts/:id/image", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    const broadcastRes = await pool.query(
      "SELECT image_path, image_filename, image_mime FROM broadcasts WHERE id = $1",
      [broadcastId]
    );
    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }
    const broadcast = broadcastRes.rows[0];
    if (!broadcast.image_path) {
      return res.status(404).json({ error: "BROADCAST_IMAGE_NOT_FOUND" });
    }

    const uploadsDir = path.resolve(__dirname, "..", "..", "uploads", "broadcasts");
    const filePath = path.resolve(String(broadcast.image_path));
    if (!filePath.startsWith(`${uploadsDir}${path.sep}`)) {
      return res.status(404).json({ error: "BROADCAST_IMAGE_NOT_FOUND" });
    }

    const fileBuffer = await fs.readFile(filePath);
    res.setHeader(
      "Content-Type",
      broadcast.image_mime && String(broadcast.image_mime).trim()
        ? String(broadcast.image_mime).trim()
        : "image/jpeg"
    );
    if (broadcast.image_filename) {
      res.setHeader("Content-Disposition", `inline; filename="${broadcast.image_filename}"`);
    }
    return res.send(fileBuffer);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return res.status(404).json({ error: "BROADCAST_IMAGE_NOT_FOUND" });
    }
    return next(error);
  }
});

router.patch("/broadcasts/:id", async (req, res, next) => {
  const broadcastId = req.params.id;
  const messageText = req.body && req.body.message !== undefined
    ? String(req.body.message).trim()
    : null;
  const hasMessageEntitiesInput = Boolean(
    req.body && Object.prototype.hasOwnProperty.call(req.body, "message_entities")
  );
  const messageEntities = hasMessageEntitiesInput
    ? normalizeBroadcastMessageEntities(req.body.message_entities)
    : null;
  const rawSegment = req.body && req.body.segment ? String(req.body.segment).trim() : "";
  const imageDataUrl = req.body && req.body.image_data_url
    ? String(req.body.image_data_url).trim()
    : "";
  const mediaFileId = req.body && req.body.media_file_id
    ? String(req.body.media_file_id).trim()
    : "";
  const mediaKind = normalizeBroadcastMediaKind(req.body && req.body.media_kind);
  const clearImage = Boolean(req.body && req.body.clear_image);
  const hasButtonsInput = Boolean(
    req.body && Object.prototype.hasOwnProperty.call(req.body, "buttons")
  );
  const buttons = hasButtonsInput ? normalizeBroadcastButtons(req.body.buttons) : [];
  const savedFlag = typeof req.body?.saved === "boolean" ? req.body.saved : null;
  const hasSavedKindInput = Boolean(
    req.body && Object.prototype.hasOwnProperty.call(req.body, "saved_kind")
  );
  const hasExceptIdsInput = Boolean(req.body && Object.prototype.hasOwnProperty.call(req.body, "except_ids"));
  const exceptIds = hasExceptIdsInput ? normalizeChatIds(req.body.except_ids) : [];

  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query("SELECT * FROM broadcasts WHERE id = $1", [
      broadcastId,
    ]);
    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }

    const broadcast = broadcastRes.rows[0];
    const imagePayload = imageDataUrl ? parseImageDataUrl(imageDataUrl) : null;
    if (imageDataUrl && mediaFileId) {
      return res.status(400).json({ error: "MEDIA_CONFLICT" });
    }
    if (imageDataUrl && !imagePayload) {
      return res.status(400).json({ error: "IMAGE_INVALID" });
    }
    if (mediaFileId && !mediaKind) {
      return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
    }
    if (imagePayload && imagePayload.buffer.length > 6 * 1024 * 1024) {
      return res.status(400).json({ error: "IMAGE_TOO_LARGE" });
    }

    const nextMessage = messageText !== null ? messageText : broadcast.message_text;
    const normalizedSegment = rawSegment ? normalizeBroadcastSegmentInput(rawSegment) : "";
    const nextSegment = normalizedSegment || broadcast.segment;
    const nextButtons = hasButtonsInput ? buttons : (Array.isArray(broadcast.buttons) ? broadcast.buttons : []);
    const nextSavedKind = hasSavedKindInput
      ? normalizeSavedKind(req.body.saved_kind, nextButtons)
      : hasButtonsInput
      ? normalizeSavedKind(null, nextButtons)
      : normalizeSavedKind(broadcast.saved_kind, nextButtons);
    const hasImage = Boolean(broadcast.image_path) && !clearImage;
    if (!nextMessage && !hasImage && !imagePayload && !mediaFileId) {
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }

    const isGroups = nextSegment === "GROUPS";
    const isChannels = nextSegment === "CHANNELS";
    const destination = isGroups || isChannels ? "CHAT" : "DM";

    const updateRes = await pool.query(
      `UPDATE broadcasts
       SET message_text = $1,
           message_entities = COALESCE($8::jsonb, message_entities),
           segment = $2,
           destination = $3,
           buttons = $4::jsonb,
           saved = COALESCE($5, saved),
           saved_kind = $9,
           image_path = CASE WHEN $6 THEN NULL ELSE image_path END,
           image_filename = CASE WHEN $6 THEN NULL ELSE image_filename END,
           image_mime = CASE WHEN $6 THEN NULL ELSE image_mime END
       WHERE id = $7
       RETURNING *`,
      [
        nextMessage,
        nextSegment,
        destination,
        JSON.stringify(nextButtons),
        savedFlag,
        clearImage,
        broadcastId,
        hasMessageEntitiesInput ? JSON.stringify(messageEntities) : null,
        nextSavedKind,
      ]
    );

    let updated = updateRes.rows[0];
    if (mediaFileId) {
      const mediaRes = await pool.query(
        `UPDATE broadcasts
         SET image_path = $1, image_filename = NULL, image_mime = $2
         WHERE id = $3
         RETURNING *`,
        [`tgfile:${mediaFileId}`, `tg:${mediaKind}`, updated.id]
      );
      updated = mediaRes.rows[0];
    } else if (imagePayload) {
      const uploadsDir = path.resolve(__dirname, "..", "..", "uploads", "broadcasts");
      await fs.mkdir(uploadsDir, { recursive: true });
      const extension = getImageExtension(imagePayload.mime);
      const filename = `broadcast-${updated.id}.${extension}`;
      const filePath = path.join(uploadsDir, filename);
      await fs.writeFile(filePath, imagePayload.buffer);
      const imageRes = await pool.query(
        `UPDATE broadcasts
         SET image_path = $1, image_filename = $2, image_mime = $3
         WHERE id = $4
         RETURNING *`,
        [filePath, filename, imagePayload.mime, updated.id]
      );
      updated = imageRes.rows[0];
    }

    if (nextSegment === "ALL" && hasExceptIdsInput) {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "BROADCAST_EXCLUDED_RECIPIENTS",
          "broadcast",
          updated.id,
          JSON.stringify({ except_ids: exceptIds }),
        ]
      );
    }

    return res.json({
      broadcast: {
        ...updated,
        segment: mapBroadcastSegment(updated.segment, updated.segment === "ALL"),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/broadcasts/:id", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query(
      "DELETE FROM broadcasts WHERE id = $1 RETURNING *",
      [broadcastId]
    );
    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }
    const deleted = broadcastRes.rows[0];
    return res.json({
      ok: true,
      broadcast: {
        ...deleted,
        segment: mapBroadcastSegment(deleted.segment, deleted.segment === "ALL"),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/broadcasts", async (req, res, next) => {
  const messageText = req.body && req.body.message ? String(req.body.message).trim() : "";
  const messageEntities = normalizeBroadcastMessageEntities(req.body && req.body.message_entities);
  const rawSegment = req.body && req.body.segment ? String(req.body.segment).trim() : "ALL_USERS";
  const imageDataUrl = req.body && req.body.image_data_url
    ? String(req.body.image_data_url).trim()
    : "";
  const mediaFileId = req.body && req.body.media_file_id
    ? String(req.body.media_file_id).trim()
    : "";
  const mediaKind = normalizeBroadcastMediaKind(req.body && req.body.media_kind);
  const imagePayload = imageDataUrl ? parseImageDataUrl(imageDataUrl) : null;
  const buttons = normalizeBroadcastButtons(req.body && req.body.buttons);
  const savedKind = normalizeSavedKind(req.body && req.body.saved_kind, buttons);

  if (!messageText && !imagePayload && !mediaFileId) {
    return res.status(400).json({ error: "MESSAGE_REQUIRED" });
  }
  if (imageDataUrl && mediaFileId) {
    return res.status(400).json({ error: "MEDIA_CONFLICT" });
  }
  if (imageDataUrl && !imagePayload) {
    return res.status(400).json({ error: "IMAGE_INVALID" });
  }
  if (mediaFileId && !mediaKind) {
    return res.status(400).json({ error: "MEDIA_KIND_INVALID" });
  }
  if (imagePayload && imagePayload.buffer.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: "IMAGE_TOO_LARGE" });
  }

  const isCustom = rawSegment === "CUSTOM";
  const isGroups = rawSegment === "GROUPS";
  const isChannels = rawSegment === "CHANNELS";
  const isBuyers = rawSegment === "BUYERS";
  const isAffiliates = rawSegment === "AFFILIATES";
  if (
    !isCustom
    && !isGroups
    && !isChannels
    && !isBuyers
    && !isAffiliates
    && rawSegment !== "ALL_USERS"
    && rawSegment !== "BUYERS_AFFILIATES"
  ) {
    return res.status(400).json({ error: "SEGMENT_INVALID" });
  }

  const telegramIds = isCustom ? normalizeTelegramIds(req.body.telegram_ids) : [];
  const chatIds = isGroups || isChannels ? normalizeChatIds(req.body.chat_ids) : [];
  const exceptIds = rawSegment === "ALL_USERS" ? normalizeChatIds(req.body.except_ids) : [];
  if (isCustom && telegramIds.length === 0) {
    return res.status(400).json({ error: "TELEGRAM_IDS_REQUIRED" });
  }
  if ((isGroups || isChannels) && chatIds.length === 0) {
    return res.status(400).json({ error: "CHAT_IDS_REQUIRED" });
  }

  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query(
      `INSERT INTO broadcasts (segment, destination, message_text, buttons, message_entities, saved_kind)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING *`,
      [
        isBuyers
          ? "BUYERS"
          : isAffiliates
          ? "AFFILIATES"
          : rawSegment === "BUYERS_AFFILIATES"
          ? "BUYERS_AFFILIATES"
          : isGroups
          ? "GROUPS"
          : isChannels
          ? "CHANNELS"
          : "ALL",
        isGroups || isChannels ? "CHAT" : "DM",
        messageText,
        JSON.stringify(buttons),
        JSON.stringify(messageEntities),
        savedKind,
      ]
    );

    let broadcast = broadcastRes.rows[0];

    if (mediaFileId) {
      const updateRes = await pool.query(
        `UPDATE broadcasts
         SET image_path = $1, image_filename = NULL, image_mime = $2
         WHERE id = $3
         RETURNING *`,
        [`tgfile:${mediaFileId}`, `tg:${mediaKind}`, broadcast.id]
      );
      broadcast = updateRes.rows[0];
    } else if (imagePayload) {
      const uploadsDir = path.resolve(__dirname, "..", "..", "uploads", "broadcasts");
      await fs.mkdir(uploadsDir, { recursive: true });
      const extension = getImageExtension(imagePayload.mime);
      const filename = `broadcast-${broadcast.id}.${extension}`;
      const filePath = path.join(uploadsDir, filename);
      await fs.writeFile(filePath, imagePayload.buffer);
      const updateRes = await pool.query(
        `UPDATE broadcasts
         SET image_path = $1, image_filename = $2, image_mime = $3
         WHERE id = $4
         RETURNING *`,
        [filePath, filename, imagePayload.mime, broadcast.id]
      );
      broadcast = updateRes.rows[0];
    }

    if (isCustom) {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "BROADCAST_CUSTOM_RECIPIENTS",
          "broadcast",
          broadcast.id,
          JSON.stringify({ telegram_ids: telegramIds }),
        ]
      );
    }
    if (isGroups || isChannels) {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "BROADCAST_GROUP_CHATS",
          "broadcast",
          broadcast.id,
          JSON.stringify({ chat_ids: chatIds }),
        ]
      );
    }
    if (rawSegment === "ALL_USERS" && exceptIds.length > 0) {
      await pool.query(
        `INSERT INTO audit_logs (admin_action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "BROADCAST_EXCLUDED_RECIPIENTS",
          "broadcast",
          broadcast.id,
          JSON.stringify({ except_ids: exceptIds }),
        ]
      );
    }

    return res.status(201).json({
      broadcast: {
        ...broadcast,
        segment: mapBroadcastSegment(broadcast.segment, isCustom || isGroups || isChannels),
        telegram_ids: telegramIds,
        chat_ids: chatIds,
        except_ids: exceptIds,
        // Back-compat alias (deprecated):
        custom_telegram_ids: telegramIds,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/broadcasts/:id/send", async (req, res, next) => {
  const broadcastId = req.params.id;
  const pool = getPool();

  try {
    await ensureBroadcastSchema(pool);
    const broadcastRes = await pool.query("SELECT * FROM broadcasts WHERE id = $1", [
      broadcastId,
    ]);

    if (broadcastRes.rowCount === 0) {
      return res.status(404).json({ error: "BROADCAST_NOT_FOUND" });
    }

    const broadcast = broadcastRes.rows[0];
    const asyncRequested = Boolean(req.body && req.body.async);
    if (asyncRequested) {
      const progressStatus = String(broadcast.progress_status || "").toUpperCase();
      if (["QUEUED", "SENDING", "PAUSING", "STOPPING", "PAUSED"].includes(progressStatus)) {
        return res.status(409).json({ error: "BROADCAST_ALREADY_SENDING" });
      }

      const { recipientIds } = await resolveBroadcastRecipients(
        pool,
        broadcastId,
        broadcast,
        req.body || {}
      );

      await pool.query(
        `UPDATE broadcasts
         SET progress_status = 'QUEUED',
             progress_target_count = $2,
             progress_sent_count = 0,
             progress_failed_count = 0,
             progress_cursor = 0,
             progress_recipients = $3::jsonb,
             progress_last_error = NULL,
             progress_lease_token = NULL,
             progress_lease_expires_at = NULL,
             progress_started_at = now(),
             progress_updated_at = now()
         WHERE id = $1`,
        [broadcastId, recipientIds.length, JSON.stringify(recipientIds)]
      );

      scheduleBroadcastSendJob(pool, broadcastId);

      const queuedRes = await pool.query("SELECT * FROM broadcasts WHERE id = $1", [
        broadcastId,
      ]);
      return res.status(202).json({
        ok: true,
        broadcast: queuedRes.rows[0],
        progress: buildBroadcastProgressPayload(queuedRes.rows[0]),
      });
    }

    const { recipientIds, isCustom, isGroups, isChannels } = await resolveBroadcastRecipients(
      pool,
      broadcastId,
      broadcast,
      req.body || {}
    );
    const sendOutcome = await performBroadcastSend(pool, broadcast, recipientIds);

    return res.json({
      ok: true,
      broadcast: {
        ...sendOutcome.broadcast,
        segment: mapBroadcastSegment(
          sendOutcome.broadcast.segment,
          isCustom || isGroups || isChannels
        ),
      },
      result: sendOutcome.result,
    });
  } catch (error) {
    next(error);
  }
});

router.startBroadcastRecoveryLoop = startBroadcastRecoveryLoop;
module.exports = router;
