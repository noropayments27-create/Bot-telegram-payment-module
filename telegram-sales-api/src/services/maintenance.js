let maintenanceSchemaReady = false;

async function ensureMaintenanceSchema(pool) {
  if (maintenanceSchemaReady) {
    return;
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_maintenance (
       id int PRIMARY KEY DEFAULT 1,
       active boolean NOT NULL DEFAULT false,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `INSERT INTO bot_maintenance (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`
  );
  maintenanceSchemaReady = true;
}

async function getMaintenanceStatus(pool) {
  await ensureMaintenanceSchema(pool);
  const res = await pool.query(
    "SELECT active FROM bot_maintenance WHERE id = 1"
  );
  return Boolean(res.rows[0]?.active);
}

async function setMaintenanceStatus(pool, active) {
  await ensureMaintenanceSchema(pool);
  const normalized = Boolean(active);
  await pool.query(
    `UPDATE bot_maintenance
     SET active = $1,
         updated_at = now()
     WHERE id = 1`,
    [normalized]
  );
  return normalized;
}

module.exports = {
  ensureMaintenanceSchema,
  getMaintenanceStatus,
  setMaintenanceStatus,
};
