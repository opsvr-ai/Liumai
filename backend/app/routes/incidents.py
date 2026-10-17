"""Unified incident center — read-only aggregation across the alert inbox,
in-progress RCA sessions and the report library.

The 告警中心 / RCA 分析 / 报告库 surfaces keep their own (existing) endpoints;
this module only **reads** them and projects a single normalised shape so the
front-end can offer one page with three tabs:

``GET /api/incidents?tab=inbox|active|reports&page=&page_size=&search=``

* ``inbox``   — alerts whose status is pending / triggered / coalesced
  (``alert_pipeline.INBOX_STATUSES``), newest first;
* ``active``  — RCA sessions in ``QUEUED`` / ``RUNNING``, newest first;
* ``reports`` — structured reports for completed RCA sessions, newest first.

``GET /api/incidents/{kind}/{id}`` (``kind = alert | rca | report``) is the
「作战室」detail view: one read-only aggregate with the source row, its alerts,
RCA summary, collaboration timeline, report links, suggested actions and
related events.  Cross-team / missing ids are reported as 404 so they cannot
be probed.

All queries are scoped to ``user.team_id``; the routes never write and never
change the semantics of the existing APIs.  ``counts`` always reports the
team-wide totals of the three tabs (search only narrows ``items``/``total``).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.models import (
    Alert,
    CollaborationEvent,
    RcaReport,
    RcaSession,
    RcaStatus,
    User,
)
from app.models.database import get_db_session
from app.services.alert_pipeline import INBOX_STATUSES, severity_label

router = APIRouter()

IncidentTab = Literal["inbox", "active", "reports"]

#: RCA sessions that count as "进行中" (the only non-terminal states).
ACTIVE_STATUSES: tuple[RcaStatus, ...] = (RcaStatus.QUEUED, RcaStatus.RUNNING)

#: Longest title we return; the UI clamps the text anyway.
_TITLE_LIMIT = 200

#: Workspace timeline: latest non-heartbeat events (ascending in the payload).
_DETAIL_TIMELINE_LIMIT = 50
_DETAIL_TIMELINE_SCAN = 200

#: Related events: same service, around the same window.
_RELATED_LIMIT = 5
_RELATED_HALF_WINDOW = timedelta(hours=24)


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class IncidentItem(BaseModel):
    """One normalised event row shared by all three tabs.

    ``id`` is a composite string (``alert-12`` / ``rca-34`` / ``report-56``)
    because numeric ids from the three source tables overlap.
    ``actions`` is a stable list of action keys the UI may render
    (``trigger`` / ``dismiss`` / ``open_rca`` / ``open_alerts`` / ``cancel`` /
    ``download_md`` / ``download_html``); unknown keys must be ignored.
    """

    id: str
    kind: Literal["alert", "rca", "report"]
    title: str
    service: str | None = None
    severity: str | None = None
    status: str
    created_at: datetime
    rca_session_id: int | None = None
    actions: list[str] = Field(default_factory=list)


class IncidentCounts(BaseModel):
    """Team-wide totals shown as tab badges (search does not change them)."""

    inbox: int
    active: int
    reports: int


class IncidentPage(BaseModel):
    items: list[IncidentItem]
    total: int
    counts: IncidentCounts


class IncidentDetailAlert(BaseModel):
    """One inbound alert rendered in the workspace context column."""

    id: int
    uid: str | None = None
    severity: str | None = None
    content: str | None = None
    time: datetime | None = None


class IncidentTimeWindow(BaseModel):
    """Analysis window (either bound may be unknown)."""

    start: datetime | None = None
    end: datetime | None = None


class IncidentRcaSummary(BaseModel):
    """Compact RCA session projection shared by all three incident kinds."""

    session_id: int
    status: str
    trigger_reason: str | None = None
    root_cause: str | None = None
    confidence: float | None = None
    top3: list[str] = Field(default_factory=list)
    evidence: list[Any] = Field(default_factory=list)
    recommended_actions: list[Any] = Field(default_factory=list)


class IncidentTimelineEntry(BaseModel):
    at: datetime
    type: str
    content: str | None = None


class IncidentReportDownload(BaseModel):
    """Authenticated download paths (``None`` when no report exists)."""

    md: str | None = None
    html: str | None = None


class IncidentReportInfo(BaseModel):
    available: bool
    download: IncidentReportDownload = Field(default_factory=IncidentReportDownload)


class IncidentAction(BaseModel):
    """Suggested action; the UI may ignore unknown keys."""

    key: str
    label: str
    enabled: bool
    reason: str | None = None


class IncidentRelated(BaseModel):
    """Another incident row shown under 关联事件 (composite id, like the list)."""

    id: str
    title: str
    status: str
    created_at: datetime


class IncidentDetail(BaseModel):
    """Unified workspace payload for one alert / RCA session / report."""

    kind: Literal["alert", "rca", "report"]
    id: int
    title: str
    service: str | None = None
    severity: str | None = None
    status: str
    created_at: datetime
    time_window: IncidentTimeWindow | None = None
    alerts: list[IncidentDetailAlert] = Field(default_factory=list)
    rca: IncidentRcaSummary | None = None
    timeline: list[IncidentTimelineEntry] = Field(default_factory=list)
    report: IncidentReportInfo
    actions: list[IncidentAction] = Field(default_factory=list)
    related: list[IncidentRelated] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _clip(value: str | None, limit: int = _TITLE_LIMIT) -> str:
    text = " ".join((value or "").split())
    return text[:limit]


def _search_int(value: str) -> int | None:
    """Return the integer form of *value* when it is purely numeric."""
    return int(value) if value.isdigit() else None


def _inbox_conditions(team_id: int, search: str | None) -> list:
    conditions = [Alert.team_id == team_id, Alert.status.in_(INBOX_STATUSES)]
    if search:
        like = f"%{search}%"
        matching = [
            Alert.alert_uid.ilike(like),
            Alert.ci_name.ilike(like),
            Alert.ci_application.ilike(like),
            Alert.content.ilike(like),
            Alert.source.ilike(like),
            Alert.ip.ilike(like),
        ]
        wanted_id = _search_int(search)
        if wanted_id is not None:
            matching.append(Alert.id == wanted_id)
        conditions.append(or_(*matching))
    return conditions


def _active_conditions(team_id: int, search: str | None) -> list:
    conditions = [
        RcaSession.team_id == team_id,
        RcaSession.status.in_(ACTIVE_STATUSES),
    ]
    if search:
        like = f"%{search}%"
        matching = [
            RcaSession.service_name.ilike(like),
            RcaSession.trigger_reason.ilike(like),
            RcaSession.root_cause_summary.ilike(like),
        ]
        wanted_id = _search_int(search)
        if wanted_id is not None:
            matching.append(RcaSession.id == wanted_id)
        conditions.append(or_(*matching))
    return conditions


def _report_conditions(team_id: int, search: str | None) -> list:
    # The owning session is the tenancy authority (RcaReport.team_id is kept
    # in sync by the runner, but the session scopes the report list).
    conditions = [
        RcaSession.team_id == team_id,
        RcaSession.status == RcaStatus.COMPLETED,
    ]
    if search:
        like = f"%{search}%"
        matching = [
            RcaReport.service_name.ilike(like),
            RcaReport.category.ilike(like),
            RcaReport.root_cause.ilike(like),
            RcaSession.service_name.ilike(like),
        ]
        wanted_id = _search_int(search)
        if wanted_id is not None:
            matching.extend([
                RcaReport.id == wanted_id,
                RcaReport.session_id == wanted_id,
            ])
        conditions.append(or_(*matching))
    return conditions


async def _counts(db: AsyncSession, team_id: int) -> IncidentCounts:
    inbox = (
        await db.execute(
            select(func.count()).select_from(Alert).where(*_inbox_conditions(team_id, None))
        )
    ).scalar_one()
    active = (
        await db.execute(
            select(func.count())
            .select_from(RcaSession)
            .where(*_active_conditions(team_id, None))
        )
    ).scalar_one()
    reports = (
        await db.execute(
            select(func.count())
            .select_from(RcaReport)
            .join(RcaSession, RcaSession.id == RcaReport.session_id)
            .where(*_report_conditions(team_id, None))
        )
    ).scalar_one()
    return IncidentCounts(inbox=int(inbox), active=int(active), reports=int(reports))


def _alert_item(alert: Alert) -> IncidentItem:
    actions: list[str] = []
    if alert.status == "pending":
        actions.extend(["trigger", "dismiss"])
    if alert.rca_session_id:
        actions.append("open_rca")
    actions.append("open_alerts")
    severity = (
        severity_label(alert.severity_level)
        if alert.severity_level is not None
        else (alert.severity or None)
    )
    return IncidentItem(
        id=f"alert-{alert.id}",
        kind="alert",
        title=_clip(
            alert.content or alert.alert_uid or alert.ci_name or f"告警 #{alert.id}"
        ),
        service=(
            alert.ci_application or alert.ci_name or alert.source or None
        ),
        severity=severity,
        status=alert.status,
        created_at=alert.created_at,
        rca_session_id=alert.rca_session_id,
        actions=actions,
    )


def _session_item(session: RcaSession) -> IncidentItem:
    service = session.service_name or None
    title = f"{service or '未知服务'} · RCA #{session.id}"
    return IncidentItem(
        id=f"rca-{session.id}",
        kind="rca",
        title=_clip(title),
        service=service,
        severity=None,
        status=session.status.value,
        created_at=session.created_at,
        rca_session_id=session.id,
        actions=["open_rca", "cancel"],
    )


def _report_item(report: RcaReport, session: RcaSession) -> IncidentItem:
    service = report.service_name or session.service_name or None
    title = _clip(
        report.root_cause
        or report.category
        or f"{service or '未知服务'} · RCA 报告 #{session.id}"
    )
    return IncidentItem(
        id=f"report-{report.id}",
        kind="report",
        title=title,
        service=service,
        severity=None,
        status=session.status.value,
        created_at=report.created_at,
        rca_session_id=session.id,
        actions=["open_rca", "download_md", "download_html"],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Workspace (detail) helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _one_line(value: Any) -> str:
    """Best-effort single-line text for a JSON value (never raises)."""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(value)
    return " ".join(text.split())


def _alert_severity(alert: Alert) -> str | None:
    if alert.severity_level is not None:
        return severity_label(alert.severity_level)
    return alert.severity or None


def _alert_service(alert: Alert) -> str | None:
    return alert.ci_application or alert.ci_name or alert.source or None


def _alert_title(alert: Alert) -> str:
    return _clip(
        alert.content or alert.alert_uid or alert.ci_name or f"告警 #{alert.id}"
    )


def _detail_alert(alert: Alert) -> IncidentDetailAlert:
    return IncidentDetailAlert(
        id=alert.id,
        uid=alert.alert_uid,
        severity=_alert_severity(alert),
        content=alert.content,
        time=alert.alert_time or alert.created_at,
    )


def _session_title(session: RcaSession) -> str:
    return _clip(f"{session.service_name or '未知服务'} · RCA #{session.id}")


def _session_evidence(session: RcaSession) -> list[Any]:
    """Return the evidence list whether ``session.evidence`` is dict or list."""
    raw = session.evidence
    if isinstance(raw, dict):
        raw = raw.get("evidence")
    if isinstance(raw, list):
        return raw
    return [] if raw is None else [raw]


def _top3_line(value: Any) -> str:
    """Normalise one persisted Top3 entry (str or legacy dict)."""
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


def _session_top3(session: RcaSession, report: RcaReport | None) -> list[str]:
    """Persisted Top3 first, then a deterministic derivation (same as RCA page)."""
    raw = session.evidence
    if isinstance(raw, dict):
        stored = raw.get("top3")
        if isinstance(stored, list):
            items = [line for line in (_top3_line(v) for v in stored) if line]
            if items:
                return items[:3]

    candidates: list[Any] = []
    if report is not None:
        candidates.extend(report.evidence or [])
        candidates.extend(report.recommended_actions or [])
    if not candidates:
        candidates.extend(_session_evidence(session))

    derived: list[str] = []
    for value in candidates:
        line = _one_line(value)
        if line:
            derived.append(f"（派生）{line}"[:500])
        if len(derived) >= 3:
            break
    return derived


def _session_window(session: RcaSession) -> IncidentTimeWindow | None:
    if session.time_window_start is None and session.time_window_end is None:
        return None
    return IncidentTimeWindow(
        start=session.time_window_start,
        end=session.time_window_end,
    )


def _highest_severity(alerts: list[Alert]) -> str | None:
    """Highest alert severity in a session (level 1 = 严重)."""
    scored = [
        (alert.severity_level if alert.severity_level is not None else 99, _alert_severity(alert))
        for alert in alerts
    ]
    scored = [(level, label) for level, label in scored if label]
    if not scored:
        return None
    return min(scored, key=lambda item: item[0])[1]


async def _report_for_session(
    db: AsyncSession, session_id: int
) -> RcaReport | None:
    rows = await db.execute(select(RcaReport).where(RcaReport.session_id == session_id))
    return rows.scalar_one_or_none()


async def _alerts_for_session(
    db: AsyncSession, session_id: int, team_id: int | None = None
) -> list[Alert]:
    conditions = [Alert.rca_session_id == session_id]
    if team_id is not None:
        conditions.append(Alert.team_id == team_id)
    rows = await db.execute(
        select(Alert)
        .where(*conditions)
        .order_by(Alert.alert_time.asc(), Alert.id.asc())
    )
    return list(rows.scalars())


async def _timeline_for_session(
    db: AsyncSession, session_id: int
) -> list[IncidentTimelineEntry]:
    """Latest 50 non-heartbeat collaboration events, returned chronologically."""
    rows = await db.execute(
        select(CollaborationEvent)
        .where(CollaborationEvent.rca_session_id == session_id)
        .order_by(
            CollaborationEvent.created_at.desc(),
            CollaborationEvent.id.desc(),
        )
        .limit(_DETAIL_TIMELINE_SCAN)
    )
    entries: list[IncidentTimelineEntry] = []
    for event in rows.scalars():
        meta = event.metadata_ if isinstance(event.metadata_, dict) else {}
        if meta.get("kind") == "rca_heartbeat":
            continue  # 心跳是存活信号，不属于作战室时间线
        entries.append(
            IncidentTimelineEntry(
                at=event.created_at,
                type=event.event_type.value,
                content=event.content,
            )
        )
        if len(entries) >= _DETAIL_TIMELINE_LIMIT:
            break
    entries.reverse()
    return entries


def _rca_summary(
    session: RcaSession, report: RcaReport | None
) -> IncidentRcaSummary:
    evidence = _session_evidence(session)
    if not evidence and report is not None:
        evidence = list(report.evidence or [])
    root_cause = (report.root_cause if report is not None else None) or (
        session.root_cause_summary
    )
    return IncidentRcaSummary(
        session_id=session.id,
        status=session.status.value,
        trigger_reason=session.trigger_reason,
        root_cause=root_cause,
        confidence=report.confidence if report is not None else None,
        top3=_session_top3(session, report),
        evidence=evidence,
        recommended_actions=(
            list(report.recommended_actions or []) if report is not None else []
        ),
    )


def _report_info(
    session: RcaSession, report: RcaReport | None
) -> IncidentReportInfo:
    if report is None:
        return IncidentReportInfo(available=False, download=IncidentReportDownload())
    base = f"/api/rca/sessions/{session.id}/report/download"
    return IncidentReportInfo(
        available=True,
        download=IncidentReportDownload(
            md=f"{base}?format=md",
            html=f"{base}?format=html",
        ),
    )


def _detail_actions(
    kind: Literal["alert", "rca", "report"],
    session: RcaSession | None,
    report_available: bool,
) -> list[IncidentAction]:
    """Stable action list; disabled entries explain why in ``reason``."""
    actions: list[IncidentAction] = []

    if session is not None:
        active = session.status in ACTIVE_STATUSES
        actions.append(
            IncidentAction(key="open_rca", label="查看 RCA 详情", enabled=True)
        )
        actions.append(
            IncidentAction(
                key="rerun",
                label="重新分析",
                enabled=not active,
                reason="分析进行中，无法重新分析" if active else None,
            )
        )
        if kind != "report":
            actions.append(
                IncidentAction(
                    key="cancel",
                    label="终止",
                    enabled=active,
                    reason="会话已结束，无法终止" if not active else None,
                )
            )
        for fmt in ("md", "html"):
            actions.append(
                IncidentAction(
                    key=f"download_{fmt}",
                    label=f"下载报告 {fmt.upper()}",
                    enabled=report_available,
                    reason=None if report_available else "暂无报告（分析未完成或失败）",
                )
            )

    if kind == "alert":
        actions.append(
            IncidentAction(key="open_alerts", label="前往告警中心", enabled=True)
        )
    return actions


async def _related_sessions(
    db: AsyncSession,
    session: RcaSession,
    *,
    limit: int = _RELATED_LIMIT,
) -> list[RcaSession]:
    """Same-service sessions around the same window, newest first."""
    if not session.service_name:
        return []

    start = session.time_window_start or (session.created_at - _RELATED_HALF_WINDOW)
    end = session.time_window_end or (session.created_at + _RELATED_HALF_WINDOW)
    if start > end:
        start, end = end, start

    rows = await db.execute(
        select(RcaSession)
        .where(
            RcaSession.team_id == session.team_id,
            RcaSession.service_name == session.service_name,
            RcaSession.id != session.id,
            RcaSession.created_at >= start,
            RcaSession.created_at <= end,
        )
        .order_by(RcaSession.created_at.desc(), RcaSession.id.desc())
        .limit(limit)
    )
    return list(rows.scalars())


async def _related_alerts(
    db: AsyncSession,
    alert: Alert,
    *,
    limit: int = _RELATED_LIMIT,
) -> list[Alert]:
    """Other alerts for the same service within ±24h."""
    service = _alert_service(alert)
    if not service or alert.created_at is None:
        return []

    anchor = alert.alert_time or alert.created_at
    start = anchor - _RELATED_HALF_WINDOW
    end = anchor + _RELATED_HALF_WINDOW
    rows = await db.execute(
        select(Alert)
        .where(
            Alert.team_id == alert.team_id,
            Alert.id != alert.id,
            or_(
                Alert.ci_application == service,
                Alert.ci_name == service,
                Alert.source == service,
            ),
            Alert.created_at >= start,
            Alert.created_at <= end,
        )
        .order_by(Alert.created_at.desc(), Alert.id.desc())
        .limit(limit)
    )
    return list(rows.scalars())


def _related_item_session(session: RcaSession) -> IncidentRelated:
    return IncidentRelated(
        id=f"rca-{session.id}",
        title=_session_title(session),
        status=session.status.value,
        created_at=session.created_at,
    )


def _related_item_alert(alert: Alert) -> IncidentRelated:
    return IncidentRelated(
        id=f"alert-{alert.id}",
        title=_alert_title(alert),
        status=alert.status,
        created_at=alert.created_at,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Route
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=IncidentPage)
@router.get("/", response_model=IncidentPage, include_in_schema=False)
async def list_incidents(
    tab: IncidentTab = Query("inbox", description="inbox | active | reports"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None, max_length=200),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> IncidentPage:
    """Return one page of the unified event list plus the tab counters.

    Read-only: no rows are modified and the existing alert/RCA/report APIs are
    untouched.  Everything is scoped to the caller's team; IDs from another
    team simply never appear (there is nothing to probe on this route).
    """
    query = (search or "").strip() or None
    team_id = user.team_id
    offset = (page - 1) * page_size

    if tab == "inbox":
        conditions = _inbox_conditions(team_id, query)
        total = (
            await db.execute(
                select(func.count()).select_from(Alert).where(*conditions)
            )
        ).scalar_one()
        rows = await db.execute(
            select(Alert)
            .where(*conditions)
            .order_by(Alert.created_at.desc(), Alert.id.desc())
            .offset(offset)
            .limit(page_size)
        )
        items = [_alert_item(alert) for alert in rows.scalars()]
    elif tab == "active":
        conditions = _active_conditions(team_id, query)
        total = (
            await db.execute(
                select(func.count()).select_from(RcaSession).where(*conditions)
            )
        ).scalar_one()
        rows = await db.execute(
            select(RcaSession)
            .where(*conditions)
            .order_by(RcaSession.created_at.desc(), RcaSession.id.desc())
            .offset(offset)
            .limit(page_size)
        )
        items = [_session_item(session) for session in rows.scalars()]
    else:  # reports
        conditions = _report_conditions(team_id, query)
        total = (
            await db.execute(
                select(func.count())
                .select_from(RcaReport)
                .join(RcaSession, RcaSession.id == RcaReport.session_id)
                .where(*conditions)
            )
        ).scalar_one()
        rows = await db.execute(
            select(RcaReport, RcaSession)
            .join(RcaSession, RcaSession.id == RcaReport.session_id)
            .where(*conditions)
            .order_by(RcaReport.created_at.desc(), RcaReport.id.desc())
            .offset(offset)
            .limit(page_size)
        )
        items = [_report_item(report, session) for report, session in rows.all()]

    return IncidentPage(
        items=items,
        total=int(total),
        counts=await _counts(db, team_id),
    )


@router.get("/{kind}/{incident_id}", response_model=IncidentDetail)
async def get_incident_detail(
    kind: str,
    incident_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> IncidentDetail:
    """Unified read-only "作战室" payload for one alert / RCA session / report.

    Team isolation is absolute: a row owned by another team is reported as
    404, exactly like a missing row, so ids cannot be probed across tenants.
    Only SELECTs are issued; no row is modified and no existing API changes.
    """
    team_id = user.team_id

    # ── alert ────────────────────────────────────────────────────────────
    if kind == "alert":
        alert = await db.get(Alert, incident_id)
        if alert is None or alert.team_id != team_id:
            raise HTTPException(status_code=404, detail="事件不存在")

        session: RcaSession | None = None
        if alert.rca_session_id is not None:
            candidate = await db.get(RcaSession, alert.rca_session_id)
            if candidate is not None and candidate.team_id == team_id:
                session = candidate

        report = (
            await _report_for_session(db, session.id)
            if session is not None
            else None
        )
        alerts = (
            await _alerts_for_session(db, session.id, team_id)
            if session is not None
            else [alert]
        )
        if not any(item.id == alert.id for item in alerts):
            alerts.insert(0, alert)

        if session is not None:
            time_window = _session_window(session) or IncidentTimeWindow(
                start=alert.alert_time or alert.created_at,
                end=alert.created_at or alert.alert_time,
            )
        else:
            time_window = IncidentTimeWindow(
                start=alert.alert_time or alert.created_at,
                end=alert.created_at or alert.alert_time,
            )

        related_alerts = await _related_alerts(db, alert)
        return IncidentDetail(
            kind="alert",
            id=alert.id,
            title=_alert_title(alert),
            service=_alert_service(alert),
            severity=_alert_severity(alert),
            status=alert.status,
            created_at=alert.created_at,
            time_window=time_window,
            alerts=[_detail_alert(item) for item in alerts],
            rca=_rca_summary(session, report) if session is not None else None,
            timeline=(
                await _timeline_for_session(db, session.id)
                if session is not None
                else []
            ),
            report=_report_info(session, report) if session is not None else IncidentReportInfo(
                available=False,
                download=IncidentReportDownload(),
            ),
            actions=_detail_actions(
                "alert", session, report is not None
            ),
            related=[_related_item_alert(item) for item in related_alerts],
        )

    # ── RCA session ──────────────────────────────────────────────────────
    if kind == "rca":
        session = await db.get(RcaSession, incident_id)
        if session is None or session.team_id != team_id:
            raise HTTPException(status_code=404, detail="事件不存在")

        report = await _report_for_session(db, session.id)
        alerts = await _alerts_for_session(db, session.id, team_id)
        related = await _related_sessions(db, session)
        return IncidentDetail(
            kind="rca",
            id=session.id,
            title=_session_title(session),
            service=session.service_name or None,
            severity=_highest_severity(alerts),
            status=session.status.value,
            created_at=session.created_at,
            time_window=_session_window(session),
            alerts=[_detail_alert(item) for item in alerts],
            rca=_rca_summary(session, report),
            timeline=await _timeline_for_session(db, session.id),
            report=_report_info(session, report),
            actions=_detail_actions("rca", session, report is not None),
            related=[_related_item_session(item) for item in related],
        )

    # ── report ───────────────────────────────────────────────────────────
    if kind == "report":
        report = await db.get(RcaReport, incident_id)
        if report is None:
            raise HTTPException(status_code=404, detail="事件不存在")

        session = await db.get(RcaSession, report.session_id)
        if session is None or session.team_id != team_id:
            raise HTTPException(status_code=404, detail="事件不存在")

        alerts = await _alerts_for_session(db, session.id, team_id)
        peers = await _related_sessions(db, session, limit=_RELATED_LIMIT - 1)
        service = report.service_name or session.service_name or None
        title = _clip(
            report.root_cause
            or report.category
            or f"{service or '未知服务'} · RCA 报告 #{session.id}"
        )
        return IncidentDetail(
            kind="report",
            id=report.id,
            title=title,
            service=service,
            severity=_highest_severity(alerts),
            status=session.status.value,
            created_at=report.created_at,
            time_window=_session_window(session),
            alerts=[_detail_alert(item) for item in alerts],
            rca=_rca_summary(session, report),
            timeline=await _timeline_for_session(db, session.id),
            report=_report_info(session, report),
            actions=_detail_actions("report", session, True),
            related=[
                _related_item_session(session),
                *[_related_item_session(item) for item in peers],
            ],
        )

    raise HTTPException(status_code=404, detail="事件不存在")
