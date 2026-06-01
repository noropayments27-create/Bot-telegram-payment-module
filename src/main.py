from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlparse

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web

from .config import (
    BOT_UPDATE_MODE,
    TELEGRAM_BOT_TOKEN,
    WEBHOOK_HOST,
    WEBHOOK_PATH,
    WEBHOOK_PORT,
    WEBHOOK_SECRET,
    WEBHOOK_URL,
)
from .handlers import admin_payments, payments
from .services.api_client import ApiClient


def _normalize_webhook_path(path: str) -> str:
    clean_path = str(path or "/telegram/webhook").strip() or "/telegram/webhook"
    return clean_path if clean_path.startswith("/") else f"/{clean_path}"


def _normalize_webhook_url(url: str, path: str) -> str:
    clean_url = str(url or "").strip()
    webhook_path = _normalize_webhook_path(path)
    parsed = urlparse(clean_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError(
            "WEBHOOK_URL must be a full HTTPS URL, for example "
            f"https://your-service.koyeb.app{webhook_path}"
        )
    if parsed.path in {"", "/"}:
        clean_url = clean_url.rstrip("/") + webhook_path
    parsed = urlparse(clean_url)
    if parsed.path != webhook_path:
        raise RuntimeError(
            f"WEBHOOK_URL path must match WEBHOOK_PATH. Expected {webhook_path}, got {parsed.path or '/'}"
        )
    return clean_url


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    dp = Dispatcher(storage=MemoryStorage())

    dp.include_router(payments.router)
    dp.include_router(admin_payments.router)

    try:
        if BOT_UPDATE_MODE == "webhook":
            if not WEBHOOK_URL:
                raise RuntimeError("WEBHOOK_URL is required when BOT_UPDATE_MODE=webhook")
            webhook_path = _normalize_webhook_path(WEBHOOK_PATH)
            webhook_url = _normalize_webhook_url(WEBHOOK_URL, webhook_path)

            app = web.Application()
            request_handler = SimpleRequestHandler(
                dispatcher=dp,
                bot=bot,
                secret_token=WEBHOOK_SECRET or None,
            )
            request_handler.register(app, path=webhook_path)
            setup_application(app, dp, bot=bot)
            await bot.set_webhook(
                webhook_url,
                secret_token=WEBHOOK_SECRET or None,
                drop_pending_updates=True,
            )

            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, WEBHOOK_HOST, WEBHOOK_PORT)
            await site.start()
            logging.info("Payment bot webhook running on %s:%s%s", WEBHOOK_HOST, WEBHOOK_PORT, webhook_path)
            await asyncio.Event().wait()
        else:
            await bot.delete_webhook(drop_pending_updates=True)
            logging.info("Payment bot polling started")
            await dp.start_polling(bot)
    finally:
        await ApiClient.aclose_all()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
