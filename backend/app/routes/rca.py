"""RCA session management endpoints.

Manual trigger (active mode), session listing with pagination,
session detail with timeline, and queue status.
"""

from __future__ import annotations

import asyncio
import html
import io
import json
import re
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    PERM_RCA_TERMINATE,
    get_current_user,
    require_permission,
)
from app.config import settings
from app.models import (
    Alert,
    CollaborationEvent,
    CollaborationEventType,
    RcaReport,
    RcaSession,
    RcaStatus,
    RcaTriggerType,
    User,
)
from app.models.database import get_db_session
from app.services.audit import record_audit
from app.services.hermes import HermesClient
from app.services.rca_runner import _release_slot, run_rca_session

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
    team_id: int = Field(
        default=1,
        description="Deprecated: owning team is taken from the authenticated user",
    )
    created_by: int | None = Field(default=None, description="User ID who triggered")
    service_name: str | None = Field(default=None, description="Affected service")


class TriggerRcaResponse(BaseModel):
    """Response returned after triggering an RCA."""

    session_id: int
    status: str
    position_in_queue: int | None = None


class CancelRcaResponse(BaseModel):
    """Result of manually terminating a queued/running RCA session."""

    session_id: int
    status: str
    hermes_stopped: bool = False


class RcaSessionSummary(BaseModel):
    """Summary fields for list views."""

    id: int
    trigger_type: str
    status: str
    rule_name: str | None = None
    service_name: str | None = None
    alert_count: int | None = None
    trigger_reason: str | None = None
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
    service_name: str | None = None
    alert_count: int | None = None
    trigger_reason: str | None = None
    time_window_start: datetime | None
    time_window_end: datetime | None
    hermes_session_id: str | None
    wecom_chat_id: str | None
    root_cause_summary: str | None
    evidence: list[Any]
    created_at: datetime
    completed_at: datetime | None
    timeline: list[dict[str, Any]] = Field(default_factory=list)


class RcaReportOut(BaseModel):
    """Structured RCA report returned by the report library endpoints."""

    id: int
    session_id: int
    service_name: str | None = None
    alert_count: int
    category: str | None = None
    root_cause: str | None = None
    confidence: float | None = None
    evidence: list[Any] = Field(default_factory=list)
    impacted_services: list[Any] = Field(default_factory=list)
    recommended_actions: list[Any] = Field(default_factory=list)
    created_at: datetime
    # Top3 根因摘要：列表也返回，便于报告库直接展示（缺失时由证据/建议派生）。
    top3: list[str] = Field(default_factory=list)


class RcaSessionReport(RcaReportOut):
    """Report enriched with the session's inbound alerts."""

    session_status: str
    trigger_reason: str | None = None
    time_window_start: datetime | None = None
    time_window_end: datetime | None = None
    alerts: list[dict[str, Any]] = Field(default_factory=list)
    # Top3 根因（结构化结果缺失时由 evidence/recommended_actions 派生）。
    top3: list[str] = Field(default_factory=list)


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


class ExportReportsRequest(BaseModel):
    """Payload for the report-library bulk export (ZIP of rendered reports)."""

    session_ids: list[int] = Field(
        ...,
        min_length=1,
        max_length=200,
        description="要导出的 RCA 会话 ID（去重后按请求顺序打包），单次上限 200 条",
    )
    format: Literal["md", "html"] = Field(
        default="md",
        description="单报告渲染格式：``md``（Markdown）或 ``html``（单文件 HTML）",
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/trigger", response_model=TriggerRcaResponse, status_code=201)
async def trigger_rca(
    req: TriggerRcaRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> TriggerRcaResponse:
    """Manually trigger an RCA session (active mode).

    The session is queued immediately and analysed by the background runner —
    the HTTP request no longer blocks for the whole Hermes call.

    The owning team is always taken from the authenticated user, never from
    the request body, so a caller cannot create a session in another tenant.

    状态一致性（P1-12）：响应里的 ``status`` 不再是“预测值”。因为
    ``BackgroundTasks`` 在响应返回之后才执行，落库状态此刻必然是
    ``QUEUED``；真正开跑时由 :func:`rca_runner.run_rca_session` 改成
    ``RUNNING``。返回 QUEUED 与 DB 完全一致，避免出现“接口说 RUNNING、
    列表里还是 QUEUED”的假象。

    并发闸门：真正的限流在 runner 侧（优先 Redis 计数跨 worker，Redis
    不可用时回退进程内信号量）。这里只做队列可见性统计。
    """
    # ── 队列可见性（以 DB 为唯一事实来源）──────────────────────────────
    active_count = await _count_by_status(db, RcaStatus.RUNNING)
    queued_count = await _count_by_status(db, RcaStatus.QUEUED)
    # 新会话排在本团队已有 QUEUED 之后；runner 拿到空槽后才会转为 RUNNING。
    position = queued_count + 1

    # ── Create session record ───────────────────────────────────────────
    session = RcaSession(
        team_id=user.team_id,
        trigger_type=RcaTriggerType.ACTIVE,
        status=RcaStatus.QUEUED,
        service_name=req.service_name,
        alert_count=1,
        trigger_reason=f"manual_by:{user.username}",
        time_window_start=datetime.fromisoformat(req.time_window_start),
        time_window_end=datetime.fromisoformat(req.time_window_end),
        created_by=req.created_by or user.id,
    )
    db.add(session)
    await db.flush()

    db.add(CollaborationEvent(
        rca_session_id=session.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=f"人工触发 RCA（操作人 {user.username}）",
        metadata_={"data_sources": req.data_sources},
    ))
    await record_audit(
        db, user.username, "人工触发RCA",
        detail=f"session=#{session.id} window={req.time_window_start}~{req.time_window_end}",
        extra={"session_id": session.id},
    )
    await db.commit()
    background.add_task(run_rca_session, session.id)

    logger.info(
        "RCA session {} queued (manual trigger, running={} max={})",
        session.id,
        active_count,
        settings.RCA_MAX_CONCURRENCY,
    )
    return TriggerRcaResponse(
        session_id=session.id,
        status=RcaStatus.QUEUED.value,
        position_in_queue=position,
    )


@router.get("/sessions", response_model=PaginatedResponse)
async def list_rca_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status_filter: str | None = Query(None, alias="status"),
    team_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedResponse:
    """List RCA sessions with pagination and optional filters.

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

    if status_filter:
        query = query.where(RcaSession.status == status_filter)

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
            service_name=r.service_name,
            alert_count=r.alert_count,
            trigger_reason=r.trigger_reason,
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
    user: User = Depends(get_current_user),
) -> RcaSessionDetail:
    """Get full detail for a single RCA session, including timeline."""
    session = await _get_scoped_session(db, session_id, user)

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
        service_name=session.service_name,
        alert_count=session.alert_count,
        trigger_reason=session.trigger_reason,
        time_window_start=session.time_window_start,
        time_window_end=session.time_window_end,
        hermes_session_id=session.hermes_session_id,
        wecom_chat_id=session.wecom_chat_id,
        root_cause_summary=session.root_cause_summary,
        evidence=_session_evidence(session),
        created_at=session.created_at,
        completed_at=session.completed_at,
        timeline=timeline,
    )


@router.get("/queue", response_model=QueueStatus)
async def get_queue_status(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> QueueStatus:
    """Get the current RCA queue state (D-11), scoped to the caller's team."""
    active = await _count_by_status(db, RcaStatus.RUNNING, team_id=user.team_id)
    queued = await _count_by_status(db, RcaStatus.QUEUED, team_id=user.team_id)

    return QueueStatus(
        active_count=active,
        queued_count=queued,
        max_concurrency=settings.RCA_MAX_CONCURRENCY,
    )


@router.get("/reports", response_model=PaginatedResponse)
async def list_reports(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    service: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedResponse:
    """Report library — list structured RCA reports with search."""
    from sqlalchemy import or_

    query = select(RcaReport).where(RcaReport.team_id == user.team_id)
    if service:
        query = query.where(RcaReport.service_name.ilike(f"%{service.strip()}%"))
    if search:
        like = f"%{search.strip()}%"
        query = query.where(or_(
            RcaReport.root_cause.ilike(like),
            RcaReport.service_name.ilike(like),
            RcaReport.category.ilike(like),
        ))
    query = query.order_by(RcaReport.created_at.desc())

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    offset = (page - 1) * page_size
    rows = list((await db.execute(query.offset(offset).limit(page_size))).scalars())
    # Top3 摘要来自会话侧 JSONB（与单报告接口同一派生逻辑），一次批量取回。
    sessions_by_id: dict[int, RcaSession] = {}
    if rows:
        session_rows = await db.execute(
            select(RcaSession).where(RcaSession.id.in_({r.session_id for r in rows}))
        )
        sessions_by_id = {s.id: s for s in session_rows.scalars()}
    items = [
        RcaReportOut(
            id=r.id,
            session_id=r.session_id,
            service_name=r.service_name,
            alert_count=r.alert_count,
            category=r.category,
            root_cause=r.root_cause,
            confidence=r.confidence,
            evidence=r.evidence or [],
            impacted_services=r.impacted_services or [],
            recommended_actions=r.recommended_actions or [],
            created_at=r.created_at,
            top3=(
                _session_top3(sessions_by_id[r.session_id], r)
                if r.session_id in sessions_by_id
                else []
            ),
        ).model_dump()
        for r in rows
    ]
    return PaginatedResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/reports/export")
async def export_reports(
    req: ExportReportsRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> Response:
    """Bulk-export reports as a ZIP archive (one rendered file per session).

    团队隔离：只导出 ``user.team_id`` 下可见的会话；跨团队 / 不存在的会话按
    “不存在”记录在 ``skipped`` 中（不暴露存在性）。已存在但尚无报告的会话
    同样跳过。单个报告渲染失败只影响该文件，其余报告照常打包。

    跳过明细写入压缩包内的 ``README.txt``，同时通过 ``X-Skipped-Count``
    响应头返回数量，便于前端提示。单次上限 200 条（超出由 Pydantic 返回 422）。
    复用单报告渲染函数，不引入第三方文档库。
    """
    ordered: list[int] = []
    seen: set[int] = set()
    for session_id in req.session_ids:
        if session_id not in seen:
            seen.add(session_id)
            ordered.append(session_id)

    session_rows = await db.execute(
        select(RcaSession).where(
            RcaSession.id.in_(ordered), RcaSession.team_id == user.team_id
        )
    )
    sessions = {s.id: s for s in session_rows.scalars()}

    report_rows = await db.execute(
        select(RcaReport).where(RcaReport.session_id.in_(ordered))
    )
    reports = {
        r.session_id: r for r in report_rows.scalars() if r.session_id in sessions
    }

    timelines = await _timeline_summaries_bulk(
        db, [session_id for session_id in ordered if session_id in sessions]
    )

    fmt = req.format
    generated_at = datetime.now(timezone.utc)
    rendered: list[tuple[str, str]] = []
    skipped: list[tuple[int, str]] = []

    for session_id in ordered:
        session = sessions.get(session_id)
        if session is None:
            skipped.append((session_id, "会话不存在或无权访问（跨团队按不存在处理）"))
            continue
        report = reports.get(session_id)
        if report is None:
            skipped.append((session_id, "该会话尚无报告（分析未完成或失败）"))
            continue
        try:
            events, timeline_total = timelines.get(session_id, ([], 0))
            render = _render_report_html if fmt == "html" else _render_report_markdown
            body = render(
                session=session,
                report=report,
                top3=_session_top3(session, report),
                events=events,
                timeline_total=timeline_total,
                generated_at=generated_at,
            )
            rendered.append((
                _export_member_name(
                    session_id, report.service_name or session.service_name, fmt
                ),
                body,
            ))
        except Exception as exc:  # noqa: BLE001 — 单文件失败不能拖垮整包
            logger.warning("报告导出渲染失败 session=#{}: {}", session_id, exc)
            skipped.append((session_id, f"渲染失败（{type(exc).__name__}），已跳过"))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in rendered:
            archive.writestr(name, body.encode("utf-8"))
        if skipped:
            archive.writestr(
                "README.txt",
                _export_readme(fmt, len(rendered), skipped, generated_at).encode("utf-8"),
            )

    stamp = generated_at.astimezone(_CST).strftime("%Y%m%d-%H%M%S")
    filename = f"liumai-rca-reports-{stamp}.zip"
    disposition = (
        f'attachment; filename="{filename}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "no-store",
            "X-Skipped-Count": str(len(skipped)),
        },
    )


def _alert_brief(a: Alert) -> dict[str, Any]:
    return {
        "id": a.id,
        "alert_uid": a.alert_uid,
        "source": a.source,
        "ip": a.ip,
        "ci_name": a.ci_name,
        "ci_application": a.ci_application,
        "content": a.content,
        "severity": a.severity,
        "severity_level": a.severity_level,
        "alert_type": a.alert_type,
        "status": a.status,
        "alert_time": a.alert_time.isoformat() if a.alert_time else None,
        "raw_payload": a.raw_payload or {},
    }


@router.get("/sessions/{session_id}/report", response_model=RcaSessionReport)
async def get_session_report(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> RcaSessionReport:
    """Return the structured report + linked alerts for one RCA session."""
    session = await _get_scoped_session(db, session_id, user)

    result = await db.execute(select(RcaReport).where(RcaReport.session_id == session_id))
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="该会话尚无报告（分析未完成或失败）")

    alerts_q = await db.execute(
        select(Alert).where(Alert.rca_session_id == session_id).order_by(Alert.alert_time.asc())
    )
    return RcaSessionReport(
        id=report.id,
        session_id=session_id,
        service_name=report.service_name,
        alert_count=report.alert_count,
        category=report.category,
        root_cause=report.root_cause,
        confidence=report.confidence,
        evidence=report.evidence or [],
        impacted_services=report.impacted_services or [],
        recommended_actions=report.recommended_actions or [],
        created_at=report.created_at,
        session_status=session.status.value,
        trigger_reason=session.trigger_reason,
        time_window_start=session.time_window_start,
        time_window_end=session.time_window_end,
        alerts=[_alert_brief(a) for a in alerts_q.scalars()],
        top3=_session_top3(session, report),
    )


@router.get("/sessions/{session_id}/report/download")
async def download_session_report(
    session_id: int,
    format: str = Query(
        "md",
        pattern="^(md|html)$",
        description="下载格式：``md``（Markdown）或 ``html``（单文件 HTML）",
    ),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> Response:
    """Render the structured report as a downloadable Markdown / HTML file.

    认证与团队隔离与同文件其他端点一致：跨团队会话按 404 处理，不暴露存在性；
    报告不存在时与 ``GET /sessions/{id}/report`` 返回相同的 404 语义。
    渲染完全使用服务端已有字段（``RcaReport`` + 会话时间线），不依赖文件系统，
    也不引入第三方文档库。
    """
    session = await _get_scoped_session(db, session_id, user)

    result = await db.execute(select(RcaReport).where(RcaReport.session_id == session_id))
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="该会话尚无报告（分析未完成或失败）")

    fmt = (format or "md").strip().lower()
    top3 = _session_top3(session, report)
    events, timeline_total = await _timeline_summary(db, session_id)
    generated_at = datetime.now(timezone.utc)

    if fmt == "html":
        body = _render_report_html(
            session=session,
            report=report,
            top3=top3,
            events=events,
            timeline_total=timeline_total,
            generated_at=generated_at,
        )
        media_type = "text/html; charset=utf-8"
    else:
        body = _render_report_markdown(
            session=session,
            report=report,
            top3=top3,
            events=events,
            timeline_total=timeline_total,
            generated_at=generated_at,
        )
        media_type = "text/markdown; charset=utf-8"

    stamp = generated_at.astimezone(_CST).strftime("%Y%m%d-%H%M%S")
    filename = f"liumai-rca-{session.id}-{stamp}.{fmt}"
    # ASCII 文件名 + RFC 5987 双写，既兼容旧客户端也保留可读名字。
    disposition = (
        f'attachment; filename="{filename}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )
    return Response(
        content=body,
        media_type=media_type,
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "no-store",
        },
    )


@router.get("/sessions/{session_id}/alerts", response_model=list[dict])
async def list_session_alerts(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List inbound alerts attached to a session (including coalesced ones)."""
    await _get_scoped_session(db, session_id, user)
    rows = await db.execute(
        select(Alert).where(Alert.rca_session_id == session_id).order_by(Alert.alert_time.asc())
    )
    return [_alert_brief(a) for a in rows.scalars()]


@router.post("/sessions/{session_id}/rerun")
async def rerun_session(
    session_id: int,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(require_permission(PERM_RCA_TERMINATE)),
) -> dict[str, Any]:
    """Re-run analysis for a failed/completed session."""
    session = await _get_scoped_session(db, session_id, user)
    if session.status in (RcaStatus.QUEUED, RcaStatus.RUNNING):
        raise HTTPException(status_code=409, detail="该会话正在分析中")

    session.status = RcaStatus.QUEUED
    session.completed_at = None
    existing = await db.execute(select(RcaReport).where(RcaReport.session_id == session_id))
    report = existing.scalar_one_or_none()
    if report is not None:
        await db.delete(report)
    db.add(CollaborationEvent(
        rca_session_id=session_id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=f"重新分析（操作人 {user.username}）",
    ))
    await record_audit(db, user.username, "RCA重新分析", detail=f"session=#{session_id}")
    await db.commit()
    background.add_task(run_rca_session, session_id)
    return {"status": "queued", "session_id": session_id}


@router.post("/sessions/{session_id}/cancel", response_model=CancelRcaResponse)
async def cancel_rca_session(
    session_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(require_permission(PERM_RCA_TERMINATE)),
) -> CancelRcaResponse:
    """Manually terminate a QUEUED/RUNNING RCA session.

    权限与隔离：需要 ``rca_terminate`` 权限位；会话按 ``user.team_id`` 隔离，
    跨团队 / 不存在的会话按 404 处理（与同文件其他端点一致，不暴露存在性）。

    状态语义：只有 QUEUED/RUNNING 可以终止；终态会话返回 409
    ``{"detail": "会话已结束"}``。终止后沿用现有枚举置为 ``FAILED``（模型里
    没有 CANCELLED），同时写 ``completed_at`` 与 ``root_cause_summary``
    （``【手动终止】`` 前缀，等价 error_message），并追加时间线事件
    （``metadata.kind = "rca_cancelled"``）与审计记录。

    Hermes 关联：若会话记录了形如 ``run_*`` / ``api-*`` 的
    ``hermes_session_id``，best-effort 调用 ``POST /v1/runs/{id}/stop``
    （硬 5s 超时，失败只 warning，不影响终止结果）。Redis 并发槽位随后
    幂等归还（``_release_slot``），由 TTL 与票据机制防止重复扣减。
    """
    session = await _get_scoped_session(db, session_id, user)
    if session.status not in (RcaStatus.QUEUED, RcaStatus.RUNNING):
        raise HTTPException(status_code=409, detail="会话已结束")

    previous = session.status
    hermes_session_id = (session.hermes_session_id or "").strip()
    now = datetime.now(timezone.utc)

    session.status = RcaStatus.FAILED
    session.completed_at = now
    session.root_cause_summary = (
        f"【手动终止】{user.username} 终止了 RCA 分析"
        f"（原状态 {previous.value}，终止时间 {_fmt_dt(now)}）"
    )[:500]
    db.add(CollaborationEvent(
        rca_session_id=session_id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"【手动终止】{user.username} 终止了 RCA 分析"
            f"（原状态 {previous.value}）。"
            "如需继续，可在会话结束后重新分析。"
        )[:1000],
        metadata_={
            "kind": "rca_cancelled",
            "previous_status": previous.value,
            "operator": user.username,
            "hermes_session_id": hermes_session_id or None,
        },
    ))
    await record_audit(
        db,
        user.username,
        "RCA手动终止",
        detail=(
            f"session=#{session_id} {previous.value}→FAILED；"
            f"hermes_session_id={hermes_session_id or '-'}"
        )[:4000],
        extra={
            "session_id": session_id,
            "previous_status": previous.value,
            "hermes_session_id": hermes_session_id or None,
        },
    )
    await db.commit()

    # 落库之后再访问外部服务：即使 Hermes 挂起 5s，终止状态也已经持久化。
    hermes_stopped = False
    if _is_hermes_run_id(hermes_session_id):
        hermes_stopped = await _stop_hermes_run_best_effort(hermes_session_id)
    else:
        logger.info(
            "RCA 手动终止：session_id={} 无可用 Hermes run_id（{}），跳过 stop",
            session_id,
            hermes_session_id or "empty",
        )

    # 幂等归还 Redis 并发槽位（票据不存在时不会 DECR）。
    await _release_slot(session_id, reason="cancel")

    logger.info(
        "RCA session {} cancelled by {} ({}→FAILED, hermes_stopped={})",
        session_id,
        user.username,
        previous.value,
        hermes_stopped,
    )
    return CancelRcaResponse(
        session_id=session_id,
        status=RcaStatus.FAILED.value,
        hermes_stopped=hermes_stopped,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════


_HERMES_RUN_STOP_TIMEOUT_SECONDS = 5.0


def _is_hermes_run_id(value: str | None) -> bool:
    """Whether *value* looks like a Hermes Runs API id we can stop."""
    candidate = (value or "").strip()
    return candidate.startswith("run_") or candidate.startswith("api-")


async def _stop_hermes_run_best_effort(run_id: str) -> bool:
    """``POST /v1/runs/{id}/stop`` with a hard 5s budget — never raises."""
    client: HermesClient | None = None
    try:
        client = HermesClient(timeout=_HERMES_RUN_STOP_TIMEOUT_SECONDS)
        await asyncio.wait_for(
            client.stop_run(run_id),
            timeout=_HERMES_RUN_STOP_TIMEOUT_SECONDS,
        )
        logger.info("RCA 手动终止：已请求 Hermes 停止 run_id={}", run_id)
        return True
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — stop 失败只 warning，不能影响终止
        logger.warning(
            "RCA 手动终止：Hermes stop 请求失败 run_id={} err={}", run_id, exc,
        )
        return False
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass


async def _get_scoped_session(
    db: AsyncSession, session_id: int, user: User,
) -> RcaSession:
    """Load an RCA session owned by *user*'s team.

    Cross-team access is reported as 404 (not 403) so that session IDs cannot
    be probed across tenants. Admins are not exempt: within this platform an
    admin is still scoped to their own team (same convention as
    ``alerts.py`` / ``root_cause.py``).
    """
    session = await db.get(RcaSession, session_id)
    if session is None or session.team_id != user.team_id:
        raise HTTPException(status_code=404, detail="RCA 会话不存在")
    return session


async def _count_by_status(
    db: AsyncSession, status_: RcaStatus, team_id: int | None = None,
) -> int:
    """Count RCA sessions with a given status, optionally for a single team."""
    query = select(func.count()).where(RcaSession.status == status_.value)
    if team_id is not None:
        query = query.where(RcaSession.team_id == team_id)
    result = await db.execute(query)
    return result.scalar_one()


# ═══════════════════════════════════════════════════════════════════════════════
# Report rendering helpers (Markdown / standalone HTML)
# ═══════════════════════════════════════════════════════════════════════════════
#
# ``RcaSession.evidence`` 是现有 JSONB 字段（无 schema 变更）：P1-5 起写入结构
# ``{"evidence": [...], "top3": [...], "generated_at": "..."}``。历史会话里它
# 仍可能是一个纯 evidence 列表，因此所有读取都必须兼容两种形状。

_CST = timezone(timedelta(hours=8))
_MAX_TIMELINE_SUMMARY = 30
_TIMELINE_ITEM_CHARS = 500


def _text(value: Any) -> str:
    """Best-effort text for JSON values (dict/list → JSON, never raises)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _one_line(value: Any) -> str:
    """Collapse whitespace so a value fits on one Markdown/HTML list line."""
    return re.sub(r"\s+", " ", _text(value)).strip()


def _fmt_dt(value: datetime | None) -> str:
    if value is None:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(_CST).strftime("%Y-%m-%d %H:%M:%S")


def _session_evidence(session: RcaSession) -> list[Any]:
    """Return the evidence list whether ``session.evidence`` is dict or list."""
    raw = session.evidence
    if isinstance(raw, dict):
        raw = raw.get("evidence")
    if isinstance(raw, list):
        return raw
    return [] if raw is None else [raw]


def _top3_line(value: Any) -> str:
    """Normalise one persisted Top3 entry (str or old-platform dict)."""
    if isinstance(value, dict):
        line = _one_line(
            value.get("summary")
            or value.get("title")
            or value.get("root_cause")
            or value.get("conclusion")
            or ""
        )
        if not line:
            return ""
        rank = value.get("rank")
        if rank not in (None, ""):
            line = f"[{rank}] {line}"
        score = value.get("score", value.get("confidence"))
        if score not in (None, ""):
            line += f"（评分 {score}）"
        return line[:500]
    return _one_line(value)[:500]


def _session_top3(session: RcaSession, report: RcaReport) -> list[str]:
    """Top3 from the persisted session JSON, else derive from report fields.

    Persisted shape wins.  Legacy sessions (evidence is a plain list, or the
    analysis predates Top3 persistence) get a deterministic derivation so the
    report never shows an empty section: evidence first, then recommendations.
    """
    raw = session.evidence
    if isinstance(raw, dict):
        stored = raw.get("top3")
        if isinstance(stored, list):
            items = [line for line in (_top3_line(v) for v in stored) if line]
            if items:
                return items[:3]

    derived: list[str] = []
    candidates = [*(report.evidence or []), *(report.recommended_actions or [])]
    for value in candidates:
        line = _one_line(value)
        if line:
            derived.append(f"（派生）{line}"[:500])
        if len(derived) >= 3:
            break
    return derived


async def _timeline_summary(
    db: AsyncSession, session_id: int,
) -> tuple[list[CollaborationEvent], int]:
    """Latest non-heartbeat timeline events (chronological) + total event count."""
    base = select(CollaborationEvent).where(
        CollaborationEvent.rca_session_id == session_id
    )
    total = (
        await db.execute(
            select(func.count())
            .select_from(CollaborationEvent)
            .where(CollaborationEvent.rca_session_id == session_id)
        )
    ).scalar_one()

    rows = await db.execute(
        base.order_by(
            CollaborationEvent.created_at.desc(), CollaborationEvent.id.desc()
        ).limit(_MAX_TIMELINE_SUMMARY * 2)
    )
    events: list[CollaborationEvent] = []
    for event in rows.scalars():
        meta = event.metadata_ if isinstance(event.metadata_, dict) else {}
        if meta.get("kind") == "rca_heartbeat":
            continue  # 心跳是存活信号，不属于报告内容
        events.append(event)
        if len(events) >= _MAX_TIMELINE_SUMMARY:
            break
    events.reverse()
    return events, int(total or 0)


async def _timeline_summaries_bulk(
    db: AsyncSession, session_ids: list[int],
) -> dict[int, tuple[list[CollaborationEvent], int]]:
    """Bulk form of :func:`_timeline_summary` used by the ZIP export.

    Same semantics (latest non-heartbeat events, chronological, max
    ``_MAX_TIMELINE_SUMMARY``; ``total`` counts every event), but issued as
    two queries instead of two per session.
    """
    summaries: dict[int, tuple[list[CollaborationEvent], int]] = {
        session_id: ([], 0) for session_id in session_ids
    }
    if not session_ids:
        return summaries

    totals = (
        await db.execute(
            select(CollaborationEvent.rca_session_id, func.count())
            .where(CollaborationEvent.rca_session_id.in_(session_ids))
            .group_by(CollaborationEvent.rca_session_id)
        )
    ).all()
    total_by_id = {session_id: int(count) for session_id, count in totals}

    rows = await db.execute(
        select(CollaborationEvent)
        .where(CollaborationEvent.rca_session_id.in_(session_ids))
        .order_by(
            CollaborationEvent.rca_session_id.asc(),
            CollaborationEvent.created_at.desc(),
            CollaborationEvent.id.desc(),
        )
    )
    buckets: dict[int, list[CollaborationEvent]] = {
        session_id: [] for session_id in session_ids
    }
    for event in rows.scalars():
        meta = event.metadata_ if isinstance(event.metadata_, dict) else {}
        if meta.get("kind") == "rca_heartbeat":
            continue
        bucket = buckets[event.rca_session_id]
        if len(bucket) >= _MAX_TIMELINE_SUMMARY:
            continue
        bucket.append(event)

    for session_id, events in buckets.items():
        events.reverse()
        summaries[session_id] = (events, total_by_id.get(session_id, 0))
    return summaries


def _export_member_name(
    session_id: int, service: str | None, fmt: str,
) -> str:
    """ASCII/中文安全的 zip 成员名（Windows 解压不允许 ``<>:"/\\|?*``）。"""
    label = re.sub(r"[^\w.-]+", "-", (service or "").strip())[:40].strip("-._")
    if not label:
        label = "report"
    return f"rca-report-{session_id}-{label}.{fmt}"


def _export_readme(
    fmt: str,
    exported: int,
    skipped: list[tuple[int, str]],
    generated_at: datetime,
) -> str:
    """README.txt written into the ZIP when any session was skipped."""
    fmt_label = "HTML" if fmt == "html" else "Markdown"
    lines = [
        "六脉 RCA 报告批量导出",
        f"生成时间：{_fmt_dt(generated_at)}（Asia/Shanghai）",
        f"导出格式：{fmt_label}",
        f"成功：{exported} 份；跳过：{len(skipped)} 份",
        "",
        "跳过明细：",
    ]
    lines.extend(f"- 会话 #{sid}：{reason}" for sid, reason in skipped)
    lines += [
        "",
        "说明：跨团队会话按不存在处理；尚未生成报告的会话会被跳过。",
        "",
    ]
    return "\n".join(lines)


def _confidence_text(confidence: float | None) -> str:
    if confidence is None:
        return "—"
    return f"{max(0.0, min(1.0, confidence)) * 100:.0f}%"


def _md_cell(value: Any) -> str:
    return _one_line(value).replace("|", "\\|")[:500]


def _md_list(values: list[Any], *, numbered: bool = False) -> list[str]:
    lines: list[str] = []
    for idx, value in enumerate(values or [], start=1):
        line = _one_line(value)
        if not line:
            continue
        prefix = f"{idx}. " if numbered else "- "
        lines.append(f"{prefix}{line[:1000]}")
    return lines


def _timeline_md(events: list[CollaborationEvent], total: int) -> list[str]:
    lines = [
        f"共 {total} 条时间线事件，摘要展示最近 {len(events)} 条"
        "（已省略心跳记录）。",
        "",
    ]
    for event in events:
        content = _one_line(event.content or "")[: _TIMELINE_ITEM_CHARS]
        lines.append(f"- {_fmt_dt(event.created_at)}　{content or '（无内容）'}")
    return lines


def _render_report_markdown(
    *,
    session: RcaSession,
    report: RcaReport,
    top3: list[str],
    events: list[CollaborationEvent],
    timeline_total: int,
    generated_at: datetime,
) -> str:
    """Render the report as Markdown (Chinese labels, plain text only)."""
    lines: list[str] = [
        f"# 六脉 RCA 分析报告 · 会话 #{session.id}",
        "",
        "| 字段 | 值 |",
        "| --- | --- |",
        f"| 会话 ID | {session.id} |",
        f"| 服务 | {_md_cell(report.service_name or session.service_name or '—')} |",
        f"| 分类 | {_md_cell(report.category or '—')} |",
        f"| 告警数 | {report.alert_count} |",
        f"| 分析窗口 | {_fmt_dt(session.time_window_start)} ~ "
        f"{_fmt_dt(session.time_window_end)} |",
        f"| 会话状态 | {session.status.value} |",
        f"| 生成时间 | {_fmt_dt(generated_at)} |",
        "",
        "## 一、根因结论",
        "",
        _one_line(report.root_cause or "—")[:4000],
        "",
        "## 二、置信度",
        "",
        _confidence_text(report.confidence),
        "",
        "## 三、Top3 根因",
        "",
    ]
    if top3:
        lines.extend(f"{i}. {line}" for i, line in enumerate(top3, start=1))
    else:
        lines.append("（无 Top3 结论）")

    lines += ["", "## 四、证据链", ""]
    evidence = _md_list(report.evidence or [])
    lines.extend(evidence or ["（无证据记录）"])

    lines += ["", "## 五、影响面", ""]
    impacted = _md_list(report.impacted_services or [])
    lines.extend(impacted or ["（未识别受影响服务）"])

    lines += ["", "## 六、处置建议", ""]
    actions = _md_list(report.recommended_actions or [], numbered=True)
    lines.extend(actions or ["（无处置建议）"])

    lines += ["", "## 七、时间线摘要", ""]
    lines.extend(_timeline_md(events, timeline_total))

    lines += [
        "",
        "---",
        "",
        f"*本报告由六脉 RCA 平台自动生成 · {_fmt_dt(generated_at)}（Asia/Shanghai）*",
        "",
    ]
    return "\n".join(lines)


def _html_list(values: list[Any], *, ordered: bool = False) -> str:
    tag = "ol" if ordered else "ul"
    items = "".join(
        f"<li>{html.escape(_one_line(v)[:1000])}</li>"
        for v in (values or [])
        if _one_line(v)
    )
    return f"<{tag}>{items}</{tag}>" if items else "<p class='muted'>（无）</p>"


def _render_report_html(
    *,
    session: RcaSession,
    report: RcaReport,
    top3: list[str],
    events: list[CollaborationEvent],
    timeline_total: int,
    generated_at: datetime,
) -> str:
    """Render a single-file, self-contained HTML report (inline CSS only)."""
    e = html.escape
    top3_html = (
        "<ol>" + "".join(f"<li>{e(line)}</li>" for line in top3) + "</ol>"
        if top3
        else "<p class='muted'>（无 Top3 结论）</p>"
    )
    timeline_html = "".join(
        "<li><span class='ts'>{ts}</span>{content}</li>".format(
            ts=e(_fmt_dt(ev.created_at)),
            content=e(_one_line(ev.content or "（无内容）")[:_TIMELINE_ITEM_CHARS]),
        )
        for ev in events
    )
    if not timeline_html:
        timeline_html = "<li class='muted'>（无时间线记录）</li>"

    rows = [
        ("会话 ID", f"#{session.id}"),
        ("服务", report.service_name or session.service_name or "—"),
        ("分类", report.category or "—"),
        ("告警数", str(report.alert_count)),
        (
            "分析窗口",
            f"{_fmt_dt(session.time_window_start)} ~ {_fmt_dt(session.time_window_end)}",
        ),
        ("会话状态", session.status.value),
        ("生成时间", _fmt_dt(generated_at)),
    ]
    meta_rows = "".join(
        f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in rows
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>六脉 RCA 报告 · 会话 #{session.id}</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 32px 16px; background: #f5f7fa; color: #1f2937;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    line-height: 1.65;
  }}
  main {{ max-width: 920px; margin: 0 auto; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 40px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  h2 {{ font-size: 16px; margin: 28px 0 10px; padding-left: 10px;
    border-left: 4px solid #2563eb; }}
  .sub {{ color: #6b7280; font-size: 12px; margin-bottom: 20px; }}
  table.meta {{ width: 100%; border-collapse: collapse; font-size: 13px;
    margin-bottom: 8px; }}
  table.meta th {{ text-align: left; width: 110px; color: #6b7280;
    font-weight: 500; padding: 6px 8px; background: #f9fafb;
    border: 1px solid #eef0f3; }}
  table.meta td {{ padding: 6px 8px; border: 1px solid #eef0f3;
    word-break: break-word; }}
  .root {{ background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 8px; padding: 14px 16px; white-space: pre-wrap;
    word-break: break-word; }}
  .conf {{ font-size: 24px; font-weight: 700; color: #2563eb; }}
  ul, ol {{ margin: 8px 0; padding-left: 22px; }}
  li {{ margin: 4px 0; word-break: break-word; }}
  .muted {{ color: #9ca3af; }}
  .timeline {{ list-style: none; padding-left: 0; font-size: 13px; }}
  .timeline li {{ border-bottom: 1px dashed #eef0f3; padding: 7px 0; }}
  .timeline .ts {{ display: inline-block; min-width: 148px; color: #6b7280;
    font-variant-numeric: tabular-nums; font-size: 12px; }}
  footer {{ margin-top: 28px; padding-top: 12px; border-top: 1px solid #eef0f3;
    color: #9ca3af; font-size: 12px; }}
  @media (max-width: 640px) {{ main {{ padding: 20px 16px; }} }}
</style>
</head>
<body>
<main>
  <h1>六脉 RCA 分析报告 · 会话 #{session.id}</h1>
  <p class="sub">根因分析报告 · 由六脉 RCA 平台自动生成</p>

  <table class="meta">{meta_rows}</table>

  <h2>一、根因结论</h2>
  <div class="root">{e(_one_line(report.root_cause or "—")[:4000])}</div>

  <h2>二、置信度</h2>
  <p class="conf">{e(_confidence_text(report.confidence))}</p>

  <h2>三、Top3 根因</h2>
  {top3_html}

  <h2>四、证据链</h2>
  {_html_list(report.evidence or [])}

  <h2>五、影响面</h2>
  {_html_list(report.impacted_services or [])}

  <h2>六、处置建议</h2>
  {_html_list(report.recommended_actions or [], ordered=True)}

  <h2>七、时间线摘要</h2>
  <p class="muted">共 {timeline_total} 条时间线事件，摘要展示最近 {len(events)} 条（已省略心跳记录）。</p>
  <ul class="timeline">{timeline_html}</ul>

  <footer>
    本报告由六脉 RCA 平台自动生成 · {e(_fmt_dt(generated_at))}（Asia/Shanghai）
  </footer>
</main>
</body>
</html>
"""
