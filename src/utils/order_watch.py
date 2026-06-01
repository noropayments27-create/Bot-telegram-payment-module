from __future__ import annotations

import asyncio
from typing import Dict

from aiogram.types import Message

from .order_flow import is_order_payable, show_not_payable

_WATCH_TASKS: Dict[int, asyncio.Task] = {}
_WATCH_ORDER: Dict[int, str] = {}


async def stop_order_watch(user_id: int, reason: str = "manual") -> None:
    task = _WATCH_TASKS.pop(user_id, None)
    _WATCH_ORDER.pop(user_id, None)
    if task and not task.done():
        task.cancel()
    print("[payment/order_watch] stopped", {"telegram_id": user_id, "reason": reason})


async def start_order_watch(
    api_client,
    order_id: str,
    message: Message,
    *,
    interval_seconds: int = 3,
) -> None:
    if not message.from_user:
        return
    user_id = message.from_user.id
    current = _WATCH_ORDER.get(user_id)
    if current == order_id and user_id in _WATCH_TASKS:
        return
    if current and current != order_id:
        await stop_order_watch(user_id, "order_changed")

    async def _watch() -> None:
        print("[payment/order_watch] started", {"telegram_id": user_id, "order_id": order_id})
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                result = await api_client.get_order(order_id)
            except Exception:
                await stop_order_watch(user_id, "fetch_failed")
                return
            order = result.get("order") if isinstance(result, dict) else None
            if not is_order_payable(order):
                await show_not_payable(message)
                await stop_order_watch(user_id, "not_payable")
                return

    task = asyncio.create_task(_watch())
    _WATCH_TASKS[user_id] = task
    _WATCH_ORDER[user_id] = order_id
