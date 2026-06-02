/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

require("../src/config/env");
const { getPool } = require("../src/db");

const CATALOG_PATH = path.join(__dirname, "catalog_placeholder.yaml");
const CATEGORY_ORDER = ["SHOP", "METODOS", "VIP", "WEB"];
const CATEGORY_PREFIXES = {
  SHOP: "shop_",
  METODOS: "metodos_",
  VIP: "vip_",
  WEB: "web_",
};
const DELIVERY_TYPES = new Set([
  "LINK",
  "TEXT",
  "FILE",
  "VIDEO",
  "IMAGE",
  "EXPIRING_LINK",
]);

function normalizeMultiline(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return String(value);
  return value.split(" | ").join("\n").trim();
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return Boolean(value);
}

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(`Catalog file not found: ${CATALOG_PATH}`);
  }
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const parsed = yaml.load(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.products)) return parsed.products;
  throw new Error("Catalog YAML must be an array or include a products array.");
}

function buildDeliveryPayload(item) {
  const deliveryType = item.delivery_type;
  const payload = item.delivery_payload || {};

  if (deliveryType === "TEXT") {
    const text = normalizeMultiline(payload.text);
    if (!text) throw new Error("TEXT delivery_payload.text is required.");
    return { text };
  }

  if (deliveryType === "LINK" || deliveryType === "EXPIRING_LINK") {
    const url = String(payload.url || "").trim();
    if (!url) throw new Error(`${deliveryType} delivery_payload.url is required.`);
    const note = payload.note ? normalizeMultiline(payload.note) : undefined;
    return note ? { url, note } : { url };
  }

  if (deliveryType === "FILE" || deliveryType === "VIDEO" || deliveryType === "IMAGE") {
    const telegramFileId = String(payload.telegram_file_id || "").trim();
    const filename = String(payload.filename || "").trim();
    if (!telegramFileId || !filename) {
      throw new Error(`${deliveryType} delivery_payload.telegram_file_id and filename are required.`);
    }
    const fallbackUrl = payload.fallback_url
      ? String(payload.fallback_url).trim()
      : undefined;
    return fallbackUrl
      ? { telegram_file_id: telegramFileId, filename, fallback_url: fallbackUrl }
      : { telegram_file_id: telegramFileId, filename };
  }

  throw new Error(`Unsupported delivery_type: ${deliveryType}`);
}

function normalizeItem(item) {
  const category = String(item.category || "").trim().toUpperCase();
  if (!CATEGORY_ORDER.includes(category)) {
    throw new Error(`Invalid category: ${item.category}`);
  }

  const positionRaw = item.position;
  const position = Number.parseInt(positionRaw, 10);
  if (!Number.isInteger(position) || position < 1 || position > 99) {
    throw new Error(`Invalid position for ${item.sku_key || "item"}: ${positionRaw}`);
  }

  const skuKey = String(item.sku_key || "").trim();

  const name = String(item.name || "").trim();
  if (!name) throw new Error(`name is required for ${skuKey || "item"}`);

  const priceUsd = Number(item.price_usd);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new Error(`price_usd invalid for ${skuKey}`);
  }

  const deliveryType = String(item.delivery_type || "").trim().toUpperCase();
  if (!DELIVERY_TYPES.has(deliveryType)) {
    throw new Error(`Invalid delivery_type for ${skuKey}: ${item.delivery_type}`);
  }

  return {
    category,
    position,
    sku_key: skuKey,
    name,
    price: priceUsd,
    is_active: parseBoolean(item.is_active, true),
    delivery_type: deliveryType,
    delivery_payload: buildDeliveryPayload({
      delivery_type: deliveryType,
      delivery_payload: item.delivery_payload,
    }),
    description: normalizeMultiline(item.description || ""),
  };
}

async function seedCatalog() {
  const rawItems = loadCatalog();
  const skuKeySet = new Set();
  const items = rawItems.map((item) => {
    const normalized = normalizeItem(item);
    if (normalized.sku_key && skuKeySet.has(normalized.sku_key)) {
      throw new Error(`Duplicate sku_key in catalog: ${normalized.sku_key}`);
    }
    if (normalized.sku_key) {
      skuKeySet.add(normalized.sku_key);
    }
    return normalized;
  });

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query("CREATE SEQUENCE IF NOT EXISTS products_sku_key_seq");
    await client.query(
      "GRANT USAGE, SELECT ON SEQUENCE products_sku_key_seq TO PUBLIC"
    );
    await client.query(
      `UPDATE products
       SET is_active = false, updated_at = now()
       WHERE sku_key ~ '^[0-9]+$'`
    );

    for (const item of items) {
      let nextSkuKey = item.sku_key;
      if (!nextSkuKey || !/^\d+$/.test(nextSkuKey)) {
        const skuRes = await client.query(
          "SELECT nextval('products_sku_key_seq') AS value"
        );
        nextSkuKey = String(skuRes.rows[0].value).padStart(6, "0");
      }
      await client.query(
        `INSERT INTO products
          (sku_key, code, name, description, price, is_active, delivery_type, delivery_payload, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
         ON CONFLICT (sku_key) WHERE sku_key IS NOT NULL DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          price = EXCLUDED.price,
          is_active = EXCLUDED.is_active,
          delivery_type = EXCLUDED.delivery_type,
          delivery_payload = EXCLUDED.delivery_payload,
          code = COALESCE(NULLIF(products.code, ''), EXCLUDED.code),
          updated_at = now()`,
        [
          nextSkuKey,
          null,
          item.name,
          item.description,
          item.price,
          item.is_active,
          item.delivery_type,
          JSON.stringify(item.delivery_payload),
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`Seed complete: ${items.length} products upserted.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  console.log("Catalog seed runner");
  console.log(`Catalog file: ${CATALOG_PATH}`);
  console.log("Run: node seeds/seed_catalog.js");
  console.log("Edit catalog: edit seeds/catalog_placeholder.yaml in VS Code.");
  console.log("Verify: SELECT sku_key, code, is_active FROM products ORDER BY code;");
  await seedCatalog();
  await getPool().end();
}

main().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
