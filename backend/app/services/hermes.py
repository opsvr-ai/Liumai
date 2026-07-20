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
import uuid
from typing import Any, AsyncGenerator

import httpx
from loguru import logger

from app.config import settings

# ── Runtime config (reloadable from DB, starts from env vars) ─────────────────
_hermes_url: str = settings.HERMES_GATEWAY_URL
_hermes_api_key: str | None = settings.HERMES_API_KEY


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
# Client
# ═══════════════════════════════════════════════════════════════════════════════


class HermesClient:
    """Async HTTP client for the Hermes OpenAI-compatible API server.

    Uses a shared ``httpx.AsyncClient`` with 600s timeout (RCA analysis
    can take minutes).  Instantiate once per application scope.
    """

    def __init__(self) -> None:
        # base_url should end with ``/v1``, e.g.
        # ``http://<host>:8642/v1``
        self.base_url = _hermes_url.rstrip("/")
        self.api_key = _hermes_api_key
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(600.0, connect=30.0),
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
                Included in ``session_id`` for traceability.
            params: RCA parameters.  Expected keys include
                ``service_name``, ``time_window_start``,
                ``time_window_end``, plus any additional context.

        Returns:
            A dict with the standard envelope::

                {
                    "session_id": "<uuid>",
                    "status": "completed",
                    "result": {
                        "output": "<JSON string from Hermes>"
                    }
                }

        Raises:
            RuntimeError: If the API call fails or returns an unexpected
                status.
        """
        params = params or {}
        session_id = f"{skill_name}--{uuid.uuid4().hex}"

        # Build a user message from the params dict
        user_message_lines = [f"技能名称: {skill_name}"]
        for key, value in params.items():
            user_message_lines.append(f"{key}: {value}")
        user_message = "\n".join(user_message_lines)

        url = f"{self.base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": "hermes-agent",
            "messages": [
                {"role": "system", "content": RCA_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.1,
            "max_tokens": 4096,
        }

        logger.info(
            "Hermes RCA request: skill={!r} session_id={} params_keys={}",
            skill_name,
            session_id,
            list(params.keys()),
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

        data = resp.json()

        # Extract the assistant's reply from OpenAI-compatible response
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as exc:
            raise RuntimeError(
                f"Unexpected Hermes response format: missing choices/content: {data}"
            ) from exc

        logger.info(
            "Hermes RCA completed: session_id={} input_tokens={} output_tokens={}",
            session_id,
            data.get("usage", {}).get("prompt_tokens", "?"),
            data.get("usage", {}).get("completion_tokens", "?"),
        )

        return {
            "session_id": session_id,
            "status": "completed",
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
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream a chat completion via Hermes API Server with SSE.

        Sends ``POST /v1/chat/completions`` with ``stream: true`` and yields
        parsed delta events one at a time.  Each yielded dict has the shape::

            {
                "type": "delta" | "tool_call" | "done" | "error",
                "content": str | None,       # text chunk (type=delta)
                "tool_call": dict | None,    # tool-call delta (type=tool_call)
                "finish_reason": str | None, # stop / tool_calls / length (type=done)
                "usage": dict | None,        # token counts (type=done, may be absent)
                "error": str | None,         # error message (type=error)
            }

        Args:
            messages: List of message dicts with ``role`` and ``content`` keys
                (OpenAI-compatible format).
            model: Model identifier (default ``"hermes-agent"``).
            temperature: Sampling temperature (0-2, default 0.7).
            max_tokens: Maximum tokens to generate (default 4096).

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
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(600.0, connect=30.0),
            headers=self._headers(),
        ) as stream_client:
            try:
                async with stream_client.stream("POST", url, json=payload) as resp:
                    resp.raise_for_status()

                    tool_call_buf: dict[int, dict[str, Any]] = {}
                    current_sse_event: str | None = None

                    async for line in resp.aiter_lines():
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
                            logger.info(
                                "Hermes SSE → done: finish_reason={}", finish_reason
                            )
                            yield {
                                "type": "done",
                                "content": None,
                                "tool_call": None,
                                "finish_reason": finish_reason,
                                "usage": chunk.get("usage"),
                                "error": None,
                            }

                        # ── Catch-all for unknown shapes ────────────────────
                        if (
                            not raw_tool_calls
                            and not _find_content(delta)
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

    # ── Skills & toolsets discovery ────────────────────────────────────

    async def get_skills(self) -> list[dict[str, Any]]:
        """List skills registered with the Hermes agent.

        Returns metadata for every skill the agent can invoke — name,
        description, and category.  Requires ``API_SERVER_KEY`` on the
        Hermes side if authentication is enabled.
        """
        url = f"{self.base_url}/skills"
        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            return resp.json()  # list[Skill]
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
