const express = require("express");
const { getPool } = require("../db");

const router = express.Router();

function requireBotSecret(req, res, next) {
  const secret = req.header("x-bot-secret");
  const expectedSecret = process.env.BOT_TO_API_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  return next();
}

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

let ticketMessageSchemaReady = false;
async function ensureTicketMessageSchema(pool) {
  if (ticketMessageSchemaReady) {
    return;
  }
  await pool.query(
    `ALTER TABLE ticket_messages
     ADD COLUMN IF NOT EXISTS telegram_file_unique_id text`
  );
  ticketMessageSchemaReady = true;
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

async function getOrCreateUser(client, telegramId, telegramUsername) {
  const userRes = await client.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  if (userRes.rowCount > 0) {
    return userRes.rows[0];
  }

  const insertRes = await client.query(
    `INSERT INTO users (telegram_id, telegram_username)
     VALUES ($1, $2)
     RETURNING *`,
    [telegramId, telegramUsername || null]
  );
  return insertRes.rows[0];
}

router.post("/open-or-create", requireBotSecret, async (req, res, next) => {
  const telegramId = Number(req.body.telegram_id);
  const telegramUsername = req.body.telegram_username || req.body.username || null;
  const subject = (req.body.subject || "Soporte").trim();
  const messageText = req.body.message ? String(req.body.message).trim() : "";

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!subject) {
    return res.status(400).json({ error: "subject is required" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureTicketSchema(pool);
    await ensureTicketMessageSchema(pool);
    await ensureSupportBanSchema(pool);
    await client.query("BEGIN");
    const banRes = await client.query(
      "SELECT 1 FROM support_bans WHERE telegram_id = $1 LIMIT 1",
      [telegramId]
    );
    if (banRes.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "USER_BANNED" });
    }

    const user = await getOrCreateUser(client, telegramId, telegramUsername);

    const openTicketRes = await client.query(
      `SELECT * FROM tickets
       WHERE user_id = $1 AND status = 'OPEN'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [user.id]
    );

    if (openTicketRes.rowCount > 0) {
      const openTicket = openTicketRes.rows[0];
      const lastMsgRes = await client.query(
        `SELECT sender
         FROM ticket_messages
         WHERE ticket_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [openTicket.id]
      );
      const lastSender = lastMsgRes.rows[0]?.sender || null;
      if (!messageText) {
        if (lastSender === "USER") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "WAIT_ADMIN_REPLY",
            ticket: openTicket,
          });
        }
        await client.query("COMMIT");
        return res.status(200).json({ ticket: openTicket });
      }
      if (lastSender === "USER") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "WAIT_ADMIN_REPLY",
          ticket: openTicket,
        });
      }
      const msgRes = await client.query(
        `INSERT INTO ticket_messages (ticket_id, sender, message_text)
         VALUES ($1, 'USER', $2)
         RETURNING *`,
        [openTicket.id, messageText]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        ticket: openTicket,
        message: msgRes.rows[0],
      });
    }

    if (!messageText) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "MESSAGE_REQUIRED" });
    }

    const ticketRes = await client.query(
      `INSERT INTO tickets (user_id, status, subject, allow_image)
       VALUES ($1, 'OPEN', $2, false)
       RETURNING *`,
      [user.id, subject]
    );

    const msgRes = await client.query(
      `INSERT INTO ticket_messages (ticket_id, sender, message_text)
       VALUES ($1, 'USER', $2)
       RETURNING *`,
      [ticketRes.rows[0].id, messageText]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ticket: ticketRes.rows[0],
      message: msgRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/:id/message", requireBotSecret, async (req, res, next) => {
  const ticketId = req.params.id;
  const telegramId = Number(req.body.telegram_id);
  const messageText = req.body.message ? String(req.body.message).trim() : "";
  const telegramFileId = req.body.telegram_file_id
    ? String(req.body.telegram_file_id).trim()
    : "";
  const telegramFileUniqueId = req.body.telegram_file_unique_id
    ? String(req.body.telegram_file_unique_id).trim()
    : "";

  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  if (!messageText && !telegramFileId) {
    return res.status(400).json({ error: "message is required" });
  }

  const pool = getPool();

  try {
    await ensureTicketSchema(pool);
    await ensureTicketMessageSchema(pool);
    await ensureSupportBanSchema(pool);
    const banRes = await pool.query(
      "SELECT 1 FROM support_bans WHERE telegram_id = $1 LIMIT 1",
      [telegramId]
    );
    if (banRes.rowCount > 0) {
      return res.status(403).json({ error: "USER_BANNED" });
    }
    const ticketRes = await pool.query(
      `SELECT t.id, t.status, t.allow_image
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND u.telegram_id = $2`,
      [ticketId, telegramId]
    );

    if (ticketRes.rowCount === 0) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }

    if (ticketRes.rows[0].status !== "OPEN") {
      return res.status(400).json({ error: "TICKET_NOT_OPEN" });
    }

    if (telegramFileId) {
      const allowRes = await pool.query(
        "SELECT allow_image FROM tickets WHERE id = $1",
        [ticketId]
      );
      if (!allowRes.rows[0]?.allow_image) {
        return res.status(409).json({ error: "IMAGE_NOT_ALLOWED" });
      }
      if (!telegramFileUniqueId) {
        return res.status(400).json({ error: "telegram_file_unique_id is required" });
      }
      const duplicateRes = await pool.query(
        `SELECT 1
         FROM ticket_messages tm
         JOIN tickets t ON t.id = tm.ticket_id
         JOIN users u ON u.id = t.user_id
         WHERE u.telegram_id = $1
           AND tm.telegram_file_unique_id = $2
         LIMIT 1`,
        [telegramId, telegramFileUniqueId]
      );
      if (duplicateRes.rowCount > 0) {
        return res.status(409).json({ error: "DUPLICATE_IMAGE" });
      }
    } else {
      const lastMsgRes = await pool.query(
        `SELECT sender
         FROM ticket_messages
         WHERE ticket_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [ticketId]
      );
      if (lastMsgRes.rows[0]?.sender === "USER") {
        return res.status(409).json({ error: "WAIT_ADMIN_REPLY" });
      }
    }

    const msgRes = await pool.query(
      `INSERT INTO ticket_messages (
         ticket_id,
         sender,
         message_text,
         telegram_file_id,
         telegram_file_unique_id
       )
       VALUES ($1, 'USER', $2, $3, $4)
       RETURNING *`,
      [ticketId, messageText || null, telegramFileId || null, telegramFileUniqueId || null]
    );

    if (telegramFileId) {
      await pool.query(
        "UPDATE tickets SET allow_image = false WHERE id = $1",
        [ticketId]
      );
    }

    return res.status(201).json({ message: msgRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/active", requireBotSecret, async (req, res, next) => {
  const telegramId = Number(req.query.telegram_id);
  if (!Number.isFinite(telegramId)) {
    return res.status(400).json({ error: "telegram_id is required" });
  }
  const pool = getPool();
  try {
    await ensureTicketSchema(pool);
    const ticketRes = await pool.query(
      `SELECT t.id, t.status, t.allow_image
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE u.telegram_id = $1 AND t.status = 'OPEN'
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [telegramId]
    );
    if (ticketRes.rowCount === 0) {
      return res.json({ ticket: null });
    }
    return res.json({ ticket: ticketRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
