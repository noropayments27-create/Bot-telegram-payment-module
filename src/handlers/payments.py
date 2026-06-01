from __future__ import annotations

import html
from typing import Any, Dict, List

import httpx
from aiogram import F, Router
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message

from ..config import (
    API_BASE_URL,
    API_TOKEN,
    BOT_RATE_LIMIT_ENABLED,
    BOT_RATE_LIMIT_PAID_SECONDS,
    BOT_RATE_LIMIT_SCREENSHOT_SECONDS,
    BOT_RATE_LIMIT_SECONDS,
    BOT_TO_API_SECRET,
    BINANCE_ID,
    CRYPTO_WALLET_BTC,
    CRYPTO_WALLET_LTC,
    CRYPTO_WALLET_USDT_BSC,
    CRYPTO_WALLET_USDT_TRON,
    MERCADOPAGO_ACCOUNT,
    NEQUI_NAME,
    NEQUI_NUMBER,
    PAYPAL_ACCOUNT,
)
from ..services.api_client import ApiClient
from ..utils.order_flow import guard_order_payable
from ..utils.order_watch import start_order_watch, stop_order_watch
from ..utils.rate_limit import check_rate_limit

router = Router()
api_client = ApiClient(API_BASE_URL, API_TOKEN, BOT_TO_API_SECRET)


class PaymentStates(StatesGroup):
    waiting_photo = State()


_DEFAULT_PAYMENT_METHODS = [
    {"key": "NEQUI", "label": "🏦 Nequi", "enabled": True},
    {"key": "BINANCE_ID", "label": "🟡 Binance ID", "enabled": True},
    {"key": "CRYPTO", "label": "🪙 Crypto", "enabled": True},
    {"key": "MERCADOPAGO", "label": "🧾 MercadoPago", "enabled": True},
    {"key": "PAYPAL", "label": "💳 PayPal", "enabled": True},
]


def _fmt_usd(value: Any) -> str:
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0.0
    if amount <= 0:
        return "$0 USD"
    return f"${amount:,.2f} USD".replace(".00", "")


def _extract_args(text: str | None) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    return raw.split()[1:]


def _method_key(value: Any) -> str:
    return str(value or "").strip().upper()


def _build_home_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="💼 Wallet", callback_data="payments:wallet")],
        ]
    )


async def _send_start_text(message: Message) -> None:
    await message.answer(
        "💳 <b>Payment Module activo</b>\n\n"
        "Comandos:\n"
        "• /pay_product PRODUCT_ID [qty]\n"
        "• /checkout_cart\n"
        "• /status ORDER_ID\n"
        "• /wallet",
        parse_mode=ParseMode.HTML,
        reply_markup=_build_home_keyboard(),
    )


async def _send_wallet_text(message: Message, telegram_id: int) -> None:
    try:
        data = await api_client.get_wallet(telegram_id)
    except Exception:
        await message.answer("❌ No pude consultar tu wallet.")
        return
    wallet = data.get("wallet") or data
    balance = wallet.get("balance") or wallet.get("balance_usd") or 0
    await message.answer(f"💼 Saldo disponible: <b>{_fmt_usd(balance)}</b>", parse_mode=ParseMode.HTML)


async def _get_payment_methods() -> List[Dict[str, Any]]:
    try:
        payload = await api_client.get_payment_methods()
        methods = payload.get("methods") if isinstance(payload, dict) else None
        if isinstance(methods, list):
            return methods
    except Exception as exc:
        print("[payments] payment_methods_load_failed", repr(exc))
    return list(_DEFAULT_PAYMENT_METHODS)


def _build_payment_methods_keyboard(order_id: str, methods: list[dict[str, Any]], wallet_enabled: bool = True) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    enabled_methods = [item for item in methods if bool(item.get("enabled", True))]
    for index, method in enumerate(enabled_methods, start=1):
        label = str(method.get("label") or method.get("key") or f"Metodo {index}")
        rows.append([InlineKeyboardButton(text=label, callback_data=f"paymethod:{order_id}:{index}")])
    if wallet_enabled:
        rows.append([InlineKeyboardButton(text="💰 Pagar con saldo", callback_data=f"walletpay:{order_id}")])
    rows.append([InlineKeyboardButton(text="📦 Estado", callback_data=f"status:{order_id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _destination_lines(method_key: str, method: dict[str, Any] | None = None) -> list[str]:
    key = _method_key(method_key)
    if method and method.get("destination"):
        raw = str(method.get("destination") or "").strip()
        if raw:
            return [html.escape(line.strip()) for line in raw.splitlines() if line.strip()]

    if key == "NEQUI":
        lines = []
        if NEQUI_NUMBER:
            lines.append(f"Numero: <code>{html.escape(NEQUI_NUMBER)}</code>")
        if NEQUI_NAME:
            lines.append(f"Nombre: <b>{html.escape(NEQUI_NAME)}</b>")
        return lines
    if key in {"BINANCE", "BINANCE_ID"}:
        return [f"Binance ID: <code>{html.escape(BINANCE_ID)}</code>"] if BINANCE_ID else []
    if key in {"MERCADOPAGO", "MP"}:
        return [f"Cuenta / CLABE: <code>{html.escape(MERCADOPAGO_ACCOUNT)}</code>"] if MERCADOPAGO_ACCOUNT else []
    if key == "PAYPAL":
        return [f"PayPal: <code>{html.escape(PAYPAL_ACCOUNT)}</code>"] if PAYPAL_ACCOUNT else []
    if key == "CRYPTO":
        lines = []
        if CRYPTO_WALLET_BTC:
            lines.append(f"BTC: <code>{html.escape(CRYPTO_WALLET_BTC)}</code>")
        if CRYPTO_WALLET_LTC:
            lines.append(f"LTC: <code>{html.escape(CRYPTO_WALLET_LTC)}</code>")
        if CRYPTO_WALLET_USDT_TRON:
            lines.append(f"USDT Tron: <code>{html.escape(CRYPTO_WALLET_USDT_TRON)}</code>")
        if CRYPTO_WALLET_USDT_BSC:
            lines.append(f"USDT BSC: <code>{html.escape(CRYPTO_WALLET_USDT_BSC)}</code>")
        return lines
    return []


def _build_payment_instructions(order_id: str, method_key: str, total: Any, method: dict[str, Any] | None = None) -> str:
    title = str((method or {}).get("label") or method_key)
    lines = [
        f"💳 <b>Metodo de pago: {html.escape(title)}</b>",
        "",
        f"🧾 Orden: <code>{html.escape(order_id)}</code>",
        f"💵 Total: <b>{_fmt_usd(total)}</b>",
    ]
    destinations = _destination_lines(method_key, method)
    if destinations:
        lines.extend(["", "📍 <b>Enviar a:</b>"])
        lines.extend(destinations)
    else:
        lines.extend(["", "⚠️ Este metodo no tiene destino configurado."])
    description = str((method or {}).get("description") or "").strip()
    if description:
        lines.extend(["", html.escape(description)])
    lines.extend(["", "Cuando termines el pago, presiona <b>Ya pague</b> y envia una captura del comprobante."])
    return "\n".join(lines)


def _build_paid_keyboard(order_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="✅ Ya pague", callback_data=f"paid:{order_id}")],
            [InlineKeyboardButton(text="📦 Ver estado", callback_data=f"status:{order_id}")],
        ]
    )


async def _render_order_payment_options(message: Message, state: FSMContext, order_id: str, total: Any, wallet_balance: Any = None) -> None:
    methods = await _get_payment_methods()
    await state.update_data(
        current_order_id=order_id,
        current_order_total=total,
        current_wallet_balance=wallet_balance,
        payment_method=None,
        payment_method_order_id=None,
        payment_ready=False,
    )
    wallet_text = f"\n💼 Saldo disponible: <b>{_fmt_usd(wallet_balance)}</b>" if wallet_balance is not None else ""
    await message.answer(
        f"🧾 <b>Orden creada</b>\n\nID: <code>{html.escape(order_id)}</code>\nTotal: <b>{_fmt_usd(total)}</b>{wallet_text}\n\nSelecciona un metodo de pago:",
        reply_markup=_build_payment_methods_keyboard(order_id, methods, wallet_enabled=True),
        parse_mode=ParseMode.HTML,
    )
    await start_order_watch(api_client, order_id, message)


@router.message(Command("start"))
async def cmd_start(message: Message) -> None:
    await _send_start_text(message)


@router.callback_query(F.data == "payments:home")
async def cb_home(callback: CallbackQuery) -> None:
    if callback.message:
        await _send_start_text(callback.message)
    await callback.answer()


@router.message(Command("pay_product"))
async def cmd_pay_product(message: Message, state: FSMContext) -> None:
    if not message.from_user:
        return
    wait = check_rate_limit(message.from_user.id, "pay_product", BOT_RATE_LIMIT_SECONDS, BOT_RATE_LIMIT_ENABLED)
    if wait:
        await message.answer(f"Espera {wait}s antes de intentarlo de nuevo.")
        return
    args = _extract_args(message.text)
    if not args:
        await message.answer("Uso: /pay_product PRODUCT_ID [qty]")
        return
    product_id = args[0]
    qty = max(int(args[1]), 1) if len(args) > 1 and args[1].isdigit() else 1
    result = await api_client.create_order({
        "telegram_id": message.from_user.id,
        "username": message.from_user.username,
        "product_id": product_id,
        "qty": qty,
    })
    if result.get("status_code"):
        data = result.get("data") or {}
        await message.answer(f"❌ No se pudo crear la orden.\nCodigo: <code>{html.escape(str(data.get('error') or result.get('status_code')))}</code>", parse_mode=ParseMode.HTML)
        return
    order = result.get("order") or {}
    order_id = str(order.get("id") or result.get("order_id") or "").strip()
    if not order_id:
        await message.answer("❌ La API no devolvio order_id.")
        return
    await _render_order_payment_options(message, state, order_id, order.get("total") or result.get("total_usd"), result.get("wallet_balance"))


@router.message(Command("checkout_cart"))
async def cmd_checkout_cart(message: Message, state: FSMContext) -> None:
    if not message.from_user:
        return
    result = await api_client.checkout_cart({"telegram_id": message.from_user.id, "username": message.from_user.username})
    if result.get("ok") is False:
        await message.answer(f"❌ No se pudo crear la orden del carrito: {html.escape(str(result.get('error') or 'ERROR'))}", parse_mode=ParseMode.HTML)
        return
    order_id = str(result.get("order_id") or "").strip()
    if not order_id:
        await message.answer("❌ La API no devolvio order_id.")
        return
    await _render_order_payment_options(message, state, order_id, result.get("total_usd"), result.get("wallet_balance"))


@router.callback_query(F.data.startswith("paymethod:"))
async def cb_payment_method(callback: CallbackQuery, state: FSMContext) -> None:
    if not callback.message or not callback.from_user:
        return
    parts = callback.data.split(":")
    order_id = parts[1]
    selector = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
    if not await guard_order_payable(api_client, order_id, callback.message):
        await callback.answer()
        return
    methods = [item for item in await _get_payment_methods() if bool(item.get("enabled", True))]
    if selector < 1 or selector > len(methods):
        await callback.answer("Metodo no disponible", show_alert=True)
        return
    method = methods[selector - 1]
    method_key = str(method.get("key") or "").strip()
    data = await state.get_data()
    await state.update_data(payment_method=method_key, payment_method_order_id=order_id, payment_ready=False)
    await callback.message.answer(_build_payment_instructions(order_id, method_key, data.get("current_order_total"), method), reply_markup=_build_paid_keyboard(order_id), parse_mode=ParseMode.HTML)
    await callback.answer()


@router.callback_query(F.data.startswith("walletpay:"))
async def cb_wallet_pay(callback: CallbackQuery, state: FSMContext) -> None:
    if not callback.message or not callback.from_user:
        return
    order_id = callback.data.split(":")[-1]
    if not await guard_order_payable(api_client, order_id, callback.message):
        await callback.answer()
        return
    result = await api_client.pay_order_with_wallet(order_id, callback.from_user.id)
    if result.get("status_code"):
        data = result.get("data") or {}
        await callback.answer(str(data.get("message") or data.get("error") or "No se pudo pagar con saldo"), show_alert=True)
        return
    wallet = result.get("wallet") or {}
    tx = result.get("transaction") or {}
    await state.update_data(payment_method="WALLET", payment_method_order_id=order_id, payment_ready=False)
    await stop_order_watch(callback.from_user.id, "wallet_paid")
    await callback.message.answer(
        "✅ <b>Pago con saldo exitoso</b>\n\n"
        f"Orden: <code>{html.escape(order_id)}</code>\n"
        f"Descontado: <b>{_fmt_usd(tx.get('amount'))}</b>\n"
        f"Saldo restante: <b>{_fmt_usd(wallet.get('balance'))}</b>",
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("paid:"))
async def cb_paid(callback: CallbackQuery, state: FSMContext) -> None:
    if not callback.message or not callback.from_user:
        return
    wait = check_rate_limit(callback.from_user.id, "paid", BOT_RATE_LIMIT_PAID_SECONDS, BOT_RATE_LIMIT_ENABLED)
    if wait:
        await callback.answer(f"Espera {wait}s antes de intentarlo de nuevo.", show_alert=True)
        return
    order_id = callback.data.split(":")[-1]
    if not await guard_order_payable(api_client, order_id, callback.message):
        await callback.answer()
        return
    data = await state.get_data()
    if data.get("payment_method_order_id") != order_id or not data.get("payment_method"):
        await callback.answer("Primero selecciona un metodo de pago.", show_alert=True)
        return
    await state.update_data(order_id=order_id, payment_ready=True, payment_proof_invalid_attempts=0)
    await state.set_state(PaymentStates.waiting_photo)
    await callback.message.answer("📸 Envia ahora la captura o imagen del comprobante de pago.")
    await callback.answer()


@router.message(PaymentStates.waiting_photo, F.photo)
async def handle_payment_photo(message: Message, state: FSMContext) -> None:
    if message.photo:
        photo = message.photo[-1]
        await _process_payment_proof(message, state, photo.file_id, photo.file_unique_id)


@router.message(PaymentStates.waiting_photo, F.document)
async def handle_payment_document(message: Message, state: FSMContext) -> None:
    if not message.document:
        return
    if not str(message.document.mime_type or "").startswith("image/"):
        await message.answer("⚠️ El documento debe ser una imagen.")
        return
    await _process_payment_proof(message, state, message.document.file_id, message.document.file_unique_id)


async def _process_payment_proof(message: Message, state: FSMContext, file_id: str, unique_id: str) -> None:
    if not message.from_user:
        return
    wait = check_rate_limit(message.from_user.id, "proof", BOT_RATE_LIMIT_SCREENSHOT_SECONDS, BOT_RATE_LIMIT_ENABLED)
    if wait:
        await message.answer(f"Espera {wait}s antes de enviar otra captura.")
        return
    data = await state.get_data()
    order_id = data.get("order_id") or data.get("current_order_id")
    if not order_id:
        await message.answer("No tienes una orden activa.")
        await state.clear()
        return
    if not data.get("payment_ready"):
        await message.answer("Primero presiona el boton 'Ya pague'.")
        return
    if not await guard_order_payable(api_client, str(order_id), message):
        return
    payment_method = data.get("payment_method")
    if not payment_method or data.get("payment_method_order_id") != order_id:
        await message.answer("Primero selecciona el metodo de pago usado.")
        return
    notice = await message.answer("🔎 Analizando comprobante...")
    try:
        result = await api_client.submit_payment_proof(str(order_id), {
            "telegram_id": message.from_user.id,
            "screenshot_file_id": file_id,
            "screenshot_unique_id": unique_id,
            "payment_method": payment_method,
        })
    except (httpx.TimeoutException, httpx.RequestError):
        await notice.delete()
        await message.answer("❌ Error de red enviando comprobante. Intentalo otra vez.")
        return
    except Exception as exc:
        await notice.delete()
        await message.answer(f"❌ Error inesperado procesando comprobante: {html.escape(str(exc))}", parse_mode=ParseMode.HTML)
        return
    await notice.delete()
    if result.get("status_code"):
        payload = result.get("data") or {}
        error = str(payload.get("error") or result.get("status_code"))
        msg = str(payload.get("message") or "")
        await message.answer(f"⚠️ Comprobante no aceptado.\nCodigo: <code>{html.escape(error)}</code>" + (f"\n{html.escape(msg)}" if msg else ""), parse_mode=ParseMode.HTML)
        return
    await message.answer("✅ Comprobante recibido. Tu pago queda en revision.")
    await state.update_data(order_id=None, payment_ready=False, payment_method=None, payment_method_order_id=None)
    await state.set_state(None)
    await stop_order_watch(message.from_user.id, "proof_submitted")


@router.message(Command("status"))
async def cmd_status(message: Message) -> None:
    args = _extract_args(message.text)
    if not args:
        await message.answer("Uso: /status ORDER_ID")
        return
    await _send_order_status(message, args[0])


@router.callback_query(F.data.startswith("status:"))
async def cb_status(callback: CallbackQuery) -> None:
    if callback.message:
        await _send_order_status(callback.message, callback.data.split(":")[-1])
    await callback.answer()


async def _send_order_status(message: Message, order_id: str) -> None:
    try:
        result = await api_client.get_order(order_id)
    except Exception:
        await message.answer("❌ Orden no encontrada.")
        return
    order = result.get("order") or {}
    status = str(order.get("status") or "-")
    text = [
        "📦 <b>Estado de orden</b>",
        "",
        f"ID: <code>{html.escape(order_id)}</code>",
        f"Estado: <b>{html.escape(status)}</b>",
        f"Total: <b>{_fmt_usd(order.get('total') or order.get('total_usd'))}</b>",
    ]
    if order.get("paid_at"):
        text.append(f"Pagada: {html.escape(str(order.get('paid_at')))}")
    await message.answer("\n".join(text), parse_mode=ParseMode.HTML)


@router.message(Command("wallet"))
async def cmd_wallet(message: Message) -> None:
    if not message.from_user:
        return
    await _send_wallet_text(message, message.from_user.id)


@router.callback_query(F.data == "payments:wallet")
async def cb_wallet(callback: CallbackQuery) -> None:
    if callback.message and callback.from_user:
        await _send_wallet_text(callback.message, callback.from_user.id)
    await callback.answer()
