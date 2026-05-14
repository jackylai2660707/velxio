"""
Extension hooks for the velxio backend.

Routes that stay in OSS (compile, libraries, simulation, iot_gateway) used to
import directly from `app.core.dependencies`, `app.database.session`,
`app.models.*` and `app.services.metrics`. That made the OSS image impossible
to ship without the auth/DB stack — deleting any of those modules would
crash the route layer at import time.

This module is the seam. OSS routes import only from here. Each hook is a
no-op by default; a private overlay (e.g. velxio-prod's `app.pro`) calls the
`register_*` setter inside its own `register_pro(app)` to plug in a real
implementation. When the overlay is absent, the routes still load and the
hooks just return None / yield no events.

Adding a new extension point: define a Protocol/Callable type, a module-level
slot, a `register_*` setter, and a public callable that invokes the slot if
present. Do NOT import from `app.database`, `app.models`, or `app.services` here.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from fastapi import Request

logger = logging.getLogger(__name__)


# ── record_compile ───────────────────────────────────────────────────────────
# Fires once per compile attempt. Overlay implementations own their own DB
# session and decide what to persist. The compile route only knows about
# metadata (user_id, project_id, board fqbn, timing, error classification).

RecordCompileHook = Callable[
    ...,  # accepts the kwargs below; using ... avoids over-constraining overlays
    Awaitable[None],
]

_record_compile_hook: Optional[RecordCompileHook] = None


def register_record_compile(hook: RecordCompileHook) -> None:
    """Install the compile-metric recorder. Called by overlays in register_pro."""
    global _record_compile_hook
    _record_compile_hook = hook


async def record_compile(
    *,
    user_id: Optional[str],
    project_id: Optional[str],
    board_fqbn: str,
    success: bool,
    duration_ms: int,
    error_kind: Optional[str],
    extra: dict,
    request: Any = None,
) -> None:
    """Record a compile event. No-op when no overlay is loaded."""
    if _record_compile_hook is None:
        return
    try:
        await _record_compile_hook(
            user_id=user_id,
            project_id=project_id,
            board_fqbn=board_fqbn,
            success=success,
            duration_ms=duration_ms,
            error_kind=error_kind,
            extra=extra,
            request=request,
        )
    except Exception:
        # A failing metric must never break the compile response.
        logger.exception("record_compile hook failed (swallowed)")


# ── get_current_user_id ───────────────────────────────────────────────────────
# FastAPI dependency: resolves the current user's id from the request (typically
# by decoding a JWT cookie). Returns None for anonymous requests OR when no auth
# overlay is loaded. Routes that need an id but accept anonymous use the
# returned value directly; routes that require auth wrap with require_auth_hook.

GetCurrentUserIdHook = Callable[[Any], Awaitable[Optional[str]]]

_get_current_user_id_hook: Optional[GetCurrentUserIdHook] = None


def register_get_current_user_id(hook: GetCurrentUserIdHook) -> None:
    """Install the auth resolver. Called by overlays in register_pro."""
    global _get_current_user_id_hook
    _get_current_user_id_hook = hook


async def get_current_user_id(request: Request) -> Optional[str]:  # FastAPI dependency
    if _get_current_user_id_hook is None:
        return None
    try:
        return await _get_current_user_id_hook(request)
    except Exception:
        logger.exception("get_current_user_id hook failed (treating as anonymous)")
        return None


# ── lifespan startup ──────────────────────────────────────────────────────────
# Overlays that need to run async setup during FastAPI lifespan (DB init,
# table creation, legacy column migrations, etc.) register a coroutine here.
# main.py invokes run_lifespan_startup() once during lifespan; if no overlay
# registered anything, nothing happens.

LifespanStartupHook = Callable[[], Awaitable[None]]

_lifespan_startup_hooks: list[LifespanStartupHook] = []


def register_lifespan_startup(hook: LifespanStartupHook) -> None:
    """Queue a coroutine to run during FastAPI lifespan startup."""
    _lifespan_startup_hooks.append(hook)


async def run_lifespan_startup() -> None:
    """Invoked once by main.py's lifespan. Runs hooks in registration order;
    a failing hook is logged but does not abort the others."""
    for hook in _lifespan_startup_hooks:
        try:
            await hook()
        except Exception:
            logger.exception("lifespan startup hook %r failed (swallowed)", hook)
