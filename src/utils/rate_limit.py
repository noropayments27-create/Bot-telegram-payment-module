from __future__ import annotations

import time
from collections import defaultdict

_last_seen: dict[str, float] = defaultdict(float)


def check_rate_limit(user_id: int, action: str, seconds: int, enabled: bool = True) -> int:
    if not enabled or seconds <= 0:
        return 0
    key = f"{user_id}:{action}"
    now = time.monotonic()
    last = _last_seen.get(key, 0.0)
    elapsed = now - last
    if elapsed < seconds:
        return max(1, int(seconds - elapsed))
    _last_seen[key] = now
    return 0
