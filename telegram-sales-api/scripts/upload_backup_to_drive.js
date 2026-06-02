#!/usr/bin/env node
const path = require("path");
const { isDriveUploadEnabled, uploadBackupFileToDrive } = require("../src/services/backupDrive");

async function main() {
  const inputPath = String(process.argv[2] || "").trim();
  if (!inputPath) {
    console.error("Usage: node scripts/upload_backup_to_drive.js <backup-file.sql.gz>");
    process.exit(1);
  }

  if (!isDriveUploadEnabled()) {
    console.log("[drive-upload] skipped: BACKUP_DRIVE_ENABLED is false");
    process.exit(0);
  }

  const absolutePath = path.resolve(process.cwd(), inputPath);
  const uploaded = await uploadBackupFileToDrive(absolutePath, {
    filename: path.basename(absolutePath),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        file: path.basename(absolutePath),
        drive: uploaded,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[drive-upload] failed", error?.message || String(error));
  process.exit(1);
});
