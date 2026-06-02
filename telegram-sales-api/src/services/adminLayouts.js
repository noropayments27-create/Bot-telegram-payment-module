let adminLayoutsSchemaReady = false;

async function ensureAdminLayoutsSchema(pool) {
  if (adminLayoutsSchemaReady) {
    return;
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_layouts (
       layout_key text PRIMARY KEY,
       layout jsonb,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  adminLayoutsSchemaReady = true;
}

async function getAdminLayout(pool, key) {
  await ensureAdminLayoutsSchema(pool);
  const res = await pool.query(
    "SELECT layout FROM admin_layouts WHERE layout_key = $1",
    [key]
  );
  return res.rows[0]?.layout || null;
}

async function setAdminLayout(pool, key, layout) {
  await ensureAdminLayoutsSchema(pool);
  await pool.query(
    `INSERT INTO admin_layouts (layout_key, layout)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (layout_key)
     DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`,
    [key, JSON.stringify(layout)]
  );
  return getAdminLayout(pool, key);
}

module.exports = {
  ensureAdminLayoutsSchema,
  getAdminLayout,
  setAdminLayout,
};
