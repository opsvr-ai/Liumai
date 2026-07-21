"""Intelligent chat endpoints with SSE streaming via Hermes.

Provides a conversational interface that relays messages to the Hermes
agent and streams the response back as Server-Sent Events (SSE).  The
stream carries text deltas, tool-call invocations, and completion signals
that the frontend chat panel renders in real time.
"""

from __future__ import annotations

import json
from typing import Any

from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import ChatMessage, ChatSession, User
from app.models.database import get_db_session
from app.services.hermes import HermesClient


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


class ChatMessageIn(BaseModel):
    """A single message in the conversation history."""

    role: str = Field(..., pattern="^(system|user|assistant|tool)$")
    content: str


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
    model: str = Field(
        default="hermes-agent",
        description="Hermes model to use",
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
    * ``done`` — stream finished, may include ``usage`` info
    * ``error`` — an unrecoverable error; the stream is terminated
    """
    hermes = _get_hermes()

    # ── Mode-aware system prompt injection ───────────────────────────────
    messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in body.messages
    ]

    if body.mode:
        from app.models import ChatMode as ChatModeModel
        row = await db.execute(
            select(ChatModeModel).where(
                ChatModeModel.slug == body.mode,
                ChatModeModel.enabled == True,  # noqa: E712
            )
        )
        mode = row.scalar_one_or_none()
        if mode and mode.system_prompt:
            # Prepend system prompt only if not already present
            if not messages or messages[0].get("role") != "system":
                messages.insert(0, {"role": "system", "content": mode.system_prompt})
            # RCA mode: inject time window into user message
            if body.mode == "rca" and (body.time_window_start or body.time_window_end):
                tw_info = f"\n[时间窗口: {body.time_window_start or '?'} → {body.time_window_end or '?'}]"
                last_user = None
                for m in reversed(messages):
                    if m["role"] == "user":
                        last_user = m
                        break
                if last_user:
                    last_user["content"] += tw_info
            # RCA mode: lower temperature for deterministic output
            body.temperature = 0.3

    # ── LLM direct path (mode with provider=llm) ─────────────────────────
    if mode and (mode.config or {}).get("provider") == "llm":
        return await _llm_direct_stream(messages, body, mode, db)

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
                model=body.model,
                temperature=body.temperature,
            ):
                event_type: str = event.get("type", "unknown")
                payload: dict[str, Any] = {"type": event_type}

                if event_type == "delta":
                    payload["content"] = event.get("content", "")
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
        },
    )


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

    model_config = {"from_attributes": True}


class SaveMessagesRequest(BaseModel):
    """Bulk-save messages for a session (upsert: clear + re-insert)."""

    messages: list[dict] = Field(default_factory=list)
    title: str | None = None


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
    )


@router.post("/sessions/{session_id}/messages")
async def save_messages(
    session_id: int,
    body: SaveMessagesRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> Response:
    """Save (replace) all messages in a session."""
    row = await db.get(ChatSession, session_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")

    # Delete existing messages
    from sqlalchemy import delete

    await db.execute(
        delete(ChatMessage).where(ChatMessage.session_id == session_id)
    )

    # Insert new messages
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
    """List all enabled chat modes."""
    from app.models import ChatMode as ChatModeModel

    from sqlalchemy import case as _sql_case
    rows = await db.execute(
        select(ChatModeModel)
        .where(ChatModeModel.enabled == True)  # noqa: E712
        .order_by(
            # Put 'general' first, then 智能助理, then the rest
            _sql_case(
                (ChatModeModel.slug == "general", 0),
                (ChatModeModel.slug == "default", 1),
                else_=2,
            ),
            ChatModeModel.id,
        )
    )
    modes = rows.scalars().all()
    return [
        ChatModeOut(
            slug=m.slug,
            name=m.name,
            system_prompt=m.system_prompt or "",
            config=m.config or {},
            enabled=m.enabled,
        )
        for m in modes
    ]


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

import os
import tempfile
import uuid

from fastapi import UploadFile

ALLOWED_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".epub",
    ".html", ".htm", ".csv", ".json", ".xml", ".ipynb",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif",
    ".zip", ".txt", ".md", ".py", ".js", ".ts", ".log", ".sql",
    ".java", ".go", ".rs", ".c", ".cpp", ".h", ".sh", ".bat", ".ps1",
    ".yaml", ".yml", ".ini", ".cfg", ".env", ".css", ".rss",
}


@router.post("/convert-file")
async def convert_file(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> dict:
    """Convert an uploaded file to Markdown using Microsoft MarkItDown.

    Supports PDF, Word, Excel, PPT, images (OCR), HTML, CSV, JSON, code,
    Jupyter notebooks, ZIP archives, and more.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="未提供文件名")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {ext}。支持: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # Save to a temp file (markitdown needs a real file path for binary formats)
    suffix = ext if ext else ".txt"
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        # Convert using markitdown
        from markitdown import MarkItDown
        md = MarkItDown()
        result = md.convert(tmp_path)
        text = result.text_content.strip()

        if not text:
            return {
                "ok": True,
                "filename": file.filename,
                "content": f"[文件 {file.filename} 内容为空或无法提取文本]",
            }

        return {
            "ok": True,
            "filename": file.filename,
            "content": text,
        }
    except ImportError:
        raise HTTPException(status_code=500, detail="markitdown 未安装")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"文件转换失败: {exc}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


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
