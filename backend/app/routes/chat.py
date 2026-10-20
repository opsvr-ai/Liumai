"""Intelligent chat endpoints with SSE streaming via Hermes.

Provides a conversational interface that relays messages to the Hermes
agent and streams the response back as Server-Sent Events (SSE).  The
stream carries text deltas, tool-call invocations, and completion signals
that the frontend chat panel renders in real time.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import ChatMessage, ChatSession, User
from app.models.database import get_db_session
from app.services.hermes import HermesClient, HermesRunError


# ── LLM config helper ──────────────────────────────────────────────────────────


async def _load_llm_config(db: AsyncSession) -> dict[str, str]:
    """Load LLM configuration from database (fall back to env defaults)."""
    from app.models import SystemConfig
    rows = await db.execute(
        select(SystemConfig).where(
            SystemConfig.key.in_(["llm_base_url", "llm_api_key", "llm_model"])
        )
    )
    return {r.key: r.value for r in rows.scalars()}


def _llm_sse_event(event_type: str, data: str) -> str:
    """Like _sse_event but imported at module scope."""
    return f"event: {event_type}\ndata: {data}\n\n"

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


#: 单条消息 content parts 的载荷上限（base64 图片 + 文本）。
MAX_CHAT_CONTENT_BYTES = 6 * 1024 * 1024

#: 允许内联的图片 MIME（与 /convert-file 的图片白名单一致）。
_ALLOWED_IMAGE_MIMES = ("png", "jpeg", "jpg", "webp", "gif")


def _part_payload_size(part: dict[str, Any]) -> int:
    """UTF-8 byte size of the user-visible payload carried by one part."""
    if part.get("type") == "text":
        return len(str(part.get("text") or "").encode("utf-8"))
    image_url = part.get("image_url")
    url = image_url.get("url") if isinstance(image_url, dict) else image_url
    return len(str(url or "").encode("utf-8"))


class ChatMessageIn(BaseModel):
    """A single message in the conversation history.

    ``content`` is either a plain string (text-only turn) or an OpenAI-style
    content-parts array.  Only ``text`` and ``image_url`` parts are accepted —
    Hermes rejects ``file`` / ``input_file`` parts upstream — and the whole
    message must stay within :data:`MAX_CHAT_CONTENT_BYTES`.
    """

    role: str = Field(..., pattern="^(system|user|assistant|tool)$")
    content: str | list[dict[str, Any]]

    @field_validator("content")
    @classmethod
    def _validate_content_parts(
        cls, value: str | list[dict[str, Any]]
    ) -> str | list[dict[str, Any]]:
        """Loose shape check on content parts + hard 6MB payload cap."""
        if isinstance(value, str):
            return value

        total = 0
        for part in value:
            if not isinstance(part, dict):
                raise ValueError("消息内容格式无效")
            part_type = part.get("type")
            if part_type == "text":
                if not isinstance(part.get("text"), str):
                    raise ValueError("文本片段格式无效")
            elif part_type == "image_url":
                image_url = part.get("image_url")
                url = image_url.get("url") if isinstance(image_url, dict) else image_url
                if not isinstance(url, str) or not url:
                    raise ValueError("图片片段格式无效")
                lowered = url.lower()
                if lowered.startswith("data:"):
                    if not any(
                        lowered.startswith(f"data:image/{mime};")
                        for mime in _ALLOWED_IMAGE_MIMES
                    ):
                        raise ValueError("仅支持 png/jpeg/webp/gif 图片")
                elif not lowered.startswith(("http://", "https://")):
                    raise ValueError("图片链接格式无效")
            else:
                raise ValueError("不支持的消息片段类型（仅支持 text / image_url）")
            total += _part_payload_size(part)
            if total > MAX_CHAT_CONTENT_BYTES:
                raise ValueError("消息内容超过 6MB 上限")

        return value


class ChatRequest(BaseModel):
    """Payload for the streaming chat endpoint."""

    messages: list[ChatMessageIn] = Field(
        ...,
        min_length=1,
        description="Conversation history in OpenAI-compatible format",
    )
    mode: str | None = Field(
        default=None,
        description="Chat mode slug (rca, knowledge, etc.)",
    )
    model: str | None = Field(
        default=None,
        description=(
            "Model to use. Omit to let the server pick: Hermes agent for agent "
            "modes, the configured LLM for direct-LLM modes. Sending the "
            "'hermes-agent' literal to an external LLM endpoint breaks it."
        ),
    )
    temperature: float = Field(
        default=0.7,
        ge=0.0,
        le=2.0,
        description="Sampling temperature",
    )
    # RCA mode extras
    time_window_start: str | None = None
    time_window_end: str | None = None
    hermes_session_id: str | None = Field(
        default=None,
        description=(
            "Hermes agent session to continue. Sent upstream as "
            "X-Hermes-Session-Id so the agent keeps its server-side context."
        ),
    )
    chat_session_id: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Platform chat session (ChatSession.id) this turn belongs to.  It "
            "scopes agent artifacts to hermes-files/<chat_session_id>/ and is "
            "echoed back as X-Artifact-Session-Id.  Omit on the very first turn: "
            "a short random directory is used until the session is saved."
        ),
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

# Lazy-initialised singleton — automatically recreated when the admin
# changes the Hermes URL or API key through the settings UI.
_hermes: HermesClient | None = None


def _get_hermes() -> HermesClient:
    """Return the current HermesClient, recreating if config changed."""
    global _hermes
    from app.services.hermes import _hermes_url, _hermes_api_key
    current_url = _hermes_url.rstrip("/")
    current_key = _hermes_api_key
    if _hermes is not None and (
        _hermes.base_url != current_url or _hermes.api_key != current_key
    ):
        # Close old client before replacing (prevents connection leak)
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_hermes.close())
        except RuntimeError:
            pass
        _hermes = None  # force recreation with new config
    if _hermes is None:
        _hermes = HermesClient()
    return _hermes


def _sse_event(event_type: str, data: str) -> str:
    """Format a single SSE event.

    Args:
        event_type: The SSE ``event:`` field (e.g. ``"delta"``, ``"done"``).
        data: JSON-encoded payload for the ``data:`` field.

    Returns:
        A complete SSE event string including the trailing blank line.
    """
    return f"event: {event_type}\ndata: {data}\n\n"


# ── Agent artifact (B1) ───────────────────────────────────────────────────────
#
# Artifacts live under one directory per platform chat session:
#   <HERMES_FILES_DIR>/<chat_session_id>/<filename>
# The download endpoint only serves files from a session directory owned by the
# caller, so guesses of another user's session id (or the old flat layout) 404.

#: Container-side shared directory (bind-mounted from the host).
HERMES_FILES_DIR = os.getenv("HERMES_FILES_DIR", "/data/hermes-files")
#: Host-side path of the same directory, only used inside the prompt.
HERMES_FILES_HOST_PATH = os.getenv(
    "HERMES_FILES_HOST_PATH", r"E:\dev\Liumai\hermes-files"
)
#: Single downloadable artifact size cap.
MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
#: Strict basename whitelist — no separators, no traversal, no spaces.
_ARTIFACT_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,128}")
#: Download-path session id: digits only (a real ``ChatSession.id``).
_ARTIFACT_SESSION_ID_RE = re.compile(r"[0-9]{1,19}")


def _artifact_root() -> Path:
    """Resolved shared artifact directory (host bind mount inside the container)."""
    return Path(os.getenv("HERMES_FILES_DIR", HERMES_FILES_DIR)).resolve()


def _random_artifact_token() -> str:
    """Short, non-guessable directory token for a turn without a saved session."""
    return f"art_{secrets.token_hex(4)}"


def _artifact_prompt(token: str) -> str:
    """Artifact convention for one turn, scoped to ``token`` (the session id)."""
    container_dir = f"{HERMES_FILES_DIR.rstrip('/')}/{token}"
    host_dir = HERMES_FILES_HOST_PATH.rstrip("/\\") + "\\" + token
    return (
        f"本会话 id 为 {token}。需要产出文件时，写入 {container_dir}"
        f"（宿主路径 {host_dir}），"
        "并在最终回复中用 [[artifact: 文件名]] 标记。"
        "文件名只能包含字母、数字、点、下划线、连字符，不得包含目录或路径。"
    )


async def _resolve_artifact_scope(
    db: AsyncSession,
    user: User,
    chat_session_id: int | None,
) -> tuple[str, str]:
    """Return ``(directory_token, prompt)`` for this turn.

    A valid platform chat session owned by the caller keys the directory.  When
    the turn has no saved session yet (or the id is not the caller's), a short
    random token is used instead so artifacts never land in the shared root.
    The token is echoed back in the response (header / JSON field).
    """
    token: str | None = None
    if chat_session_id:
        row = await db.get(ChatSession, chat_session_id)
        if row is not None and row.user_id == user.id:
            token = str(row.id)
        else:
            logger.warning(
                "Artifact scope rejected: chat_session_id={} user_id={}",
                chat_session_id,
                user.id,
            )

    root = _artifact_root()
    if token is None:
        token = _random_artifact_token()

    directory = root / token
    try:
        if directory.is_symlink():
            # Never write through a symlink that could escape the shared dir.
            logger.warning("Artifact directory is a symlink, using temp scope: {}", directory)
            token = _random_artifact_token()
            directory = root / token
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.warning("Cannot create artifact directory: {}", directory, exc_info=True)

    logger.info(
        "Artifact scope: chat_session_id={} token={} dir={}",
        chat_session_id,
        token,
        directory,
    )
    return token, _artifact_prompt(token)


def _append_artifact_prompt(messages: list[dict[str, Any]], prompt: str) -> None:
    """Append the artifact convention to the system message (or insert one).

    Existing system prompts are never overwritten — the convention is appended
    at the end so a mode's own instructions stay authoritative and Hermes still
    sees them verbatim.
    """
    for message in messages:
        if message.get("role") != "system":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content.append({"type": "text", "text": f"\n\n{prompt}"})
        elif content:
            message["content"] = f"{content}\n\n{prompt}"
        else:
            message["content"] = prompt
        return
    messages.insert(0, {"role": "system", "content": prompt})


# ═══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════════


@router.post(
    "/stream",
    summary="Stream a chat completion via SSE",
    description=(
        "Accepts a conversation history and streams the Hermes agent's "
        "response as Server-Sent Events.  Each event carries a typed payload "
        "suitable for incremental rendering in the chat UI."
    ),
)
async def chat_stream_endpoint(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Stream a chat completion from Hermes via SSE.

    The response is a ``text/event-stream`` with the following event types:

    * ``delta`` — a text chunk from the assistant
    * ``tool_call`` — an assembled tool-call snapshot (incremental)
    * ``reasoning`` — chain-of-thought chunk (shown collapsed in the UI)
    * ``session`` — Hermes agent session id (for multi-turn continuity)
    * ``ping`` — keepalive, emitted during long tool runs; carries no data
    * ``status`` — forwarded ``hermes.status`` event, if Hermes sends one
    * ``done`` — stream finished, may include ``usage`` info
    * ``error`` — an unrecoverable error; the stream is terminated
    """
    hermes = _get_hermes()

    # ── Mode-aware system prompt injection ───────────────────────────────
    # ``content`` may be a string or content-parts array (image inline); it is
    # forwarded to Hermes verbatim, so parts must not be stringified here.
    messages: list[dict[str, Any]] = [
        {
            "role": m.role,
            "content": (
                m.content
                if isinstance(m.content, str)
                else [dict(part) for part in m.content]
            ),
        }
        for m in body.messages
    ]

    mode: Any = None  # ChatMode or UserChatMode
    mode_config: dict[str, Any] = {}

    if body.mode:
        if body.mode.startswith("user:"):
            # User custom mode
            from app.models import UserChatMode
            mode_id = int(body.mode.split(":", 1)[1])
            row = await db.get(UserChatMode, mode_id)
            if row and row.user_id == user.id and row.enabled:
                mode = row
                mode_config = {"provider": row.provider, "icon": row.icon, "user_mode": True}
        else:
            # System mode — strip "system:" prefix if present
            slug = body.mode.replace("system:", "", 1)
            from app.models import ChatMode as ChatModeModel
            row = await db.execute(
                select(ChatModeModel).where(
                    ChatModeModel.slug == slug,
                    ChatModeModel.enabled == True,  # noqa: E712
                )
            )
            mode = row.scalar_one_or_none()
            if mode:
                mode_config = mode.config or {}
        if mode and mode.system_prompt:
            # Prepend system prompt only if not already present
            if not messages or messages[0].get("role") != "system":
                messages.insert(0, {"role": "system", "content": mode.system_prompt})
            # RCA mode: inject time window into user message.
            # ``body.mode`` arrives as ``system:rca`` (older code compared it to
            # a bare ``rca``, so the window was never injected).
            mode_slug = body.mode.replace("system:", "", 1)
            if mode_slug == "rca" and (body.time_window_start or body.time_window_end):
                tw_info = f"\n[时间窗口: {body.time_window_start or '?'} → {body.time_window_end or '?'}]"
                last_user = None
                for m in reversed(messages):
                    if m["role"] == "user":
                        last_user = m
                        break
                if last_user:
                    content = last_user.get("content")
                    if isinstance(content, list):
                        content.append({"type": "text", "text": tw_info})
                    else:
                        last_user["content"] = f"{content or ''}{tw_info}"
            # RCA mode: lower temperature for deterministic output
            if mode_slug == "rca":
                body.temperature = 0.3

    # ── LLM direct path (mode with provider=llm) ─────────────────────────
    if mode and mode_config.get("provider") == "llm":
        return await _llm_direct_stream(messages, body, mode, db)

    # ── Agent path: teach Hermes where to write downloadable artifacts ───
    # Runs on the Hermes path only; direct-LLM modes have no file tools.
    # The directory is per platform chat session: hermes-files/<session_id>/.
    artifact_token, artifact_prompt = await _resolve_artifact_scope(
        db, user, body.chat_session_id
    )
    _append_artifact_prompt(messages, artifact_prompt)
    artifact_headers = {"X-Artifact-Session-Id": artifact_token}

    # Guard against empty URL (not yet configured by admin)
    if not hermes.base_url:
        async def _not_configured():
            yield _sse_event(
                "error",
                json.dumps(
                    {"type": "error", "error": "Hermes 未配置 — 请在系统设置中配置 Hermes 连接"},
                    ensure_ascii=False,
                ),
            )
        return StreamingResponse(
            _not_configured(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                **artifact_headers,
            },
        )

    logger.info(
        "Chat stream request: msg_count={} model={!r}",
        len(messages),
        body.model,
    )

    async def event_generator():
        """Iterate Hermes stream and yield SSE-formatted events."""
        try:
            async for event in hermes.chat_stream(
                messages,
                model=body.model or "hermes-agent",
                temperature=body.temperature,
                session_id=body.hermes_session_id,
            ):
                event_type: str = event.get("type", "unknown")

                # ── 心跳：不发 data 行 ──────────────────────────────────
                # Hermes 的 `: keepalive` 注释被 hermes.chat_stream 转成 ping
                # 事件。这里必须继续输出 SSE 帧（哪怕没有 data），否则长工具
                # 执行期间连接会被 nginx / 网关按空闲超时切断。不带 data 的
                # `event:`（含注释）不会触发浏览器 EventSource 的 message，
                # 现有前端解析器只会跳过它，不影响既有事件兼容性。
                if event_type == "ping":
                    yield "event: ping\n\n"
                    continue

                payload: dict[str, Any] = {"type": event_type}

                if event_type == "delta":
                    payload["content"] = event.get("content", "")
                elif event_type == "reasoning":
                    payload["content"] = event.get("content", "")
                elif event_type == "session":
                    payload["session_id"] = event.get("session_id")
                elif event_type == "status":
                    payload["status"] = event.get("status")
                elif event_type == "tool_call":
                    raw_calls = event.get("tool_calls", [])
                    for tc in raw_calls:
                        for key in ("hermes_emoji", "hermes_label", "hermes_status"):
                            if key in event and key not in tc:
                                tc[key] = event[key]
                    payload["tool_calls"] = raw_calls
                elif event_type == "done":
                    payload["finish_reason"] = event.get("finish_reason")
                    usage = event.get("usage")
                    if usage:
                        payload["usage"] = usage
                    # Abnormal finishes (context overflow, provider error, …)
                    # carry diagnostics on the finish chunk.  Forward them so the
                    # UI can say "任务中断" instead of rendering a clean stop.
                    finish_error = event.get("error")
                    if finish_error:
                        payload["error"] = finish_error
                    hermes_extra = event.get("hermes")
                    if hermes_extra:
                        payload["hermes"] = hermes_extra
                elif event_type == "error":
                    payload["error"] = event.get("error", "未知错误")

                yield _sse_event(event_type, json.dumps(payload, ensure_ascii=False))
        except Exception as exc:
            logger.exception("Chat stream generator error")
            yield _sse_event(
                "error",
                json.dumps(
                    {"type": "error", "error": f"流中断: {exc}"},
                    ensure_ascii=False,
                ),
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering
            **artifact_headers,
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Runs API proxy (structured agent runs: real stop / steer / approval / resume)
# ═══════════════════════════════════════════════════════════════════════════════


class ChatRunRequest(BaseModel):
    """Payload for ``POST /api/chat/runs`` (agent-mode turn)."""

    input: str = Field(..., min_length=1, description="User message for this turn")
    session_id: str | None = Field(
        default=None,
        description=(
            "Hermes agent session to continue.  When omitted Hermes keys the run "
            "by run_id, so callers wanting multi-turn continuity must pass it back."
        ),
    )
    chat_session_id: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Platform chat session (ChatSession.id) this run belongs to.  It "
            "scopes agent artifacts to hermes-files/<chat_session_id>/ and is "
            "returned as ``artifact_session_id``.  Omit on the very first turn: "
            "a short random directory is used until the session is saved."
        ),
    )
    instructions: str | None = Field(
        default=None,
        description="Ephemeral system prompt for this turn (not persisted)",
    )
    model: str | None = Field(default=None, description="Optional model override")
    conversation_history: list[ChatMessageIn] | None = Field(
        default=None,
        description=(
            "Prior turns to replay when there is no Hermes session yet (e.g. "
            "after switching modes).  The newest user message travels as "
            "``input``, not here."
        ),
    )
    mode: str | None = Field(
        default=None,
        description=(
            "Chat mode slug (system:default, user:3, …).  Its system prompt is "
            "used as ``instructions`` when the caller sends none.  Direct-LLM "
            "modes (provider=llm) are rejected — they belong on /chat/stream."
        ),
    )


class ChatRunSteerRequest(BaseModel):
    """Payload for ``POST /api/chat/runs/{run_id}/steer``."""

    input: str = Field(..., min_length=1, description="Supplementary instruction")


class ChatRunApprovalRequest(BaseModel):
    """Payload for ``POST /api/chat/runs/{run_id}/approval``."""

    approval_id: str | None = Field(
        default=None,
        description=(
            "Hermes approval request id (the ``request_id`` reported by an "
            "``approval.request`` event).  Omit to resolve the oldest pending one."
        ),
    )
    decision: str = Field(
        ...,
        min_length=1,
        description="once / session / always / deny (approve is aliased to once)",
    )


def _raise_for_run_error(exc: HermesRunError) -> None:
    """Translate a :class:`HermesRunError` into an ``HTTPException``.

    Keeps the semantics the UI needs: 404 → run expired/unknown, 409 → the run
    is not in a state that accepts the control, 400 → bad input, everything else
    → 502 (upstream failure) instead of a bare 500.
    """
    code = exc.status_code
    if code == 404:
        raise HTTPException(status_code=404, detail="运行不存在或已过期")
    if code == 409:
        raise HTTPException(status_code=409, detail=exc.detail or "当前运行状态不允许该操作")
    if code == 400:
        raise HTTPException(status_code=400, detail=exc.detail or "运行请求参数无效")
    if code == 503:
        raise HTTPException(status_code=503, detail=exc.detail or "无法连接 Hermes 服务")
    raise HTTPException(status_code=502, detail=f"Hermes 运行接口错误: {exc.detail}")


async def _resolve_run_mode(
    db: AsyncSession,
    mode_slug: str | None,
    user: User,
) -> tuple[Any, dict[str, Any]]:
    """Resolve a chat-mode slug to ``(mode_row, config)`` for the Runs path.

    Read-only mirror of the lookup in :func:`chat_stream_endpoint`; used to
    detect direct-LLM modes and to reuse the mode's system prompt as the run's
    ephemeral ``instructions``.
    """
    if not mode_slug:
        return None, {}

    if mode_slug.startswith("user:"):
        from app.models import UserChatMode

        try:
            mode_id = int(mode_slug.split(":", 1)[1])
        except (IndexError, ValueError):
            return None, {}
        row = await db.get(UserChatMode, mode_id)
        if row and row.user_id == user.id and row.enabled:
            return row, {"provider": row.provider, "icon": row.icon, "user_mode": True}
        return None, {}

    from app.models import ChatMode as ChatModeModel

    slug = mode_slug.replace("system:", "", 1)
    result = await db.execute(
        select(ChatModeModel).where(
            ChatModeModel.slug == slug,
            ChatModeModel.enabled == True,  # noqa: E712
        )
    )
    row = result.scalar_one_or_none()
    if row:
        return row, dict(row.config or {})
    return None, {}


@router.post(
    "/runs",
    summary="Start a structured Hermes agent run",
    description=(
        "Proxies ``POST /v1/runs`` on Hermes: returns a ``run_id`` immediately, "
        "then stream progress from ``/api/chat/runs/{run_id}/events``.  Unlike "
        "``/chat/stream`` the run keeps executing server-side, so it can be "
        "stopped, steered and approved, and reattached after a disconnect."
    ),
)
async def create_chat_run(
    body: ChatRunRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Create a Hermes run for an agent-mode turn."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置 — 请在系统设置中配置 Hermes 连接")

    mode, mode_config = await _resolve_run_mode(db, body.mode, user)
    if mode is not None and mode_config.get("provider") == "llm":
        # Direct-LLM modes have no agent loop: keep them on /chat/stream.
        raise HTTPException(
            status_code=400,
            detail="该模式使用直连模型，请使用 /api/chat/stream",
        )

    instructions = body.instructions
    if not instructions and mode is not None:
        system_prompt = getattr(mode, "system_prompt", None)
        if system_prompt:
            instructions = system_prompt

    # Agent runs always go to Hermes: append the artifact convention (scoped to
    # this platform chat session) instead of overwriting the mode's instructions.
    artifact_token, artifact_prompt = await _resolve_artifact_scope(
        db, user, body.chat_session_id
    )
    instructions = (
        f"{instructions}\n\n{artifact_prompt}"
        if instructions
        else artifact_prompt
    )

    try:
        result = await hermes.create_run(
            input=body.input,
            session_id=body.session_id,
            instructions=instructions,
            model=body.model,
            conversation_history=(
                [{"role": m.role, "content": m.content} for m in body.conversation_history]
                if body.conversation_history
                else None
            ),
        )
    except HermesRunError as exc:
        _raise_for_run_error(exc)

    run_id = str(result.get("run_id") or "")
    if not run_id:
        raise HTTPException(status_code=502, detail="Hermes 未返回 run_id")

    # Hermes keys a session-less run by its run_id (session_id = run_id), so that
    # value is the continuity token for the next turn.
    session_id = body.session_id or result.get("session_id") or run_id

    logger.info(
        "Chat run created: run_id={} session_id={} mode={!r} status={}",
        run_id,
        session_id,
        body.mode,
        result.get("status"),
    )
    return {
        "run_id": run_id,
        "status": result.get("status") or "queued",
        "session_id": session_id,
        "replayed": bool(result.get("replayed")),
        # Directory token the agent was told to write into (also the platform
        # chat session id when one was supplied and owned by the caller).
        "artifact_session_id": artifact_token,
    }


@router.get(
    "/runs/{run_id}",
    summary="Poll a Hermes run's status",
    description=(
        "Proxies ``GET /v1/runs/{run_id}`` — the reconnect/refresh path.  The "
        "payload carries ``status``, ``session_id``, ``output``, ``usage`` and "
        "any ``pending_controls``."
    ),
)
async def get_chat_run(
    run_id: str,
    user: User = Depends(get_current_user),
) -> dict:
    """Return the pollable status of a run."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置")
    try:
        return await hermes.get_run(run_id)
    except HermesRunError as exc:
        _raise_for_run_error(exc)
        raise  # unreachable — keeps type-checkers happy


@router.get(
    "/runs/{run_id}/events",
    summary="Stream a Hermes run's SSE events (raw proxy)",
    description=(
        "Proxies ``GET /v1/runs/{run_id}/events``.  Frames are forwarded "
        "byte-for-byte (including ``:`` keepalive comments).  The client's "
        "``Last-Event-ID`` header is passed through so Hermes replays missed "
        "frames after a reconnect."
    ),
)
async def stream_chat_run_events(
    run_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Stream run events to the browser as ``text/event-stream``."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置")

    last_event_id = request.headers.get("last-event-id") or request.headers.get(
        "Last-Event-ID"
    )

    # Fail fast (before the SSE headers go out) when the run is unknown/expired,
    # so the browser gets a real 404 instead of an empty stream.
    try:
        await hermes.get_run(run_id)
    except HermesRunError as exc:
        if exc.status_code == 404:
            _raise_for_run_error(exc)
        logger.warning(
            "Run event pre-check failed for {} (HTTP {}): {} — streaming anyway",
            run_id,
            exc.status_code,
            exc.detail,
        )

    async def event_proxy():
        """Forward upstream chunks; close the upstream stream on disconnect."""
        stream = hermes.stream_run_events(run_id, last_event_id=last_event_id)
        try:
            async for chunk in stream:
                if await request.is_disconnected():
                    logger.info("Run event client disconnected: run_id={}", run_id)
                    break
                yield chunk
        except HermesRunError as exc:
            logger.warning(
                "Run event upstream error: run_id={} HTTP {}: {}",
                run_id,
                exc.status_code,
                exc.detail,
            )
            payload = json.dumps(
                {"event": "error", "run_id": run_id, "error": exc.detail},
                ensure_ascii=False,
            )
            yield f"data: {payload}\n\n".encode()
        except Exception as exc:
            logger.exception("Run event proxy error: run_id={}", run_id)
            payload = json.dumps(
                {"event": "error", "run_id": run_id, "error": f"事件流中断: {exc}"},
                ensure_ascii=False,
            )
            yield f"data: {payload}\n\n".encode()
        finally:
            # Explicit close: ``async for`` does not close an async generator on
            # break, and the upstream HTTP connection must be released.
            await stream.aclose()

    return StreamingResponse(
        event_proxy(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


@router.post(
    "/runs/{run_id}/stop",
    summary="Stop a Hermes run",
    description="Proxies ``POST /v1/runs/{run_id}/stop`` — a cooperative interrupt.",
)
async def stop_chat_run(
    run_id: str,
    user: User = Depends(get_current_user),
) -> dict:
    """Ask Hermes to interrupt the run."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置")
    try:
        return await hermes.stop_run(run_id)
    except HermesRunError as exc:
        _raise_for_run_error(exc)
        raise  # unreachable


@router.post(
    "/runs/{run_id}/steer",
    summary="Steer a running Hermes run",
    description="Proxies ``POST /v1/runs/{run_id}/steer`` with supplementary guidance.",
)
async def steer_chat_run(
    run_id: str,
    body: ChatRunSteerRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Inject supplementary instructions into a running agent."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置")
    try:
        return await hermes.steer_run(run_id, body.input)
    except HermesRunError as exc:
        _raise_for_run_error(exc)
        raise  # unreachable


@router.post(
    "/runs/{run_id}/approval",
    summary="Answer a pending tool approval",
    description=(
        "Proxies ``POST /v1/runs/{run_id}/approval``.  Platform callers send "
        "``{approval_id, decision}``; Hermes expects ``{request_id, choice}``, "
        "so both are translated (approve → once)."
    ),
)
async def approve_chat_run(
    run_id: str,
    body: ChatRunApprovalRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Resolve a pending approval for the run."""
    hermes = _get_hermes()
    if not hermes.base_url:
        raise HTTPException(status_code=503, detail="Hermes 未配置")
    try:
        return await hermes.respond_approval(
            run_id, body.decision, approval_id=body.approval_id
        )
    except HermesRunError as exc:
        _raise_for_run_error(exc)
        raise  # unreachable


# ═══════════════════════════════════════════════════════════════════════════════
# LLM direct streaming (for modes with provider=llm)
# ═══════════════════════════════════════════════════════════════════════════════


async def _llm_direct_stream(
    messages: list[dict[str, Any]],
    body: ChatRequest,
    mode: Any,
    db: AsyncSession,
) -> StreamingResponse:
    """Stream directly from the configured LLM (not Hermes).

    Used when a chat mode has ``config.provider == "llm"``.
    """
    import httpx

    cfg = await _load_llm_config(db)
    base_url = cfg.get("llm_base_url", "").strip()
    api_key = cfg.get("llm_api_key", "").strip()
    config_model = cfg.get("llm_model", "").strip()

    if not base_url:
        async def _no_llm():
            yield _sse_event(
                "error",
                json.dumps(
                    {"type": "error", "error": "智能引擎未配置 — 请在系统设置中配置通用模型"},
                    ensure_ascii=False,
                ),
            )
        return StreamingResponse(_no_llm(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    model = body.model or config_model or "gpt-4o"
    url = base_url.rstrip("/")
    # Append /v1/chat/completions if not already in the URL
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions" if "/v1" in url else f"{url}/v1/chat/completions"

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": body.temperature,
        "stream": True,
    }

    logger.info("LLM direct stream: model={} url={} msg_count={}", model, url, len(messages))

    async def _llm_event_generator():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        body_text = await resp.aread()
                        logger.error("LLM HTTP {}: {}", resp.status_code, body_text[:500])
                        yield _sse_event(
                            "error",
                            json.dumps({"type": "error", "error": f"模型服务错误 (HTTP {resp.status_code})"}, ensure_ascii=False),
                        )
                        yield _sse_event("done", json.dumps({"type": "done", "finish_reason": "error"}, ensure_ascii=False))
                        return

                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        choices = chunk.get("choices", [])
                        if not choices:
                            continue

                        choice = choices[0]
                        delta = choice.get("delta", {})
                        finish = choice.get("finish_reason")

                        content = delta.get("content", "")
                        if isinstance(content, str) and content:
                            yield _sse_event(
                                "delta",
                                json.dumps({"type": "delta", "content": content}, ensure_ascii=False),
                            )

                        if finish is not None:
                            usage = chunk.get("usage")
                            done_payload: dict[str, Any] = {"type": "done", "finish_reason": finish}
                            if usage:
                                done_payload["usage"] = usage
                            yield _sse_event("done", json.dumps(done_payload, ensure_ascii=False))

        except httpx.ConnectError:
            yield _sse_event("error", json.dumps({"type": "error", "error": "无法连接到模型服务"}, ensure_ascii=False))
            yield _sse_event("done", json.dumps({"type": "done", "finish_reason": "error"}, ensure_ascii=False))
        except httpx.TimeoutException:
            yield _sse_event("error", json.dumps({"type": "error", "error": "模型服务超时"}, ensure_ascii=False))
            yield _sse_event("done", json.dumps({"type": "done", "finish_reason": "error"}, ensure_ascii=False))
        except Exception as exc:
            logger.exception("LLM direct stream error")
            yield _sse_event("error", json.dumps({"type": "error", "error": f"流中断: {exc}"}, ensure_ascii=False))
            yield _sse_event("done", json.dumps({"type": "done", "finish_reason": "error"}, ensure_ascii=False))

    return StreamingResponse(
        _llm_event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Chat history CRUD
# ═══════════════════════════════════════════════════════════════════════════════


class ChatSessionOut(BaseModel):
    """Serialised chat session (without messages)."""

    id: int
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0

    model_config = {"from_attributes": True}


class ChatSessionDetail(BaseModel):
    """Chat session with full message list."""

    id: int
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[dict] = []
    # Hermes agent linkage (null when the chat has no agent session yet).
    hermes_session_id: str | None = None
    # Run still executing for this chat — lets the UI reattach after a reload.
    active_run_id: str | None = None

    model_config = {"from_attributes": True}


class SaveMessagesRequest(BaseModel):
    """Bulk-save messages for a session (upsert: clear + re-insert).

    ``messages`` is optional so callers can update only the Hermes linkage;
    omitting it keeps the stored transcript, while an explicit list (even
    ``[]``) replaces it.

    ``hermes_session_id`` / ``active_run_id`` persist the Hermes linkage in the
    same write as the transcript.  They use ``model_fields_set`` semantics: a
    field is only touched when the caller sent it (an explicit ``null`` clears
    it), so older clients that omit them keep the stored values intact.
    """

    messages: list[dict] | None = None
    title: str | None = None
    hermes_session_id: str | None = None
    active_run_id: str | None = None


@router.get("/sessions", response_model=list[ChatSessionOut])
async def list_chat_sessions(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[ChatSessionOut]:
    """List chat sessions for the current user, newest first."""
    rows = await db.execute(
        select(
            ChatSession.id,
            ChatSession.title,
            ChatSession.created_at,
            ChatSession.updated_at,
            func.count(ChatMessage.id).label("message_count"),
        )
        .outerjoin(ChatMessage, ChatMessage.session_id == ChatSession.id)
        .where(ChatSession.user_id == user.id)
        .group_by(ChatSession.id)
        .order_by(ChatSession.updated_at.desc())
    )
    return [
        ChatSessionOut(
            id=r.id,
            title=r.title,
            created_at=r.created_at,
            updated_at=r.updated_at,
            message_count=r.message_count,
        )
        for r in rows
    ]


@router.post(
    "/sessions",
    response_model=ChatSessionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_chat_session(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> ChatSessionOut:
    """Create a new empty chat session."""
    session = ChatSession(user_id=user.id, title="新对话")
    db.add(session)
    await db.flush()
    await db.refresh(session)
    return ChatSessionOut(
        id=session.id,
        title=session.title,
        created_at=session.created_at,
        updated_at=session.updated_at,
        message_count=0,
    )


@router.get("/sessions/{session_id}", response_model=ChatSessionDetail)
async def get_chat_session(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> ChatSessionDetail:
    """Get a chat session with all messages."""
    row = await db.get(ChatSession, session_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")

    msg_rows = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
    )
    messages = [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "tool_calls": m.tool_calls,
            "created_at": m.created_at.isoformat(),
        }
        for m in msg_rows.scalars()
    ]

    return ChatSessionDetail(
        id=row.id,
        title=row.title,
        created_at=row.created_at,
        updated_at=row.updated_at,
        messages=messages,
        hermes_session_id=row.hermes_session_id,
        active_run_id=row.active_run_id,
    )


@router.post("/sessions/{session_id}/messages")
async def save_messages(
    session_id: int,
    body: SaveMessagesRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> Response:
    """Save messages and/or the Hermes linkage for a session."""
    row = await db.get(ChatSession, session_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")

    # Replace the transcript only when the caller sent one; a link-only update
    # (messages omitted) must not wipe the stored conversation.
    if body.messages is not None:
        from sqlalchemy import delete

        await db.execute(
            delete(ChatMessage).where(ChatMessage.session_id == session_id)
        )

        for m in body.messages:
            db.add(
                ChatMessage(
                    session_id=session_id,
                    role=m.get("role", "user"),
                    content=m.get("content", ""),
                    tool_calls=m.get("tool_calls"),
                )
            )

    # Update title if provided
    if body.title:
        row.title = body.title

    # Persist the Hermes linkage.  Only fields the caller actually sent are
    # touched (explicit null clears), so partial updates from older clients
    # cannot wipe a session that is still linked to a running agent.
    if "hermes_session_id" in body.model_fields_set:
        row.hermes_session_id = body.hermes_session_id
    if "active_run_id" in body.model_fields_set:
        row.active_run_id = body.active_run_id

    row.updated_at = func.now()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/sessions/{session_id}")
async def delete_chat_session(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a chat session and all its messages."""
    row = await db.get(ChatSession, session_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")
    await db.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ═══════════════════════════════════════════════════════════════════════════════
# Chat mode management
# ═══════════════════════════════════════════════════════════════════════════════


class ChatModeOut(BaseModel):
    slug: str
    name: str
    system_prompt: str = ""
    config: dict = Field(default_factory=dict)
    enabled: bool = True

    model_config = {"from_attributes": True}


class ChatModeUpdate(BaseModel):
    system_prompt: str | None = None
    enabled: bool | None = None


@router.get("/modes", response_model=list[ChatModeOut])
async def list_chat_modes(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[ChatModeOut]:
    """List all enabled chat modes (system + user custom)."""
    from app.models import ChatMode as ChatModeModel, UserChatMode
    from sqlalchemy import case as _sql_case

    rows = await db.execute(
        select(ChatModeModel)
        .where(ChatModeModel.enabled == True)  # noqa: E712
        .order_by(
            _sql_case(
                (ChatModeModel.slug == "general", 0),
                (ChatModeModel.slug == "default", 1),
                else_=2,
            ),
            ChatModeModel.id,
        )
    )
    result = [
        ChatModeOut(
            slug=f"system:{m.slug}",
            name=m.name,
            system_prompt=m.system_prompt or "",
            config=m.config or {},
            enabled=m.enabled,
        )
        for m in rows.scalars().all()
    ]
    # User custom modes
    user_rows = await db.execute(
        select(UserChatMode)
        .where(UserChatMode.user_id == user.id, UserChatMode.enabled == True)  # noqa: E712
        .order_by(UserChatMode.created_at.desc())
    )
    for um in user_rows.scalars().all():
        result.append(ChatModeOut(
            slug=f"user:{um.id}",
            name=um.name,
            system_prompt=um.system_prompt or "",
            config={"provider": um.provider, "icon": um.icon, "user_mode": True},
            enabled=um.enabled,
        ))
    return result


class UserModeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    system_prompt: str = Field(default="")
    icon: str = Field(default="🤖")
    provider: str = Field(default="llm")


@router.post("/user-modes", response_model=ChatModeOut, status_code=201)
async def create_user_mode(
    body: UserModeCreate,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> ChatModeOut:
    """Create a custom assistant (private)."""
    from app.models import UserChatMode
    um = UserChatMode(user_id=user.id, name=body.name, system_prompt=body.system_prompt, icon=body.icon, provider=body.provider)
    db.add(um); await db.flush(); await db.refresh(um)
    return ChatModeOut(slug=f"user:{um.id}", name=um.name, system_prompt=um.system_prompt, config={"provider": um.provider, "icon": um.icon, "user_mode": True}, enabled=um.enabled)


@router.put("/user-modes/{mode_id}", response_model=ChatModeOut)
async def update_user_mode(
    mode_id: int, body: UserModeCreate,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> ChatModeOut:
    """Update custom assistant."""
    from app.models import UserChatMode
    um = await db.get(UserChatMode, mode_id)
    if not um or um.user_id != user.id: raise HTTPException(status_code=404, detail="不存在")
    um.name = body.name; um.system_prompt = body.system_prompt; um.icon = body.icon; um.provider = body.provider
    await db.flush()
    return ChatModeOut(slug=f"user:{um.id}", name=um.name, system_prompt=um.system_prompt, config={"provider": um.provider, "icon": um.icon, "user_mode": True}, enabled=um.enabled)


@router.delete("/user-modes/{mode_id}")
async def delete_user_mode(
    mode_id: int, db: AsyncSession = Depends(get_db_session), user: User = Depends(get_current_user),
) -> Response:
    """Delete custom assistant."""
    from app.models import UserChatMode
    um = await db.get(UserChatMode, mode_id)
    if not um or um.user_id != user.id: raise HTTPException(status_code=404, detail="不存在")
    await db.delete(um); return Response(status_code=204)


@router.put("/modes/{slug}", response_model=ChatModeOut)
async def update_chat_mode(
    slug: str,
    body: ChatModeUpdate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> ChatModeOut:
    """Update a chat mode's system prompt or enabled state (admin only)."""
    from app.models import ChatMode as ChatModeModel

    row = await db.execute(
        select(ChatModeModel).where(ChatModeModel.slug == slug)
    )
    mode = row.scalar_one_or_none()
    if not mode:
        raise HTTPException(status_code=404, detail="模式不存在")

    if body.system_prompt is not None:
        mode.system_prompt = body.system_prompt
    if body.enabled is not None:
        mode.enabled = body.enabled
    await db.flush()

    return ChatModeOut(
        slug=mode.slug,
        name=mode.name,
        system_prompt=mode.system_prompt or "",
        config=mode.config or {},
        enabled=mode.enabled,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Hermes skills & toolsets discovery (with caching)
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/hermes/skills")
async def list_hermes_skills(
    user: User = Depends(get_current_user),
) -> list[dict]:
    """List skills from cache.  Auto-refreshed periodically."""
    from app.services.hermes import get_cached_skills
    return get_cached_skills()


@router.get("/hermes/toolsets")
async def list_hermes_toolsets(
    user: User = Depends(get_current_user),
) -> list[dict]:
    """List toolsets from cache.  Auto-refreshed periodically."""
    from app.services.hermes import get_cached_toolsets
    return get_cached_toolsets()


@router.get("/hermes/cache-status")
async def hermes_cache_status(
    user: User = Depends(get_current_user),
) -> dict:
    """Return cache age and refresh interval."""
    from app.services.hermes import get_cache_age_secs, get_cache_refresh_secs
    return {
        "age_secs": round(get_cache_age_secs(), 1),
        "refresh_secs": get_cache_refresh_secs(),
        "stale": get_cache_age_secs() > get_cache_refresh_secs(),
    }


@router.post("/hermes/refresh")
async def refresh_hermes_cache(
    _admin: User = Depends(require_admin),
) -> dict:
    """Force-refresh the skills/toolsets cache."""
    from app.services.hermes import (
        refresh_skills_cache,
        get_cache_age_secs,
        get_cached_skills,
        get_cached_toolsets,
    )
    hermes = _get_hermes()
    await refresh_skills_cache(hermes)
    return {
        "skills_count": len(get_cached_skills()),
        "toolsets_count": len(get_cached_toolsets()),
        "age_secs": round(get_cache_age_secs(), 1),
    }


@router.put("/hermes/cache-interval")
async def set_cache_interval(
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Set the cache refresh interval (seconds).  Persisted to system_config."""
    from app.models import SystemConfig
    from app.services.hermes import set_cache_refresh_secs, get_cache_refresh_secs

    secs = int(body.get("refresh_secs", 300))
    set_cache_refresh_secs(secs)

    row = await db.get(SystemConfig, "skills_refresh_secs")
    if row:
        row.value = str(secs)
        row.updated_at = func.now()
    else:
        db.add(SystemConfig(key="skills_refresh_secs", value=str(secs)))
    await db.flush()

    return {"refresh_secs": get_cache_refresh_secs()}


@router.get("/hermes/cache-interval")
async def get_cache_interval(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Get the current cache refresh interval from DB or default."""
    from app.models import SystemConfig
    from app.services.hermes import get_cache_refresh_secs

    row = await db.get(SystemConfig, "skills_refresh_secs")
    db_secs = int(row.value) if row and row.value.isdigit() else None
    return {"refresh_secs": db_secs or get_cache_refresh_secs()}


# ═══════════════════════════════════════════════════════════════════════════════
# File conversion (MarkItDown)
# ═══════════════════════════════════════════════════════════════════════════════

import tempfile
import uuid

from fastapi import UploadFile

#: 文本 / 文档类附件白名单（MarkItDown 可转换）。
TEXT_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".epub",
    ".html", ".htm", ".csv", ".json", ".xml", ".ipynb",
    ".zip", ".txt", ".md", ".py", ".js", ".ts", ".log", ".sql",
    ".java", ".go", ".rs", ".c", ".cpp", ".h", ".sh", ".bat", ".ps1",
    ".yaml", ".yml", ".ini", ".cfg", ".env", ".css", ".rss",
}

#: 图片白名单 — 只有这四种会走内联 data URL（Hermes 仅支持图片 data URL）。
IMAGE_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

ALLOWED_EXTENSIONS = TEXT_EXTENSIONS | set(IMAGE_MIME_BY_EXT)

# 附件链路上限：避免超大文件把内存 / MarkItDown / 后续 prompt 打爆。
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024      # 文本类上传文件 20MB
MAX_ATTACHMENT_CHARS = 200_000               # 转换后正文默认 200k 字符
MAX_IMAGE_BYTES = 3 * 1024 * 1024            # 内联图片 3MB（base64 后 < 6MB）
MIN_ATTACHMENT_CHARS = 1_000
MAX_ATTACHMENT_CHARS_LIMIT = 1_000_000


@router.post("/convert-file")
async def convert_file(
    file: UploadFile = File(...),
    max_chars: int | None = Query(
        default=None,
        ge=MIN_ATTACHMENT_CHARS,
        le=MAX_ATTACHMENT_CHARS_LIMIT,
        description=(
            "转换后正文的最大字符数。省略时沿用 200k；agent 模式前端传 60000 "
            "(Hermes 对单段文本有 64K 字符的静默截断)。"
        ),
    ),
    user: User = Depends(get_current_user),
) -> dict:
    """Convert an uploaded file to Markdown (or inline an image as data URL).

    Supports PDF, Word, Excel, PPT, HTML, CSV, JSON, code, Jupyter notebooks,
    ZIP archives, and inline images (png/jpeg/webp/gif).

    约束：
    * 文本类上传大小 ≤ 20MB、图片 ≤ 3MB，超出返回 413；
    * 转换后正文 ≤ ``max_chars``（默认 200k），超出截断并在正文末尾标注；
    * 图片不进入 MarkItDown，直接返回 ``kind="image"`` + data URL；
    * 转换失败返回 4xx，绝不把 `[错误: 文件名]` 之类的错误文本当正文。
    * 日志只记录文件名 / 大小，绝不打印文件内容。
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="未提供文件名")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {ext}。支持文本类文档与 png/jpg/webp/gif 图片",
        )

    # ── 图片：内联为 data URL，交给 Hermes 的 vision 通道 ────────────────
    if ext in IMAGE_MIME_BY_EXT:
        # 多读 1 字节即可判断是否超限，避免把超大图片整个读进内存。
        raw = await file.read(MAX_IMAGE_BYTES + 1)
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"图片超过 {MAX_IMAGE_BYTES // (1024 * 1024)}MB 上限",
            )
        if not raw:
            raise HTTPException(status_code=400, detail="文件为空")
        mime = IMAGE_MIME_BY_EXT[ext]
        logger.info(
            "Attached image inlined: filename={!r} bytes={} mime={}",
            file.filename,
            len(raw),
            mime,
        )
        return {
            "ok": True,
            "kind": "image",
            "filename": file.filename,
            "mime": mime,
            "bytes": len(raw),
            "data_url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}",
        }

    # 多读 1 字节即可判断是否超限，避免把超大文件整个读进内存。
    raw = await file.read(MAX_ATTACHMENT_BYTES + 1)
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过 {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB 上限",
        )
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")

    char_limit = max_chars or MAX_ATTACHMENT_CHARS

    # Save to a temp file (markitdown needs a real file path for binary formats)
    suffix = ext if ext else ".txt"
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name

        # Convert using markitdown
        from markitdown import MarkItDown
        md = MarkItDown()
        result = md.convert(tmp_path)
        text = result.text_content.strip()

        if not text:
            # 提取不到正文属于转换失败，返回 4xx，由前端展示错误状态。
            raise HTTPException(
                status_code=422,
                detail=f"文件 {file.filename} 内容为空或无法提取文本",
            )

        original_chars = len(text)
        truncated = original_chars > char_limit
        if truncated:
            text = (
                text[:char_limit]
                + f"\n\n[内容超长已截断：原文 {original_chars} 字符，"
                  f"仅保留前 {char_limit} 字符]"
            )
            logger.warning(
                "Attached file truncated: filename={!r} chars={} limit={}",
                file.filename,
                original_chars,
                char_limit,
            )

        return {
            "ok": True,
            "kind": "text",
            "filename": file.filename,
            "content": text,
            "truncated": truncated,
            "original_chars": original_chars,
            "max_chars": char_limit,
        }
    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(status_code=500, detail="markitdown 未安装")
    except Exception as exc:
        # 转换失败（损坏/加密的文件等）→ 422，调用方按错误处理，不写正文。
        logger.warning(
            "convert-file failed: filename={!r} error={}", file.filename, exc
        )
        raise HTTPException(status_code=422, detail=f"文件转换失败: {exc}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════════
# Agent artifacts (B1) — download files Hermes wrote into the shared directory
# ═══════════════════════════════════════════════════════════════════════════════


@router.get(
    "/artifacts/{session_id}/{filename}",
    summary="Download a Hermes agent artifact",
    description=(
        "Serves a file the agent produced for one platform chat session.  "
        "``session_id`` must be an integer ``ChatSession.id`` owned by the "
        "caller (admins get no bypass — same 404 policy as the other chat "
        "session routes); the file must live in "
        "``HERMES_FILES_DIR/<session_id>/``.  The filename is whitelisted, "
        "symlinks are refused and path traversal returns 404.  Files left in "
        "the legacy flat root are deliberately no longer downloadable."
    ),
)
async def download_artifact(
    session_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Return one session-scoped artifact (≤10MB, no traversal, no symlinks)."""
    # The handler takes ``session_id`` as a string so a non-integer id yields the
    # same 404 as an unknown one (``int`` would answer 422 and leak the shape).
    if (
        not _ARTIFACT_SESSION_ID_RE.fullmatch(session_id or "")
        or not _ARTIFACT_NAME_RE.fullmatch(filename or "")
        or filename in {".", ".."}
    ):
        raise HTTPException(status_code=404, detail="文件不存在")

    chat_session = await db.get(ChatSession, int(session_id))
    if chat_session is None or chat_session.user_id != user.id:
        # Deliberately indistinguishable from "file missing": no ownership or
        # existence oracle for other users' sessions.
        raise HTTPException(status_code=404, detail="文件不存在")

    root = _artifact_root()
    directory = root / str(chat_session.id)
    # Reject symlinks *before* resolving: resolve() would follow them away.
    if directory.is_symlink():
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        session_dir = directory.resolve()
        session_dir.relative_to(root)
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="文件不存在")

    if session_dir.is_symlink() or not session_dir.is_dir():
        raise HTTPException(status_code=404, detail="文件不存在")

    candidate = session_dir / filename
    if candidate.is_symlink():
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        target = candidate.resolve()
        target.relative_to(session_dir)
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="文件不存在")

    if target.is_symlink() or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        size = target.stat().st_size
    except OSError:
        raise HTTPException(status_code=404, detail="文件不存在")
    if size > MAX_ARTIFACT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过 {MAX_ARTIFACT_BYTES // (1024 * 1024)}MB 上限",
        )

    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    logger.info(
        "Artifact download: session_id={} filename={!r} bytes={}",
        chat_session.id,
        filename,
        size,
    )
    return FileResponse(
        target,
        media_type=media_type,
        filename=filename,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# LLM model discovery
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/llm-models")
async def list_llm_models(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """List available models from the configured LLM endpoint.

    Proxies ``GET /v1/models`` on the configured LLM base URL.  Falls back
    to returning the single configured model if the endpoint is unreachable
    or does not support model listing.
    """
    import httpx

    cfg = await _load_llm_config(db)
    base_url = cfg.get("llm_base_url", "").strip()
    api_key = cfg.get("llm_api_key", "").strip()
    config_model = cfg.get("llm_model", "").strip()

    models: list[dict] = []

    # Try to discover models from the configured LLM endpoint
    if base_url:
        url = base_url.rstrip("/")
        # Build models URL
        if url.endswith("/v1"):
            models_url = f"{url}/models"
        elif "/v1/" in url:
            models_url = f"{url.split('/v1/')[0]}/v1/models"
        else:
            models_url = f"{url}/v1/models"

        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=5.0)) as client:
                resp = await client.get(models_url, headers=headers)
                if resp.status_code < 400:
                    data = resp.json()
                    raw_list: list[dict] = data.get("data", data if isinstance(data, list) else [])
                    models = [{"id": m.get("id", "unknown"), "owned_by": m.get("owned_by", "")} for m in raw_list]
        except Exception:
            logger.info("LLM model discovery failed — falling back to configured model")

    # Fallback: use the single configured model
    if not models and config_model:
        models = [{"id": config_model, "owned_by": ""}]

    # Ultimate fallback
    if not models:
        models = [{"id": "gpt-4o", "owned_by": ""}]

    return models


# ═══════════════════════════════════════════════════════════════════════════════
# Hermes health
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/hermes-health")
async def hermes_health(
    user: User = Depends(get_current_user),
) -> dict:
    """Lightweight Hermes health check — returns ok + latency."""
    from app.services.hermes import _hermes_url, _hermes_api_key
    import time, httpx

    url = _hermes_url.rstrip("/")
    # Strip /v1 so we hit the root-level /health endpoint
    import re
    url = re.sub(r"/v1$", "", url)

    headers: dict[str, str] = {}
    if _hermes_api_key:
        headers["Authorization"] = f"Bearer {_hermes_api_key}"

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
            resp = await client.get(f"{url}/health", headers=headers)
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {"ok": resp.status_code < 500, "status_code": resp.status_code, "latency_ms": latency_ms}
    except Exception:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {"ok": False, "status_code": 0, "latency_ms": latency_ms}


# ═══════════════════════════════════════════════════════════════════════════════
# Hermes capability probe (non-admin chat UI)
# ═══════════════════════════════════════════════════════════════════════════════

#: Only the feature bits the chat UI can act on.  Everything else Hermes
#: advertises (version, runtime, model options, endpoints, gateway URL) stays on
#: the admin-only ``/hermes-info`` self-report below.
_CHAT_CAPABILITY_FLAGS: tuple[str, ...] = (
    "run_submission",
    "run_stop",
    "run_steer",
    "run_approval_response",
    "tool_progress_events",
    "chat_completions_streaming",
)

#: ``/v1/capabilities`` only changes on deploy/restart — 60 s keeps an upgrade
#: visible quickly while sparing the gateway one probe per page load.
_CAPABILITIES_CACHE_TTL_SECONDS = 60.0

#: Process-wide cache (Hermes is a single global engine).  ``base_url`` is kept
#: only to invalidate the entry when an admin points the platform elsewhere.
_capabilities_cache: dict[str, Any] = {
    "payload": None,
    "expires_at": 0.0,
    "base_url": None,
}


def _capability_payload(features: dict[str, Any]) -> dict[str, Any]:
    """Project Hermes ``features`` onto the safe capability payload.

    Missing/non-boolean flags become ``False`` (the UI hides the matching
    control); ``session_continuity_header`` is a header name or flag, never a
    secret.
    """
    payload: dict[str, Any] = {
        key: features.get(key) is True for key in _CHAT_CAPABILITY_FLAGS
    }
    header = features.get("session_continuity_header")
    payload["session_continuity_header"] = (
        header if isinstance(header, (str, bool)) else None
    )
    return payload


@router.get(
    "/hermes-capabilities",
    summary="Hermes capability bits for the chat UI",
    description=(
        "Read-only capability probe available to every signed-in user.  "
        "Returns only the feature flags the chat panel needs (runs / stop / "
        "steer / approval / tool progress / streaming) plus the session "
        "continuity header — never URLs, versions, models or health details.  "
        "When Hermes is unreachable every flag is false while the endpoint "
        "still answers 200 so the UI degrades instead of breaking."
    ),
)
async def hermes_capabilities(
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Return a 60 s-cached, non-sensitive capability payload.

    Deliberately **not** admin-only: ordinary users need to know whether the
    Runs API exists so the chat panel can hide stop/steer/approval controls that
    would otherwise 403.  The admin-only :func:`hermes_info` remains the rich
    inspector for the settings screen.

    Hermes failures are swallowed: every flag is ``False`` and the HTTP status
    stays 200, which tells the frontend to stay on the legacy
    ``/api/chat/stream`` path.
    """
    from app.services.hermes import HermesClient, _hermes_url

    base_url = (_hermes_url or "").rstrip("/")
    now = time.monotonic()
    cached = _capabilities_cache
    if (
        cached["payload"] is not None
        and cached["base_url"] == base_url
        and now < cached["expires_at"]
    ):
        return dict(cached["payload"])

    features: dict[str, Any] = {}
    if base_url:
        # Short timeout: a half-dead gateway must not hold the chat page for the
        # 600 s agent timeout.  Constructed per cache miss (≤ once a minute) and
        # always closed so no connection is leaked.
        client = HermesClient(timeout=10.0)
        try:
            caps = await client.get_capabilities()
            raw_features = caps.get("features") if isinstance(caps, dict) else None
            if isinstance(raw_features, dict):
                features = raw_features
        except Exception:  # never 500 the chat page on a probe failure
            logger.warning("hermes-capabilities probe failed", exc_info=True)
            features = {}
        finally:
            try:
                await client.close()
            except Exception:
                logger.debug("hermes-capabilities: client close failed")

    payload = _capability_payload(features)
    _capabilities_cache.update(
        {
            "payload": payload,
            "expires_at": now + _CAPABILITIES_CACHE_TTL_SECONDS,
            "base_url": base_url,
        }
    )
    return dict(payload)


# ═══════════════════════════════════════════════════════════════════════════════
# Hermes capability self-report (settings → 智能引擎)
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/hermes-info")
async def hermes_info(
    _admin: User = Depends(require_admin),
) -> dict:
    """Rich Hermes self-report for the settings screen.

    Combines ``/health/detailed``, ``/v1/capabilities`` and ``/api/model/options``
    into one payload so the UI can show version, runtime mode, feature flags and
    the active model instead of dumping a raw JSON blob into a toast.

    Admin-only: this is the settings screen's engine inspector.
    """
    from app.services.hermes import _hermes_url, HermesClient

    base = {"url": _hermes_url, "ok": False}

    import time
    t0 = time.monotonic()
    # Short timeout: a half-dead Hermes must not hang the settings page for the
    # default 600s agent timeout.
    client = HermesClient(timeout=15.0)
    try:
        health = await client.get_health_detailed()
        latency_ms = round((time.monotonic() - t0) * 1000)

        # ``get_health_detailed`` never raises: it returns the successful body
        # plus ``_probe`` metadata, or ``{"_probe": {"ok": False}}``.  Surface
        # every attempted URL and an actionable hint instead of the old opaque
        # "无法获取 /health/detailed".
        probe = health.get("_probe") if isinstance(health, dict) else None
        if not isinstance(probe, dict) or not probe.get("ok"):
            probe = probe if isinstance(probe, dict) else {}
            hint = (
                probe.get("hint")
                or "健康端点探测失败 — 请检查 API 地址、端口与 API Key"
            )
            return {
                **base,
                "latency_ms": latency_ms,
                "error": "Hermes 健康检查失败",
                "probe": {
                    "attempts": probe.get("attempts") or [],
                    "resolved_url": probe.get("resolved_url"),
                    "hint": hint,
                },
            }

        caps = await client.get_capabilities()
        models = await client.get_model_options() if caps.get("endpoints", {}).get("model_options") else {}

        readiness = health.get("readiness") or {}
        checks: dict[str, str] = {}
        for key, value in (readiness.get("checks") or {}).items():
            # Individual checks are usually {"status": "ok"} but some builds
            # report a bare string — never assume the shape.
            checks[key] = value.get("status", "unknown") if isinstance(value, dict) else str(value)

        features = caps.get("features") or {}
        # Only the flags a platform UI can act on — keeps the payload small.
        feature_flags = {
            key: features.get(key)
            for key in (
                "chat_completions_streaming",
                "responses_api",
                "run_submission",
                "run_stop",
                "run_steer",
                "run_approval_response",
                "tool_progress_events",
                "reasoning_streaming",
                "session_chat_streaming",
                "session_fork",
                "skills_api",
                "jobs_admin",
                "memory_write_api",
            )
            if key in features
        }

        current_model = None
        for prov in (models.get("providers") or []):
            if not isinstance(prov, dict):
                continue
            if prov.get("is_current"):
                model_ids = [
                    m.get("id") if isinstance(m, dict) else str(m)
                    for m in (prov.get("models") or [])
                ]
                current_model = {
                    "provider": prov.get("name") or prov.get("slug"),
                    "models": [m for m in model_ids if m][:20],
                }
                break

        health_status = readiness.get("status") or health.get("status") or "ok"
        result = {
            **base,
            "ok": health_status == "ok",
            "latency_ms": latency_ms,
            "version": health.get("version") or caps.get("platform"),
            "platform": health.get("platform"),
            "gateway_state": health.get("gateway_state"),
            "runtime": caps.get("runtime") or {},
            "features": feature_flags,
            "session_continuity_header": features.get("session_continuity_header"),
            "checks": checks,
            "platforms": {
                name: (state.get("state") if isinstance(state, dict) else state)
                for name, state in (health.get("platforms") or {}).items()
            },
            "current_model": current_model,
            "disk_used_percent": (
                (((readiness.get("checks") or {}).get("disk") or {}).get("used_percent"))
                if isinstance((readiness.get("checks") or {}).get("disk"), dict)
                else None
            ),
        }
        # Success via a fallback endpoint is usable, but the caller should know
        # it is missing the detailed payload (readiness checks, disk, …).
        if probe.get("warning"):
            result["warning"] = probe["warning"]
        return result
    except Exception as exc:  # never 500 the settings page on a shape change
        logger.exception("hermes-info failed")
        return {
            **base,
            "error": f"读取 Hermes 能力信息失败: {exc}",
            "probe": {
                "attempts": [],
                "resolved_url": None,
                "hint": "读取 Hermes 能力信息失败 — 请查看后端日志",
            },
        }
    finally:
        await client.close()
