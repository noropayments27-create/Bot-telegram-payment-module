#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${API_DIR}/.env"

read_env_value() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi
  sed -n "s/^${key}=//p" "${ENV_FILE}" | head -n 1
}

usage() {
  cat <<'USAGE'
Usage:
  bash ./scripts/restore_db.sh <backup-file.sql.gz>
  bash ./scripts/restore_db.sh --latest

Options:
  --latest     Restore using latest file in ./backups/postgres

Safety:
  - Creates a pre-restore backup automatically before overwrite.
  - Requires manual confirmation unless FORCE_RESTORE=true.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "" ]]; then
  usage
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed"
  exit 1
fi

if ! command -v gunzip >/dev/null 2>&1; then
  echo "ERROR: gunzip is not installed"
  exit 1
fi

DATABASE_URL_FROM_ENV="$(read_env_value DATABASE_URL)"
export DATABASE_URL="${DATABASE_URL:-${DATABASE_URL_FROM_ENV}}"
if [[ -z "${DATABASE_URL}" ]]; then
  echo "ERROR: DATABASE_URL is required (env or .env)"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-${API_DIR}/backups/postgres}"
if [[ ! -d "${BACKUP_DIR}" ]]; then
  mkdir -p "${BACKUP_DIR}"
fi

INPUT_PATH="${1:-}"
if [[ "${INPUT_PATH}" == "--latest" ]]; then
  INPUT_PATH="$(ls -t "${BACKUP_DIR}"/*.sql.gz 2>/dev/null | head -n 1 || true)"
  if [[ -z "${INPUT_PATH}" ]]; then
    echo "ERROR: no backup files found in ${BACKUP_DIR}"
    exit 1
  fi
fi

if [[ ! -f "${INPUT_PATH}" ]]; then
  echo "ERROR: backup file not found: ${INPUT_PATH}"
  exit 1
fi

ABS_INPUT_PATH="$(cd "$(dirname "${INPUT_PATH}")" && pwd)/$(basename "${INPUT_PATH}")"

echo "[restore] target backup: ${ABS_INPUT_PATH}"
echo "[restore] database: ${DATABASE_URL}"

if [[ "${FORCE_RESTORE:-}" != "true" ]]; then
  echo "[restore] This will OVERWRITE current data."
  read -r -p "Type RESTORE to continue: " confirmation
  if [[ "${confirmation}" != "RESTORE" ]]; then
    echo "[restore] cancelled"
    exit 1
  fi
fi

echo "[restore] creating pre-restore backup..."
PRE_RESTORE_OUTPUT="$(
  cd "${API_DIR}"
  BACKUP_PREFIX="${BACKUP_PREFIX:-telegram_sales_pre_restore}" \
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}" \
  DATABASE_URL="${DATABASE_URL}" \
  bash "${API_DIR}/scripts/backup_db.sh"
)"

PRE_RESTORE_PATH="$(printf '%s\n' "${PRE_RESTORE_OUTPUT}" | awk 'NF { last=$0 } END { print last }')"
if [[ -z "${PRE_RESTORE_PATH}" ]]; then
  echo "ERROR: failed to capture pre-restore backup path"
  exit 1
fi
if [[ "${PRE_RESTORE_PATH}" != /* ]]; then
  PRE_RESTORE_PATH="${API_DIR}/${PRE_RESTORE_PATH#./}"
fi
echo "[restore] pre-backup: ${PRE_RESTORE_PATH}"

echo "[restore] resetting public schema..."
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL

echo "[restore] importing dump..."
gunzip -c "${ABS_INPUT_PATH}" | psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 >/dev/null

echo "[restore] done"
