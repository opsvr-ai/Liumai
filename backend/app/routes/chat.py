"""Intelligent chat endpoints with SSE streaming via Hermes.

Provides a conversational interface that relays messages to the Hermes
agent and streams the response back as Server-Sent Events (SSE).  The
stream carries text deltas, tool-call invocations, and completion signals
that the frontend chat panel renders in real time.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field

from app.services.hermes import HermesClient

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


class ChatMessage(BaseModel):
    """A single message in the conversation history."""

    role: str = Field(..., pattern="^(system|user|assistant|tool)$")
    content: str


class ChatRequest(BaseModel):
    """Payload for the streaming chat endpoint."""

    messages: list[ChatMessage] = Field(
        ...,
        min_length=1,
        description="Conversation history in OpenAI-compatible format",
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


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

# Lazy-initialised singleton — initialised on first request so tests or
# alternative configs can replace it before any call is made.
_hermes: HermesClient | None = None


def _get_hermes() -> HermesClient:
    """Return the module-level HermesClient singleton."""
    global _hermes
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
async def chat_stream_endpoint(body: ChatRequest) -> StreamingResponse:
    """Stream a chat completion from Hermes via SSE.

    The response is a ``text/event-stream`` with the following event types:

    * ``delta`` — a text chunk from the assistant
    * ``tool_call`` — an assembled tool-call snapshot (incremental)
    * ``done`` — stream finished, may include ``usage`` info
    * ``error`` — an unrecoverable error; the stream is terminated
    """
    hermes = _get_hermes()

    messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in body.messages
    ]

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
