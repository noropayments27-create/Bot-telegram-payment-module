# Bot Telegram Payment Module

Modulo independiente para procesar pagos manuales desde un bot de Telegram usando `aiogram` y un backend externo.

Este repo fue extraido conceptualmente del flujo de pagos del bot original, pero queda limpio y enfocado solo en:

- Crear ordenes de pago.
- Mostrar metodos de pago.
- Pagar con saldo interno / wallet.
- Recibir comprobantes de pago.
- Consultar estado de orden.
- Aprobar, rechazar, cancelar y reembolsar ordenes desde comandos admin.
- Procesar recargas de wallet desde admin.

> Importante: este bot no cobra directamente con Stripe, MercadoPago Checkout ni PayPal API. Este modulo esta pensado para pagos manuales por comprobante y/o saldo interno, delegando la validacion real al backend definido en `API_BASE_URL`.

## Requisitos

- Python 3.10+
- Bot de Telegram creado con BotFather
- Backend compatible con los endpoints documentados abajo

## Instalacion

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

## Variables de entorno

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

## Endpoints esperados del backend

Este modulo espera que tu backend implemente endpoints similares a estos:

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
