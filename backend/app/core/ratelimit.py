"""
Tiny in-process sliding-window rate limiter for the auth endpoints —
enough to stop naive password brute-forcing on a single-instance school
deployment (stdlib-only, no Redis). For multi-instance deployments put a
reverse-proxy limiter in front as well.
"""

from __future__ import annotations

import threading
import time
from collections import deque

_lock = threading.Lock()
_hits: dict[str, deque[float]] = {}
_MAX_KEYS = 10_000


def allow(key: str, limit: int, window_seconds: float) -> bool:
    """True if this call is within `limit` calls per `window_seconds`."""
    now = time.monotonic()
    with _lock:
        if len(_hits) > _MAX_KEYS:  # crude memory bound
            _hits.clear()
        dq = _hits.setdefault(key, deque())
        while dq and now - dq[0] > window_seconds:
            dq.popleft()
        if len(dq) >= limit:
            return False
        dq.append(now)
        return True


def reset() -> None:
    """Test helper."""
    with _lock:
        _hits.clear()
