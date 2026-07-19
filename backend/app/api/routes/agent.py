"""
AI Assistant streaming proxy.

The browser drives the whole agent loop (tools execute against the Zustand
stores client-side); this route only relays one model call per turn and
streams events back. Keeping the loop client-side matches the OSS
architecture: zero server-side state, the server never sees or stores the
project.

Providers — OpenAI-compatible endpoints are the primary path (works with any
relay/self-hosted gateway speaking `POST {base_url}/chat/completions`); the
official Anthropic API is also supported:

  - "openai"    — requests/streams are translated to/from the Anthropic wire
    shapes the frontend accumulator speaks, so the frontend stays
    provider-agnostic.
  - "anthropic" — official Anthropic SDK; events forwarded raw.

Configuration resolution, per request field: request body override (set from
the panel's settings UI, stored in the user's browser) → environment default.

Environment defaults:

  VELXIO_AGENT_PROVIDER   openai | anthropic            (default: openai)
  VELXIO_AGENT_MODEL      model id
  VELXIO_AGENT_MAX_TOKENS Anthropic max_tokens          (default: 16000)
  VELXIO_AGENT_EFFORT     reasoning effort              (none|low|medium|high)
  VELXIO_OPENAI_BASE_URL  e.g. https://api.example.com/v1
  VELXIO_OPENAI_API_KEY   key for the openai provider
  ANTHROPIC_API_KEY       key for the anthropic provider

The API key travels in the `x-agent-key` request header (legacy alias
`x-anthropic-key` still accepted); it is never placed in the body so request
logs stay clean.

Note on trust model: `base_url` comes from the browser, so this proxy will
POST to a user-chosen host. That matches Velxio OSS's single-user trust model
(the same browser can already drive the compile and IoT-gateway endpoints);
do not expose this backend publicly without adding your own auth in front.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

ENV_PROVIDER = os.environ.get("VELXIO_AGENT_PROVIDER", "openai").strip().lower()
ENV_MODEL = os.environ.get("VELXIO_AGENT_MODEL", "").strip()
MAX_TOKENS = int(os.environ.get("VELXIO_AGENT_MAX_TOKENS", "16000"))
ENV_EFFORT = os.environ.get("VELXIO_AGENT_EFFORT", "").strip() or None
ENV_OPENAI_BASE_URL = os.environ.get("VELXIO_OPENAI_BASE_URL", "").strip().rstrip("/")
ENV_OPENAI_API_KEY = os.environ.get("VELXIO_OPENAI_API_KEY", "")

VALID_PROVIDERS = ("openai", "anthropic")
VALID_EFFORTS = ("none", "low", "medium", "high")


class ProviderConfig(BaseModel):
    """Per-request overrides for the upstream provider (panel settings)."""

    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    effort: str | None = None


class AgentStreamRequest(ProviderConfig):
    system: str = ""
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)


class Resolved(BaseModel):
    provider: str
    base_url: str
    model: str
    effort: str | None
    api_key: str


def _resolve(cfg: ProviderConfig, header_key: str | None) -> Resolved:
    provider = (cfg.provider or ENV_PROVIDER or "openai").strip().lower()
    if provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail=f"provider must be one of {VALID_PROVIDERS}")

    base_url = (cfg.base_url or ENV_OPENAI_BASE_URL).strip().rstrip("/")
    if provider == "openai":
        if not base_url:
            raise HTTPException(
                status_code=422,
                detail="No OpenAI-compatible base URL. Set it in the AI panel settings "
                "or via VELXIO_OPENAI_BASE_URL on the server.",
            )
        if not base_url.startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="base_url must start with http(s)://")

    model = (cfg.model or ENV_MODEL).strip()
    if not model:
        model = "claude-opus-4-8" if provider == "anthropic" else "gpt-4o"

    effort = (cfg.effort or ENV_EFFORT or "").strip().lower() or None
    if effort == "none":
        effort = None
    if effort is not None and effort not in VALID_EFFORTS:
        raise HTTPException(status_code=422, detail=f"effort must be one of {VALID_EFFORTS}")

    api_key = header_key or (
        ENV_OPENAI_API_KEY if provider == "openai" else os.environ.get("ANTHROPIC_API_KEY", "")
    )
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="No API key configured. Enter one in the AI panel settings, or set "
            "VELXIO_OPENAI_API_KEY / ANTHROPIC_API_KEY on the server.",
        )
    if provider == "anthropic":
        try:
            import anthropic  # noqa: F401
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="The 'anthropic' package is not installed on this server. "
                "Run: pip install anthropic",
            )
    return Resolved(provider=provider, base_url=base_url, model=model, effort=effort, api_key=api_key)


@router.get("/config")
async def agent_config() -> dict[str, Any]:
    """Environment defaults, used by the panel to prefill its settings UI."""
    return {
        "enabled": True,
        "provider": ENV_PROVIDER,
        "base_url": ENV_OPENAI_BASE_URL,
        "model": ENV_MODEL,
        "effort": ENV_EFFORT or "",
        "server_has_key": bool(ENV_OPENAI_API_KEY if ENV_PROVIDER == "openai" else os.environ.get("ANTHROPIC_API_KEY")),
    }


def _http_transport():
    import httpx

    # local_address forces an AF_INET (IPv4) socket. Without it, connects to
    # some hosts hang until timeout under WSL2's NAT (observed: curl fine,
    # httpx ConnectTimeout on every attempt).
    return httpx.AsyncHTTPTransport(retries=2, local_address="0.0.0.0")


@router.post("/test")
async def agent_test(
    cfg: ProviderConfig,
    x_agent_key: str | None = Header(default=None),
    x_anthropic_key: str | None = Header(default=None),
) -> dict[str, Any]:
    """Cheap connectivity check for the settings UI: one tiny completion."""
    r = _resolve(cfg, x_agent_key or x_anthropic_key)
    t0 = time.monotonic()
    try:
        if r.provider == "openai":
            import httpx

            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0), transport=_http_transport()
            ) as client:
                resp = await client.post(
                    f"{r.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {r.api_key}"},
                    json={
                        "model": r.model,
                        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                        "stream": False,
                    },
                )
                if resp.status_code != 200:
                    return {
                        "ok": False,
                        "message": f"HTTP {resp.status_code}: {resp.text[:300]}",
                    }
                data = resp.json()
                _ = data["choices"][0]["message"]
        else:
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic(api_key=r.api_key)
            try:
                await client.messages.create(
                    model=r.model,
                    max_tokens=8,
                    messages=[{"role": "user", "content": "Reply with exactly: OK"}],
                )
            finally:
                await client.close()
    except Exception as exc:
        return {"ok": False, "message": str(exc)[:300]}
    return {
        "ok": True,
        "message": f"{r.provider} · {r.model}",
        "latency_ms": int((time.monotonic() - t0) * 1000),
    }


# ── Anthropic provider ─────────────────────────────────────────────────────


async def _anthropic_events(req: AgentStreamRequest, r: Resolved) -> AsyncIterator[str]:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=r.api_key)
    try:
        stream = await client.messages.create(
            model=r.model,
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


async def _openai_events(req: AgentStreamRequest, r: Resolved) -> AsyncIterator[str]:
    """Stream an OpenAI-compatible chat completion, re-emitting the chunks as
    the Anthropic-shaped events the frontend accumulator understands."""
    import httpx

    payload: dict[str, Any] = {
        "model": r.model,
        "messages": _to_openai_messages(req.system, req.messages),
        "stream": True,
    }
    if req.tools:
        payload["tools"] = _to_openai_tools(req.tools)
    if r.effort:
        payload["reasoning_effort"] = r.effort

    emit = lambda obj: f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"  # noqa: E731

    # Block-index bookkeeping: text lives at Anthropic index 0; the OpenAI
    # tool_call with index i maps to Anthropic block index 1+i.
    text_open = False
    open_tool_indexes: set[int] = set()
    finish_reason: str | None = None

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(300.0, connect=10.0),
        transport=_http_transport(),
    ) as client:
        async with client.stream(
            "POST",
            f"{r.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {r.api_key}", "Content-Type": "application/json"},
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

                # Reasoning-model progress (relays stream it as
                # delta.reasoning_content). Forwarded as a lightweight
                # frontend-only event so the UI can show "still thinking";
                # never enters the conversation history.
                reasoning = delta.get("reasoning_content")
                if reasoning:
                    yield emit({"type": "velxio_thinking", "chars": len(reasoning)})

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
    x_agent_key: str | None = Header(default=None),
    x_anthropic_key: str | None = Header(default=None),
) -> StreamingResponse:
    r = _resolve(req, x_agent_key or x_anthropic_key)
    inner = _openai_events(req, r) if r.provider == "openai" else _anthropic_events(req, r)

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
