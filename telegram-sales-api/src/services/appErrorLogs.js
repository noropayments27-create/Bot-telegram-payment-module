const { getPool } = require("../db");

let appErrorLogSchemaReady = false;

function sanitizeText(value, maxLength = 2000) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function sanitizeContext(value) {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, innerValue) => {
        if (typeof innerValue === "string") {
          return sanitizeText(innerValue, 1000);
        }
        if (innerValue instanceof Error) {
          return {
            name: sanitizeText(innerValue.name, 120),
            message: sanitizeText(innerValue.message, 500),
            stack: sanitizeText(innerValue.stack, 2000),
          };
        }
        return innerValue;
      })
    );
  } catch (error) {
    return {
      raw: sanitizeText(String(value), 1000),
    };
  }
}

function normalizeSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (["api", "bot", "admin"].includes(source)) {
    return source;
  }
  return "";
}

function normalizeLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  if (["error", "warning", "info"].includes(level)) {
    return level;
  }
  return "error";
}

async function ensureAppErrorLogSchema(executor = null) {
  if (appErrorLogSchemaReady) {
    return;
  }
  const db = executor || getPool();
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_error_logs (
       id bigserial PRIMARY KEY,
       source text NOT NULL,
       level text NOT NULL DEFAULT 'error',
       code text,
       route text,
       message text NOT NULL,
       stack text,
       context jsonb,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_app_error_logs_source_created_at
     ON app_error_logs (source, created_at DESC)`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_app_error_logs_level_created_at
     ON app_error_logs (level, created_at DESC)`
  );
  appErrorLogSchemaReady = true;
}

async function recordAppError(entry, executor = null) {
  const db = executor || getPool();
  await ensureAppErrorLogSchema(db);

  const source = normalizeSource(entry?.source);
  const message = sanitizeText(entry?.message, 3000);
  if (!source || !message) {
    return false;
  }

  await db.query(
    `INSERT INTO app_error_logs (
       source,
       level,
       code,
       route,
       message,
       stack,
       context
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      source,
      normalizeLevel(entry?.level),
      sanitizeText(entry?.code, 120) || null,
      sanitizeText(entry?.route, 300) || null,
      message,
      sanitizeText(entry?.stack, 12000) || null,
      JSON.stringify(sanitizeContext(entry?.context)),
    ]
  );
  return true;
}

async function listAppErrors(source, limit = 10, executor = null) {
  const normalizedSource = normalizeSource(source);
  if (!normalizedSource) {
    return [];
  }
  const parsedLimit = Number.parseInt(String(limit || 10), 10);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 50)
    : 10;
  const db = executor || getPool();
  await ensureAppErrorLogSchema(db);
  const result = await db.query(
    `SELECT created_at,
            source,
            level,
            code,
            route,
            message,
            stack,
            context
     FROM app_error_logs
     WHERE source = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [normalizedSource, safeLimit]
  );
  return result.rows;
}

module.exports = {
  ensureAppErrorLogSchema,
  recordAppError,
  listAppErrors,
};
