from __future__ import annotations

import html
from typing import Any

from aiogram import Router
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.types import Message

from ..config import ADMIN_TELEGRAM_IDS, API_BASE_URL, API_TOKEN, BOT_TO_API_SECRET
from ..services.api_client import ApiClient

router = Router()
api_client = ApiClient(API_BASE_URL, API_TOKEN, BOT_TO_API_SECRET)


def _is_admin(message: Message) -> bool:
    return bool(message.from_user and message.from_user.id in ADMIN_TELEGRAM_IDS)


async def _admin_guard(message: Message) -> bool:
    if _is_admin(message):
        return True
    await message.answer("⛔ No autorizado.")
    return False


def _args(message: Message) -> list[str]:
    text = (message.text or "").strip()
    return text.split()[1:]


def _fmt_amount(value: Any) -> str:
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0.0
    return f"${amount:,.2f} USD".replace(".00", "")


@router.message(Command("admin_payments"))
async def cmd_admin_payments(message: Message) -> None:
    if not await _admin_guard(message):
        return
    try:
        data = await api_client.admin_list_orders(status="WAITING_PAYMENT", page=1, page_size=10)
    except Exception as exc:
        await message.answer(f"❌ Error consultando pendientes: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    items = data.get("items") or []
    if not items:
        await message.answer("✅ No hay ordenes pendientes de pago.")
        return
    lines = ["📋 <b>Ordenes pendientes</b>", ""]
    for index, order in enumerate(items, start=1):
        order_id = str(order.get("id") or "")
        username = str(order.get("telegram_username") or order.get("username") or "-")
        total = order.get("total") or order.get("total_usd")
        status = str(order.get("status") or "-")
        lines.append(
            f"{index}. <code>{html.escape(order_id)}</code>\n"
            f"   👤 @{html.escape(username)}\n"
            f"   💵 <b>{_fmt_amount(total)}</b> · {html.escape(status)}"
        )
    lines.extend([
        "",
        "Comandos:",
        "<code>/approve ORDER_ID</code>",
        "<code>/reject ORDER_ID motivo</code>",
        "<code>/cancel_order ORDER_ID motivo</code>",
        "<code>/refund ORDER_ID motivo</code>",
    ])
    await message.answer("\n".join(lines), parse_mode=ParseMode.HTML)


@router.message(Command("approve"))
async def cmd_approve(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /approve ORDER_ID")
        return
    order_id = args[0]
    try:
        result = await api_client.admin_mark_order_paid(order_id)
    except Exception as exc:
        await message.answer(f"❌ No se pudo aprobar: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    status = (result.get("order") or {}).get("status") or result.get("status") or "OK"
    await message.answer(
        f"✅ <b>Orden aprobada</b>\n\nID: <code>{html.escape(order_id)}</code>\nEstado: <b>{html.escape(str(status))}</b>",
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("reject"))
async def cmd_reject(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /reject ORDER_ID motivo opcional")
        return
    order_id = args[0]
    reason = " ".join(args[1:]).strip() or "Rejected by Telegram admin"
    try:
        await api_client.admin_reject_order(order_id, mode="retry", reason=reason)
    except Exception as exc:
        await message.answer(f"❌ No se pudo rechazar: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    await message.answer(
        f"❌ <b>Orden rechazada</b>\n\nID: <code>{html.escape(order_id)}</code>\nMotivo: {html.escape(reason)}",
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("cancel_order"))
async def cmd_cancel_order(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /cancel_order ORDER_ID motivo opcional")
        return
    order_id = args[0]
    reason = " ".join(args[1:]).strip() or "Cancelled by Telegram admin"
    try:
        await api_client.admin_cancel_order(order_id, reason=reason)
    except Exception as exc:
        await message.answer(f"❌ No se pudo cancelar: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    await message.answer(
        f"🛑 <b>Orden cancelada</b>\n\nID: <code>{html.escape(order_id)}</code>\nMotivo: {html.escape(reason)}",
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("refund"))
async def cmd_refund(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /refund ORDER_ID motivo opcional")
        return
    order_id = args[0]
    reason = " ".join(args[1:]).strip() or "Refunded by Telegram admin"
    try:
        result = await api_client.admin_refund_order(order_id, reason=reason)
    except Exception as exc:
        await message.answer(f"❌ No se pudo reembolsar: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    refund = result.get("refund") or {}
    await message.answer(
        f"💸 <b>Reembolso aplicado</b>\n\n"
        f"ID: <code>{html.escape(order_id)}</code>\n"
        f"Monto: <b>{_fmt_amount(refund.get('amount'))}</b>\n"
        f"Motivo: {html.escape(reason)}",
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("wallet_topups"))
async def cmd_wallet_topups(message: Message) -> None:
    if not await _admin_guard(message):
        return
    try:
        data = await api_client.admin_list_wallet_topups(status="SUBMITTED", page=1, page_size=10)
    except Exception as exc:
        await message.answer(f"❌ Error consultando recargas: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    items = data.get("items") or []
    if not items:
        await message.answer("✅ No hay recargas pendientes.")
        return
    lines = ["📥 <b>Recargas pendientes</b>", ""]
    for item in items:
        ref = str(item.get("topup_number_label") or item.get("id") or "-")
        telegram_id = str(item.get("telegram_id") or "-")
        amount = item.get("amount_usd") or item.get("amount")
        method = str(item.get("payment_method") or "-")
        lines.append(f"• <code>{html.escape(ref)}</code> · {html.escape(telegram_id)} · <b>{_fmt_amount(amount)}</b> · {html.escape(method)}")
    lines.extend([
        "",
        "Comandos:",
        "<code>/approve_topup REF</code>",
        "<code>/reject_topup REF motivo</code>",
    ])
    await message.answer("\n".join(lines), parse_mode=ParseMode.HTML)


@router.message(Command("approve_topup"))
async def cmd_approve_topup(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /approve_topup REF")
        return
    ref = args[0]
    try:
        result = await api_client.admin_approve_wallet_topup(ref)
    except Exception as exc:
        await message.answer(f"❌ No se pudo aprobar recarga: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    topup = result.get("topup") or {}
    await message.answer(
        f"✅ <b>Recarga aprobada</b>\n\nRef: <code>{html.escape(ref)}</code>\nMonto: <b>{_fmt_amount(topup.get('amount_usd') or topup.get('amount'))}</b>",
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("reject_topup"))
async def cmd_reject_topup(message: Message) -> None:
    if not await _admin_guard(message):
        return
    args = _args(message)
    if not args:
        await message.answer("Uso: /reject_topup REF motivo opcional")
        return
    ref = args[0]
    reason = " ".join(args[1:]).strip() or "Rejected by Telegram admin"
    try:
        await api_client.admin_reject_wallet_topup(ref, reason=reason)
    except Exception as exc:
        await message.answer(f"❌ No se pudo rechazar recarga: <code>{html.escape(str(exc))}</code>", parse_mode=ParseMode.HTML)
        return
    await message.answer(
        f"❌ <b>Recarga rechazada</b>\n\nRef: <code>{html.escape(ref)}</code>\nMotivo: {html.escape(reason)}",
        parse_mode=ParseMode.HTML,
    )
