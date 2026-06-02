const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const includeSeeds = process.argv.includes("--include-seeds");
const dryRun = process.argv.includes("--dry-run");
const sqlDir = path.join(__dirname, "..", "sql");

function checksum(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getMigrationFiles() {
  return fs
    .readdirSync(sqlDir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => includeSeeds || !name.startsWith("seed_"))
    .sort((a, b) => a.localeCompare(b));
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let dollarQuote = null;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (dollarQuote) {
      current += char;
      if (sql.startsWith(dollarQuote, index)) {
        current += sql.slice(index + 1, index + dollarQuote.length);
        index += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "-" && next === "-") {
      current += char;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuote = match[0];
        current += dollarQuote;
        index += dollarQuote.length - 1;
        continue;
      }
    }

    if (!inDoubleQuote && char === "'" && sql[index - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (!inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === ";") {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }
  return statements;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    const appliedRows = await client.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    const applied = new Map(
      appliedRows.rows.map((row) => [row.name, row.checksum])
    );

    for (const fileName of getMigrationFiles()) {
      const filePath = path.join(sqlDir, fileName);
      const sql = fs.readFileSync(filePath, "utf8");
      const fileChecksum = checksum(sql);
      const appliedChecksum = applied.get(fileName);

      if (appliedChecksum) {
        if (appliedChecksum !== fileChecksum) {
          throw new Error(`Migration changed after being applied: ${fileName}`);
        }
        console.log(`[migrate] skip ${fileName}`);
        continue;
      }

      console.log(`[migrate] apply ${fileName}`);
      if (!dryRun) {
        for (const statement of splitSqlStatements(sql)) {
          await client.query(statement);
        }
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [fileName, fileChecksum]
        );
      }
    }

    console.log(dryRun ? "[migrate] dry run complete" : "[migrate] complete");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrate] failed", error);
  process.exit(1);
});
