const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    const maxConnections = Number.parseInt(process.env.DB_POOL_MAX || "", 10) || 5;
    const idleTimeoutMillis = Number.parseInt(process.env.DB_IDLE_TIMEOUT_MS || "", 10) || 10_000;
    const connectionTimeoutMillis = Number.parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || "", 10) || 5_000;

    pool = new Pool({
      connectionString,
      max: Math.max(1, maxConnections),
      idleTimeoutMillis: Math.max(1000, idleTimeoutMillis),
      connectionTimeoutMillis: Math.max(1000, connectionTimeoutMillis),
    });
  }
  return pool;
}

async function connectDb() {
  const p = getPool();
  const client = await p.connect();
  try {
    // Prueba simple
    const res = await client.query("SELECT 1 as ok");
    console.log("DB connected:", res.rows[0]);
    if (process.env.NODE_ENV !== "production") {
      const privilegesRes = await client.query(
        `SELECT
           has_table_privilege(current_user, 'public.product_stock_holds', 'INSERT') AS holds_insert,
           has_table_privilege(current_user, 'public.product_stock_units', 'UPDATE') AS units_update`
      );
      const row = privilegesRes.rows[0] || {};
      if (!row.holds_insert) {
        console.warn(
          "[db] missing privileges for product_stock_holds INSERT (current_user)"
        );
      }
      if (!row.units_update) {
        console.warn(
          "[db] missing privileges for product_stock_units UPDATE (current_user)"
        );
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { getPool, connectDb };
