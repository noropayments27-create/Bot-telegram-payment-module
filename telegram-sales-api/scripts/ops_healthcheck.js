#!/usr/bin/env node
const HEALTHCHECK_URL = String(process.env.HEALTHCHECK_URL || "").trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const alertChats = String(process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item && /^[0-9]+$/.test(item))
  .map((item) => Number(item));

function getApiUrl(path) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${path}`;
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  const response = await fetch(getApiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(`TELEGRAM_SEND_FAILED_${response.status}`);
  }
}

async function run() {
  if (!HEALTHCHECK_URL) {
    console.error("HEALTHCHECK_URL is required");
    process.exit(1);
  }
  const timeoutMs = Math.max(Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || "", 10) || 8000, 1000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let ok = false;
  let status = 0;
  let body = "";
  try {
    const res = await fetch(HEALTHCHECK_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "ops-healthcheck/1.0",
      },
    });
    status = res.status;
    body = await res.text();
    ok = res.ok;
  } catch (error) {
    body = error?.message || String(error);
  } finally {
    clearTimeout(timeout);
  }

  if (ok) {
    console.log(`[healthcheck] ok status=${status}`);
    process.exit(0);
  }

  const shortBody = String(body || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const text = [
    "🚨 Healthcheck fallido",
    `URL: ${HEALTHCHECK_URL}`,
    `Status: ${status || "no_response"}`,
    `Detalle: ${shortBody || "-"}`,
  ].join("\n");

  if (alertChats.length > 0 && BOT_TOKEN) {
    await Promise.all(
      alertChats.map((chatId) =>
        sendTelegramMessage(chatId, text).catch((error) => {
          console.error("[healthcheck] telegram alert failed", {
            chatId,
            message: error?.message || String(error),
          });
        })
      )
    );
  }

  console.error(`[healthcheck] failed status=${status || "no_response"} detail=${shortBody || "-"}`);
  process.exit(2);
}

run().catch((error) => {
  console.error("[healthcheck] fatal", error?.message || String(error));
  process.exit(1);
});
