"""Audit-trail helper.

Every operator/system action worth tracing (webhook ingestion, RCA trigger,
policy change, knowledge annotation) is persisted to ``audit_logs`` so it can
be reviewed in the 系统管理 → 审计日志 view.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog


async def record_audit(
    db: AsyncSession,
    username: str | None,
    action: str,
    detail: str = "",
    ip: str = "",
    extra: dict[str, Any] | None = None,
) -> None:
    """Append one audit record (flushed, committed by the request session)."""
    db.add(
        AuditLog(
            username=(username or "system")[:255],
            action=action[:100],
            detail=(detail or "")[:4000],
            ip=(ip or "")[:100],
            extra=extra or {},
        )
    )
    await db.flush()
