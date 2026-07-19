"""
AI Assistant streaming proxy.

The browser drives the whole agent loop (tools execute against the Zustand
stores client-side); this route only relays one Messages API call per turn to
Anthropic and streams the raw SSE events back. Keeping the loop client-side
matches the OSS architecture: zero server-side state, the server never sees or
stores the project.

Auth for the upstream call, in priority order:
  1. `x-anthropic-key` request header (user-supplied key, stored in the
     browser's localStorage — lets a shared self-hosted instance work without
     a server key)
  2. `ANTHROPIC_API_KEY` environment variable on the backend

`GET /api/agent/config` tells the frontend whether the server holds a key so
the UI knows when to prompt the user for one.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_MODEL = os.environ.get("VELXIO_AGENT_MODEL", "claude-opus-4-8")
MAX_TOKENS = int(os.environ.get("VELXIO_AGENT_MAX_TOKENS", "16000"))


class AgentStreamRequest(BaseModel):
    system: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = Field(default_factory=list)
    model: str | None = None


@router.get("/config")
async def agent_config() -> dict[str, Any]:
    try:
        import anthropic  # noqa: F401

        sdk = True
    except ImportError:
        sdk = False
    return {
        "enabled": sdk,
        "server_has_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "model": DEFAULT_MODEL,
    }


@router.post("/stream")
async def agent_stream(
    req: AgentStreamRequest,
    x_anthropic_key: str | None = Header(default=None),
) -> StreamingResponse:
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="The 'anthropic' package is not installed on this server. "
            "Run: pip install anthropic",
        )

    api_key = x_anthropic_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="No Anthropic API key. Set ANTHROPIC_API_KEY on the server "
            "or enter a key in the AI panel settings.",
        )

    model = req.model or DEFAULT_MODEL
    client = AsyncAnthropic(api_key=api_key)

    async def event_stream():
        try:
            stream = await client.messages.create(
                model=model,
                max_tokens=MAX_TOKENS,
                system=[
                    {
                        "type": "text",
                        "text": req.system,
                        # The system prompt + tool schemas are identical every
                        # turn of the loop — cache them.
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=req.messages,
                tools=req.tools,
                thinking={"type": "adaptive"},
                stream=True,
            )
            async for event in stream:
                yield f"data: {event.model_dump_json()}\n\n"
            yield 'data: {"type": "velxio_done"}\n\n'
        except Exception as exc:  # surface upstream errors to the browser
            logger.exception("agent stream failed")
            status = getattr(exc, "status_code", None)
            payload = {
                "type": "velxio_error",
                "status": status,
                "message": str(getattr(exc, "message", None) or exc),
            }
            yield f"data: {json.dumps(payload)}\n\n"
        finally:
            await client.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
        },
    )
