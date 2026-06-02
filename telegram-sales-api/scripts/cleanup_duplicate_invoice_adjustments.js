const { getPool } = require("../src/db");

async function cleanupDuplicateInvoiceAdjustments() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const findRes = await client.query(
      `WITH invoice_adjustments AS (
         SELECT
           a.id AS adjustment_id,
           i.id AS invoice_id,
           ROW_NUMBER() OVER (
             PARTITION BY i.id
             ORDER BY a.created_at ASC, a.id
           ) AS rn
         FROM affiliate_invoices i
         JOIN affiliate_adjustments a
           ON a.affiliate_id = i.affiliate_id
          AND a.amount = -i.amount
          AND a.status = 'EARNED'
          AND (a.reason ILIKE 'Factura%' OR a.reason ILIKE 'Invoice%')
          AND i.status = 'PAID'
          AND a.created_at BETWEEN
            (COALESCE(i.paid_at, i.created_at) - interval '10 minutes')
            AND (COALESCE(i.paid_at, i.created_at) + interval '10 minutes')
       )
       SELECT adjustment_id
       FROM invoice_adjustments
       WHERE rn > 1`
    );
    const toDelete = findRes.rows.map((row) => row.adjustment_id);
    if (toDelete.length === 0) {
      await client.query("ROLLBACK");
      console.log("No duplicate invoice adjustments found.");
      return;
    }
    const deleteRes = await client.query(
      `DELETE FROM affiliate_adjustments
       WHERE id = ANY($1::uuid[])`,
      [toDelete]
    );
    await client.query("COMMIT");
    console.log(`Removed duplicate invoice adjustments: ${deleteRes.rowCount}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Cleanup failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

cleanupDuplicateInvoiceAdjustments();
