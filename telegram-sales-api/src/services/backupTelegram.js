const path = require("path");
const { sendDocument } = require("./telegram");

function isTelegramBackupEnabled() {
  return String(process.env.BACKUP_TELEGRAM_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

function parseIds(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => Number.parseInt(String(value || "").trim(), 10))
    .filter(Number.isFinite);
}

function resolveTelegramTargets() {
  const explicit = String(process.env.BACKUP_TELEGRAM_CHAT_IDS || "").trim();
  const fallback = String(process.env.ADMIN_TELEGRAM_IDS || "").trim();
  const explicitIds = parseIds(explicit);
  const fallbackIds = parseIds(fallback);
  if (explicitIds.length > 0) {
    return {
      primary: explicitIds,
      fallback: fallbackIds.filter((id) => !explicitIds.includes(id)),
    };
  }
  return {
    primary: fallbackIds,
    fallback: [],
  };
}

function parseTelegramChatIds() {
  return resolveTelegramTargets().primary;
}

async function sendToChats(chatIds, payloadBuilder) {
  const delivered = [];
  const failed = [];
  for (const chatId of chatIds) {
    try {
      const message = await sendDocument(chatId, payloadBuilder(chatId));
      delivered.push({
        chat_id: chatId,
        message_id: Number(message?.message_id || 0) || null,
      });
    } catch (error) {
      failed.push({
        chat_id: chatId,
        error: error?.message || "TELEGRAM_SEND_FAILED",
      });
    }
  }
  return { delivered, failed };
}

async function uploadBackupFileToTelegram(filePath, options = {}) {
  const absoluteFilePath = path.resolve(filePath);
  const targets = resolveTelegramTargets();
  if (targets.primary.length === 0) {
    throw new Error("BACKUP_TELEGRAM_CHAT_IDS_MISSING");
  }

  const filename = String(options.filename || "").trim() || path.basename(absoluteFilePath);
  const captionPrefix = String(process.env.BACKUP_TELEGRAM_CAPTION_PREFIX || "Backup DB")
    .trim()
    .slice(0, 128);
  const caption = `${captionPrefix}: ${filename}`.trim();

  const payloadBuilder = () => ({
    path: absoluteFilePath,
    filename,
    caption,
  });

  const primaryResult = await sendToChats(targets.primary, payloadBuilder);
  const delivered = [...primaryResult.delivered];
  const failed = [...primaryResult.failed];
  let fallbackUsed = false;

  if (delivered.length === 0 && targets.fallback.length > 0) {
    fallbackUsed = true;
    const fallbackResult = await sendToChats(targets.fallback, payloadBuilder);
    delivered.push(...fallbackResult.delivered);
    failed.push(...fallbackResult.failed);
  }

  return {
    uploaded: delivered.length > 0,
    partial: delivered.length > 0 && failed.length > 0,
    fallback_used: fallbackUsed,
    delivered_count: delivered.length,
    failed_count: failed.length,
    delivered,
    failed,
  };
}

module.exports = {
  isTelegramBackupEnabled,
  parseTelegramChatIds,
  uploadBackupFileToTelegram,
};
