"""Audit log read API (系统管理 → 审计日志)."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin
from app.models import AuditLog, User
from app.models.database import get_db_session

router = APIRouter()


class AuditOut(BaseModel):
    id: int
    username: str | None
    action: str
    detail: str | None
    ip: str | None
    extra: dict | None
    created_at: datetime


class PaginatedAudit(BaseModel):
    items: list[AuditOut]
    total: int
    page: int
    page_size: int
    actions: list[str]


@router.get("", response_model=PaginatedAudit)
async def list_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    action: str | None = Query(None),
    username: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> PaginatedAudit:
    query = select(AuditLog)
    if action:
        query = query.where(AuditLog.action == action)
    if username:
        query = query.where(AuditLog.username.ilike(f"%{username.strip()}%"))
    query = query.order_by(AuditLog.created_at.desc())

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    actions_rows = await db.execute(
        select(AuditLog.action).distinct().order_by(AuditLog.action)
    )
    return PaginatedAudit(
        items=[
            AuditOut(
                id=row.id,
                username=row.username,
                action=row.action,
                detail=row.detail,
                ip=row.ip,
                extra=row.extra or {},
                created_at=row.created_at,
            )
            for row in rows.scalars()
        ],
        total=total,
        page=page,
        page_size=page_size,
        actions=[a for a in actions_rows.scalars() if a],
    )
