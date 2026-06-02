let botAssetsSchemaReady = false;

const BOT_ASSET_FIELDS = [
  "main",
  "affiliate_panel",
  "affiliate_invoice",
  "cart",
  "community",
  "shop_section",
  "support",
  "payment_methods",
  "wallet",
  "wallet_topup",
  "wallet_history",
];

const BOT_ASSET_COLUMNS = BOT_ASSET_FIELDS.flatMap((field) => [
  `${field}_image_url`,
  `${field}_image_file_id`,
]);

async function ensureBotAssetsSchema(pool) {
  if (botAssetsSchemaReady) {
    return;
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_assets (
       id int PRIMARY KEY DEFAULT 1,
       main_image_url text,
       main_image_file_id text,
       affiliate_panel_image_url text,
       affiliate_panel_image_file_id text,
       affiliate_invoice_image_url text,
       affiliate_invoice_image_file_id text,
       cart_image_url text,
       cart_image_file_id text,
       community_image_url text,
       community_image_file_id text,
       shop_section_image_url text,
       shop_section_image_file_id text,
       support_image_url text,
       support_image_file_id text,
       payment_methods_image_url text,
       payment_methods_image_file_id text,
       wallet_image_url text,
       wallet_image_file_id text,
       wallet_topup_image_url text,
       wallet_topup_image_file_id text,
       wallet_history_image_url text,
       wallet_history_image_file_id text,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `ALTER TABLE bot_assets
     ADD COLUMN IF NOT EXISTS main_image_url text,
     ADD COLUMN IF NOT EXISTS main_image_file_id text,
     ADD COLUMN IF NOT EXISTS affiliate_panel_image_url text,
     ADD COLUMN IF NOT EXISTS affiliate_panel_image_file_id text,
     ADD COLUMN IF NOT EXISTS affiliate_invoice_image_url text,
     ADD COLUMN IF NOT EXISTS affiliate_invoice_image_file_id text,
     ADD COLUMN IF NOT EXISTS cart_image_url text,
     ADD COLUMN IF NOT EXISTS cart_image_file_id text,
     ADD COLUMN IF NOT EXISTS community_image_url text,
     ADD COLUMN IF NOT EXISTS community_image_file_id text,
     ADD COLUMN IF NOT EXISTS shop_section_image_url text,
     ADD COLUMN IF NOT EXISTS shop_section_image_file_id text,
     ADD COLUMN IF NOT EXISTS support_image_url text,
     ADD COLUMN IF NOT EXISTS support_image_file_id text,
     ADD COLUMN IF NOT EXISTS payment_methods_image_url text,
     ADD COLUMN IF NOT EXISTS payment_methods_image_file_id text,
     ADD COLUMN IF NOT EXISTS wallet_image_url text,
     ADD COLUMN IF NOT EXISTS wallet_image_file_id text,
     ADD COLUMN IF NOT EXISTS wallet_topup_image_url text,
     ADD COLUMN IF NOT EXISTS wallet_topup_image_file_id text,
     ADD COLUMN IF NOT EXISTS wallet_history_image_url text,
     ADD COLUMN IF NOT EXISTS wallet_history_image_file_id text`
  );
  await pool.query(
    `INSERT INTO bot_assets (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`
  );
  botAssetsSchemaReady = true;
}

async function getBotAssets(pool) {
  await ensureBotAssetsSchema(pool);
  const res = await pool.query(
    `SELECT ${BOT_ASSET_COLUMNS.join(", ")}
     FROM bot_assets
     WHERE id = 1`
  );
  const row = res.rows[0] || {};
  return BOT_ASSET_COLUMNS.reduce((acc, key) => {
    acc[key] = row[key] || null;
    return acc;
  }, {});
}

function normalizeAssetValue(value) {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

async function setBotAssets(pool, payload) {
  await ensureBotAssetsSchema(pool);
  const updates = [];
  const values = [];
  BOT_ASSET_COLUMNS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) {
      const normalized = normalizeAssetValue(payload[key]);
      values.push(normalized);
      updates.push(`${key} = $${values.length}`);
    }
  });
  if (updates.length > 0) {
    values.push(1);
    await pool.query(
      `UPDATE bot_assets
       SET ${updates.join(", ")},
           updated_at = now()
       WHERE id = $${values.length}`,
      values
    );
  }
  return getBotAssets(pool);
}

async function setPaymentMethodsImage(pool, imageUrl) {
  const assets = await setBotAssets(pool, {
    payment_methods_image_url: imageUrl,
  });
  return assets.payment_methods_image_url || null;
}

module.exports = {
  ensureBotAssetsSchema,
  getBotAssets,
  setBotAssets,
  setPaymentMethodsImage,
};
