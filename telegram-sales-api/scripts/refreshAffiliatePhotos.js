const { Pool } = require("pg");
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

async function getUserPhotoFileId(telegramId) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${telegramId}&limit=1`
  );
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  const photos = payload?.result?.photos || [];
  if (!photos.length || !photos[0].length) {
    return null;
  }
  return photos[0][photos[0].length - 1].file_id || null;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  let updated = 0;
  let total = 0;
  try {
    const res = await client.query(
      `SELECT u.id, u.telegram_id
       FROM affiliates a
       JOIN users u ON u.id = a.user_id`
    );
    total = res.rowCount;
    for (const row of res.rows) {
      const fileId = await getUserPhotoFileId(row.telegram_id);
      if (!fileId) {
        continue;
      }
      await client.query(
        "UPDATE users SET telegram_photo_file_id = $1 WHERE id = $2",
        [fileId, row.id]
      );
      updated += 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`Updated ${updated} of ${total} affiliates.`);
}

main().catch((err) => {
  console.error("Refresh failed", err);
  process.exit(1);
});
