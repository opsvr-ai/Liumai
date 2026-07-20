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

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.models import ChatMessage, ChatSession, User
from app.models.database import get_db_session
from app.services.hermes import HermesClient

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
) -> list[ChatModeOut]:
    """List all enabled chat modes."""
    from app.models import ChatMode as ChatModeModel

    rows = await db.execute(
        select(ChatModeModel)
        .where(ChatModeModel.enabled == True)  # noqa: E712
        .order_by(ChatModeModel.id)
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
    _admin: User = Depends(get_current_user),
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
# Hermes skills & toolsets discovery
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/hermes/skills")
async def list_hermes_skills() -> list[dict]:
    """Proxy: list skills registered with the connected Hermes agent.

    Calls ``GET /v1/skills`` on the Hermes API Server.  Returns an empty
    list if the Hermes server is unreachable or does not support the endpoint.
    """
    hermes = _get_hermes()
    return await hermes.get_skills()


@router.get("/hermes/toolsets")
async def list_hermes_toolsets() -> list[dict]:
    """Proxy: list toolsets registered with the connected Hermes agent.

    Calls ``GET /v1/toolsets`` on the Hermes API Server.  Returns an empty
    list if the Hermes server is unreachable or does not support the endpoint.
    """
    hermes = _get_hermes()
    return await hermes.get_toolsets()
