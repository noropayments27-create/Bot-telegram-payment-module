function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatUsdAmount(amount) {
  const numeric = Number(amount || 0);
  const formatted = Number.isInteger(numeric)
    ? numeric.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : numeric.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `$${formatted} USD`;
}

function buildAffiliateInvoiceMessage({ affiliate, invoice }) {
  const username = affiliate?.telegram_username
    ? `@${String(affiliate.telegram_username).replace(/^@/, "")}`
    : "-";
  const affiliateNumber = affiliate?.affiliate_number
    ? String(affiliate.affiliate_number).padStart(3, "0")
    : "---";
  const affiliateId = affiliate?.id ? String(affiliate.id) : "-";
  const invoiceReason = invoice?.reason ? String(invoice.reason) : "-";
  const invoiceDate = new Date(invoice?.created_at || new Date());
  const dateText = invoiceDate.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
  });
  const timeText = invoiceDate.toLocaleTimeString("en-US", {
    timeZone: "America/Bogota",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    "🧾 Factura de Pago\n\n"
    + `👤 Afiliado: ${escapeHtml(username)}\n`
    + `🆔 ID Telegram: ${escapeHtml(affiliate?.telegram_id || "-")}\n`
    + `🔢 N.º Afiliado: #${affiliateNumber}\n`
    + `🆔 ID Afiliado: <code>${escapeHtml(affiliateId)}</code>\n\n`
    + `💵 Se te Descontara: ${formatUsdAmount(invoice?.amount)}\n\n`
    + `📝 Nota: ${escapeHtml(invoiceReason)}\n\n`
    + `📅 ${dateText} — ⏰ ${timeText} (Hora COL)\n\n`
    + "⚠️ Importante\n"
    + "• Este pago es interno y se descuenta del saldo disponible.\n"
    + "• Una vez confirmado, no es reversible."
  );
}

module.exports = {
  buildAffiliateInvoiceMessage,
};
