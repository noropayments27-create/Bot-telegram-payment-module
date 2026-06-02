# telegram-sales-api

API base para el bot de ventas en Telegram.

## Requisitos
- Node.js 18+
- npm

## Instalacion
```bash
npm install
cp .env.example .env
npm run migrate
```

## Playwright (render de recibos)
En servidores Linux, instala el navegador de Chromium y dependencias:
```bash
npx playwright install chromium --with-deps
```

## Variables de entorno
Configura estas variables en `.env`:
- `DATABASE_URL`
- `DB_POOL_MAX` (opcional, default 5; usa la URL pooled de Neon cuando haya muchas conexiones)
- `DB_IDLE_TIMEOUT_MS` (opcional, default 10000)
- `DB_CONNECTION_TIMEOUT_MS` (opcional, default 5000)
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_TELEGRAM_IDS`
- `BOT_TO_API_SECRET`
- `ADMIN_TOKEN_SECRET` (opcional, si no se usa se reutiliza `ADMIN_PASSWORD`)
- `DELIVERY_INITIAL_DELAY_MS` (opcional, default 10000)
- `DELIVERY_MESSAGE_INTERVAL_MS` (opcional, default 1000)
- `WALLET_SYNC_THROTTLE_MS` (opcional, default 30000)
- `WALLET_SYNC_BATCH_LIMIT` (opcional, default 50)

## Desarrollo
```bash
npm run dev
```

## Produccion
```bash
npm run migrate
npm start
```

## Migraciones
Ejecuta todas las migraciones SQL pendientes:

```bash
npm run migrate
```

Para incluir el seed demo de productos:

```bash
npm run migrate:with-seed
```

## Catalogo editable (seed)
Editar el archivo `seeds/catalog_placeholder.yaml` y ejecutar:
```bash
npm run seed:catalog
```
Verificar en DB:
```sql
SELECT sku_key, code, is_active FROM products ORDER BY code;
```

## Migracion codes por seccion
Ejecutar:
```bash
psql "$DATABASE_URL" -f sql/006_products_code_by_section.sql
```
Verificar por seccion:
```sql
SELECT sku_key, code, name FROM products WHERE sku_key LIKE 'shop_%' ORDER BY code;
SELECT sku_key, code, name FROM products WHERE sku_key LIKE 'metodos_%' ORDER BY code;
SELECT sku_key, code, name FROM products WHERE sku_key LIKE 'vip_%' ORDER BY code;
SELECT sku_key, code, name FROM products WHERE sku_key LIKE 'web_%' ORDER BY code;
SELECT COUNT(*) FROM products WHERE sku_key LIKE 'shop_%' AND (code IS NULL OR code='');
```

## Endpoint de salud
- GET `http://localhost:3001/health`
