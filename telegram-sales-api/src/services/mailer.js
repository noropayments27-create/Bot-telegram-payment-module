const nodemailer = require("nodemailer");

let transporter = null;
let transporterKey = "";

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getMailConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || "").trim();
  const portRaw = String(process.env.SMTP_PORT || "").trim();
  const port = Number(portRaw || 587);
  const secure = normalizeBool(process.env.SMTP_SECURE, port === 465);

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
  };
}

function isMailConfigured() {
  const config = getMailConfig();
  return Boolean(
    config.host
      && Number.isFinite(config.port)
      && config.user
      && config.pass
      && config.from
  );
}

function getTransporter() {
  const config = getMailConfig();
  if (!isMailConfigured()) {
    throw new Error("MAIL_NOT_CONFIGURED");
  }

  const currentKey = `${config.host}:${config.port}:${config.secure}:${config.user}:${config.from}`;
  if (transporter && transporterKey === currentKey) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  transporterKey = currentKey;
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const recipient = String(to || "").trim();
  if (!recipient) {
    throw new Error("MAIL_TO_REQUIRED");
  }

  const config = getMailConfig();
  const transport = getTransporter();
  const payload = {
    from: config.from,
    to: recipient,
    subject: String(subject || "").trim() || "Notificacion",
    text: String(text || "").trim() || undefined,
    html: String(html || "").trim() || undefined,
  };

  const result = await transport.sendMail(payload);
  return result;
}

module.exports = {
  sendMail,
  isMailConfigured,
};
