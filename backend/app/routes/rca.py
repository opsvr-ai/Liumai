"""RCA session management endpoints.

Manual trigger (active mode), session listing with pagination,
session detail with timeline, and queue status.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import (
    CollaborationEvent,
    RcaSession,
    RcaStatus,
    RcaTriggerType,
)
from app.models.database import get_db_session
from app.services.hermes import HermesClient

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas
# ═══════════════════════════════════════════════════════════════════════════════


class TriggerRcaRequest(BaseModel):
    """Payload for manually triggering an RCA session."""

    time_window_start: str = Field(
        ...,
        description="ISO-8601 start of the analysis window",
    )
    time_window_end: str = Field(
        ...,
        description="ISO-8601 end of the analysis window",
    )
    data_sources: list[str] = Field(
        default_factory=lambda: ["monitoring", "logs", "metrics"],
        description="Data-source adapters to include in the RCA",
    )
    team_id: int = Field(default=1, description="Team (tenant) identifier")
    created_by: int | None = Field(default=None, description="User ID who triggered")


class TriggerRcaResponse(BaseModel):
    """Response returned after triggering an RCA."""

    session_id: int
    status: str
    position_in_queue: int | None = None


class RcaSessionSummary(BaseModel):
    """Summary fields for list views."""

    id: int
    trigger_type: str
    status: str
    rule_name: str | None = None
    time_window_start: datetime | None = None
    time_window_end: datetime | None = None
    created_at: datetime
    completed_at: datetime | None = None
    root_cause_summary: str | None = None


class RcaSessionDetail(BaseModel):
    """Full session detail including the collaboration timeline."""

    id: int
    team_id: int
    rule_id: int | None
    trigger_type: str
    status: str
    time_window_start: datetime | None
    time_window_end: datetime | None
    hermes_session_id: str | None
    wecom_chat_id: str | None
    root_cause_summary: str | None
    evidence: list[Any]
    created_at: datetime
    completed_at: datetime | None
    timeline: list[dict[str, Any]] = Field(default_factory=list)


class QueueStatus(BaseModel):
    """Current RCA queue state."""

    active_count: int
    queued_count: int
    max_concurrency: int


class PaginatedResponse(BaseModel):
    """Generic paginated list wrapper."""

    items: list[Any]
    total: int
    page: int
    page_size: int


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/trigger", response_model=TriggerRcaResponse, status_code=201)
async def trigger_rca(
    req: TriggerRcaRequest,
    db: AsyncSession = Depends(get_db_session),
) -> TriggerRcaResponse:
    """Manually trigger an RCA session (active mode).

    Validates concurrency limits (D-11), then spawns a Hermes agent
    session with the ``rca-fault-delimitation`` skill.
    """
    # ── Check concurrency ───────────────────────────────────────────────
    active_count = await _count_by_status(db, RcaStatus.RUNNING)
    queued_count = await _count_by_status(db, RcaStatus.QUEUED)

    status_ = RcaStatus.RUNNING if active_count < settings.RCA_MAX_CONCURRENCY else RcaStatus.QUEUED
    position = (queued_count + 1) if status_ == RcaStatus.QUEUED else None

    # ── Create session record ───────────────────────────────────────────
    session = RcaSession(
        team_id=req.team_id,
        trigger_type=RcaTriggerType.ACTIVE,
        status=status_,
        time_window_start=datetime.fromisoformat(req.time_window_start),
        time_window_end=datetime.fromisoformat(req.time_window_end),
        created_by=req.created_by,
    )
    db.add(session)
    await db.flush()

    # ── Spawn Hermes agent (fire-and-forget) ───────────────────────────
    if status_ == RcaStatus.RUNNING:
        try:
            hermes = HermesClient()
            hermes_session_id = await hermes.trigger_skill(
                skill_name="rca-fault-delimitation",
                params={
                    "trigger": "manual",
                    "session_id": session.id,
                    "time_window_start": req.time_window_start,
                    "time_window_end": req.time_window_end,
                    "data_sources": req.data_sources,
                },
            )
            session.hermes_session_id = hermes_session_id
        except Exception:
            logger.exception("Failed to spawn Hermes RCA session")
            session.status = RcaStatus.FAILED

        await db.flush()

    logger.info(
        "RCA session {} created (status={})",
        session.id,
        session.status.value,
    )

    return TriggerRcaResponse(
        session_id=session.id,
        status=session.status.value,
        position_in_queue=position,
    )


@router.get("/sessions", response_model=PaginatedResponse)
async def list_rca_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status_filter: str | None = Query(None, alias="status"),
    team_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
) -> PaginatedResponse:
    """List RCA sessions with pagination and optional filters."""
    query = select(RcaSession).order_by(RcaSession.created_at.desc())

    if status_filter:
        query = query.where(RcaSession.status == status_filter)
    if team_id:
        query = query.where(RcaSession.team_id == team_id)

    total_q = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(total_q)
    total = total_result.scalar_one()

    offset = (page - 1) * page_size
    result = await db.execute(query.offset(offset).limit(page_size))
    rows = result.scalars().all()

    items = [
        RcaSessionSummary(
            id=r.id,
            trigger_type=r.trigger_type.value,
            status=r.status.value,
            time_window_start=r.time_window_start,
            time_window_end=r.time_window_end,
            created_at=r.created_at,
            completed_at=r.completed_at,
            root_cause_summary=r.root_cause_summary,
        )
        for r in rows
    ]

    return PaginatedResponse(
        items=[i.model_dump() for i in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/sessions/{session_id}", response_model=RcaSessionDetail)
async def get_rca_session(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
) -> RcaSessionDetail:
    """Get full detail for a single RCA session, including timeline."""
    result = await db.execute(
        select(RcaSession).where(RcaSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"RCA session {session_id} not found",
        )

    # ── Timeline ────────────────────────────────────────────────────────
    ev_result = await db.execute(
        select(CollaborationEvent)
        .where(CollaborationEvent.rca_session_id == session_id)
        .order_by(CollaborationEvent.created_at.asc())
    )
    events = ev_result.scalars().all()

    timeline = [
        {
            "id": e.id,
            "event_type": e.event_type.value,
            "content": e.content,
            "metadata": e.metadata_,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in events
    ]

    return RcaSessionDetail(
        id=session.id,
        team_id=session.team_id,
        rule_id=session.rule_id,
        trigger_type=session.trigger_type.value,
        status=session.status.value,
        time_window_start=session.time_window_start,
        time_window_end=session.time_window_end,
        hermes_session_id=session.hermes_session_id,
        wecom_chat_id=session.wecom_chat_id,
        root_cause_summary=session.root_cause_summary,
        evidence=session.evidence or [],
        created_at=session.created_at,
        completed_at=session.completed_at,
        timeline=timeline,
    )


@router.get("/queue", response_model=QueueStatus)
async def get_queue_status(
    db: AsyncSession = Depends(get_db_session),
) -> QueueStatus:
    """Get the current RCA queue state (D-11)."""
    active = await _count_by_status(db, RcaStatus.RUNNING)
    queued = await _count_by_status(db, RcaStatus.QUEUED)

    return QueueStatus(
        active_count=active,
        queued_count=queued,
        max_concurrency=settings.RCA_MAX_CONCURRENCY,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════


async def _count_by_status(db: AsyncSession, status_: RcaStatus) -> int:
    """Count RCA sessions with a given status."""
    result = await db.execute(
        select(func.count()).where(RcaSession.status == status_)
    )
    return result.scalar_one()
