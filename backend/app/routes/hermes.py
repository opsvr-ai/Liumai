"""Unified read-only adapter for the Hermes gateway.

Hermes access is currently scattered across ``chat.py``, ``rca_runner.py`` and
``knowledge.py`` (chat completions, runs, jobs, health).  This module adds the
*read-only* discovery/proxy surface that the rest of the platform was missing,
behind one authenticated, consistently error-mapped family of endpoints.

Design notes
------------
* Hermes is a **global engine**, not a per-team resource.  These routes are
  intentionally not team-scoped: every authenticated user sees the same
  upstream data (same as the existing ``/api/chat/hermes-info`` route).
* Only ``GET`` is implemented here.  Mutating operations keep their existing
  dedicated endpoints (for example ``/api/jobs`` CRUD), so no functionality is
  lost or duplicated.
* ``_hermes_url`` / ``_hermes_api_key`` are read from
  :mod:`app.services.hermes` on every call, so an admin-side reconfiguration
  takes effect without a restart.  The API key only ever goes into the
  outgoing ``Authorization`` header — it is never returned, logged, or echoed
  in an error detail.
* Read-only calls use a 10 s timeout.  Long-running inference stays on the
  existing chat/RCA paths, which need minutes rather than seconds.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from loguru import logger

from app.auth import get_current_user

# All routes require an authenticated platform user.  ``get_current_user`` is
# attached at router level so a newly added endpoint cannot accidentally ship
# without auth.
router = APIRouter(dependencies=[Depends(get_current_user)])

# ── Timeouts / cache ─────────────────────────────────────────────────────────

#: Read-only upstream timeout (seconds).  A half-dead Hermes must not hang a
#: page for the 600 s agent timeout used by the chat/RCA paths.
READ_TIMEOUT_SECONDS = 10.0
CONNECT_TIMEOUT_SECONDS = 5.0

#: ``GET /v1/capabilities`` changes only on deploy/restart; 60 s is short
#: enough to pick up an upgrade and long enough to spare the gateway on a
#: settings/chat page that fans out several calls.
CAPABILITIES_CACHE_TTL_SECONDS = 60.0

_READ_TIMEOUT = httpx.Timeout(READ_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS)

#: Global capabilities cache.  Hermes is a single global engine, so the payload
#: is not user-specific.  ``expires_at`` uses ``time.monotonic``.
_CAPABILITIES_CACHE: dict[str, Any] = {
    "payload": None,
    "expires_at": 0.0,
    "fetched_at": None,
    "base_url": None,
}

_READY_STATES = frozenset({"ok", "ready", "healthy", "pass", "up"})


# ═══════════════════════════════════════════════════════════════════════════════
# Upstream call helper
# ═══════════════════════════════════════════════════════════════════════════════


def _hermes_root_url(raw: str | None) -> str:
    """Return the Hermes base URL without the OpenAI-compatible ``/v1`` suffix.

    ``_hermes_url`` points at the OpenAI-compatible API server (usually ending
    in ``/v1``), while capabilities/runs live under ``/v1`` and
    health/model-options/sessions/jobs live at the server root.  Calling the
    helper with a root-level *path* therefore needs the trailing ``/v1``
    stripped exactly once — same convention as ``routes/jobs.py``.
    """
    base = (raw or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return base


def _current_config() -> tuple[str, str | None]:
    """Return ``(root_url, api_key)`` from the live Hermes service config.

    Imported at call time because ``reload_hermes_config`` replaces the
    module-level globals after an admin saves new settings.
    """
    from app.services.hermes import _hermes_api_key, _hermes_url

    return _hermes_root_url(_hermes_url), _hermes_api_key


def _unconfigured_error() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail="Hermes 网关未配置：请先在系统设置中填写 Hermes 地址",
    )


def _upstream_message(body: bytes | str) -> str:
    """Best-effort Chinese-friendly message from a Hermes error body.

    Hermes uses ``{"error": {"message": ...}}`` on most surfaces, but some
    handlers return ``{"error": "..."}``, ``{"detail": ...}`` or plain text.
    """
    text = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
    text = text.strip()
    if not text:
        return "Hermes 未返回错误详情"
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return text[:500]
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict):
            for key in ("message", "detail", "code"):
                value = error.get(key)
                if value:
                    return str(value)[:500]
        for key in ("error", "detail", "message"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:500]
    return text[:500]


def _redact(text: str, secret: str | None) -> str:
    """Strip the Hermes API key from an upstream message, if it leaked."""
    if secret and secret in text:
        return text.replace(secret, "***")
    return text


#: Chinese prefixes for the Hermes 4xx statuses we expect to pass through.
_4XX_REASONS: dict[int, str] = {
    400: "请求参数错误",
    401: "认证失败（请检查 Hermes API Key）",
    403: "拒绝访问",
    404: "资源不存在",
    409: "状态冲突",
    422: "请求参数无法处理",
    429: "请求过于频繁",
}


async def _hermes_call(
    path: str,
    *,
    params: dict[str, Any] | None = None,
) -> tuple[Any, int]:
    """``GET`` a Hermes endpoint and return ``(decoded_json, latency_ms)``.

    Error contract (shared by every route in this module):

    * no ``HERMES_GATEWAY_URL`` configured → ``503``
    * Hermes ``4xx`` → the upstream status is passed through, with a Chinese
      detail prefix
    * connection / upstream ``5xx`` failure → ``502``
    * timeout (>10 s) → ``504``
    * non-JSON 2xx payload → ``502``

    ``path`` is appended to the ``/v1``-stripped base URL, so callers pass
    ``/v1/capabilities`` or ``/api/jobs`` explicitly.
    """
    # Import at call time: the module-level globals are replaced by
    # ``reload_hermes_config`` after an admin saves new settings.
    base, api_key = _current_config()
    if not base:
        raise _unconfigured_error()

    url = f"{base}{path}"
    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_READ_TIMEOUT, headers=headers) as client:
            resp = await client.get(url, params=params)
    except httpx.TimeoutException as exc:
        logger.warning("Hermes read timeout: GET {} ({})", path, exc)
        raise HTTPException(
            status_code=504,
            detail=f"Hermes 请求超时（{READ_TIMEOUT_SECONDS:g} 秒）：{path}",
        ) from exc
    except httpx.RequestError as exc:
        logger.warning("Hermes connection failed: GET {} → {}", path, exc)
        raise HTTPException(
            status_code=502,
            detail=f"无法连接到 Hermes 服务：{exc}",
        ) from exc

    latency_ms = int(round((time.monotonic() - started) * 1000))

    if resp.status_code >= 500:
        message = _redact(_upstream_message(resp.content), api_key)
        logger.warning(
            "Hermes upstream error: GET {} HTTP {} → {}",
            path,
            resp.status_code,
            message,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Hermes 网关异常（HTTP {resp.status_code}）：{message}",
        )

    if resp.status_code >= 400:
        message = _redact(_upstream_message(resp.content), api_key)
        reason = _4XX_REASONS.get(resp.status_code, "返回错误")
        logger.warning(
            "Hermes client error: GET {} HTTP {} → {}",
            path,
            resp.status_code,
            message,
        )
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Hermes {reason}（HTTP {resp.status_code}）：{message}",
        )

    try:
        data = resp.json()
    except ValueError as exc:
        logger.warning(
            "Hermes returned non-JSON: GET {} HTTP {}", path, resp.status_code
        )
        raise HTTPException(
            status_code=502,
            detail=f"Hermes 返回了非 JSON 响应（HTTP {resp.status_code}）：{path}",
        ) from exc

    logger.debug(
        "Hermes read ok: GET {} HTTP {} in {}ms", path, resp.status_code, latency_ms
    )
    return data, latency_ms


# ═══════════════════════════════════════════════════════════════════════════════
# Small normalisation helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _first(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """Return the first present, non-``None`` value for *keys*."""
    for key in keys:
        if key in mapping:
            value = mapping[key]
            if value is not None:
                return value
    return None


def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _pick_int(mapping: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    return _as_int(_first(mapping, keys))


def _pick_float(mapping: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    return _as_float(_first(mapping, keys))


def _norm_time(value: Any) -> str | None:
    """Normalise a Hermes timestamp to an ISO-8601 string.

    Hermes usually sends ISO strings, but SQLite-backed dashboards sometimes
    expose epoch seconds/milliseconds.  Unsupported shapes are dropped (return
    ``None``) rather than rendered as ``"{...}"``.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        # Heuristic: 1e12 ≈ year 33658 for seconds, but ≈ 2001 for millis.
        if abs(ts) > 1e12:
            ts /= 1000.0
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(
                timespec="seconds"
            )
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        return value.strip() or None
    return None


def _extract_list(data: Any, keys: tuple[str, ...]) -> list[Any] | None:
    """Return a list from a bare-list or envelope payload, else ``None``."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
    return None


def _as_object(data: Any, *, endpoint: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=502,
            detail=f"Hermes {endpoint}返回了非对象 JSON",
        )
    return data


def _session_summary(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Trim one Hermes session record down to list-view summary fields.

    Field names are current Hermes dashboard/SQLite names (``started_at``,
    ``last_active``, ``estimated_cost_usd`` …) plus camelCase aliases, because
    the sessions REST surface is dashboard-provided rather than covered by the
    OpenAI-compatible API contract.
    """
    session_id = _first(raw, ("id", "session_id", "sessionId", "key", "session_key"))
    if session_id is None or session_id == "":
        return None

    usage_raw = raw.get("usage")
    usage: dict[str, Any] = usage_raw if isinstance(usage_raw, dict) else {}

    input_tokens = _pick_int(
        raw, ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
    )
    if input_tokens is None:
        input_tokens = _pick_int(
            usage, ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
        )
    output_tokens = _pick_int(
        raw, ("output_tokens", "completion_tokens", "outputTokens", "completionTokens")
    )
    if output_tokens is None:
        output_tokens = _pick_int(
            usage,
            ("output_tokens", "completion_tokens", "outputTokens", "completionTokens"),
        )

    tokens = _pick_int(
        raw, ("tokens", "total_tokens", "totalTokens", "token_count", "tokenCount")
    )
    if tokens is None:
        tokens = _pick_int(usage, ("total_tokens", "totalTokens", "tokens"))
    if tokens is None and (input_tokens is not None or output_tokens is not None):
        tokens = (input_tokens or 0) + (output_tokens or 0)

    cost = _pick_float(
        raw,
        (
            "cost",
            "total_cost",
            "totalCost",
            "cost_usd",
            "costUsd",
            "estimated_cost_usd",
            "estimatedCostUsd",
        ),
    )
    if cost is None:
        cost = _pick_float(
            usage,
            (
                "cost",
                "total_cost",
                "totalCost",
                "cost_usd",
                "costUsd",
                "estimated_cost_usd",
                "estimatedCostUsd",
            ),
        )

    preview = _first(raw, ("preview", "last_message_preview", "lastMessagePreview"))
    preview_text = _as_str(preview)
    if preview_text is not None:
        preview_text = preview_text[:200]

    return {
        "id": str(session_id),
        "title": _as_str(_first(raw, ("title", "name", "session_title", "sessionTitle"))),
        "model": _as_str(_first(raw, ("model", "model_name", "modelName"))),
        "provider": _as_str(
            _first(raw, ("provider", "provider_name", "providerName"))
        ),
        "tokens": tokens,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost": cost,
        "message_count": _pick_int(
            raw,
            (
                "message_count",
                "messageCount",
                "messages_count",
                "messagesCount",
                "num_messages",
                "numMessages",
            ),
        ),
        "created_at": _norm_time(
            _first(raw, ("created_at", "createdAt", "started_at", "startedAt", "created"))
        ),
        "updated_at": _norm_time(
            _first(raw, ("updated_at", "updatedAt", "modified_at", "modifiedAt"))
        ),
        "last_active_at": _norm_time(
            _first(
                raw,
                (
                    "last_active",
                    "lastActive",
                    "last_active_at",
                    "lastActiveAt",
                    "last_message_at",
                    "lastMessageAt",
                ),
            )
        ),
        "preview": preview_text,
    }


def _state_value(value: Any) -> Any:
    """Extract a scalar state from a ``{state|status: ...}`` dict, else as-is."""
    if isinstance(value, dict):
        return value.get("state") or value.get("status")
    return value


# ═══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/capabilities", summary="Hermes 能力清单（缓存 60 秒）")
async def get_capabilities(response: Response) -> dict[str, Any]:
    """Proxy ``GET /v1/capabilities`` with a 60 s in-process cache.

    The payload is returned unchanged (it is the gateway's own feature
    advertisement).  ``X-Hermes-Cache: HIT|MISS`` and
    ``X-Hermes-Fetched-At`` make the cache state observable without wrapping
    or reshaping the upstream body.
    """
    base, _api_key = _current_config()
    if not base:
        raise _unconfigured_error()

    now = time.monotonic()
    cached = _CAPABILITIES_CACHE.get("payload")
    cache_matches = _CAPABILITIES_CACHE.get("base_url") == base
    if (
        cached is not None
        and cache_matches
        and now < float(_CAPABILITIES_CACHE.get("expires_at") or 0.0)
    ):
        response.headers["X-Hermes-Cache"] = "HIT"
        fetched_at = _CAPABILITIES_CACHE.get("fetched_at")
        if fetched_at:
            response.headers["X-Hermes-Fetched-At"] = str(fetched_at)
        return cached

    data, _latency_ms = await _hermes_call("/v1/capabilities")
    payload = _as_object(data, endpoint="能力接口")

    fetched_at = _utc_now_iso()
    _CAPABILITIES_CACHE["payload"] = payload
    _CAPABILITIES_CACHE["expires_at"] = now + CAPABILITIES_CACHE_TTL_SECONDS
    _CAPABILITIES_CACHE["fetched_at"] = fetched_at
    _CAPABILITIES_CACHE["base_url"] = base

    response.headers["X-Hermes-Cache"] = "MISS"
    response.headers["X-Hermes-Fetched-At"] = fetched_at
    return payload


@router.get("/model-options", summary="Hermes 模型目录")
async def get_model_options() -> dict[str, Any]:
    """Proxy ``GET /api/model/options`` (root-level, not under ``/v1``).

    Returns the provider/model/price catalogue the Hermes dashboard itself
    uses.  Passed through unchanged; older builds without the endpoint surface
    as a passthrough 4xx (usually 404).
    """
    data, _latency_ms = await _hermes_call("/api/model/options")
    return _as_object(data, endpoint="模型目录接口")


@router.get("/sessions", summary="Hermes 会话列表（摘要）")
async def list_sessions(
    limit: int = Query(
        default=50,
        ge=1,
        le=200,
        description="最多返回的会话数（默认 50，上限 200）",
    ),
) -> dict[str, Any]:
    """Proxy ``GET /api/sessions`` and trim records to summary fields.

    Only ``id/title/model/provider/tokens/cost/时间/preview`` survive; tool
    calls, message bodies and other bulk fields are dropped so a session list
    stays small enough for a page header/sidebar.  Use the per-session
    ``messages`` endpoint for the full history.
    """
    data, _latency_ms = await _hermes_call("/api/sessions", params={"limit": limit})

    raw_sessions = _extract_list(
        data, ("sessions", "items", "results", "data")
    )
    if raw_sessions is None:
        raise HTTPException(
            status_code=502,
            detail="Hermes 会话接口返回了非预期的数据结构",
        )

    summaries: list[dict[str, Any]] = []
    for raw in raw_sessions:
        if not isinstance(raw, dict):
            continue
        summary = _session_summary(raw)
        if summary is not None:
            summaries.append(summary)

    summaries = summaries[:limit]
    return {
        "sessions": summaries,
        "count": len(summaries),
        "limit": limit,
    }


@router.get(
    "/sessions/{session_id}/messages",
    summary="Hermes 会话消息历史",
)
async def get_session_messages(session_id: str) -> dict[str, Any]:
    """Proxy ``GET /api/sessions/{session_id}/messages``.

    Message bodies are returned untrimmed (they are the deliverable).  Only
    the envelope shape is normalised, and ``session_id`` is URL-quoted so a
    crafted value cannot escape the intended path prefix.
    """
    encoded_id = quote(session_id, safe="")
    data, _latency_ms = await _hermes_call(
        f"/api/sessions/{encoded_id}/messages"
    )

    messages = _extract_list(data, ("messages", "history", "items", "data"))
    if messages is None:
        raise HTTPException(
            status_code=502,
            detail="Hermes 会话消息接口返回了非预期的数据结构",
        )

    return {
        "session_id": session_id,
        "messages": messages,
        "count": len(messages),
    }


@router.get("/runs/{run_id}", summary="Hermes Run 状态")
async def get_run(run_id: str) -> dict[str, Any]:
    """Proxy ``GET /v1/runs/{run_id}`` — pollable status for a run."""
    encoded_id = quote(run_id, safe="")
    data, _latency_ms = await _hermes_call(f"/v1/runs/{encoded_id}")
    return _as_object(data, endpoint="Run 状态接口")


@router.get("/jobs", summary="Hermes 计划任务列表（只读）")
async def list_jobs() -> dict[str, Any] | list[Any]:
    """Proxy ``GET /api/jobs`` without exposing create/update/delete here.

    The existing ``/api/jobs`` router keeps the full CRUD surface; this is a
    read-only view for the unified Hermes adapter.
    """
    data, _latency_ms = await _hermes_call("/api/jobs")
    if not isinstance(data, (dict, list)):
        raise HTTPException(
            status_code=502,
            detail="Hermes 任务接口返回了非预期的数据结构",
        )
    return data


@router.get("/health", summary="Hermes 健康摘要")
async def get_health() -> dict[str, Any]:
    """Summarise ``GET /health/detailed`` for the unified adapter.

    Hermes returns HTTP 200 even when degraded (readiness checks fail), so
    ``ok`` is derived from ``readiness.status`` (falling back to the top-level
    ``status``) instead of the HTTP status.  Only version/readiness/platforms/
    gateway state are exposed — the raw detailed payload includes runtime
    internals the platform does not need.
    """
    data, latency_ms = await _hermes_call("/health/detailed")
    health = _as_object(data, endpoint="健康检查接口")

    readiness_raw = health.get("readiness")
    readiness: dict[str, Any] = readiness_raw if isinstance(readiness_raw, dict) else {}

    checks_raw = readiness.get("checks")
    checks: dict[str, str] = {}
    if isinstance(checks_raw, dict):
        for name, detail in checks_raw.items():
            if isinstance(detail, dict):
                raw_status = detail.get("status")
                checks[str(name)] = (
                    str(raw_status) if raw_status is not None else "unknown"
                )
            else:
                checks[str(name)] = str(detail)

    status_value = readiness.get("status") or health.get("status")
    status_text = _as_str(status_value)
    status_norm = status_text.lower() if status_text else ""

    platforms_raw = health.get("platforms")
    platforms: dict[str, Any] = {}
    if isinstance(platforms_raw, dict):
        for name, state in platforms_raw.items():
            value = _state_value(state)
            platforms[str(name)] = _as_str(value)

    gateway_state = _as_str(
        _state_value(health.get("gateway_state") or health.get("gateway"))
    )
    version = _as_str(
        _first(health, ("version", "platform_version", "api_server_version"))
    )

    return {
        "ok": status_norm in _READY_STATES,
        "status": status_text,
        "version": version,
        "readiness": {"status": status_text, "checks": checks},
        "platforms": platforms,
        "gateway_state": gateway_state,
        "latency_ms": latency_ms,
        "checked_at": _utc_now_iso(),
    }
