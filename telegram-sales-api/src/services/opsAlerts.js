const { sendMessage } = require("./telegram");

const DEFAULT_COOLDOWN_SECONDS = 300;
const lastAlertByKey = new Map();

function isEnabled() {
  return String(process.env.OPS_ALERTS_ENABLED || "").trim().toLowerCase() === "true";
}

function parseAdminTelegramIds() {
  const value = String(process.env.ADMIN_TELEGRAM_IDS || "");
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

function getClientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return forwarded[0] || req.ip || "unknown";
}

function sanitizeMessage(value, max = 300) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) {
    return "";
  }
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max)}...`;
}

function explainError(err, status) {
  const code = String(err?.code || err?.name || "").trim().toUpperCase();
  const message = String(err?.message || "").trim().toLowerCase();

  if (code === "25P02" || message.includes("current transaction is aborted")) {
    return {
      summary:
        "Una consulta SQL fallo dentro de una transaccion y la API intento ejecutar mas consultas antes de cerrar esa transaccion.",
      action:
        "Revisar el primer error SQL anterior a esta alerta; este codigo suele ser una consecuencia, no la causa inicial.",
    };
  }
  if (code === "23505") {
    return {
      summary:
        "La base de datos rechazo un registro duplicado por una regla de unicidad.",
      action:
        "Revisar si el usuario repitio la accion o si falta manejar el caso como ya procesado.",
    };
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return {
      summary:
        "La API no pudo conectarse a un servicio externo o la conexion tardo demasiado.",
      action:
        "Revisar disponibilidad del servicio externo, red y variables de entorno relacionadas.",
    };
  }
  if (Number(status) >= 500) {
    return {
      summary:
        "La API encontro un error interno mientras procesaba la solicitud.",
      action:
        "Revisar logs del servicio y la ruta indicada para ubicar la causa exacta.",
    };
  }
  return {
    summary:
      "La solicitud no pudo completarse y fue registrada para revision operativa.",
    action:
      "Revisar la ruta, el codigo y el detalle tecnico de esta alerta.",
  };
}

function translateTechnicalMessage(err, status) {
  const code = String(err?.code || err?.name || "").trim().toUpperCase();
  const message = String(err?.message || "").trim().toLowerCase();

  if (code === "25P02" || message.includes("current transaction is aborted")) {
    return "Transaccion de base de datos abortada; se intentaron ejecutar mas consultas antes de cerrarla.";
  }
  if (code === "23505") {
    return "Registro duplicado rechazado por una regla unica de la base de datos.";
  }
  if (code === "ECONNREFUSED") {
    return "Conexion rechazada por un servicio externo.";
  }
  if (code === "ETIMEDOUT") {
    return "Tiempo de espera agotado al conectar con un servicio externo.";
  }
  if (Number(status) >= 500) {
    return "Error interno del servidor.";
  }
  return "Solicitud no completada.";
}

function buildAlertKey(req, status, err) {
  const method = String(req.method || "GET").toUpperCase();
  const route = String(req.originalUrl || req.url || "/");
  const code = String(err?.code || err?.name || "ERR");
  return `${status}:${method}:${route}:${code}`;
}

function shouldSendNow(key) {
  const cooldownSeconds = Math.max(
    Number.parseInt(process.env.OPS_ALERTS_COOLDOWN_SECONDS || "", 10) || DEFAULT_COOLDOWN_SECONDS,
    10
  );
  const now = Date.now();
  const lastSent = Number(lastAlertByKey.get(key) || 0);
  if (lastSent > 0 && now - lastSent < cooldownSeconds * 1000) {
    return false;
  }
  lastAlertByKey.set(key, now);
  return true;
}

async function notifyApiError(req, err, status = 500) {
  if (!isEnabled()) {
    return;
  }
  if (Number(status) < 500) {
    return;
  }

  const admins = parseAdminTelegramIds();
  if (admins.length === 0) {
    return;
  }

  const key = buildAlertKey(req, status, err);
  if (!shouldSendNow(key)) {
    return;
  }

  const service = String(process.env.OPS_ALERTS_SERVICE || "telegram-sales-api").trim();
  const method = String(req.method || "GET").toUpperCase();
  const route = String(req.originalUrl || req.url || "/");
  const ip = getClientIp(req);
  const errorCode = sanitizeMessage(err?.code || err?.name || "-", 80);
  const explanation = explainError(err, status);
  const errorMessage = sanitizeMessage(
    explanation.summary || "La API encontro un error interno.",
    300
  );
  const actionMessage = sanitizeMessage(explanation.action || "", 300);
  const technicalMessage = sanitizeMessage(translateTechnicalMessage(err, status), 240);
  const userAgent = sanitizeMessage(req.headers?.["user-agent"] || "-", 150);

  const text = [
    "🚨 Alerta operativa",
    "",
    `Servicio: ${service}`,
    `Estado HTTP: ${status}`,
    `Ruta: ${method} ${route}`,
    `IP: ${ip}`,
    `Codigo tecnico: ${errorCode}`,
    `Que pasa: ${errorMessage}`,
    ...(actionMessage ? [`Que revisar: ${actionMessage}`] : []),
    `Detalle tecnico: ${technicalMessage}`,
    `Cliente: ${userAgent}`,
  ].join("\n");

  await Promise.all(
    admins.map((adminId) =>
      sendMessage(adminId, text).catch((sendErr) => {
        console.error("[ops-alert] telegram send failed", {
          adminId,
          message: sendErr?.message || String(sendErr),
        });
      })
    )
  );
}

module.exports = {
  notifyApiError,
};
