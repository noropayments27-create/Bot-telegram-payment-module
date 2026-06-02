const crypto = require("crypto");

const REQUEST_TTL_SECONDS = 60;
const LOGIN_REQUESTS = new Map();

function getTokenSecret() {
  const configuredSecret = String(process.env.ADMIN_TOKEN_SECRET || "").trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new Error("ADMIN_TOKEN_SECRET is required");
  }

  const devFallback = String(process.env.ADMIN_PASSWORD || "").trim();
  if (devFallback) {
    return devFallback;
  }

  const jwtFallback = String(process.env.JWT_SECRET || "").trim();
  if (jwtFallback) {
    return jwtFallback;
  }

  throw new Error("ADMIN_TOKEN_SECRET is required");
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

function signToken(payload) {
  const secret = getTokenSecret();
  return base64UrlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
}

function createAdminToken(claims, ttlSeconds = 60 * 60 * 12) {
  const payload = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signToken(payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token) {
    return null;
  }
  const [payloadEncoded, signature] = token.split(".");
  if (!payloadEncoded || !signature) {
    return null;
  }
  const expectedSignature = signToken(payloadEncoded);
  if (signature !== expectedSignature) {
    return null;
  }
  const payloadJson = base64UrlDecode(payloadEncoded);
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function createLoginRequest(tokenClaims = { sub: "admin" }) {
  const requestId = crypto.randomUUID();
  const expiresAt = Date.now() + REQUEST_TTL_SECONDS * 1000;
  LOGIN_REQUESTS.set(requestId, {
    status: "PENDING",
    expiresAt,
    token: null,
    tokenClaims:
      tokenClaims && typeof tokenClaims === "object"
        ? { ...tokenClaims }
        : { sub: "admin" },
  });
  setTimeout(() => {
    const entry = LOGIN_REQUESTS.get(requestId);
    if (entry && entry.expiresAt <= Date.now()) {
      LOGIN_REQUESTS.delete(requestId);
    }
  }, (REQUEST_TTL_SECONDS + 1) * 1000);

  return { requestId, expiresAt };
}

function getLoginRequest(requestId) {
  const entry = LOGIN_REQUESTS.get(requestId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    LOGIN_REQUESTS.delete(requestId);
    return { status: "EXPIRED" };
  }
  return entry;
}

function setLoginDecision(requestId, decision) {
  const entry = getLoginRequest(requestId);
  if (!entry || entry.status === "EXPIRED") {
    return null;
  }
  if (decision === "APPROVE") {
    const tokenClaims =
      entry.tokenClaims && typeof entry.tokenClaims === "object"
        ? entry.tokenClaims
        : { sub: "admin" };
    const token = createAdminToken(tokenClaims);
    entry.status = "APPROVED";
    entry.token = token;
  } else {
    entry.status = "DENIED";
    entry.token = null;
  }
  LOGIN_REQUESTS.set(requestId, entry);
  return entry;
}

module.exports = {
  REQUEST_TTL_SECONDS,
  createLoginRequest,
  getLoginRequest,
  setLoginDecision,
  createAdminToken,
  verifyAdminToken,
};
