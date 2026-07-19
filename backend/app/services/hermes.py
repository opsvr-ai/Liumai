"""Hermes built-in API Server client (OpenAI-compatible).

Hermes runs an OpenAI-compatible API server on port **8642** (NOT the
legacy Gateway REST API).  We POST ``/v1/chat/completions`` with a
system prompt that instructs Hermes to perform Root Cause Analysis (RCA)
fault investigation.  The response is synchronous — no polling required.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
from loguru import logger

from app.config import settings

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
        self.base_url = settings.HERMES_GATEWAY_URL.rstrip("/")
        self.api_key = settings.HERMES_API_KEY
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
    ) -> str:
        """Legacy compatibility stub.

        ``trigger_skill`` is kept for backward compatibility.  New code
        should prefer :meth:`run_rca` which is synchronous and returns
        results directly.

        Delegates to :meth:`run_rca` and returns the generated session ID.
        """
        result = await self.run_rca(skill_name, params or {})
        return result["session_id"]

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
            "model": "hermes-rca",
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
