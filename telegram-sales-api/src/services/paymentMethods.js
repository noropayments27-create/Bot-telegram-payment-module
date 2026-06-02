const DEFAULT_METHODS = [
  { key: "NEQUI", label: "Nequi", sort_order: 1 },
  { key: "BINANCE_ID", label: "Binance ID", sort_order: 2 },
  { key: "CRYPTO", label: "Cripto", sort_order: 3 },
  { key: "MERCADOPAGO", label: "Mercado pago", sort_order: 4 },
  { key: "PAYPAL", label: "Paypal", sort_order: 5 },
];

const FALLBACK_NEQUI_NUMBER = process.env.NEQUI_NUMBER || "";
const FALLBACK_NEQUI_NAME = process.env.NEQUI_NAME || "";
const FALLBACK_BINANCE_ID = process.env.BINANCE_ID || "";
const FALLBACK_MERCADOPAGO_ACCOUNT = process.env.MERCADOPAGO_ACCOUNT || "";
const FALLBACK_PAYPAL_ACCOUNT = process.env.PAYPAL_ACCOUNT || "";
const FALLBACK_CRYPTO_BTC = process.env.CRYPTO_WALLET_BTC || "";
const FALLBACK_CRYPTO_USDT_TRON = process.env.CRYPTO_WALLET_USDT_TRON || "";
const FALLBACK_CRYPTO_USDT_BSC = process.env.CRYPTO_WALLET_USDT_BSC || "";
const FALLBACK_CRYPTO_LTC = process.env.CRYPTO_WALLET_LTC || "";

function buildMethodFallbackDestination(methodKey) {
  const key = normalizeMethodKey(methodKey);
  if (!key) return null;
  if (key === "NEQUI") {
    const parts = [];
    if (FALLBACK_NEQUI_NUMBER) parts.push(`Numero: ${FALLBACK_NEQUI_NUMBER}`);
    if (FALLBACK_NEQUI_NAME) parts.push(`Nombre: ${FALLBACK_NEQUI_NAME}`);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (key === "BINANCE_ID") {
    return FALLBACK_BINANCE_ID ? `ID: ${FALLBACK_BINANCE_ID}` : null;
  }
  if (key === "MERCADOPAGO") {
    return FALLBACK_MERCADOPAGO_ACCOUNT || null;
  }
  if (key === "PAYPAL") {
    return FALLBACK_PAYPAL_ACCOUNT ? `Cuenta: ${FALLBACK_PAYPAL_ACCOUNT}` : null;
  }
  if (key === "CRYPTO") {
    const payload = {
      btc: FALLBACK_CRYPTO_BTC || "",
      usdt_tron: FALLBACK_CRYPTO_USDT_TRON || "",
      usdt_bsc: FALLBACK_CRYPTO_USDT_BSC || "",
      ltc: FALLBACK_CRYPTO_LTC || "",
    };
    const hasAny = Object.values(payload).some((value) => Boolean(String(value).trim()));
    return hasAny ? JSON.stringify(payload) : null;
  }
  return null;
}

async function ensurePaymentMethodsSchema(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS payment_methods (
       method_key text PRIMARY KEY,
       label text,
       description text,
       destination text,
       asset_images text,
       asset_file_ids text,
       image_url text,
       image_file_id text,
       markup text,
       sort_order int,
       enabled boolean NOT NULL DEFAULT true,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `ALTER TABLE payment_methods
     ADD COLUMN IF NOT EXISTS label text,
     ADD COLUMN IF NOT EXISTS description text,
     ADD COLUMN IF NOT EXISTS destination text,
     ADD COLUMN IF NOT EXISTS asset_images text,
     ADD COLUMN IF NOT EXISTS asset_file_ids text,
     ADD COLUMN IF NOT EXISTS image_url text,
     ADD COLUMN IF NOT EXISTS image_file_id text,
     ADD COLUMN IF NOT EXISTS markup text,
     ADD COLUMN IF NOT EXISTS sort_order int`
  );
  const values = [];
  const placeholders = DEFAULT_METHODS.map((item, idx) => {
    const base = idx * 3;
    values.push(item.key, item.label, item.sort_order);
    return `($${base + 1}, $${base + 2}, $${base + 3}, true)`;
  }).join(", ");
  if (values.length > 0) {
    await pool.query(
      `INSERT INTO payment_methods (method_key, label, sort_order, enabled)
       VALUES ${placeholders}
       ON CONFLICT (method_key) DO NOTHING`,
      values
    );
  }
  // Backfill missing values from legacy bot defaults without overriding existing custom settings.
  for (const item of DEFAULT_METHODS) {
    const fallbackDestination = buildMethodFallbackDestination(item.key);
    await pool.query(
      `UPDATE payment_methods
       SET label = CASE
             WHEN label IS NULL OR btrim(label) = '' THEN $2
             ELSE label
           END,
           sort_order = COALESCE(sort_order, $3),
           destination = CASE
             WHEN (destination IS NULL OR btrim(destination) = '')
               AND $4::text IS NOT NULL
               AND btrim(COALESCE($4::text, '')) <> ''
             THEN $4::text
             ELSE destination
           END,
           updated_at = now()
       WHERE method_key = $1`,
      [item.key, item.label, item.sort_order, fallbackDestination]
    );
  }
}

function normalizeMethodKey(input) {
  const key = String(input || "").trim().toUpperCase();
  return key ? key : null;
}

async function listPaymentMethods(pool) {
  await ensurePaymentMethodsSchema(pool);
  const res = await pool.query(
    `SELECT method_key, label, description, destination, asset_images, asset_file_ids, image_url, image_file_id, markup, sort_order, enabled
     FROM payment_methods
     ORDER BY sort_order NULLS LAST, method_key ASC`
  );
  return res.rows.map((row) => ({
    key: row.method_key,
    label: row.label || row.method_key,
    description: row.description || null,
    destination: row.destination || null,
    asset_images: row.asset_images || null,
    asset_file_ids: row.asset_file_ids || null,
    enabled: Boolean(row.enabled),
    image_url: row.image_url || null,
    image_file_id: row.image_file_id || null,
    markup: row.markup || null,
    sort_order: row.sort_order ?? null,
  }));
}

async function togglePaymentMethod(pool, methodKey) {
  await ensurePaymentMethodsSchema(pool);
  const key = normalizeMethodKey(methodKey);
  if (!key) {
    return null;
  }
  const res = await pool.query(
    `UPDATE payment_methods
     SET enabled = NOT enabled,
         updated_at = now()
     WHERE method_key = $1
     RETURNING method_key, enabled`,
    [key]
  );
  if (res.rowCount === 0) {
    await pool.query(
      `INSERT INTO payment_methods (method_key, enabled)
       VALUES ($1, false)
       ON CONFLICT (method_key) DO NOTHING`,
      [key]
    );
  }
  return listPaymentMethods(pool);
}

async function isPaymentMethodEnabled(pool, methodKey) {
  await ensurePaymentMethodsSchema(pool);
  const key = normalizeMethodKey(methodKey);
  if (!key) {
    return true;
  }
  const res = await pool.query(
    "SELECT enabled FROM payment_methods WHERE method_key = $1",
    [key]
  );
  if (res.rowCount === 0) {
    return true;
  }
  return Boolean(res.rows[0].enabled);
}

async function upsertPaymentMethod(pool, payload) {
  await ensurePaymentMethodsSchema(pool);
  const key = normalizeMethodKey(payload?.method_key || payload?.key);
  if (!key) {
    return null;
  }
  const currentRes = await pool.query(
    `SELECT label, description, destination, asset_images, asset_file_ids, image_url, image_file_id, markup, sort_order, enabled
     FROM payment_methods
     WHERE method_key = $1`,
    [key]
  );
  const current = currentRes.rows[0] || {};
  const hasLabel = Object.prototype.hasOwnProperty.call(payload || {}, "label");
  const label = hasLabel
    ? payload?.label
      ? String(payload.label).trim()
      : null
    : current.label || null;
  const hasDescription = Object.prototype.hasOwnProperty.call(payload || {}, "description");
  const description = hasDescription
    ? payload?.description
      ? String(payload.description).trim()
      : null
    : current.description || null;
  const hasDestination = Object.prototype.hasOwnProperty.call(payload || {}, "destination");
  const destination = hasDestination
    ? payload?.destination
      ? String(payload.destination).trim()
      : null
    : current.destination || null;
  const hasAssetImages = Object.prototype.hasOwnProperty.call(payload || {}, "asset_images");
  const assetImagesRaw = hasAssetImages ? payload?.asset_images : undefined;
  const assetImages = hasAssetImages
    ? assetImagesRaw
      ? typeof assetImagesRaw === "string"
        ? assetImagesRaw.trim()
        : JSON.stringify(assetImagesRaw)
      : null
    : current.asset_images || null;
  const hasAssetFileIds = Object.prototype.hasOwnProperty.call(payload || {}, "asset_file_ids");
  const assetFileIdsRaw = hasAssetFileIds ? payload?.asset_file_ids : undefined;
  const assetFileIds = hasAssetFileIds
    ? assetFileIdsRaw
      ? typeof assetFileIdsRaw === "string"
        ? assetFileIdsRaw.trim()
        : JSON.stringify(assetFileIdsRaw)
      : null
    : current.asset_file_ids || null;
  const hasImageUrl = Object.prototype.hasOwnProperty.call(payload || {}, "image_url");
  const imageUrl = hasImageUrl
    ? payload?.image_url
      ? String(payload.image_url).trim()
      : null
    : current.image_url || null;
  const hasImageFileId = Object.prototype.hasOwnProperty.call(payload || {}, "image_file_id");
  const imageFileId = hasImageFileId
    ? payload?.image_file_id
      ? String(payload.image_file_id).trim()
      : null
    : current.image_file_id || null;
  const hasMarkup = Object.prototype.hasOwnProperty.call(payload || {}, "markup");
  const markup = hasMarkup
    ? payload?.markup
      ? String(payload.markup)
      : null
    : current.markup || null;
  const hasSortOrder = Object.prototype.hasOwnProperty.call(payload || {}, "sort_order");
  const sortOrderRaw = hasSortOrder ? payload?.sort_order : undefined;
  const sortOrder = hasSortOrder
    ? Number.isFinite(Number(sortOrderRaw))
      ? Number(sortOrderRaw)
      : null
    : current.sort_order ?? null;
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload || {}, "enabled");
  const enabled = hasEnabled
    ? Boolean(payload.enabled)
    : current.enabled === undefined
    ? false
    : Boolean(current.enabled);
  await pool.query(
    `INSERT INTO payment_methods (method_key, label, description, destination, asset_images, asset_file_ids, image_url, image_file_id, markup, sort_order, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (method_key)
     DO UPDATE SET
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       destination = EXCLUDED.destination,
       asset_images = EXCLUDED.asset_images,
       asset_file_ids = EXCLUDED.asset_file_ids,
       image_url = EXCLUDED.image_url,
       image_file_id = EXCLUDED.image_file_id,
       markup = EXCLUDED.markup,
       sort_order = EXCLUDED.sort_order,
       enabled = EXCLUDED.enabled,
       updated_at = now()`,
    [key, label, description, destination, assetImages, assetFileIds, imageUrl, imageFileId, markup, sortOrder, enabled]
  );
  return listPaymentMethods(pool);
}

async function deletePaymentMethod(pool, methodKey) {
  await ensurePaymentMethodsSchema(pool);
  const key = normalizeMethodKey(methodKey);
  if (!key) {
    return null;
  }
  await pool.query(
    "DELETE FROM payment_methods WHERE method_key = $1",
    [key]
  );
  return listPaymentMethods(pool);
}

module.exports = {
  DEFAULT_METHODS,
  ensurePaymentMethodsSchema,
  normalizeMethodKey,
  listPaymentMethods,
  togglePaymentMethod,
  isPaymentMethodEnabled,
  upsertPaymentMethod,
  deletePaymentMethod,
};
