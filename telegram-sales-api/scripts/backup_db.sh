#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required"
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump is not installed"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
BACKUP_PREFIX="${BACKUP_PREFIX:-telegram_sales}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
FILE_PATH="${BACKUP_DIR}/${BACKUP_PREFIX}_${TIMESTAMP}.sql.gz"

echo "[backup] creating dump: ${FILE_PATH}"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$FILE_PATH"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$FILE_PATH" > "${FILE_PATH}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$FILE_PATH" > "${FILE_PATH}.sha256"
fi

echo "[backup] pruning files older than ${RETENTION_DAYS} days in ${BACKUP_DIR}"
find "$BACKUP_DIR" -type f -name "${BACKUP_PREFIX}_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete || true
find "$BACKUP_DIR" -type f -name "${BACKUP_PREFIX}_*.sql.gz.sha256" -mtime +"$RETENTION_DAYS" -delete || true

echo "[backup] done"
echo "$FILE_PATH"
