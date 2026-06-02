const { Client } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3001";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  return { status: response.status, data };
}

async function ensureProduct(client) {
  const skuKey = process.env.QA_SKU_KEY;
  if (process.env.QA_PRODUCT_ID) {
    return { id: process.env.QA_PRODUCT_ID, sku_key: skuKey || null };
  }
  if (skuKey) {
    const res = await client.query("SELECT id, sku_key FROM products WHERE sku_key = $1", [
      skuKey,
    ]);
    if (res.rowCount > 0) {
      return res.rows[0];
    }
  }

  const insertRes = await client.query(
    `INSERT INTO products
      (sku_key, name, description, price, is_active, delivery_type, delivery_payload, stock_mode, show_stock)
     VALUES ($1, $2, $3, $4, true, 'TEXT', $5::jsonb, 'UNITS', true)
     RETURNING id, sku_key`,
    [
      `qa_units_${Date.now()}`,
      "QA Units Product",
      "QA product for stock race",
      1.0,
      JSON.stringify({ text: "QA delivery" }),
    ]
  );

  return insertRes.rows[0];
}

async function seedUnits(client, productId, count) {
  const payloads = Array.from({ length: count }).map((_, index) => ({
    title: `QA Unit ${index + 1}`,
    username: `qa_user_${index + 1}`,
    password: `qa_pass_${index + 1}`,
  }));

  for (const payload of payloads) {
    await client.query(
      `INSERT INTO product_stock_units (product_id, payload, status)
       VALUES ($1, $2::jsonb, 'AVAILABLE')`,
      [productId, payload]
    );
  }
}

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const product = await ensureProduct(client);
    console.log("Using product:", product);

    await seedUnits(client, product.id, 1);

    const telegramIdA = Number(`10${Date.now() % 1000000}`);
    const telegramIdB = telegramIdA + 1;

    await fetchJson(`${API_BASE_URL}/bot/cart/add`, {
      method: "POST",
      body: JSON.stringify({
        telegram_id: telegramIdA,
        product_id: product.id,
        qty: 1,
      }),
    });

    await fetchJson(`${API_BASE_URL}/bot/cart/add`, {
      method: "POST",
      body: JSON.stringify({
        telegram_id: telegramIdB,
        product_id: product.id,
        qty: 1,
      }),
    });

    const [resultA, resultB] = await Promise.all([
      fetchJson(`${API_BASE_URL}/bot/cart/checkout`, {
        method: "POST",
        body: JSON.stringify({ telegram_id: telegramIdA }),
      }),
      fetchJson(`${API_BASE_URL}/bot/cart/checkout`, {
        method: "POST",
        body: JSON.stringify({ telegram_id: telegramIdB }),
      }),
    ]);

    console.log("Checkout A:", resultA.status, resultA.data);
    console.log("Checkout B:", resultB.status, resultB.data);
    console.log("Expect: one success and one 409 OUT_OF_STOCK.");
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("QA script failed:", error);
  process.exit(1);
});
