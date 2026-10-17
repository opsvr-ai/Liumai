"""Audit-trail history endpoints (D-06).

Provides read-only access to RCA session history and collaboration event
timelines for post-incident review and compliance.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.models import CollaborationEvent, RcaSession, User
from app.models.database import get_db_session

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RcaHistoryItem(BaseModel):
    """Lightweight history entry for list views."""

    id: int
    team_id: int
    trigger_type: str
    status: str
    time_window_start: datetime | None = None
    time_window_end: datetime | None = None
    root_cause_summary: str | None = None
    created_at: datetime | None = None
    completed_at: datetime | None = None


class PaginatedHistory(BaseModel):
    """Paginated history response."""

    items: list[Any]
    total: int
    page: int
    page_size: int


class CollaborationResponse(BaseModel):
    """Single collaboration timeline event."""

    id: int
    event_type: str
    content: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: datetime | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/rca", response_model=PaginatedHistory)
async def list_rca_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    date_from: str | None = Query(None, alias="from"),
    date_to: str | None = Query(None, alias="to"),
    team_id: int | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedHistory:
    """List RCA history with date range, team, and status filters.

    This endpoint provides the audit trail for completed and failed
    RCA investigations (D-06).

    Results are always scoped to the caller's team. An explicit ``team_id``
    filter may only narrow that scope — asking for another team is rejected.
    """
    if team_id is not None and team_id != user.team_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无权访问其他团队的 RCA 会话",
        )

    query = (
        select(RcaSession)
        .where(RcaSession.team_id == user.team_id)
        .order_by(RcaSession.created_at.desc())
    )

    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from)
            query = query.where(RcaSession.created_at >= dt_from)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid 'from' date: {date_from!r}",
            )

    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to)
            query = query.where(RcaSession.created_at <= dt_to)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid 'to' date: {date_to!r}",
            )

    if status_filter:
        query = query.where(RcaSession.status == status_filter)

    total_q = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(total_q)
    total = total_result.scalar_one()

    offset = (page - 1) * page_size
    result = await db.execute(query.offset(offset).limit(page_size))
    rows = result.scalars().all()

    items = [
        RcaHistoryItem(
            id=r.id,
            team_id=r.team_id,
            trigger_type=r.trigger_type.value,
            status=r.status.value,
            time_window_start=r.time_window_start,
            time_window_end=r.time_window_end,
            root_cause_summary=r.root_cause_summary,
            created_at=r.created_at,
            completed_at=r.completed_at,
        ).model_dump()
        for r in rows
    ]

    return PaginatedHistory(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/collaboration/{rca_session_id}", response_model=PaginatedHistory)
async def list_collaboration_events(
    rca_session_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedHistory:
    """Get the paginated collaboration-event timeline for an RCA session.

    Returns events ordered chronologically, covering group creation,
    member joins, agent progress reports, manual findings, bot mentions,
    and completion signals. Paginated to avoid unbounded response size.
    """
    # Verify the session exists and belongs to the caller's team
    sess_result = await db.execute(
        select(RcaSession).where(RcaSession.id == rca_session_id)
    )
    session = sess_result.scalar_one_or_none()
    if session is None or session.team_id != user.team_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="RCA 会话不存在",
        )

    total_q = select(func.count()).where(
        CollaborationEvent.rca_session_id == rca_session_id
    )
    total_result = await db.execute(total_q)
    total = total_result.scalar_one()

    offset = (page - 1) * page_size
    ev_result = await db.execute(
        select(CollaborationEvent)
        .where(CollaborationEvent.rca_session_id == rca_session_id)
        .order_by(CollaborationEvent.created_at.asc())
        .offset(offset)
        .limit(page_size)
    )
    events = ev_result.scalars().all()

    items = [
        {
            "id": e.id,
            "event_type": e.event_type.value,
            "content": e.content,
            "metadata": e.metadata_ or {},
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in events
    ]

    return PaginatedHistory(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )
