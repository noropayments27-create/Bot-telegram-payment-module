const { getPool } = require("../db");

let publishTargetsSchemaReady = false;
let publishTargetsSchemaPromise = null;

function normalizeChatType(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "group" || key === "supergroup" || key === "channel") {
    return key;
  }
  return "group";
}

async function ensurePublishTargetsSchema(executor = null) {
  if (publishTargetsSchemaReady) {
    return;
  }
  if (publishTargetsSchemaPromise) {
    await publishTargetsSchemaPromise;
    return;
  }
  const db = executor || getPool();
  publishTargetsSchemaPromise = (async () => {
    await db.query(
      `CREATE TABLE IF NOT EXISTS publish_targets (
         chat_id bigint PRIMARY KEY,
         chat_type text NOT NULL,
         chat_title text,
         chat_username text,
         is_active boolean NOT NULL DEFAULT true,
         bot_is_admin boolean NOT NULL DEFAULT false,
         last_seen_at timestamptz NOT NULL DEFAULT now(),
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_publish_targets_active_type
       ON publish_targets (is_active, bot_is_admin, chat_type, updated_at DESC)`
    );
  })();
  try {
    await publishTargetsSchemaPromise;
    publishTargetsSchemaReady = true;
  } finally {
    publishTargetsSchemaPromise = null;
  }
}

async function upsertPublishTarget(
  executor,
  {
    chatId,
    chatType,
    chatTitle = null,
    chatUsername = null,
    isActive = true,
    botIsAdmin = false,
  }
) {
  await ensurePublishTargetsSchema(executor);
  const db = executor || getPool();
  const normalizedChatId = Number.parseInt(String(chatId || ""), 10);
  if (!Number.isFinite(normalizedChatId)) {
    throw new Error("INVALID_CHAT_ID");
  }
  const res = await db.query(
    `INSERT INTO publish_targets (
       chat_id,
       chat_type,
       chat_title,
       chat_username,
       is_active,
       bot_is_admin,
       last_seen_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (chat_id)
     DO UPDATE SET
       chat_type = EXCLUDED.chat_type,
       chat_title = COALESCE(NULLIF(EXCLUDED.chat_title, ''), publish_targets.chat_title),
       chat_username = COALESCE(NULLIF(EXCLUDED.chat_username, ''), publish_targets.chat_username),
       is_active = EXCLUDED.is_active,
       bot_is_admin = (publish_targets.bot_is_admin OR EXCLUDED.bot_is_admin),
       last_seen_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      normalizedChatId,
      normalizeChatType(chatType),
      chatTitle ? String(chatTitle).trim() : null,
      chatUsername ? String(chatUsername).replace(/^@+/, "").trim() : null,
      Boolean(isActive),
      Boolean(botIsAdmin),
    ]
  );
  return res.rows[0] || null;
}

async function listPublishTargets(
  executor,
  { scope = "all", activeOnly = true, adminOnly = true, limit = 200 } = {}
) {
  await ensurePublishTargetsSchema(executor);
  const db = executor || getPool();
  const where = [];
  const values = [];
  const normalizedScope = String(scope || "all").trim().toLowerCase();

  if (activeOnly) {
    where.push(`is_active = true`);
  }
  if (adminOnly) {
    where.push(`bot_is_admin = true`);
  }
  if (normalizedScope === "groups") {
    where.push(`chat_type IN ('group', 'supergroup')`);
  } else if (normalizedScope === "channels") {
    where.push(`chat_type = 'channel'`);
  }
  const safeLimit = Math.max(Math.min(Number(limit || 200), 500), 1);
  values.push(safeLimit);

  const res = await db.query(
    `SELECT chat_id, chat_type, chat_title, chat_username, is_active, bot_is_admin, last_seen_at, created_at, updated_at
     FROM publish_targets
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY chat_type ASC, COALESCE(chat_title, '') ASC, updated_at DESC
     LIMIT $1`,
    values
  );
  return res.rows || [];
}

async function getPublishTargetSummary(executor) {
  await ensurePublishTargetsSchema(executor);
  const db = executor || getPool();
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active = true AND bot_is_admin = true) AS total,
       COUNT(*) FILTER (WHERE is_active = true AND bot_is_admin = true AND chat_type IN ('group', 'supergroup')) AS groups_total,
       COUNT(*) FILTER (WHERE is_active = true AND bot_is_admin = true AND chat_type = 'channel') AS channels_total
     FROM publish_targets`
  );
  return res.rows[0] || { total: 0, groups_total: 0, channels_total: 0 };
}

module.exports = {
  ensurePublishTargetsSchema,
  upsertPublishTarget,
  listPublishTargets,
  getPublishTargetSummary,
};
