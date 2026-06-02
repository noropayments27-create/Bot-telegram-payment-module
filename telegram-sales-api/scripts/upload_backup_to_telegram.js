#!/usr/bin/env node
const path = require("path");
const {
  isTelegramBackupEnabled,
  uploadBackupFileToTelegram,
} = require("../src/services/backupTelegram");

async function main() {
  const inputPath = String(process.argv[2] || "").trim();
  if (!inputPath) {
    console.error("Usage: node scripts/upload_backup_to_telegram.js <backup-file.sql.gz>");
    process.exit(1);
  }

  if (!isTelegramBackupEnabled()) {
    console.log("[telegram-upload] skipped: BACKUP_TELEGRAM_ENABLED is false");
    process.exit(0);
  }

  const absolutePath = path.resolve(process.cwd(), inputPath);
  const uploaded = await uploadBackupFileToTelegram(absolutePath, {
    filename: path.basename(absolutePath),
  });

  console.log(
    JSON.stringify(
      {
        ok: uploaded.uploaded,
        file: path.basename(absolutePath),
        telegram: uploaded,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[telegram-upload] failed", error?.message || String(error));
  process.exit(1);
});
