const RATE_LIMIT_STATUS = {
  error: "RATE_LIMITED",
  message: "Too many requests, try again later.",
};

const adminRateLimitStore = new Map();

function parseNumber(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
}

function adminRateLimit(req, res, next) {
  const enabled = String(process.env.API_RATE_LIMIT_ENABLED || "").toLowerCase() === "true";
  if (!enabled) {
    return next();
  }

  if (req.method === "OPTIONS") {
    return next();
  }

  const windowMs = parseNumber(process.env.API_RATE_LIMIT_ADMIN_WINDOW_MS, 60000);
  const maxRequests = parseNumber(process.env.API_RATE_LIMIT_ADMIN_MAX, 120);
  const ip = getClientIp(req);
  const now = Date.now();

  let entry = adminRateLimitStore.get(ip);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 0 };
  }

  entry.count += 1;
  adminRateLimitStore.set(ip, entry);

  if (entry.count > maxRequests) {
    return res.status(429).json(RATE_LIMIT_STATUS);
  }

  return next();
}

module.exports = adminRateLimit;
