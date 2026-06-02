const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const TELEGRAM_API_BASE = "https://api.telegram.org";

async function throwTelegramApiError(response, fallbackCode) {
  let description = "";
  try {
    const data = await response.json();
    description = String(data?.description || "").trim();
  } catch (_error) {
    try {
      const raw = await response.text();
      description = String(raw || "").trim();
    } catch (_ignored) {
      description = "";
    }
  }
  const safeDescription = description || `HTTP_${response.status}`;
  const error = new Error(`${fallbackCode}: ${safeDescription}`);
  error.code = fallbackCode;
  error.status = Number(response?.status || 0) || 0;
  error.description = safeDescription;
  throw error;
}

function getToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  return token;
}

async function getFilePath(fileId) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(
    fileId
  )}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!data.ok || !data.result || !data.result.file_path) {
    throw new Error("TELEGRAM_GET_FILE_FAILED");
  }

  return data.result.file_path;
}

async function downloadFile(filePath) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("TELEGRAM_FILE_DOWNLOAD_FAILED");
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType =
    response.headers.get("content-type") || "application/octet-stream";

  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function sendMessage(telegramId, text, options = {}) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: telegramId, text, ...options }),
  });

  if (!response.ok) {
    throw new Error("TELEGRAM_SEND_FAILED");
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error("TELEGRAM_SEND_FAILED");
  }

  return data.result;
}

async function deleteMessage(telegramId, messageId) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/deleteMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: telegramId, message_id: messageId }),
  });

  if (!response.ok) {
    throw new Error("TELEGRAM_DELETE_FAILED");
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error("TELEGRAM_DELETE_FAILED");
  }

  return true;
}

async function sendMultipart(
  telegramId,
  endpoint,
  fieldName,
  filePath,
  filename,
  extraFields = {}
) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${endpoint}`;
  const buffer = await fs.readFile(filePath);
  const hasFormData = typeof FormData !== "undefined" && typeof Blob !== "undefined";
  let response;

  if (hasFormData) {
    const form = new FormData();
    form.append("chat_id", String(telegramId));
    Object.entries(extraFields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        form.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    });
    form.append(fieldName, new Blob([buffer]), filename);
    response = await fetch(url, {
      method: "POST",
      body: form,
    });
  } else {
    const boundary = `----tg-${crypto.randomBytes(8).toString("hex")}`;
    const parts = [
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
        `${telegramId}\r\n`,
    ];
    Object.entries(extraFields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        parts.push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            `${serialized}\r\n`
        );
      }
    });
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(parts.join(""), "utf8"),
      buffer,
      Buffer.from(footer, "utf8"),
    ]);
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  }

  if (!response.ok) {
    await throwTelegramApiError(response, "TELEGRAM_SEND_FAILED");
  }

  const data = await response.json();
  if (!data.ok) {
    const error = new Error(
      `TELEGRAM_SEND_FAILED: ${String(data?.description || "UNKNOWN").trim()}`
    );
    error.code = "TELEGRAM_SEND_FAILED";
    error.description = String(data?.description || "").trim();
    throw error;
  }

  return data.result;
}

async function sendMedia(telegramId, endpoint, fieldName, payload) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${endpoint}`;
  const extraFields = {};
  if (payload.caption) {
    extraFields.caption = payload.caption;
  }
  if (payload.parse_mode) {
    extraFields.parse_mode = payload.parse_mode;
  }
  if (payload.caption_entities) {
    extraFields.caption_entities = payload.caption_entities;
  }
  if (payload.reply_markup) {
    extraFields.reply_markup = payload.reply_markup;
  }

  if (payload.file_id || payload.url) {
    const body = {
      chat_id: telegramId,
      [fieldName]: payload.file_id || payload.url,
      ...extraFields,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      await throwTelegramApiError(response, "TELEGRAM_SEND_FAILED");
    }
    const data = await response.json();
    if (!data.ok) {
      const error = new Error(
        `TELEGRAM_SEND_FAILED: ${String(data?.description || "UNKNOWN").trim()}`
      );
      error.code = "TELEGRAM_SEND_FAILED";
      error.description = String(data?.description || "").trim();
      throw error;
    }
    return data.result;
  }

  if (payload.path) {
    const filename =
      payload.filename || path.basename(payload.path) || "archivo";
    return sendMultipart(
      telegramId,
      endpoint,
      fieldName,
      payload.path,
      filename,
      extraFields
    );
  }

  throw new Error("TELEGRAM_MEDIA_NOT_FOUND");
}

async function sendDocument(telegramId, payload) {
  return sendMedia(telegramId, "sendDocument", "document", payload);
}

async function sendPhoto(telegramId, payload) {
  return sendMedia(telegramId, "sendPhoto", "photo", payload);
}

async function sendVideo(telegramId, payload) {
  return sendMedia(telegramId, "sendVideo", "video", payload);
}

async function sendAnimation(telegramId, payload) {
  return sendMedia(telegramId, "sendAnimation", "animation", payload);
}

async function sendSticker(telegramId, payload) {
  return sendMedia(telegramId, "sendSticker", "sticker", payload);
}

async function editMessageCaption(telegramId, messageId, caption, options = {}) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageCaption`;
  const body = {
    chat_id: telegramId,
    message_id: messageId,
    caption,
  };
  if (options.parse_mode) {
    body.parse_mode = options.parse_mode;
  }
  if (options.reply_markup) {
    body.reply_markup = options.reply_markup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("TELEGRAM_EDIT_FAILED");
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error("TELEGRAM_EDIT_FAILED");
  }
  return data.result;
}

async function editMessageText(telegramId, messageId, text, options = {}) {
  const token = getToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageText`;
  const body = {
    chat_id: telegramId,
    message_id: messageId,
    text,
  };
  if (options.parse_mode) {
    body.parse_mode = options.parse_mode;
  }
  if (options.reply_markup) {
    body.reply_markup = options.reply_markup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("TELEGRAM_EDIT_FAILED");
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error("TELEGRAM_EDIT_FAILED");
  }
  return data.result;
}

module.exports = {
  getFilePath,
  downloadFile,
  deleteMessage,
  sendMessage,
  sendDocument,
  sendPhoto,
  sendVideo,
  sendAnimation,
  sendSticker,
  editMessageCaption,
  editMessageText,
};
