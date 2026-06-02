const { notifyApiError } = require("../services/opsAlerts");
const { recordAppError } = require("../services/appErrorLogs");

const errorMiddleware = (err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  if (process.env.NODE_ENV !== 'test') {
    console.error(err);
  }

  notifyApiError(req, err, status).catch((alertError) => {
    if (process.env.NODE_ENV !== "test") {
      console.error("[ops-alert] failed to notify", alertError);
    }
  });

  recordAppError({
    source: "api",
    level: status >= 500 ? "error" : "warning",
    code: err?.code || err?.name || null,
    route: `${String(req.method || "GET").toUpperCase()} ${String(req.originalUrl || req.url || "/")}`,
    message,
    stack: err?.stack || null,
    context: {
      status,
      ip: req.ip || null,
      user_agent: req.headers?.["user-agent"] || null,
    },
  }).catch((logError) => {
    if (process.env.NODE_ENV !== "test") {
      console.error("[app-error-log] failed to persist", logError);
    }
  });

  res.status(status).json({ ok: false, error: message });
};

module.exports = errorMiddleware;
