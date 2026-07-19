"""
AI Assistant streaming proxy.

The browser drives the whole agent loop (tools execute against the Zustand
stores client-side); this route only relays one model call per turn and
streams events back. Keeping the loop client-side matches the OSS
architecture: zero server-side state, the server never sees or stores the
project.

Two upstream providers:

  - "anthropic" (default) — official Anthropic SDK; events are forwarded raw.
  - "openai"   — any OpenAI-compatible endpoint (incl. third-party relays).
    Requests/streams are translated to/from the Anthropic wire shapes the
    frontend accumulator speaks, so the frontend is provider-agnostic.

Configuration (environment):

  VELXIO_AGENT_PROVIDER   anthropic | openai            (default: anthropic)
  VELXIO_AGENT_MODEL      model id                      (default: claude-opus-4-8)
  VELXIO_AGENT_MAX_TOKENS Anthropic max_tokens          (default: 16000)
  VELXIO_AGENT_EFFORT     openai reasoning_effort       (optional: low|medium|high)
  ANTHROPIC_API_KEY       key for the anthropic provider
  VELXIO_OPENAI_BASE_URL  e.g. https://api.example.com/v1
  VELXIO_OPENAI_API_KEY   key for the openai provider

A user-supplied key in the `x-anthropic-key` request header (entered in the
panel, stored in the browser) overrides the server key for either provider.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

PROVIDER = os.environ.get("VELXIO_AGENT_PROVIDER", "anthropic").strip().lower()
DEFAULT_MODEL = os.environ.get(
    "VELXIO_AGENT_MODEL",
    "claude-opus-4-8" if PROVIDER == "anthropic" else "gpt-4o",
)
MAX_TOKENS = int(os.environ.get("VELXIO_AGENT_MAX_TOKENS", "16000"))
EFFORT = os.environ.get("VELXIO_AGENT_EFFORT", "").strip() or None
OPENAI_BASE_URL = os.environ.get("VELXIO_OPENAI_BASE_URL", "").rstrip("/")
OPENAI_API_KEY = os.environ.get("VELXIO_OPENAI_API_KEY", "")


class AgentStreamRequest(BaseModel):
    system: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = Field(default_factory=list)
    model: str | None = None


def _server_key() -> str:
    if PROVIDER == "openai":
        return OPENAI_API_KEY
    return os.environ.get("ANTHROPIC_API_KEY", "")


@router.get("/config")
async def agent_config() -> dict[str, Any]:
    if PROVIDER == "openai":
        enabled = bool(OPENAI_BASE_URL)
    else:
        try:
            import anthropic  # noqa: F401

            enabled = True
        except ImportError:
            enabled = False
    return {
        "enabled": enabled,
        "provider": PROVIDER,
        "server_has_key": bool(_server_key()),
        "model": DEFAULT_MODEL,
    }


# ── Anthropic provider ─────────────────────────────────────────────────────


async def _anthropic_events(req: AgentStreamRequest, api_key: str) -> AsyncIterator[str]:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=api_key)
    try:
        stream = await client.messages.create(
            model=req.model or DEFAULT_MODEL,
            max_tokens=MAX_TOKENS,
            system=[
                {
                    "type": "text",
                    "text": req.system,
                    # System prompt + tools are identical every loop turn — cache.
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
    finally:
        await client.close()


# ── OpenAI-compatible provider ─────────────────────────────────────────────


def _to_openai_messages(system: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic-shaped history → OpenAI chat messages.

    tool_result blocks become role:"tool" messages (they must directly follow
    the assistant message carrying the matching tool_calls, which the
    frontend's message ordering already guarantees).
    """
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        blocks: list[dict[str, Any]] = content or []

        if m.get("role") == "user":
            for b in blocks:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": b.get("tool_use_id", ""),
                            "content": c if isinstance(c, str) else json.dumps(c),
                        }
                    )
            texts = [b["text"] for b in blocks if b.get("type") == "text"]
            if texts:
                out.append({"role": "user", "content": "\n\n".join(texts)})
        else:  # assistant
            texts = [b["text"] for b in blocks if b.get("type") == "text"]
            tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
            msg: dict[str, Any] = {"role": "assistant"}
            msg["content"] = "\n\n".join(texts) if texts else None
            if tool_uses:
                msg["tool_calls"] = [
                    {
                        "id": tu.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": tu.get("name", ""),
                            "arguments": json.dumps(tu.get("input") or {}),
                        },
                    }
                    for tu in tool_uses
                ]
            if msg["content"] is not None or tool_uses:
                out.append(msg)
    return out


def _to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


_FINISH_MAP = {"tool_calls": "tool_use", "stop": "end_turn", "length": "max_tokens"}


async def _openai_events(req: AgentStreamRequest, api_key: str) -> AsyncIterator[str]:
    """Stream an OpenAI-compatible chat completion, re-emitting the chunks as
    the Anthropic-shaped events the frontend accumulator understands."""
    import httpx

    payload: dict[str, Any] = {
        "model": req.model or DEFAULT_MODEL,
        "messages": _to_openai_messages(req.system, req.messages),
        "stream": True,
    }
    if req.tools:
        payload["tools"] = _to_openai_tools(req.tools)
    if EFFORT:
        payload["reasoning_effort"] = EFFORT

    emit = lambda obj: f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"  # noqa: E731

    # Block-index bookkeeping: text lives at Anthropic index 0; the OpenAI
    # tool_call with index i maps to Anthropic block index 1+i.
    text_open = False
    open_tool_indexes: set[int] = set()
    finish_reason: str | None = None

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(300.0, connect=30.0),
        transport=httpx.AsyncHTTPTransport(retries=2),
    ) as client:
        async with client.stream(
            "POST",
            f"{OPENAI_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"Upstream HTTP {resp.status_code}: {body}")

            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get("delta") or {}

                text = delta.get("content")
                if text:
                    if not text_open:
                        text_open = True
                        yield emit(
                            {
                                "type": "content_block_start",
                                "index": 0,
                                "content_block": {"type": "text", "text": ""},
                            }
                        )
                    yield emit(
                        {
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": {"type": "text_delta", "text": text},
                        }
                    )

                for tc in delta.get("tool_calls") or []:
                    tc_index = tc.get("index", 0)
                    block_index = 1 + tc_index
                    if tc_index not in open_tool_indexes:
                        open_tool_indexes.add(tc_index)
                        yield emit(
                            {
                                "type": "content_block_start",
                                "index": block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": tc.get("id") or f"call_{tc_index}",
                                    "name": (tc.get("function") or {}).get("name", ""),
                                    "input": {},
                                },
                            }
                        )
                    args = (tc.get("function") or {}).get("arguments")
                    if args:
                        yield emit(
                            {
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": {"type": "input_json_delta", "partial_json": args},
                            }
                        )

                fr = choice.get("finish_reason")
                if fr:
                    finish_reason = fr

    if text_open:
        yield emit({"type": "content_block_stop", "index": 0})
    for tc_index in sorted(open_tool_indexes):
        yield emit({"type": "content_block_stop", "index": 1 + tc_index})
    yield emit(
        {
            "type": "message_delta",
            "delta": {"stop_reason": _FINISH_MAP.get(finish_reason or "stop", "end_turn")},
        }
    )
    yield emit({"type": "message_stop"})
    yield emit({"type": "velxio_done"})


# ── Route ──────────────────────────────────────────────────────────────────


@router.post("/stream")
async def agent_stream(
    req: AgentStreamRequest,
    x_anthropic_key: str | None = Header(default=None),
) -> StreamingResponse:
    if PROVIDER == "openai":
        if not OPENAI_BASE_URL:
            raise HTTPException(
                status_code=501,
                detail="VELXIO_AGENT_PROVIDER=openai but VELXIO_OPENAI_BASE_URL is not set.",
            )
    else:
        try:
            import anthropic  # noqa: F401
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="The 'anthropic' package is not installed on this server. "
                "Run: pip install anthropic",
            )

    api_key = x_anthropic_key or _server_key()
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="No API key configured. Set ANTHROPIC_API_KEY / VELXIO_OPENAI_API_KEY "
            "on the server or enter a key in the AI panel settings.",
        )

    inner = _openai_events(req, api_key) if PROVIDER == "openai" else _anthropic_events(req, api_key)

    async def event_stream():
        try:
            async for frame in inner:
                yield frame
        except Exception as exc:  # surface upstream errors to the browser
            logger.exception("agent stream failed")
            status = getattr(exc, "status_code", None)
            payload = {
                "type": "velxio_error",
                "status": status,
                "message": str(getattr(exc, "message", None) or exc),
            }
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
        },
    )
