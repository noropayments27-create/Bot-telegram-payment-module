const { getPool } = require("../../db");
const { ensureProductCategorySchema } = require("../../services/productSchema");

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return undefined;
}

function normalizeCategoryKey(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return "";
  return text
    .replace(/[\s-]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 32);
}

async function listProducts(req, res, next) {
  const active = parseBoolean(req.query.active);
  const categoryKey = normalizeCategoryKey(req.query.category_key);
  const telegramId = Number(req.query.telegram_id);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(parseInt(req.query.page_size, 10) || 8, 1),
    50
  );
  const offset = (page - 1) * pageSize;

  const pool = getPool();
  const filters = [];
  const values = [];
  let userId = null;
  let userLocale = "es";

  if (active !== undefined) {
    values.push(active);
    filters.push(`is_active = $${values.length}`);
  }
  if (categoryKey) {
    values.push(categoryKey);
    filters.push(`category_key = $${values.length}`);
  }

  const whereClause = filters.length
    ? `WHERE ${filters.map((filter) => `p.${filter}`).join(" AND ")}`
    : "";

  try {
    await ensureProductCategorySchema(pool);
    if (Number.isFinite(telegramId)) {
      const userRes = await pool.query(
        "SELECT id, locale FROM users WHERE telegram_id = $1",
        [telegramId]
      );
      if (userRes.rowCount > 0) {
        userId = userRes.rows[0].id;
        if (userRes.rows[0].locale === "en") {
          userLocale = "en";
        }
      }
    }

    const userParamIndex = values.length + 1;
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products p ${whereClause}`,
      values
    );
    const total = countRes.rows[0].total;

    const itemsRes = await pool.query(
      `SELECT p.id,
              p.code,
              p.sku_key,
              p.category_key,
              p.name,
              p.name_en,
              p.description,
              p.description_en,
              p.image_url,
              p.image_file_id,
              p.price,
              p.is_active,
              p.out_of_stock,
              p.delivery_type,
              p.delivery_payload,
              p.created_at,
              p.updated_at,
              p.stock_mode,
              p.stock_qty,
              p.show_stock,
              p.unique_purchase,
              CASE
                WHEN $${userParamIndex}::uuid IS NULL THEN false
                ELSE EXISTS (
                  SELECT 1
                  FROM orders o
                  WHERE o.user_id = $${userParamIndex}
                    AND o.product_id = p.id
                    AND o.status IN ('PAID', 'DELIVERED')
                )
              END AS already_purchased,
              CASE
                WHEN p.stock_mode = 'SIMPLE' AND (p.stock_qty IS NULL OR p.unique_purchase = true) THEN true
                ELSE false
              END AS stock_is_unlimited,
              CASE
                WHEN p.show_stock = false THEN NULL
                WHEN p.stock_mode = 'SIMPLE' THEN
                  CASE
                    WHEN p.stock_qty IS NULL OR p.unique_purchase = true THEN NULL
                    ELSE GREATEST(p.stock_qty - COALESCE(psh.held_qty, 0), 0)
                  END
                WHEN p.stock_mode = 'UNITS' THEN COALESCE(psu.available_units, 0)
                ELSE NULL
              END AS available_stock
       FROM products p
       LEFT JOIN (
         SELECT product_id, COUNT(*)::int AS available_units
         FROM product_stock_units
         WHERE status = 'AVAILABLE'
         GROUP BY product_id
       ) psu ON psu.product_id = p.id
       LEFT JOIN (
         SELECT product_id, COALESCE(SUM(qty), 0)::int AS held_qty
         FROM product_stock_holds
         WHERE status = 'HELD' AND expires_at > now()
         GROUP BY product_id
       ) psh ON psh.product_id = p.id
       ${whereClause}
       ORDER BY p.created_at ASC, p.name ASC
       LIMIT $${values.length + 2} OFFSET $${values.length + 3}`,
      [...values, userId, pageSize, offset]
    );

    const items = itemsRes.rows.map((row) => {
      if (userLocale !== "en") {
        return row;
      }
      return {
        ...row,
        name: row.name_en || row.name,
        description: row.description_en || row.description,
      };
    });

    const totalPages = Math.ceil(total / pageSize) || 1;

    res.json({
      items,
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { listProducts };
