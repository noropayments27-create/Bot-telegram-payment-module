from __future__ import annotations

from typing import Any, Dict, Optional

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message


def is_order_payable(order: Optional[Dict[str, Any]]) -> bool:
    if not order:
        return False
    return str(order.get("status") or "").upper() == "WAITING_PAYMENT"


async def show_not_payable(message: Message, text: str | None = None) -> None:
    await message.answer(
        text or "⚠️ Esta orden ya no se puede pagar. Puede estar pagada, cancelada, expirada o en revision.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="🏠 Inicio", callback_data="payments:home")]
            ]
        ),
    )


async def guard_order_payable(api_client, order_id: str, message: Message) -> bool:
    try:
        result = await api_client.get_order(order_id)
    except Exception:
        await show_not_payable(message, "⚠️ No pude encontrar esa orden o ya no esta disponible.")
        return False

    order = result.get("order") if isinstance(result, dict) else None
    if not is_order_payable(order):
        await show_not_payable(message)
        return False
    return True
