# Operacion: Backups y Alertas

Este bloque cubre los pasos 3 y 4:

- Backups automaticos de PostgreSQL.
- Alertas operativas por errores 5xx y healthcheck.
- Subida automatica de backups a Google Drive (opcional).

## 1) Backups automaticos

Script incluido: `scripts/backup_db.sh`

Variables:

- `DATABASE_URL` (obligatoria)
- `BACKUP_DIR` (opcional, default `./backups/postgres`)
- `BACKUP_PREFIX` (opcional, default `telegram_sales`)
- `BACKUP_RETENTION_DAYS` (opcional, default `14`)

Ejecucion manual:

```bash
npm run backup:db
```

Restore manual (ejemplo):

```bash
gunzip -c ./backups/postgres/telegram_sales_YYYYMMDD_HHMMSS.sql.gz | psql "$DATABASE_URL"
```

Restore seguro con script (sobrescribe datos actuales y crea pre-backup automatico):

```bash
npm run restore:db -- ./backups/postgres/archivo.sql.gz
```

Tambien puedes usar el ultimo backup automaticamente:

```bash
npm run restore:db -- --latest
```

Cron recomendado (servidor externo o runner):

```bash
0 3 * * * cd /ruta/telegram-sales-api && /usr/bin/env bash ./scripts/backup_db.sh >> ./backups/backup.log 2>&1
```

## 1.1) Subida automatica a Google Drive

Para habilitar subida de backups a Drive:

1. Crea una carpeta en Google Drive para backups.
2. Crea una Service Account en Google Cloud.
3. Descarga el JSON de credenciales.
4. Comparte la carpeta de Drive con el `client_email` de la Service Account (permiso Editor).
5. Configura variables:

- `BACKUP_DRIVE_ENABLED=true`
- `BACKUP_DRIVE_FOLDER_ID=<ID_DE_CARPETA_DRIVE>`
- `BACKUP_DRIVE_SERVICE_ACCOUNT_JSON=<JSON_EN_UNA_LINEA>`
  - o `BACKUP_DRIVE_SERVICE_ACCOUNT_BASE64=<JSON_EN_BASE64>`
  - o `BACKUP_DRIVE_SERVICE_ACCOUNT_FILE=/ruta/credenciales.json`

Con esto:

- El endpoint `POST /admin/ops/backup/run` sube el backup automatico a Drive.
- El cron `scripts/cron_daily_backup.sh` tambien lo sube automaticamente.

Prueba manual:

```bash
npm run backup:db
node ./scripts/upload_backup_to_drive.js ./backups/postgres/archivo.sql.gz
```

## 1.2) Envio automatico de backup por Telegram

Tambien puedes enviar cada backup como documento por Telegram (sin Drive):

- `BACKUP_TELEGRAM_ENABLED=true`
- `BACKUP_TELEGRAM_CHAT_IDS=7621162350,123456789` (opcional)
  - Si existe, se intenta primero esta lista.
  - Si toda esta lista falla, usa `ADMIN_TELEGRAM_IDS` como respaldo.
- `BACKUP_TELEGRAM_CAPTION_PREFIX=Backup DB` (opcional)
- `TELEGRAM_BOT_TOKEN=<token_del_bot>`
- `ADMIN_TELEGRAM_IDS=...` (si no defines `BACKUP_TELEGRAM_CHAT_IDS`)

Con esto:

- El endpoint `POST /admin/ops/backup/run` envia el backup por Telegram.
- El cron `scripts/cron_daily_backup.sh` tambien lo envia automaticamente.

Prueba manual:

```bash
npm run backup:db
node ./scripts/upload_backup_to_telegram.js ./backups/postgres/archivo.sql.gz
```

## 2) Alertas operativas

### 2.1 Alertas 5xx desde el API

Se envia alerta por Telegram cuando el API responde error `>=500`.

Variables:

- `OPS_ALERTS_ENABLED=true`
- `OPS_ALERTS_COOLDOWN_SECONDS=300` (evita spam por el mismo error)
- `OPS_ALERTS_SERVICE=telegram-sales-api` (nombre mostrado)
- `ADMIN_TELEGRAM_IDS=...` (destinatarios)
- `TELEGRAM_BOT_TOKEN=...` (bot que envia la alerta)

### 2.2 Healthcheck activo

Script incluido: `scripts/ops_healthcheck.js`

Variables:

- `HEALTHCHECK_URL` (ejemplo: `https://tu-api.com/health`)
- `HEALTHCHECK_TIMEOUT_MS=8000` (opcional)
- `ADMIN_TELEGRAM_IDS=...`
- `TELEGRAM_BOT_TOKEN=...`

Ejecucion manual:

```bash
npm run ops:healthcheck
```

Cron recomendado cada 5 minutos:

```bash
*/5 * * * * cd /ruta/telegram-sales-api && HEALTHCHECK_URL="https://tu-api.com/health" /usr/bin/env node ./scripts/ops_healthcheck.js >> ./backups/healthcheck.log 2>&1
```
