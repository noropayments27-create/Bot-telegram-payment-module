const express = require("express");
const router = express.Router();
const { getPool } = require("../db");

router.get("/db", async (req, res, next) => {
  try {
    const pool = getPool();
    const r = await pool.query("SELECT now() as now");
    res.json({ ok: true, service: "db", now: r.rows[0].now });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
