from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, Optional

import httpx

from ..config import (
    ADMIN_API_KEY,
    BOT_TO_API_SECRET,
    PAYMENT_PROOF_SUBMIT_TIMEOUT_SECONDS,
)


async def _request_with_retry(fn, attempts: int = 3, delay: float = 0.35) -> Any:
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return await fn()
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            last_exc = exc
            if attempt < attempts - 1:
                await asyncio.sleep(delay)
            else:
                raise
    if last_exc:
        raise last_exc
    raise RuntimeError("Retry failed without capturing an exception.")


class ApiClient:
    """Small API client dedicated to payment processing.

    The bot never decides that a payment is valid by itself. It only sends order,
    wallet and proof data to the backend. The backend must validate ownership,
    duplicates, order status and wallet transactions.
    """

    _shared_clients: Dict[str, httpx.AsyncClient] = {}
    _shared_cache: Dict[str, tuple[float, Any]] = {}

    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        bot_secret: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.bot_secret = bot_secret

    def _headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if ADMIN_API_KEY:
            headers["x-admin-key"] = ADMIN_API_KEY
        if self.bot_secret or BOT_TO_API_SECRET:
            headers["x-bot-secret"] = self.bot_secret or BOT_TO_API_SECRET or ""
        return headers

    def _client(self) -> httpx.AsyncClient:
        existing = self._shared_clients.get(self.base_url)
        if existing and not existing.is_closed:
            return existing
        client = httpx.AsyncClient()
        self._shared_clients[self.base_url] = client
        return client

    def _cache_key(self, scope: str, value: Any = None) -> str:
        suffix = "" if value is None else f":{value}"
        return f"{self.base_url}:{scope}{suffix}"

    def _cache_get(self, key: str) -> Any | None:
        cached = self._shared_cache.get(key)
        if not cached:
            return None
        expires_at, value = cached
        if expires_at <= time.monotonic():
            self._shared_cache.pop(key, None)
            return None
        return value

    def _cache_set(self, key: str, value: Any, ttl_seconds: float) -> Any:
        self._shared_cache[key] = (time.monotonic() + max(ttl_seconds, 0), value)
        return value

    def _cache_pop(self, key: str) -> None:
        self._shared_cache.pop(key, None)

    async def _request(self, method: str, url: str, *, retry: bool = False, **kwargs) -> httpx.Response:
        client = self._client()

        async def _do() -> httpx.Response:
            return await client.request(method, url, **kwargs)

        if retry:
            return await _request_with_retry(_do)
        return await _do()

    @classmethod
    async def aclose_all(cls) -> None:
        clients = list(cls._shared_clients.values())
        cls._shared_clients.clear()
        for client in clients:
            if client and not client.is_closed:
                await client.aclose()

    async def ping_health(self) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/health",
            headers=self._headers(),
            timeout=5,
        )
        response.raise_for_status()
        return response.json()

    async def get_payment_methods(self) -> Dict[str, Any]:
        cache_key = self._cache_key("payment_methods")
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached
        response = await self._request(
            "GET",
            f"{self.base_url}/orders/payment-methods",
            headers=self._headers(),
            timeout=5,
        )
        response.raise_for_status()
        return self._cache_set(cache_key, response.json(), 30)

    async def create_order(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/orders",
            json=payload,
            headers=self._headers(),
            timeout=15,
        )
        if response.status_code in (400, 403, 409, 422):
            return {"status_code": response.status_code, "data": response.json()}
        response.raise_for_status()
        return response.json()

    async def checkout_cart(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/bot/cart/checkout",
            json=payload,
            headers=self._headers(),
            timeout=15,
        )
        if response.status_code in (400, 403, 409, 422):
            return response.json()
        response.raise_for_status()
        return response.json()

    async def get_order(self, order_id: str) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/orders/{order_id}",
            headers=self._headers(),
            timeout=8,
        )
        response.raise_for_status()
        return response.json()

    async def submit_payment_proof(self, order_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/orders/{order_id}/payment-proof",
            json=payload,
            headers=self._headers(),
            timeout=PAYMENT_PROOF_SUBMIT_TIMEOUT_SECONDS,
        )
        if response.status_code in (400, 403, 404, 409, 422):
            return {"status_code": response.status_code, "data": response.json()}
        response.raise_for_status()
        return response.json()

    async def pay_order_with_wallet(self, order_id: str, telegram_id: int) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/orders/{order_id}/pay-with-wallet",
            json={"telegram_id": telegram_id},
            headers=self._headers(),
            timeout=60,
        )
        if response.status_code in (400, 403, 404, 409, 422):
            return {"status_code": response.status_code, "data": response.json()}
        response.raise_for_status()
        self._cache_pop(self._cache_key("wallet", telegram_id))
        return response.json()

    async def get_wallet(self, telegram_id: int) -> Dict[str, Any]:
        cache_key = self._cache_key("wallet", telegram_id)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached
        response = await self._request(
            "GET",
            f"{self.base_url}/users/{telegram_id}/wallet",
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        return self._cache_set(cache_key, response.json(), 8)

    async def get_wallet_history(self, telegram_id: int, limit: int = 10) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/users/{telegram_id}/wallet/history",
            params={"limit": limit},
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        return response.json()

    async def admin_list_orders(self, status: str = "WAITING_PAYMENT", page: int = 1, page_size: int = 10) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/admin/orders",
            params={"status": status, "page": page, "page_size": page_size},
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    async def admin_get_order(self, order_id: str) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/admin/orders/{order_id}",
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    async def admin_mark_order_paid(self, order_id: str) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/admin/orders/{order_id}/mark-paid",
            json={},
            headers=self._headers(),
            timeout=60,
        )
        response.raise_for_status()
        return response.json()

    async def admin_reject_order(self, order_id: str, mode: str = "retry", reason: str | None = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"mode": mode}
        if reason:
            payload["reason"] = reason
        response = await self._request(
            "POST",
            f"{self.base_url}/admin/orders/{order_id}/reject",
            json=payload,
            headers=self._headers(),
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    async def admin_cancel_order(self, order_id: str, reason: str | None = None) -> Dict[str, Any]:
        return await self.admin_reject_order(order_id, mode="cancel", reason=reason)

    async def admin_refund_order(self, order_id: str, reason: str | None = None, amount: float | None = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if reason:
            payload["reason"] = reason
        if amount is not None:
            payload["amount"] = amount
        response = await self._request(
            "POST",
            f"{self.base_url}/admin/orders/{order_id}/refund",
            json=payload,
            headers=self._headers(),
            timeout=60,
        )
        response.raise_for_status()
        return response.json()

    async def admin_list_wallet_topups(
        self,
        status: str = "SUBMITTED",
        page: int = 1,
        page_size: int = 10,
    ) -> Dict[str, Any]:
        response = await self._request(
            "GET",
            f"{self.base_url}/admin/wallets/topups",
            params={"status": status, "page": page, "page_size": page_size},
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    async def admin_approve_wallet_topup(self, ref: str) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            f"{self.base_url}/admin/wallets/topups/{ref}/approve",
            json={},
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        telegram_id = (data.get("topup") or {}).get("telegram_id")
        if telegram_id is not None:
            self._cache_pop(self._cache_key("wallet", telegram_id))
        return data

    async def admin_reject_wallet_topup(self, ref: str, reason: str | None = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if reason:
            payload["reason"] = reason
        response = await self._request(
            "POST",
            f"{self.base_url}/admin/wallets/topups/{ref}/reject",
            json=payload,
            headers=self._headers(),
            timeout=20,
        )
        response.raise_for_status()
        return response.json()
