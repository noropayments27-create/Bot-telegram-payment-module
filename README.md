# API de pagos

Este repositorio ya no es solo un cliente de Telegram. Ahora contiene el backend central de pagos en `telegram-sales-api`, mas el bot Python que puede consumirlo si quieres mantener la capa de mensajeria separada.

La idea operativa es esta:

- `telegram-sales-api` implementa el flujo real de pagos.
- El bot Python en `src/` consume esa API como cliente opcional.
- Tus otros proyectos solo llaman a esta API central y no vuelven a copiar la logica de ordenes, comprobantes, wallet ni admin.

## Estructura

```text
telegram-sales-api/   backend Node.js + PostgreSQL + admin routes
src/                  bot Python cliente de la API
```

## Requisitos

- Node.js 18+ para `telegram-sales-api`
- Python 3.10+ para `src/`
- PostgreSQL para el backend
- Bot de Telegram creado con BotFather si vas a usar la capa bot

## Instalacion del bot

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m src.main
```

En Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
python -m src.main
```

## Variables de entorno del bot

Configura `.env` usando `.env.example` como base.

Variables principales:

- `TELEGRAM_BOT_TOKEN`: token del bot.
- `API_BASE_URL`: URL de tu backend.
- `API_TOKEN`: bearer token para la API, opcional segun tu backend.
- `ADMIN_API_KEY`: llave admin opcional.
- `BOT_TO_API_SECRET`: secreto para llamadas internas del bot.
- `ADMIN_TELEGRAM_IDS`: IDs de Telegram autorizados para comandos admin, separados por coma.

Destinos de pago fallback:

- `NEQUI_NUMBER`
- `NEQUI_NAME`
- `BINANCE_ID`
- `MERCADOPAGO_ACCOUNT`
- `PAYPAL_ACCOUNT`
- `CRYPTO_WALLET_BTC`
- `CRYPTO_WALLET_LTC`
- `CRYPTO_WALLET_USDT_TRON`
- `CRYPTO_WALLET_USDT_BSC`

## Backend de pagos

El backend real vive en `telegram-sales-api/`. Ese servicio implementa:

- crear ordenes
- listar metodos de pago
- recibir comprobantes
- pagar con wallet
- consultar wallet e historial
- aprobar, rechazar, cancelar y reembolsar ordenes
- administrar recargas de wallet

Para correrlo:

```bash
cd telegram-sales-api
npm install
cp .env.example .env
npm run migrate
npm run dev
```

Si quieres cargar productos demo del bot original:

```bash
npm run migrate:with-seed
```

La API queda localmente en:

```text
http://localhost:3001
```

## Uso del bot

### Usuario

Crear una orden para un producto:

```text
/pay_product PRODUCT_ID
/pay_product PRODUCT_ID 2
```

Consultar una orden:

```text
/status ORDER_ID
```

Ver wallet:

```text
/wallet
```

Despues de crear la orden, el bot mostrara los metodos de pago. El usuario elige metodo, presiona `Ya pague` y sube una captura o imagen del comprobante.

### Admin

Listar ordenes pendientes:

```text
/admin_payments
```

Aprobar orden:

```text
/approve ORDER_ID
```

Rechazar orden y permitir reintento:

```text
/reject ORDER_ID motivo opcional
```

Cancelar orden:

```text
/cancel_order ORDER_ID motivo opcional
```

Reembolsar orden:

```text
/refund ORDER_ID motivo opcional
```

Ver recargas pendientes de wallet:

```text
/wallet_topups
```

Aprobar recarga:

```text
/approve_topup TOPUP_REF
```

Rechazar recarga:

```text
/reject_topup TOPUP_REF motivo opcional
```

## Endpoints del backend

Estos son algunos de los endpoints expuestos por el backend central:

```text
GET    /health
GET    /orders/payment-methods
POST   /orders
GET    /orders/{order_id}
POST   /orders/{order_id}/payment-proof
POST   /orders/{order_id}/pay-with-wallet
GET    /users/{telegram_id}/wallet
GET    /users/{telegram_id}/wallet/history
POST   /bot/cart/checkout

GET    /admin/orders
GET    /admin/orders/{order_id}
POST   /admin/orders/{order_id}/mark-paid
POST   /admin/orders/{order_id}/reject
POST   /admin/orders/{order_id}/refund
GET    /admin/wallets/topups
POST   /admin/wallets/topups/{ref}/approve
POST   /admin/wallets/topups/{ref}/reject
```

## Integracion En Otros Proyectos

Tus proyectos futuros no necesitan instalar todo el flujo de pagos. Les basta con:

- apuntar a la URL de esta API central
- autenticarse con `x-bot-secret`
- crear ordenes o consultar estados desde HTTP

En esos proyectos solo necesitas frontend propio si quieres mostrar pantallas de cobro o botones al usuario. La logica de pago no se duplica.

Ejemplo de variables para otro proyecto:

```env
PAYMENTS_API_URL=https://api-de-pagos.tu-dominio.com
PAYMENTS_API_SECRET=el-mismo-valor-de-BOT_TO_API_SECRET
```

Ejemplo de llamada:

```bash
curl -X POST "$PAYMENTS_API_URL/orders" \
  -H "Content-Type: application/json" \
  -H "x-bot-secret: $PAYMENTS_API_SECRET" \
  -d '{"telegram_id":123456789,"username":"cliente","product_id":"PRODUCT_UUID","qty":1}'
```

## Estados esperados de orden

El modulo asume que una orden es pagable cuando su estado es:

```text
WAITING_PAYMENT
```

Estados comunes:

```text
CREATED
WAITING_PAYMENT
PAID
DELIVERED
CANCELLED
REFUNDED
EXPIRED
SCAM
```

## Recomendaciones de seguridad

- El backend debe validar `telegram_id` contra la orden antes de aceptar comprobantes.
- El backend debe rechazar comprobantes duplicados por `screenshot_unique_id`.
- El backend debe hacer pagos con wallet en una transaccion atomica.
- El backend debe exigir `Authorization`, `x-admin-key` o `x-bot-secret` en operaciones sensibles.
- No guardes claves reales en el repo. Usa variables de entorno.
- Para produccion usa webhook HTTPS y un `WEBHOOK_SECRET` largo.

## Estructura

```text
src/
  main.py
  config.py
  handlers/
    payments.py
    admin_payments.py
  services/
    api_client.py
  utils/
    order_flow.py
    order_watch.py
```
