"""Hermes built-in API Server client (OpenAI-compatible).

Hermes runs an OpenAI-compatible API server on port **8642** (NOT the
legacy Gateway REST API).  We POST ``/v1/chat/completions`` with a
system prompt that instructs Hermes to perform Root Cause Analysis (RCA)
fault investigation.  The response is synchronous — no polling required.

For interactive chat, use :meth:`chat_stream` which enables SSE streaming
(``stream: true``) and yields parsed delta events suitable for relaying
to a browser client via Server-Sent Events.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator

import httpx
from loguru import logger

from app.config import settings

# ── Runtime config (reloadable from DB, starts from env vars) ─────────────────
_hermes_url: str = settings.HERMES_GATEWAY_URL
_hermes_api_key: str | None = settings.HERMES_API_KEY

# ── RCA output budget ────────────────────────────────────────────────────────
# 旧值固定 4096，长 JSON 报告会在 finish_reason=length 处被截断，落库后变成
# 无法解析的“半截 JSON”。默认提高到 8192，并允许用环境变量覆盖（不新增
# settings 字段，避免动 config.py / 数据库结构）。
RCA_DEFAULT_MAX_TOKENS = 8192


def _rca_max_tokens() -> int:
    """RCA 请求的 ``max_tokens``：``RCA_MAX_TOKENS`` 环境变量 > 默认 8192。

    越界值会被收敛到 [512, 32768]，避免误配导致请求被 Hermes 拒绝或费用失控。
    """
    import os

    raw: Any = os.getenv("RCA_MAX_TOKENS") or getattr(
        settings, "RCA_MAX_TOKENS", None
    )
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return RCA_DEFAULT_MAX_TOKENS
    return max(512, min(value, 32768))


# ── Skills / toolsets cache ─────────────────────────────────────────────────
_cached_skills: list[dict[str, Any]] = []
_cached_toolsets: list[dict[str, Any]] = []
_cache_updated_at: float = 0.0
_cache_refresh_secs: int = 300  # default 5 minutes


def get_cache_age_secs() -> float:
    """Seconds since the cache was last refreshed."""
    import time
    return time.time() - _cache_updated_at


def get_cache_refresh_secs() -> int:
    return _cache_refresh_secs


def set_cache_refresh_secs(secs: int) -> None:
    global _cache_refresh_secs
    _cache_refresh_secs = max(30, min(secs, 86400))  # clamp 30s–24h


async def refresh_skills_cache(client: "HermesClient | None" = None) -> None:
    """Force-refresh the skills/toolsets cache from Hermes."""
    global _cached_skills, _cached_toolsets, _cache_updated_at
    import time
    if client is None:
        client = HermesClient()
    try:
        _cached_skills = await client.get_skills()
        _cached_toolsets = await client.get_toolsets()
        _cache_updated_at = time.time()
        logger.info("Skills cache refreshed: {} skills, {} toolsets",
                     len(_cached_skills), len(_cached_toolsets))
    except Exception:
        logger.exception("Failed to refresh skills cache")


def get_cached_skills() -> list[dict[str, Any]]:
    return _cached_skills


def get_cached_toolsets() -> list[dict[str, Any]]:
    return _cached_toolsets


def reload_hermes_config(db_entries: dict[str, str]) -> None:
    """Reload Hermes config from DB values (called on admin save + startup).

    DB values take precedence over env vars.  When a key is missing from
    DB or its value is empty, falls back to the env-var default so the
    service is reachable without manual configuration.
    """
    global _hermes_url, _hermes_api_key
    _hermes_url = db_entries.get("hermes_url") or settings.HERMES_GATEWAY_URL
    _hermes_api_key = db_entries.get("hermes_api_key") or settings.HERMES_API_KEY
    logger.info("Hermes config reloaded (url={})", _hermes_url)


# ═══════════════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════════════

RCA_SYSTEM_PROMPT = """你是一个专业的故障根因分析（RCA）助手。你的任务是根据用户提供的故障信息，进行全面的根因分析。

请严格按照以下步骤执行分析：

## 第一步：解析输入参数
从用户消息中提取以下字段：
- service_name：故障服务名称
- time_window_start：分析时间窗口开始时间
- time_window_end：分析时间窗口结束时间

## 第二步：数据采集
根据提取的参数，查询以下数据源：
1. **监控平台指标**：查询服务在时间窗口内的 CPU、内存、延迟、错误率、吞吐量等指标
2. **日志易日志**：查询时间窗口内的异常日志、错误日志、关键事件
3. **ClickHouse 事务**：查询时间窗口内的事务记录、调用链、数据库慢查询

## 第三步：根因分析
综合分析采集到的数据，识别故障根因。

## 输出格式
必须以严格的 JSON 格式返回（不要包含 ```json 标记），包含以下字段：
{
    "root_cause": "根因简述",
    "confidence": 0.0-1.0,
    "evidence": ["证据1", "证据2", ...],
    "impacted_services": ["受影响服务1", "受影响服务2", ...],
    "recommended_actions": ["建议操作1", "建议操作2", ...]
}

注意：仅返回 JSON，不要包含任何其他文字或解释。"""

# ═══════════════════════════════════════════════════════════════════════════════
# Runs API errors
# ═══════════════════════════════════════════════════════════════════════════════


class HermesRunError(RuntimeError):
    """An error returned by (or raised while reaching) the Hermes Runs API.

    ``status_code`` mirrors the upstream HTTP status when there is one, and is
    ``503`` for connection failures / ``502`` for malformed upstream payloads.
    Routes translate this into an ``HTTPException`` so the browser sees a
    meaningful status instead of a generic 500.
    """

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = message


def _hermes_error_message(body: bytes | str) -> str:
    """Best-effort human-readable message from a Hermes error body.

    Hermes uses the OpenAI envelope (``{"error": {"message": ...}}``) on most
    surfaces, but a few handlers return ``{"error": "..."}`` or ``{"detail":
    ...}``.  Plain text bodies are truncated and passed through.
    """
    if isinstance(body, bytes):
        text = body.decode("utf-8", "replace")
    else:
        text = body
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return text.strip()[:500] or "Hermes 运行接口返回了错误"
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            message = err.get("message") or err.get("code")
            if message:
                return str(message)
        if isinstance(err, str) and err:
            return err
        for key in ("detail", "message"):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                return value
    return text.strip()[:500] or "Hermes 运行接口返回了错误"


# ═══════════════════════════════════════════════════════════════════════════════
# Health probe (fallback chain)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Hermes builds differ in *which* health endpoint exists and whether it requires
# auth: ``/health/detailed`` is bearer-protected on 0.22+ while ``/health`` is
# public.  A single 404/401 must therefore not be reported as "unreachable";
# probe the known variants in order and keep every attempt so the settings UI
# can show what was tried instead of a single opaque error.

HEALTH_PROBE_TIMEOUT = 8.0
HEALTH_PROBE_CONNECT_TIMEOUT = 5.0

_DNS_ERROR_MARKERS = (
    "getaddrinfo",
    "name or service not known",
    "nodename nor servname",
    "name resolution",
    "no address associated",
    "errno 11001",
)


def _classify_probe_error(exc: httpx.RequestError) -> tuple[str, str]:
    """Map a transport exception to ``(kind, message)`` for diagnostics."""
    message = f"{type(exc).__name__}: {exc}"[:400]
    lowered = message.lower()
    if any(marker in lowered for marker in _DNS_ERROR_MARKERS):
        return "dns", message
    if (
        isinstance(exc, httpx.TimeoutException)
        or "timed out" in lowered
        or "timeout" in lowered
    ):
        return "timeout", message
    if isinstance(exc, httpx.ConnectError) or any(
        marker in lowered
        for marker in (
            "connection refused",
            "actively refused",
            "unreachable",
            "no route to host",
        )
    ):
        return "connect", message
    return "request", message


async def _probe_health_url(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    *,
    auth: str,
) -> dict[str, Any]:
    """Request one health URL; never raises.

    The returned object contains internal keys (``kind`` / ``body`` / ``text``)
    plus a public ``attempt`` entry ``{url, status, error, auth}``.
    """
    try:
        resp = await client.get(url, headers=headers)
    except httpx.RequestError as exc:
        kind, error = _classify_probe_error(exc)
        return {
            "ok": False,
            "status": None,
            "kind": kind,
            "body": None,
            "attempt": {"url": url, "status": None, "error": error, "auth": auth},
        }

    body_text = resp.text or ""
    if 200 <= resp.status_code < 300:
        try:
            data: Any = resp.json()
        except ValueError:
            data = None
        return {
            "ok": True,
            "status": resp.status_code,
            "kind": "ok",
            "body": data,
            "text": body_text,
            "attempt": {
                "url": url,
                "status": resp.status_code,
                "error": None,
                "auth": auth,
            },
        }

    # A short body excerpt is often the only clue (e.g. "Invalid gateway API
    # key"), so keep it in the attempt — never the full response.
    snippet = " ".join(body_text.split())[:200]
    error = f"HTTP {resp.status_code}" + (f": {snippet}" if snippet else "")
    return {
        "ok": False,
        "status": resp.status_code,
        "kind": "http",
        "body": None,
        "attempt": {
            "url": url,
            "status": resp.status_code,
            "error": error,
            "auth": auth,
        },
    }


def _health_payload(
    result: dict[str, Any],
    attempts: list[dict[str, Any]],
    warning: str | None,
) -> dict[str, Any]:
    """Merge a successful health body with its ``_probe`` metadata."""
    body = result.get("body")
    if isinstance(body, dict):
        payload: dict[str, Any] = dict(body)
    elif body is not None:
        payload = {"data": body}
    else:
        text = (result.get("text") or "").strip()
        payload = {"body": text[:2000]} if text else {}

    url = result["attempt"]["url"]
    payload["_probe"] = {
        "ok": True,
        "url": url,
        "status": result.get("status"),
        "attempts": attempts,
        "resolved_url": url,
        "hint": None,
        "warning": warning,
    }
    return payload


def _health_hint(attempts: list[dict[str, Any]], kinds: list[str]) -> str:
    """Turn the probe attempts into one actionable Chinese hint."""
    statuses = [
        attempt.get("status")
        for attempt in attempts
        if attempt.get("status") is not None
    ]
    if "dns" in kinds:
        return "主机名无法解析"
    if any(status in (401, 403) for status in statuses):
        return "API Key 不正确或未配置（Hermes 0.22+ /health/detailed 需鉴权）"
    if any(kind in ("timeout", "connect") for kind in kinds):
        return "后端所在主机无法访问该地址（内网 ACL/端口/容器网络）"
    if statuses and all(status == 404 for status in statuses):
        return "Hermes 版本不支持这些健康端点，但服务可能正常，请检查 API 版本"
    return "健康端点探测失败 — 请检查 API 地址、端口与 API Key"


# ═══════════════════════════════════════════════════════════════════════════════
# Client
# ═══════════════════════════════════════════════════════════════════════════════


class HermesClient:
    """Async HTTP client for the Hermes OpenAI-compatible API server.

    Uses a shared ``httpx.AsyncClient`` with a configurable timeout (600s
    default — RCA analysis can take minutes).  Instantiate once per
    application scope.
    """

    def __init__(self, timeout: float = 600.0) -> None:
        # base_url should end with ``/v1``, e.g.
        # ``http://<host>:8642/v1``
        self.base_url = _hermes_url.rstrip("/")
        self.api_key = _hermes_api_key
        self.timeout = timeout
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=30.0),
            headers=self._headers(),
        )

    async def close(self) -> None:
        """Gracefully close the underlying HTTP client."""
        await self._client.aclose()

    # ── RCA invocation ────────────────────────────────────────────────────

    async def trigger_skill(
        self,
        skill_name: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Execute an RCA analysis and return both session id and output."""
        result = await self.run_rca(skill_name, params or {})
        return {
            "session_id": result["session_id"],
            "output": result["result"]["output"],
        }

    async def run_rca(
        self,
        skill_name: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run an RCA fault analysis synchronously via Hermes API Server.

        Sends a chat-completion request to ``POST /v1/chat/completions``
        with the RCA system prompt and the provided parameters serialised
        as the user message.  Hermes streams the analysis internally and
        returns the result in one response.

        Args:
            skill_name: Hermes skill name (e.g. ``"rca-fault-delimitation"``).
            params: RCA parameters.  Expected keys include
                ``service_name``, ``time_window_start``,
                ``time_window_end``, plus any additional context.

        Returns:
            A dict with the standard envelope::

                {
                    "session_id": "<Hermes 响应头 X-Hermes-Session-Id，取不到为 ''>",
                    "status": "completed",
                    "finish_reason": "stop" | "length" | ...,
                    "result": {
                        "output": "<JSON string from Hermes>"
                    }
                }

            ``session_id`` 只取 Hermes 真实回传的会话 id，绝不在本地拼
            ``skill--uuid`` 伪造（伪造值与 Hermes 侧会话对不上，写进
            ``rca_sessions.hermes_session_id`` 只会误导排查）。

        Raises:
            RuntimeError: If the API call fails or returns an unexpected
                status.
        """
        params = params or {}

        # Build a user message from the params dict
        user_message_lines = [f"技能名称: {skill_name}"]
        for key, value in params.items():
            user_message_lines.append(f"{key}: {value}")
        user_message = "\n".join(user_message_lines)

        url = f"{self.base_url}/chat/completions"
        max_tokens = _rca_max_tokens()
        payload: dict[str, Any] = {
            "model": "hermes-agent",
            "messages": [
                {"role": "system", "content": RCA_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }

        logger.info(
            "Hermes RCA request: skill={!r} params_keys={} max_tokens={}",
            skill_name,
            list(params.keys()),
            max_tokens,
        )

        try:
            resp = await self._client.post(url, json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"Hermes API Server error (HTTP {exc.response.status_code}): "
                f"{exc.response.text}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(
                f"Hermes API Server request failed: {exc}"
            ) from exc

        # 真实会话 id 只来自响应头（Hermes 在 SSE / 响应头里回传）；取不到就留空。
        session_id = (resp.headers.get("x-hermes-session-id") or "").strip()

        data = resp.json()

        # Extract the assistant's reply from OpenAI-compatible response
        try:
            choice = data["choices"][0]
            content = choice["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(
                f"Unexpected Hermes response format: missing choices/content: {data}"
            ) from exc

        finish_reason = (
            choice.get("finish_reason") if isinstance(choice, dict) else None
        )
        usage = data.get("usage") if isinstance(data, dict) else None
        usage = usage if isinstance(usage, dict) else {}

        logger.info(
            "Hermes RCA completed: session_id={} finish_reason={} "
            "input_tokens={} output_tokens={}",
            session_id or "-",
            finish_reason,
            usage.get("prompt_tokens", "?"),
            usage.get("completion_tokens", "?"),
        )

        # 截断是静默数据损坏：finish_reason=length 时 JSON 报告大概率不完整，
        # 必须留痕，方便按日志调大 RCA_MAX_TOKENS 后重跑。
        if finish_reason == "length":
            logger.warning(
                "Hermes RCA 输出被截断（finish_reason=length, max_tokens={}）"
                "— 报告 JSON 可能不完整，可通过环境变量 RCA_MAX_TOKENS 调大后重跑",
                max_tokens,
            )

        return {
            "session_id": session_id,
            "status": "completed",
            "finish_reason": finish_reason,
            "result": {"output": content},
        }

    # ── Streaming chat (for interactive conversation) ─────────────────────

    async def chat_stream(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str = "hermes-agent",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        session_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream a chat completion via Hermes API Server with SSE.

        Sends ``POST /v1/chat/completions`` with ``stream: true`` and yields
        parsed delta events one at a time.  Each yielded dict has the shape::

            {
                "type": "delta" | "reasoning" | "tool_call" | "session"
                        | "ping" | "status" | "done" | "error",
                "content": str | None,       # text chunk (type=delta/reasoning)
                "tool_call": dict | None,    # tool-call delta (type=tool_call)
                "finish_reason": str | None, # stop / tool_calls / length (type=done)
                "usage": dict | None,        # token counts (type=done, may be absent)
                "error": str | None,         # error message (type=error)
                "status": dict | None,       # forwarded Hermes status payload
            }

        ``type=ping`` 对应 Hermes 的 SSE 注释行（``: keepalive``）。Hermes 在
        工具执行/长思考期间按固定间隔（当前源码常量
        ``CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS`` = 30s）写注释行保活；注释
        不是 ``data:`` 行，必须显式转发，否则长工具执行时浏览器收不到任何
        字节，容易被反向代理按空闲超时切断。

        Args:
            messages: List of message dicts with ``role`` and ``content`` keys
                (OpenAI-compatible format).
            model: Model identifier (default ``"hermes-agent"``).
            temperature: Sampling temperature (0-2, default 0.7).
            max_tokens: Maximum tokens to generate (default 4096).
            session_id: Hermes session to continue (sent as
                ``X-Hermes-Session-Id``).  Hermes then keeps the agent's
                server-side context across turns instead of treating every
                request as a brand-new conversation.

        Yields:
            Parsed delta events as described above.
        """
        url = f"{self.base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }

        logger.info(
            "Hermes chat stream: model={!r} msg_count={}",
            model,
            len(messages),
        )

        # We use a fresh client for streaming to avoid blocking the shared
        # client on long-lived connections.
        stream_headers = self._headers()
        if session_id and self.api_key:
            # Hermes continues an existing server-side agent session.
            stream_headers["X-Hermes-Session-Id"] = session_id
        elif session_id:
            # Hermes 0.22.x rejects this header with 403 when the API server has
            # no API key configured, so it must only ride along with auth.
            logger.info(
                "Hermes API key not configured — omitting X-Hermes-Session-Id "
                "(Hermes rejects it without auth)"
            )
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(600.0, connect=30.0),
            headers=stream_headers,
        ) as stream_client:
            try:
                async with stream_client.stream("POST", url, json=payload) as resp:
                    resp.raise_for_status()

                    # Hermes echoes (or mints) the session id here; the chat
                    # layer forwards it to the browser so the next turn can
                    # reuse the same agent session.
                    hermes_session_id = resp.headers.get("x-hermes-session-id") or session_id
                    if hermes_session_id:
                        yield {
                            "type": "session",
                            "session_id": hermes_session_id,
                            "content": None,
                            "tool_call": None,
                            "finish_reason": None,
                            "usage": None,
                            "error": None,
                        }

                    tool_call_buf: dict[int, dict[str, Any]] = {}
                    current_sse_event: str | None = None

                    async for line in resp.aiter_lines():
                        # ── SSE 注释行（`: keepalive`）─────────────────────
                        # Hermes 在工具执行/长思考的空档写 `: keepalive` 注释；
                        # 注释既不是 `event:` 也不是 `data:`，旧实现直接丢弃，
                        # 导致最长几分钟的“静默期”里浏览器和反代都看不到任何
                        # 字节。这里转成 ping 事件，由 chat 层包成 `event: ping`。
                        if line.startswith(":"):
                            logger.debug("Hermes SSE keepalive: {!r}", line[:80])
                            yield {
                                "type": "ping",
                                "content": None,
                                "tool_call": None,
                                "finish_reason": None,
                                "usage": None,
                                "error": None,
                            }
                            continue

                        # ── Track SSE event: lines ──────────────────────────
                        if line.startswith("event: "):
                            current_sse_event = line[7:].strip()
                            continue

                        if not line.startswith("data: "):
                            continue

                        data_str = line[6:]  # strip "data: " prefix

                        if data_str == "[DONE]":
                            break

                        try:
                            chunk: dict[str, Any] = json.loads(data_str)
                        except json.JSONDecodeError:
                            logger.warning(
                                "Hermes SSE unparseable: {!r}", data_str[:200]
                            )
                            continue

                        # Log every chunk so we can diagnose what Hermes sends
                        logger.info(
                            "Hermes SSE | event={} keys={} preview={}",
                            current_sse_event,
                            list(chunk.keys()),
                            json.dumps(chunk, ensure_ascii=False)[:400],
                        )

                        sse_event = current_sse_event
                        current_sse_event = None

                        # ── Hermes tool progress events ─────────────────────
                        if sse_event == "hermes.tool.progress":
                            yield _parse_hermes_tool_progress(chunk, tool_call_buf)
                            continue

                        # ── Hermes agent status events ──────────────────────
                        # 部分 Hermes 版本 / 代理层会额外发 `event: hermes.status`
                        # （例如阶段切换、排队、审批等待）。原样转发为 status，
                        # 前端不认识也不会被误当成正文内容。
                        if sse_event in ("hermes.status", "status"):
                            logger.info(
                                "Hermes SSE → status: {}",
                                json.dumps(chunk, ensure_ascii=False)[:300],
                            )
                            yield {
                                "type": "status",
                                "content": None,
                                "tool_call": None,
                                "finish_reason": None,
                                "usage": None,
                                "error": None,
                                "status": chunk,
                            }
                            continue

                        # ── Multi-format delta extraction ───────────────────
                        delta, finish_reason = _extract_delta(chunk)

                        # ── Tool calls ───────────────────────────────────────
                        raw_tool_calls = _find_tool_calls(delta)
                        if raw_tool_calls:
                            for tc in raw_tool_calls:
                                idx: int = tc.get("index", 0)
                                if idx not in tool_call_buf:
                                    tool_call_buf[idx] = {
                                        "id": tc.get("id", ""),
                                        "function": {"name": "", "arguments": ""},
                                    }
                                entry = tool_call_buf[idx]
                                if tc.get("id"):
                                    entry["id"] = tc["id"]
                                func = tc.get("function", {})
                                if func.get("name"):
                                    entry["function"]["name"] += func["name"]
                                if func.get("arguments"):
                                    entry["function"]["arguments"] += func["arguments"]

                            assembled = [
                                tool_call_buf[i]
                                for i in sorted(tool_call_buf.keys())
                            ]
                            logger.info(
                                "Hermes SSE → tool_call: names={}",
                                [t["function"]["name"] for t in assembled],
                            )
                            yield {
                                "type": "tool_call",
                                "content": None,
                                "tool_calls": assembled,
                                "finish_reason": None,
                                "usage": None,
                                "error": None,
                            }

                        # ── Reasoning / thinking deltas ──────────────────────
                        # Hermes streams the model's chain-of-thought as
                        # ``delta.reasoning_content`` (see /v1/capabilities →
                        # features.reasoning_streaming).  Forward it separately so
                        # the UI can collapse it instead of mixing it into the
                        # answer text.
                        reasoning = _find_reasoning(delta)
                        if reasoning:
                            yield {
                                "type": "reasoning",
                                "content": reasoning,
                                "tool_call": None,
                                "finish_reason": None,
                                "usage": None,
                                "error": None,
                            }

                        # ── Text content ────────────────────────────────────
                        content = _find_content(delta)
                        if content:
                            yield {
                                "type": "delta",
                                "content": content,
                                "tool_call": None,
                                "finish_reason": None,
                                "usage": None,
                                "error": None,
                            }

                        # ── Finish ───────────────────────────────────────────
                        if finish_reason is not None:
                            if finish_reason == "tool_calls":
                                tool_call_buf.clear()
                            # Hermes attaches diagnostics to abnormal finish
                            # chunks (``error`` / ``hermes``); dropping them made
                            # a truncated turn look like a clean stop.
                            finish_error = chunk.get("error")
                            if finish_error is not None and not isinstance(
                                finish_error, str
                            ):
                                finish_error = json.dumps(
                                    finish_error, ensure_ascii=False
                                )
                            hermes_extra = chunk.get("hermes")
                            if finish_error:
                                logger.warning(
                                    "Hermes SSE → done with error: {}",
                                    finish_error[:300],
                                )
                            logger.info(
                                "Hermes SSE → done: finish_reason={} has_error={}",
                                finish_reason,
                                bool(finish_error),
                            )
                            done_event: dict[str, Any] = {
                                "type": "done",
                                "content": None,
                                "tool_call": None,
                                "finish_reason": finish_reason,
                                "usage": chunk.get("usage"),
                                "error": finish_error or None,
                            }
                            if hermes_extra:
                                done_event["hermes"] = hermes_extra
                            yield done_event

                        # ── Catch-all for unknown shapes ────────────────────
                        if (
                            not raw_tool_calls
                            and not _find_content(delta)
                            and not reasoning
                            and finish_reason is None
                        ):
                            logger.info(
                                "Hermes SSE → unhandled: {}",
                                json.dumps(chunk, ensure_ascii=False)[:300],
                            )

            except httpx.HTTPStatusError as exc:
                logger.error(
                    "Hermes chat stream HTTP error: status={} body={!r}",
                    exc.response.status_code,
                    exc.response.text[:500],
                )
                yield {
                    "type": "error",
                    "content": None,
                    "tool_call": None,
                    "finish_reason": None,
                    "usage": None,
                    "error": f"Hermes API error (HTTP {exc.response.status_code})",
                }
            except httpx.RequestError as exc:
                logger.error("Hermes chat stream request error: {}", exc)
                yield {
                    "type": "error",
                    "content": None,
                    "tool_call": None,
                    "finish_reason": None,
                    "usage": None,
                    "error": f"无法连接到 Hermes 服务: {exc}",
                }

    # ── Runs API (structured agent runs) ──────────────────────────────────
    #
    # The Runs API decouples "submit" from "watch": ``POST /v1/runs`` returns a
    # ``run_id`` immediately, progress arrives on ``GET /v1/runs/{id}/events``
    # (SSE), and the run can be stopped / steered / approved through dedicated
    # control endpoints.  Unlike ``/v1/chat/completions`` streaming, the run
    # keeps executing on the Hermes side when the client disconnects, which is
    # what makes a real "stop" possible.

    def _run_url(self, run_id: str, suffix: str = "") -> str:
        return f"{self.base_url}/runs/{run_id}{suffix}"

    async def _run_request(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Call a Runs API endpoint and return the decoded JSON object.

        Raises:
            HermesRunError: on connection failures, non-2xx responses, or a
                body that is not a JSON object.
        """
        try:
            resp = await self._client.request(
                method, url, json=payload, headers=self._headers()
            )
        except httpx.RequestError as exc:
            logger.warning("Hermes Runs API request failed: {} {}", method, url)
            raise HermesRunError(503, f"无法连接 Hermes 服务: {exc}") from exc

        if resp.status_code >= 400:
            message = _hermes_error_message(resp.content)
            logger.warning(
                "Hermes Runs API HTTP {}: {} {} → {}",
                resp.status_code,
                method,
                url,
                message[:200],
            )
            raise HermesRunError(resp.status_code, message)

        try:
            data = resp.json()
        except ValueError as exc:
            raise HermesRunError(502, "Hermes 运行接口返回了非 JSON 响应") from exc
        return data if isinstance(data, dict) else {"data": data}

    async def create_run(
        self,
        *,
        input: str,
        session_id: str | None = None,
        instructions: str | None = None,
        model: str | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Submit ``POST /v1/runs`` and return ``{run_id, status, replayed?}``.

        Args:
            input: The user message for this turn.
            session_id: Hermes agent session to continue.  When omitted Hermes
                keys the run by its own ``run_id``, so callers that want
                multi-turn continuity must pass the session id back.
            instructions: Ephemeral system prompt for this turn (Hermes passes
                it as the agent's system prompt; it is not persisted).
            model: Optional model override.
            conversation_history: Optional prior messages in OpenAI format.
        """
        payload: dict[str, Any] = {"input": input}
        if session_id:
            payload["session_id"] = session_id
        if instructions:
            payload["instructions"] = instructions
        if model:
            payload["model"] = model
        if conversation_history:
            payload["conversation_history"] = conversation_history

        logger.info(
            "Hermes run create: session_id={} has_instructions={} model={!r}",
            session_id,
            bool(instructions),
            model,
        )
        return await self._run_request("POST", f"{self.base_url}/runs", payload)

    async def get_run(self, run_id: str) -> dict[str, Any]:
        """Fetch ``GET /v1/runs/{run_id}`` — pollable status for reconnect."""
        return await self._run_request("GET", self._run_url(run_id))

    async def stop_run(self, run_id: str) -> dict[str, Any]:
        """Ask Hermes to interrupt a run (``POST /v1/runs/{id}/stop``)."""
        logger.info("Hermes run stop: run_id={}", run_id)
        return await self._run_request("POST", self._run_url(run_id, "/stop"))

    async def steer_run(self, run_id: str, input: str) -> dict[str, Any]:
        """Inject guidance into a running agent (``POST …/steer``)."""
        logger.info("Hermes run steer: run_id={} chars={}", run_id, len(input))
        return await self._run_request(
            "POST", self._run_url(run_id, "/steer"), {"input": input}
        )

    async def respond_approval(
        self,
        run_id: str,
        decision: str,
        approval_id: str | None = None,
    ) -> dict[str, Any]:
        """Resolve a pending tool approval (``POST …/approval``).

        Hermes names the decision field ``choice`` and accepts
        ``once``/``session``/``always``/``deny`` (``approve`` is aliased to
        ``once`` upstream, but we normalise here so either vocabulary works).
        """
        choice = _normalize_approval_choice(decision)
        payload: dict[str, Any] = {"choice": choice}
        if approval_id:
            payload["request_id"] = approval_id
        logger.info(
            "Hermes run approval: run_id={} choice={} has_request_id={}",
            run_id,
            choice,
            bool(approval_id),
        )
        return await self._run_request(
            "POST", self._run_url(run_id, "/approval"), payload
        )

    async def stream_run_events(
        self,
        run_id: str,
        *,
        last_event_id: str | int | None = None,
    ) -> AsyncGenerator[bytes, None]:
        """Proxy ``GET /v1/runs/{run_id}/events`` as raw SSE bytes.

        Hermes writes SSE frames as ``id: <seq>`` + ``data: <json>`` (the event
        *name* lives inside the JSON ``event`` field — there is no ``event:``
        line) and uses comment frames (``: open``, ``: keepalive``,
        ``: stream closed``) as keepalives.  We therefore forward the raw byte
        chunks byte-for-byte instead of re-encoding them.

        Args:
            run_id: The Hermes run to stream.
            last_event_id: Value of the client's ``Last-Event-ID`` header
                (or ``?last_seq=``), forwarded so Hermes replays missed frames
                after a dropped connection.

        Yields:
            Raw SSE byte chunks exactly as Hermes sent them.

        Raises:
            HermesRunError: if Hermes rejects the subscription (unknown run,
                run not owned, …) before any bytes are streamed.
        """
        headers = self._headers()
        headers["Accept"] = "text/event-stream"
        if last_event_id not in (None, ""):
            headers["Last-Event-ID"] = str(last_event_id)

        # Long-lived connection: run events can idle for minutes while the agent
        # waits on a tool approval, so keep the read timeout generous (Hermes
        # emits a keepalive comment every ~10s anyway).
        timeout = httpx.Timeout(600.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            async with client.stream("GET", self._run_url(run_id, "/events")) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    raise HermesRunError(
                        resp.status_code, _hermes_error_message(body)
                    )
                async for chunk in resp.aiter_raw():
                    if chunk:
                        yield chunk

    # ── Skills & toolsets discovery ────────────────────────────────────

    async def get_skills(self) -> list[dict[str, Any]]:
        """List skills registered with the Hermes agent.

        Returns metadata for every skill the agent can invoke — name,
        description, and category.  Requires ``API_SERVER_KEY`` on the
        Hermes side if authentication is enabled.

        Handles both bare-list and envelope ``{object, data: [...]}`` responses.
        """
        url = f"{self.base_url}/skills"
        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                return data["data"]
            return data  # bare list
        except httpx.HTTPStatusError as exc:
            logger.warning("Hermes /v1/skills returned {}", exc.response.status_code)
            return []
        except httpx.RequestError as exc:
            logger.warning("Hermes /v1/skills request failed: {}", exc)
            return []

    async def get_toolsets(self) -> list[dict[str, Any]]:
        """List toolsets (tool groups) registered with the Hermes agent.

        Returns each toolset's name, label, description, enabled/configured
        status, and the concrete ``tools`` list it expands to.  Requires
        ``API_SERVER_KEY`` on the Hermes side if authentication is enabled.

        Handles both bare-list and envelope ``{object, data: [...]}`` responses.
        """
        url = f"{self.base_url}/toolsets"
        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                return data["data"]
            return data  # bare list
        except httpx.HTTPStatusError as exc:
            logger.warning("Hermes /v1/toolsets returned {}", exc.response.status_code)
            return []
        except httpx.RequestError as exc:
            logger.warning("Hermes /v1/toolsets request failed: {}", exc)
            return []

    # ── Capabilities / health / model discovery ───────────────────────────

    def _root_url(self) -> str:
        """Base URL with any trailing ``/v1`` removed (root-level endpoints)."""
        base = self.base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        return base

    async def get_capabilities(self) -> dict[str, Any]:
        """Fetch ``GET /v1/capabilities``.

        The server advertises the exact API surface it supports (runs,
        session continuity headers, reasoning streaming, jobs admin, …), so the
        UI can adapt instead of guessing.  Returns ``{}`` when unavailable —
        older Hermes builds predate this endpoint.
        """
        try:
            resp = await self._client.get(f"{self.base_url}/capabilities")
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
            logger.warning("Hermes /v1/capabilities unavailable: {}", exc)
            return {}

    async def get_health_detailed(self) -> dict[str, Any]:
        """Probe Hermes health endpoints, preferring the detailed one.

        Fallback chain (same host, so URL prefixes and ``/v1`` variants are all
        covered):

        1. ``{root}/health/detailed`` — richest payload, bearer-protected on
           Hermes 0.22+ (older deployments may answer 401/403/404).
        2. ``{root}/health`` — public on every known build.
        3. ``{root}/v1/health`` — some proxies only expose the versioned path.

        Every request carries the Bearer token; a 401/403 is retried **once
        without** ``Authorization`` because some deployments expose the health
        routes publicly but reject an unknown token.  Each attempt gets 8 s
        (5 s connect).  A 2xx from any endpoint ends the chain.

        Never raises.  The returned dict is the successful health body merged
        with ``_probe`` metadata::

            {
                ...,  # health payload (version / readiness / …)
                "_probe": {
                    "ok": bool,
                    "url": str | None,
                    "status": int | None,
                    "attempts": [{"url", "status", "error", "auth"}, …],
                    "resolved_url": str | None,
                    "hint": str | None,
                    "warning": str | None,
                },
            }

        When every probe fails only ``{"_probe": {..., "ok": False}}`` is
        returned, so callers must check ``_probe.ok`` rather than truthiness.
        Existing callers keep reading top-level fields such as
        ``readiness`` / ``version`` unchanged.
        """
        root = self._root_url()
        targets: tuple[tuple[str, str | None], ...] = (
            (f"{root}/health/detailed", None),
            (f"{root}/health", "使用 /health 回退（detail 不可用）"),
            (f"{root}/v1/health", "使用 /v1/health 回退（detail 不可用）"),
        )

        attempts: list[dict[str, Any]] = []
        kinds: list[str] = []
        timeout = httpx.Timeout(
            HEALTH_PROBE_TIMEOUT, connect=HEALTH_PROBE_CONNECT_TIMEOUT
        )

        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True
        ) as probe_client:
            for url, fallback_warning in targets:
                result = await _probe_health_url(
                    probe_client,
                    url,
                    self._headers(),
                    auth="bearer" if self.api_key else "none",
                )
                attempts.append(result["attempt"])
                kinds.append(result["kind"])
                logger.info(
                    "Hermes health probe: {} → {}",
                    url,
                    result["status"] if result["ok"] else result["attempt"].get("error"),
                )
                if result["ok"]:
                    logger.info(
                        "Hermes health ok via {} (HTTP {}) after {} attempt(s)",
                        url,
                        result["status"],
                        len(attempts),
                    )
                    return _health_payload(result, attempts, fallback_warning)

                # Unknown/stale token: retry the same URL unauthenticated once.
                if result["status"] in (401, 403) and self.api_key:
                    noauth = await _probe_health_url(
                        probe_client,
                        url,
                        {"Accept": "application/json"},
                        auth="none",
                    )
                    attempts.append(noauth["attempt"])
                    kinds.append(noauth["kind"])
                    logger.info(
                        "Hermes health probe (no auth): {} → {}",
                        url,
                        noauth["status"]
                        if noauth["ok"]
                        else noauth["attempt"].get("error"),
                    )
                    if noauth["ok"]:
                        logger.info(
                            "Hermes health ok via {} without auth after {} attempt(s)",
                            url,
                            len(attempts),
                        )
                        return _health_payload(noauth, attempts, fallback_warning)

        hint = _health_hint(attempts, kinds)
        logger.warning(
            "Hermes health probe failed after {} attempt(s): {}",
            len(attempts),
            hint,
        )
        return {
            "_probe": {
                "ok": False,
                "url": None,
                "status": None,
                "attempts": attempts,
                "resolved_url": None,
                "hint": hint,
                "warning": None,
            }
        }

    async def get_model_options(self) -> dict[str, Any]:
        """Fetch ``GET /api/model/options`` — providers/models the agent can use.

        Returns ``{}`` when the endpoint is absent (older builds).
        """
        try:
            resp = await self._client.get(f"{self._root_url()}/api/model/options")
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
            logger.warning("Hermes /api/model/options unavailable: {}", exc)
            return {}

    # ── Legacy methods (deprecated) ───────────────────────────────────────

    async def get_session_status(self, session_id: str) -> str:
        """Deprecated.  Hermes API Server is synchronous — no polling needed."""
        logger.warning(
            "get_session_status called for {} — Hermes API Server is "
            "synchronous, status is always 'completed' on success.",
            session_id,
        )
        return "completed"

    async def get_session_result(
        self,
        session_id: str,
    ) -> dict[str, Any]:
        """Deprecated.  Hermes API Server is synchronous — use :meth:`run_rca`."""
        logger.warning(
            "get_session_result called for {} — Hermes API Server is "
            "synchronous; this method returns an empty result.",
            session_id,
        )
        return {}

    # ── Internal ──────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        """Build request headers, including optional Bearer API key auth."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers


# ═══════════════════════════════════════════════════════════════════════════════
# Format-agnostic SSE helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _normalize_approval_choice(decision: str) -> str:
    """Map a UI decision onto the ``choice`` vocabulary Hermes accepts.

    Hermes accepts ``once`` / ``session`` / ``always`` / ``deny`` (and aliases
    ``approve`` → ``once``).  The platform API speaks ``decision``, callers may
    send either vocabulary, so normalise here.  Unknown values pass through
    unchanged and Hermes answers 400 with a descriptive message.
    """
    value = (decision or "").strip().lower()
    aliases = {
        "approve": "once",
        "approved": "once",
        "allow": "once",
        "yes": "once",
        "ok": "once",
        "reject": "deny",
        "rejected": "deny",
        "denied": "deny",
        "no": "deny",
        "cancel": "deny",
    }
    return aliases.get(value, value)


def _parse_hermes_tool_progress(
    chunk: dict[str, Any],
    _tool_buf: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    """Convert a ``hermes.tool.progress`` SSE event into a :meth:`chat_stream` event.

    Hermes emits tool progress in this shape::

        {
            "tool": "browser_navigate",
            "emoji": "🌐",
            "label": "https://...",
            "toolCallId": "call_00_xxx",
            "status": "running" | "completed"
        }

    We normalise this into the same ``tool_call`` envelope the frontend
    already understands, adding ``emoji`` and ``label`` for richer display.
    """
    tool_name: str = chunk.get("tool", "unknown")
    tool_call_id: str = chunk.get("toolCallId", "")
    status: str = chunk.get("status", "running")
    emoji: str | None = chunk.get("emoji")  # None → frontend preserves previous emoji
    label: str = chunk.get("label", "")

    tool_call = {
        "id": tool_call_id,
        "function": {
            "name": tool_name,
            "arguments": label,  # repurpose: Hermes puts description here
        },
    }

    logger.info(
        "Hermes SSE → tool progress: tool={} status={} label={!r}",
        tool_name,
        status,
        label,
    )

    return {
        "type": "tool_call",
        "content": None,
        "tool_calls": [tool_call],
        "finish_reason": None,
        "usage": None,
        "error": None,
        # Hermes-specific fields forwarded to the frontend
        "hermes_emoji": emoji,
        "hermes_label": label,
        "hermes_status": status,
    }


def _extract_delta(chunk: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Pull ``delta`` and ``finish_reason`` out of an SSE chunk.

    Handles every variant we've seen from OpenAI-compatible servers:
    * ``choices[0].delta`` + ``choices[0].finish_reason`` (standard)
    * ``delta`` at chunk root
    * ``choices[0].message`` (some servers use ``message`` instead of ``delta``)
    """
    delta: dict[str, Any] = {}
    finish_reason: str | None = None

    choices: list[dict[str, Any]] = chunk.get("choices", [])
    if choices:
        choice = choices[0]
        delta = choice.get("delta", {})
        if not delta:
            # Some servers put the full message in ``choices[0].message``
            delta = choice.get("message", {})
        finish_reason = choice.get("finish_reason")

    # Top-level delta (bypassing choices)
    if not delta and "delta" in chunk:
        delta = chunk["delta"]

    # Top-level finish_reason
    if finish_reason is None and "finish_reason" in chunk:
        finish_reason = chunk["finish_reason"]

    return delta, finish_reason


def _find_tool_calls(delta: dict[str, Any]) -> list[dict[str, Any]]:
    """Locate tool-call descriptors anywhere in the delta.

    Checks (in order):
    1. ``delta.tool_calls`` — standard OpenAI streaming
    2. ``delta.function_call`` — legacy OpenAI (normalised to tool_calls shape)
    3. ``delta.tool_use`` — Anthropic-style (some proxies)
    """
    # Standard
    tool_calls: Any = delta.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        return tool_calls  # type: ignore[return-value]

    # Legacy function_call
    func_call: Any = delta.get("function_call")
    if isinstance(func_call, dict) and func_call:
        return [{
            "index": 0,
            "id": func_call.get("name", "call_0"),
            "function": {
                "name": func_call.get("name", ""),
                "arguments": func_call.get("arguments", ""),
            },
        }]

    # Anthropic-style tool_use (some proxies normalise to this)
    tool_use: Any = delta.get("tool_use")
    if isinstance(tool_use, dict) and tool_use:
        return [{
            "index": 0,
            "id": tool_use.get("id", "tool_0"),
            "function": {
                "name": tool_use.get("name", ""),
                "arguments": json.dumps(tool_use.get("input", {})),
            },
        }]

    return []


def _find_reasoning(delta: dict[str, Any]) -> str | None:
    """Extract a reasoning/thinking delta, if the server streams one.

    Hermes emits ``delta.reasoning_content`` (OpenAI-compatible reasoning
    field).  A few providers use ``reasoning``, ``thinking`` or a content-block
    list instead, so all variants are accepted here.
    """
    for key in ("reasoning_content", "reasoning", "thinking"):
        value: Any = delta.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, list):
            parts = [
                str(block.get("text", ""))
                for block in value
                if isinstance(block, dict) and block.get("text")
            ]
            if parts:
                return "".join(parts)
    return None


def _find_content(delta: dict[str, Any]) -> str | None:
    """Extract text content from a delta dict.

    Handles ``content`` as str or list (some APIs return content as a list of
    content-block dicts).
    """
    content: Any = delta.get("content")
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Content-block list (e.g. [{"type":"text","text":"hello"}])
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts) if parts else None
    return str(content)
