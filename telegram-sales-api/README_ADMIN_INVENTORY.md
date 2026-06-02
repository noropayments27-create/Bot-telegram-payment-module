# Admin Inventario

## Endpoints (admin)

### Inspect stock
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3001/admin/stock/inspect?sku_key=shop_producto_01&limit_units_sample=10"
```

### Inspect order
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3001/admin/orders/<ORDER_ID>/inspect"
```

### Set SIMPLE stock
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sku_key":"shop_producto_01","stock_qty":10}' \
  "http://localhost:3001/admin/stock/simple/set"
```

### Upload UNITS CSV
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  -F "file=@units.csv" \
  "http://localhost:3001/admin/stock/units/upload?sku_key=shop_producto_01"
```

### Units summary + sample
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3001/admin/stock/units?sku_key=shop_producto_01&limit=20"
```

## CSV formato
Encabezados aceptados:
```
product_id,sku_key,external_id,username,password,payload,starts_at,expires_at,notes
```

Ejemplo:
```
sku_key,username,password,start_at,expires_at,notes
shop_producto_01,u1,p1,2026-01-11,2026-02-11,nota 1
```
