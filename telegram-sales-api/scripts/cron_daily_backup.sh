#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${API_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[cron-backup] ERROR: .env not found at ${ENV_FILE}"
  exit 1
fi

DATABASE_URL_FROM_ENV="$(sed -n 's/^DATABASE_URL=//p' "${ENV_FILE}" | head -n 1)"
if [[ -z "${DATABASE_URL_FROM_ENV}" ]]; then
  echo "[cron-backup] ERROR: DATABASE_URL is missing in ${ENV_FILE}"
  exit 1
fi

read_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${ENV_FILE}" | head -n 1
}

cd "${API_DIR}"

export DATABASE_URL="${DATABASE_URL_FROM_ENV}"
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(read_env_value TELEGRAM_BOT_TOKEN)}"
export ADMIN_TELEGRAM_IDS="${ADMIN_TELEGRAM_IDS:-$(read_env_value ADMIN_TELEGRAM_IDS)}"
export BACKUP_PREFIX="${BACKUP_PREFIX:-telegram_sales_auto}"
export BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
export BACKUP_DRIVE_ENABLED="${BACKUP_DRIVE_ENABLED:-$(read_env_value BACKUP_DRIVE_ENABLED)}"
export BACKUP_DRIVE_FOLDER_ID="${BACKUP_DRIVE_FOLDER_ID:-$(read_env_value BACKUP_DRIVE_FOLDER_ID)}"
export BACKUP_DRIVE_SERVICE_ACCOUNT_JSON="${BACKUP_DRIVE_SERVICE_ACCOUNT_JSON:-$(read_env_value BACKUP_DRIVE_SERVICE_ACCOUNT_JSON)}"
export BACKUP_DRIVE_SERVICE_ACCOUNT_BASE64="${BACKUP_DRIVE_SERVICE_ACCOUNT_BASE64:-$(read_env_value BACKUP_DRIVE_SERVICE_ACCOUNT_BASE64)}"
export BACKUP_DRIVE_SERVICE_ACCOUNT_FILE="${BACKUP_DRIVE_SERVICE_ACCOUNT_FILE:-$(read_env_value BACKUP_DRIVE_SERVICE_ACCOUNT_FILE)}"
export BACKUP_TELEGRAM_ENABLED="${BACKUP_TELEGRAM_ENABLED:-$(read_env_value BACKUP_TELEGRAM_ENABLED)}"
export BACKUP_TELEGRAM_CHAT_IDS="${BACKUP_TELEGRAM_CHAT_IDS:-$(read_env_value BACKUP_TELEGRAM_CHAT_IDS)}"
export BACKUP_TELEGRAM_CAPTION_PREFIX="${BACKUP_TELEGRAM_CAPTION_PREFIX:-$(read_env_value BACKUP_TELEGRAM_CAPTION_PREFIX)}"

BACKUP_OUTPUT="$(bash "${API_DIR}/scripts/backup_db.sh")"
echo "${BACKUP_OUTPUT}"

BACKUP_FILE_PATH="$(printf "%s\n" "${BACKUP_OUTPUT}" | tail -n 1 | tr -d '\r')"
if [[ -n "${BACKUP_FILE_PATH}" ]]; then
  node "${API_DIR}/scripts/upload_backup_to_drive.js" "${BACKUP_FILE_PATH}" || true
  node "${API_DIR}/scripts/upload_backup_to_telegram.js" "${BACKUP_FILE_PATH}" || true
fi
