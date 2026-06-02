const { verifyAdminToken } = require("../services/adminAuth");
const { getPool } = require("../db");

async function requireAdmin(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }
  const authHeader = req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;
  const apiKey = req.header("x-admin-key") || "";
  const expected =
    process.env.ADMIN_API_KEY
    || process.env.ADMIN_KEY
    || process.env.ADMIN_SECRET;

  if (process.env.ADMIN_AUTH_LOG === "true") {
    console.log("[admin-auth] headers", {
      has_admin_key: Boolean(apiKey),
      has_authorization: Boolean(authHeader),
      has_expected_key: Boolean(expected),
    });
  }

  if (expected && apiKey && apiKey === expected) {
    req.admin = { mode: "api_key", key_id: "env:ADMIN_API_KEY" };
    return next();
  }

  const payload = token ? verifyAdminToken(token) : null;
  if (payload) {
    if (payload.sub !== "admin") {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    if (payload.purpose && payload.purpose !== "SESSION") {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const adminId = String(payload.admin_id || "").trim();
    const tokenAuthVersion = Number(payload.auth_version);
    if (adminId && Number.isFinite(tokenAuthVersion)) {
      try {
        const pool = getPool();
        const result = await pool.query(
          `SELECT auth_version, is_active
           FROM admin_accounts
           WHERE id = $1
           LIMIT 1`,
          [adminId]
        );
        const row = result.rows[0];
        if (!row || !row.is_active) {
          return res.status(401).json({ error: "UNAUTHORIZED" });
        }
        if (Number(row.auth_version || 1) !== tokenAuthVersion) {
          return res.status(401).json({ error: "SESSION_EXPIRED" });
        }
      } catch (error) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }
    }

    req.admin = { ...payload, mode: "jwt" };
    return next();
  }

  return res.status(401).json({ error: "UNAUTHORIZED" });
}

module.exports = requireAdmin;
