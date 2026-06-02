# Stock QA & Inventario

## Script QA (concurrencia)
Ejecutar desde `telegram-sales-api`:
```bash
DATABASE_URL="postgres://..." API_BASE_URL="http://localhost:3001" node scripts/qa_stock_race.js
```

Opcionales:
- `QA_PRODUCT_ID` o `QA_SKU_KEY` para reutilizar un producto existente.

## CSV para carga de UNITS
Columnas mínimas sugeridas:
```
product_id,sku_key,username,password,start_at,expires_at,notes,payload
```

- `payload` debe ser JSON válido (opcional).
- Si `product_id` o `sku_key` no viene en CSV, se usa el query param.

Ejemplo de fila:
```
,shop_test_1,u1,p1,2026-01-11,2026-02-11,nota 1,
```

## Endpoints admin nuevos
- `GET /admin/stock/inspect?product_id=...|sku_key=...`
- `GET /admin/stock/units?product_id=...&status=AVAILABLE&limit=50`
- `POST /admin/stock/units/upload?product_id=...` (multipart/form-data)
- `POST /admin/stock/simple/set`
  ```json
  {"product_id":"...","simple_stock":10}
  ```
- `POST /admin/stock/template/set`
  ```json
  {"product_id":"...","delivery_template":"..."}
  ```
- `GET /admin/orders/:id/inspect`
- `GET /admin/stock/holds/debug?order_id=...|product_id=...`

## Admin API Key auth
Con header `x-admin-key`:
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3001/admin/stock/inspect?sku_key=shop_producto_01"
```

Con `Authorization: Bearer`:
```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "http://localhost:3001/admin/stock/inspect?sku_key=shop_producto_01"
```

## Ejemplos curl
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3001/admin/stock/inspect?sku_key=shop_test_1"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3001/admin/orders/<ORDER_ID>/inspect"
```

## Queries de diagnóstico (DB)
Holds por order_id:
```sql
SELECT id, product_id, order_id, qty, status, expires_at, created_at
FROM product_stock_holds
WHERE order_id = '<ORDER_ID>'
ORDER BY created_at DESC;
```

Holds por product_id (últimos 10):
```sql
SELECT id, product_id, order_id, qty, status, expires_at, created_at
FROM product_stock_holds
WHERE product_id = '<PRODUCT_ID>'
ORDER BY created_at DESC
LIMIT 10;
```

Units HELD por product_id + order_id:
```sql
SELECT id, product_id, held_by_order_id, status, held_at, created_at
FROM product_stock_units
WHERE product_id = '<PRODUCT_ID>' AND status = 'HELD'
ORDER BY created_at DESC;
```

Nota: `order_id` != `product_id`.

## Grants DB (si faltan permisos)
Ejecutar como superuser (ajusta el rol si no es `telegram`):
```bash
psql -d telegram_sales -f sql/013_grants_stock.sql
```
