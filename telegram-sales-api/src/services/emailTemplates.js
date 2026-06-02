function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw;
}

function buildPasswordRecoveryEmailTemplate({
  code,
  expiresInMinutes,
  brandName = "NoroPayments",
  panelUrl = "",
  supportHandle = "@noropayments",
  logoUrl = "",
}) {
  const safeCode = escapeHtml(code);
  const safeBrandName = escapeHtml(brandName);
  const safeSupportHandle = escapeHtml(supportHandle);
  const safePanelUrl = escapeHtml(normalizeUrl(panelUrl));
  const safeLogoUrl = escapeHtml(normalizeUrl(logoUrl));
  const minutes = Number(expiresInMinutes) > 0 ? Number(expiresInMinutes) : 5;

  const subject = "Codigo de recuperacion - Panel Admin";

  const textLines = [
    `${brandName} | Recuperacion de acceso`,
    "",
    "Codigo de recuperacion del panel admin",
    `Codigo: ${code}`,
    `Vence en ${minutes} minutos.`,
    "",
    "Si no solicitaste este cambio, ignora este mensaje.",
    `Soporte: ${supportHandle}`,
  ];
  if (panelUrl) {
    textLines.push(`Panel: ${panelUrl}`);
  }

  const html = [
    "<!doctype html>",
    '<html lang="es">',
    '<body style="margin:0;padding:0;background:#0f1115;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0f1115;padding:24px 12px;">',
    "<tr>",
    '<td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;background:#171a21;border:1px solid #2a2f3a;border-radius:14px;overflow:hidden;">',
    "<tr>",
    '<td style="padding:24px 28px;background:#11141b;border-bottom:1px solid #2a2f3a;">',
    safeLogoUrl
      ? `<img src="${safeLogoUrl}" alt="${safeBrandName}" width="120" style="display:block;border:0;outline:none;text-decoration:none;">`
      : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#ff4d00;letter-spacing:0.4px;">${safeBrandName}</div>`,
    "</td>",
    "</tr>",
    "<tr>",
    '<td style="padding:26px 28px 20px 28px;">',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:28px;font-weight:700;color:#ffffff;margin:0 0 10px 0;">Recuperacion de acceso</div>',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#b9c0cf;margin:0 0 18px 0;">Se solicito un codigo para restablecer el acceso al panel admin.</div>',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8f98aa;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;">Codigo de verificacion</div>',
    `<div style="font-family:Consolas,Monaco,monospace;font-size:34px;line-height:38px;font-weight:700;color:#ff4d00;background:#0f1115;border:1px solid #2a2f3a;border-radius:10px;padding:14px 16px;display:inline-block;letter-spacing:2px;">${safeCode}</div>`,
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#cfd6e6;margin:16px 0 0 0;">Este codigo vence en <b>${minutes} minutos</b>.</div>`,
    safePanelUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr><td style="border-radius:10px;background:#ff4d00;"><a href="${safePanelUrl}" target="_blank" style="display:inline-block;padding:12px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Ir al panel</a></td></tr></table>`
      : "",
    "</td>",
    "</tr>",
    "<tr>",
    '<td style="padding:16px 28px 24px 28px;border-top:1px solid #2a2f3a;">',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#9aa3b5;">Si no solicitaste este cambio, ignora este mensaje.</div>',
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#9aa3b5;margin-top:6px;">Soporte: <span style="color:#ff4d00;">${safeSupportHandle}</span></div>`,
    "</td>",
    "</tr>",
    "</table>",
    "</td>",
    "</tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");

  return {
    subject,
    text: textLines.join("\n"),
    html,
  };
}

module.exports = {
  buildPasswordRecoveryEmailTemplate,
};
