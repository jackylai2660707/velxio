"""
AI Assistant streaming proxy — OpenAI-compatible endpoints only.

The browser drives the whole agent loop (tools execute against the Zustand
stores client-side); this route relays one `POST {base_url}/chat/completions`
call per turn and streams the chunks back, re-encoded as the block-oriented
SSE events the frontend accumulator speaks (a stable internal wire format,
independent of the upstream provider). Works with any relay / gateway /
self-hosted server that speaks the OpenAI chat-completions protocol.

Configuration resolution, per field: request body override (set from the
panel's settings UI, stored in the user's browser) → environment default.

Environment defaults:

  VELXIO_OPENAI_BASE_URL  e.g. https://api.example.com/v1
  VELXIO_OPENAI_API_KEY   upstream API key
  VELXIO_AGENT_MODEL      model id
  VELXIO_AGENT_EFFORT     reasoning effort (none|low|medium|high)
  VELXIO_SKIP_ARDUINO_INDEX=1  (unrelated to this route — see arduino_cli.py)

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

ENV_MODEL = os.environ.get("VELXIO_AGENT_MODEL", "").strip()
ENV_EFFORT = os.environ.get("VELXIO_AGENT_EFFORT", "").strip() or None
ENV_BASE_URL = os.environ.get("VELXIO_OPENAI_BASE_URL", "").strip().rstrip("/")
ENV_API_KEY = os.environ.get("VELXIO_OPENAI_API_KEY", "")

# Platform defaults when neither the panel nor the env pins them.
DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_EFFORT = "high"

VALID_EFFORTS = ("none", "low", "medium", "high")


class ProviderConfig(BaseModel):
    """Per-request overrides for the upstream endpoint (panel settings).

    `provider` is accepted for backward compatibility with stored client
    settings but ignored — the only supported protocol is OpenAI-compatible.
    """

    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    effort: str | None = None


class AgentStreamRequest(ProviderConfig):
    system: str = ""
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)


class Resolved(BaseModel):
    base_url: str
    model: str
    effort: str | None
    api_key: str


def _resolve(cfg: ProviderConfig, header_key: str | None) -> Resolved:
    base_url = (cfg.base_url or ENV_BASE_URL).strip().rstrip("/")
    if not base_url:
        raise HTTPException(
            status_code=422,
            detail="No OpenAI-compatible base URL. Set it in the AI panel settings "
            "or via VELXIO_OPENAI_BASE_URL on the server.",
        )
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="base_url must start with http(s)://")

    model = (cfg.model or ENV_MODEL).strip() or DEFAULT_MODEL

    effort = (cfg.effort or ENV_EFFORT or DEFAULT_EFFORT).strip().lower() or None
    if effort == "none":
        effort = None
    if effort is not None and effort not in VALID_EFFORTS:
        raise HTTPException(status_code=422, detail=f"effort must be one of {VALID_EFFORTS}")

    api_key = header_key or ENV_API_KEY
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="No API key configured. Enter one in the AI panel settings, or set "
            "VELXIO_OPENAI_API_KEY on the server.",
        )
    return Resolved(base_url=base_url, model=model, effort=effort, api_key=api_key)


def _http_transport():
    import httpx

    # local_address forces an AF_INET (IPv4) socket. Without it, connects to
    # some hosts hang until timeout under WSL2's NAT (observed: curl fine,
    # httpx ConnectTimeout on every attempt).
    return httpx.AsyncHTTPTransport(retries=2, local_address="0.0.0.0")


@router.get("/config")
async def agent_config() -> dict[str, Any]:
    """Environment defaults, used by the panel to prefill its settings UI."""
    return {
        "enabled": True,
        "provider": "openai",
        "base_url": ENV_BASE_URL,
        "model": ENV_MODEL or DEFAULT_MODEL,
        "effort": ENV_EFFORT or DEFAULT_EFFORT,
        "server_has_key": bool(ENV_API_KEY),
        # When the server key is in play, AI calls are metered per signed-in
        # user against a weekly token quota (see /api/auth/usage).
        "metered": bool(ENV_API_KEY),
    }


@router.post("/models")
async def agent_models(
    cfg: ProviderConfig,
    x_agent_key: str | None = Header(default=None),
    x_anthropic_key: str | None = Header(default=None),
) -> dict[str, Any]:
    """Proxy the upstream `GET {base_url}/models` list for the settings UI."""
    import httpx

    r = _resolve(cfg, x_agent_key or x_anthropic_key)
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0), transport=_http_transport()
        ) as client:
            resp = await client.get(
                f"{r.base_url}/models",
                headers={"Authorization": f"Bearer {r.api_key}"},
            )
            if resp.status_code != 200:
                return {"ok": False, "message": f"HTTP {resp.status_code}", "models": []}
            data = resp.json()
            ids = sorted(
                str(m.get("id", ""))
                for m in (data.get("data") or [])
                if m.get("id")
            )
            return {"ok": True, "models": ids}
    except Exception as exc:
        return {"ok": False, "message": str(exc)[:200], "models": []}


@router.post("/test")
async def agent_test(
    cfg: ProviderConfig,
    x_agent_key: str | None = Header(default=None),
    x_anthropic_key: str | None = Header(default=None),
) -> dict[str, Any]:
    """Cheap connectivity check for the settings UI: one tiny completion."""
    import httpx

    r = _resolve(cfg, x_agent_key or x_anthropic_key)
    t0 = time.monotonic()
    try:
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
                return {"ok": False, "message": f"HTTP {resp.status_code}: {resp.text[:300]}"}
            data = resp.json()
            _ = data["choices"][0]["message"]
    except Exception as exc:
        return {"ok": False, "message": str(exc)[:300]}
    return {
        "ok": True,
        "message": r.model,
        "latency_ms": int((time.monotonic() - t0) * 1000),
    }


# ── Request translation ────────────────────────────────────────────────────


def _to_openai_messages(system: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Frontend block-shaped history → OpenAI chat messages.

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


# ── Streaming ──────────────────────────────────────────────────────────────

_FINISH_MAP = {"tool_calls": "tool_use", "stop": "end_turn", "length": "max_tokens"}


async def _stream_events(
    req: AgentStreamRequest, r: Resolved, usage_out: dict[str, int] | None = None
) -> AsyncIterator[str]:
    """Stream the upstream chat completion, re-emitting chunks as the
    block-oriented events the frontend accumulator understands.

    When `usage_out` is given it is filled with prompt/completion token
    counts — the upstream-reported numbers when available, otherwise a
    chars/4 estimate — so the caller can meter quota usage.
    """
    import httpx

    base_payload: dict[str, Any] = {
        "model": r.model,
        "messages": _to_openai_messages(req.system, req.messages),
        "stream": True,
        # Ask for a final usage chunk (token accounting in the UI). Some
        # strict servers reject stream_options — we retry without it below.
        "stream_options": {"include_usage": True},
    }
    if req.tools:
        base_payload["tools"] = _to_openai_tools(req.tools)
    if r.effort:
        base_payload["reasoning_effort"] = r.effort

    emit = lambda obj: f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"  # noqa: E731

    # Block-index bookkeeping: text lives at block index 0; the OpenAI
    # tool_call with index i maps to block index 1+i.
    text_open = False
    open_tool_indexes: set[int] = set()
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    emitted_chars = 0  # fallback estimator when upstream sends no usage

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(300.0, connect=10.0),
        transport=_http_transport(),
    ) as client:
        # First attempt includes stream_options; a strict upstream that 400s
        # on it gets one retry without.
        attempts = [base_payload, {k: v for k, v in base_payload.items() if k != "stream_options"}]
        resp_ctx = None
        for i, payload in enumerate(attempts):
            resp_ctx = client.stream(
                "POST",
                f"{r.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {r.api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            resp = await resp_ctx.__aenter__()
            if resp.status_code == 400 and i == 0 and "stream_options" in payload:
                await resp_ctx.__aexit__(None, None, None)
                continue
            break

        assert resp_ctx is not None
        try:
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

                if chunk.get("usage"):
                    usage = chunk["usage"]

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
                    emitted_chars += len(reasoning)
                    yield emit({"type": "velxio_thinking", "chars": len(reasoning)})

                text = delta.get("content")
                if text:
                    emitted_chars += len(text)
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
                        emitted_chars += len(args)
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
        finally:
            await resp_ctx.__aexit__(None, None, None)

    if text_open:
        yield emit({"type": "content_block_stop", "index": 0})
    for tc_index in sorted(open_tool_indexes):
        yield emit({"type": "content_block_stop", "index": 1 + tc_index})
    if usage:
        yield emit(
            {
                "type": "velxio_usage",
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
            }
        )
    if usage_out is not None:
        if usage:
            usage_out["prompt_tokens"] = int(usage.get("prompt_tokens") or 0)
            usage_out["completion_tokens"] = int(usage.get("completion_tokens") or 0)
        else:
            # Upstream sent no usage chunk — estimate at ~4 chars/token so
            # quota accounting still moves (never free just because the
            # provider omitted the numbers).
            prompt_chars = len(req.system) + len(json.dumps(req.messages, ensure_ascii=False))
            usage_out["prompt_tokens"] = max(1, prompt_chars // 4)
            usage_out["completion_tokens"] = max(1, emitted_chars // 4)
    yield emit(
        {
            "type": "message_delta",
            "delta": {"stop_reason": _FINISH_MAP.get(finish_reason or "stop", "end_turn")},
        }
    )
    yield emit({"type": "message_stop"})
    yield emit({"type": "velxio_done"})


@router.post("/stream")
async def agent_stream(
    req: AgentStreamRequest,
    x_agent_key: str | None = Header(default=None),
    x_anthropic_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    header_key = x_agent_key or x_anthropic_key
    r = _resolve(req, header_key)

    # ── Quota gate ─────────────────────────────────────────────────────
    # Requests served with the SERVER's key are metered per signed-in user
    # against a weekly token quota. Users who bring their own key in the
    # panel pay for themselves and are unmetered.
    metered_user: dict[str, Any] | None = None
    if not header_key and ENV_API_KEY:
        from app.api.routes.auth import require_user
        from app.services import cloud_db

        metered_user = require_user(authorization)  # 401 when anonymous
        quota = cloud_db.get_ai_usage(metered_user["id"])
        if quota["used"] >= quota["limit"]:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"本週 AI 用量已達上限({quota['limit']:,} tokens),"
                    f"{quota['week_start']} 起算的額度將於下週一重置。"
                    "如需提高額度請聯絡管理員。"
                ),
            )

    usage_out: dict[str, int] = {}
    inner = _stream_events(req, r, usage_out)

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
        finally:
            if metered_user is not None and usage_out:
                from app.services import cloud_db

                total = usage_out.get("prompt_tokens", 0) + usage_out.get(
                    "completion_tokens", 0
                )
                try:
                    cloud_db.add_ai_usage(metered_user["id"], total)
                except Exception:
                    logger.exception("failed to record AI usage")

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
        },
    )
