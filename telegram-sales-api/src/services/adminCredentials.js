const bcrypt = require("bcryptjs");

let adminCredentialsSchemaReady = false;

function parseAdminTelegramIds() {
  const value = process.env.ADMIN_TELEGRAM_IDS || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && /^[0-9]+$/.test(item))
    .map((item) => Number(item));
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

async function verifyAgainstEnv(providedUsername, providedPassword) {
  const expectedUsername = String(process.env.ADMIN_USERNAME || "").trim();
  const expectedPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  const expectedPasswordPlain = String(process.env.ADMIN_PASSWORD || "").trim();

  if (!expectedUsername || (!expectedPasswordHash && !expectedPasswordPlain)) {
    return { configured: false, ok: false };
  }

  if (normalizeUsername(providedUsername) !== normalizeUsername(expectedUsername)) {
    return { configured: true, ok: false, source: "env" };
  }

  let passwordOk = false;
  if (expectedPasswordHash) {
    passwordOk = await bcrypt.compare(String(providedPassword || ""), expectedPasswordHash);
  }
  if (!passwordOk && expectedPasswordPlain) {
    passwordOk = String(providedPassword || "") === expectedPasswordPlain;
  }

  if (!passwordOk) {
    return { configured: true, ok: false, source: "env" };
  }

  return {
    configured: true,
    ok: true,
    source: "env",
    admin: {
      username: expectedUsername,
      auth_version: 1,
      telegram_id: parseAdminTelegramIds()[0] || null,
    },
  };
}

async function resolveEnvPasswordHash() {
  const expectedPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  if (expectedPasswordHash) {
    return expectedPasswordHash;
  }
  const expectedPasswordPlain = String(process.env.ADMIN_PASSWORD || "").trim();
  if (!expectedPasswordPlain) {
    return "";
  }
  return bcrypt.hash(expectedPasswordPlain, 10);
}

async function ensureAdminCredentialsSchema(pool) {
  if (adminCredentialsSchemaReady) {
    return;
  }

  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_accounts (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       username text NOT NULL,
       password_hash text NOT NULL,
       auth_version int NOT NULL DEFAULT 1,
       telegram_id bigint,
       recovery_email text,
       is_active boolean NOT NULL DEFAULT true,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_username_unique
     ON admin_accounts ((lower(btrim(username))))`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_recovery_email_unique
     ON admin_accounts ((lower(btrim(recovery_email))))
     WHERE recovery_email IS NOT NULL
       AND btrim(recovery_email) <> ''`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS admin_accounts_active_idx
     ON admin_accounts (is_active, created_at DESC)`
  );
  await pool.query(
    `ALTER TABLE admin_accounts
     ADD COLUMN IF NOT EXISTS auth_version int NOT NULL DEFAULT 1`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_auth_otps (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       admin_id uuid NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
       purpose text NOT NULL,
       channel text NOT NULL,
       code_hash text NOT NULL,
       expires_at timestamptz NOT NULL,
       attempts int NOT NULL DEFAULT 0,
       max_attempts int NOT NULL DEFAULT 5,
       used_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS admin_auth_otps_admin_idx
     ON admin_auth_otps (admin_id, created_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS admin_auth_otps_active_idx
     ON admin_auth_otps (expires_at, used_at)`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_audit_logs (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
       action text NOT NULL,
       ip inet,
       user_agent text,
       metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx
     ON admin_audit_logs (action, created_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS admin_audit_logs_admin_idx
     ON admin_audit_logs (admin_id, created_at DESC)`
  );

  const expectedUsername = String(process.env.ADMIN_USERNAME || "").trim();
  const expectedPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  const expectedPasswordPlain = String(process.env.ADMIN_PASSWORD || "").trim();
  if (expectedUsername && (expectedPasswordHash || expectedPasswordPlain)) {
    const existingRes = await pool.query(
      `SELECT id
       FROM admin_accounts
       WHERE lower(btrim(username)) = lower(btrim($1))
       LIMIT 1`,
      [expectedUsername]
    );
    if (existingRes.rowCount === 0) {
      const bootstrapHash = expectedPasswordHash
        || await bcrypt.hash(expectedPasswordPlain, 10);
      const telegramId = parseAdminTelegramIds()[0] || null;
      await pool.query(
        `INSERT INTO admin_accounts (
           username,
           password_hash,
           auth_version,
           telegram_id,
           is_active
         )
         VALUES ($1, $2, 1, $3, true)`,
        [expectedUsername, bootstrapHash, telegramId]
      );
    }
  }

  adminCredentialsSchemaReady = true;
}

async function getAdminAccountByUsername(pool, username) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return null;
  }
  const res = await pool.query(
    `SELECT id, username, password_hash, auth_version, telegram_id, recovery_email, is_active
     FROM admin_accounts
     WHERE lower(btrim(username)) = $1
       AND is_active = true
     LIMIT 1`,
    [normalized]
  );
  return res.rows[0] || null;
}

async function getCandidateAccountsForDirect(pool) {
  const preferred = String(process.env.ADMIN_USERNAME || "").trim();
  if (preferred) {
    const account = await getAdminAccountByUsername(pool, preferred);
    if (account) {
      return [account];
    }
  }
  const res = await pool.query(
    `SELECT id, username, password_hash, auth_version, telegram_id, recovery_email, is_active
     FROM admin_accounts
     WHERE is_active = true
     ORDER BY created_at ASC
     LIMIT 10`
  );
  return res.rows || [];
}

async function verifyPasswordHash(password, hash) {
  const rawPassword = String(password || "");
  const rawHash = String(hash || "").trim();
  if (!rawPassword || !rawHash) {
    return false;
  }
  return bcrypt.compare(rawPassword, rawHash);
}

async function validateAdminStartCredentials(pool, username, password) {
  await ensureAdminCredentialsSchema(pool);

  const account = await getAdminAccountByUsername(pool, username);
  if (account) {
    const ok = await verifyPasswordHash(password, account.password_hash);
    if (ok) {
      return {
        configured: true,
        ok,
        source: "db",
        admin: account,
      };
    }

    const envResult = await verifyAgainstEnv(username, password);
    if (envResult.configured && envResult.ok) {
      const envHash = await resolveEnvPasswordHash();
      if (envHash && envHash !== String(account.password_hash || "").trim()) {
        const syncRes = await pool.query(
          `UPDATE admin_accounts
           SET password_hash = $2,
               auth_version = COALESCE(auth_version, 1) + 1,
               updated_at = now()
           WHERE id = $1
           RETURNING id, username, password_hash, auth_version, telegram_id, recovery_email, is_active`,
          [account.id, envHash]
        );
        const syncedAccount = syncRes.rows[0] || account;
        return {
          configured: true,
          ok: true,
          source: "env_db_sync",
          admin: syncedAccount,
        };
      }
      return {
        configured: true,
        ok: true,
        source: "env",
        admin: account,
      };
    }

    return {
      configured: true,
      ok: false,
      source: "db",
      admin: null,
    };
  }

  return verifyAgainstEnv(username, password);
}

async function validateAdminDirectCredentials(pool, password) {
  await ensureAdminCredentialsSchema(pool);

  const candidates = await getCandidateAccountsForDirect(pool);
  for (const account of candidates) {
    const ok = await verifyPasswordHash(password, account.password_hash);
    if (ok) {
      return {
        configured: true,
        ok: true,
        source: "db",
        admin: account,
      };
    }
  }

  const envUsername = String(process.env.ADMIN_USERNAME || "").trim();
  if (!envUsername) {
    return { configured: candidates.length > 0, ok: false };
  }
  return verifyAgainstEnv(envUsername, password);
}

module.exports = {
  ensureAdminCredentialsSchema,
  validateAdminStartCredentials,
  validateAdminDirectCredentials,
};
