"""Patrol (巡检) suggestions — deterministic rule engine, no LLM calls.

Endpoints (read-only, team-scoped):

* ``GET /api/patrol/suggestions?service=&limit=50`` — ranked inspection items.
* ``GET /api/patrol/summary`` — counts + top services for the dashboard.

Rules (all evaluated over the caller's team only; windows are relative to the
request time, thresholds live at the top of this module):

1. ``high_alert_freq`` — a service with **more than 20 alerts in 24h**.
2. ``recurring_cause`` — the same root cause appears **≥ 2 times in the last
   5 RCA sessions** of a service (7-day window).
3. ``failed_sessions`` — **FAILED** sessions in the last 7 days and/or
   **QUEUED** sessions stuck for more than 30 minutes (any age).
4. ``coverage_gap`` — a service with alerts in the last 30 days but **no RCA
   session at all** in that window.
5. ``low_confidence`` — **≥ 50 %** of a service's last-30-day reports carry a
   confidence **below 0.5** (minimum 3 reports with a confidence value).

Every item carries concrete counts / timestamps in ``evidence``.  Results are
cached in-process for 60 seconds per ``(team_id, service)``; nothing is written
to the database and no model/LLM is invoked.
"""

from __future__ import annotations

import hashlib
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.models import Alert, RcaReport, RcaSession, RcaStatus, User
from app.models.database import get_db_session

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Rule thresholds (module-level constants — deterministic by design)
# ═══════════════════════════════════════════════════════════════════════════════

#: Rule 1 — high-frequency alerts.
HIGH_ALERT_WINDOW_HOURS = 24
HIGH_ALERT_THRESHOLD = 20

#: Rule 2 — recurring root cause.
RECURRING_CAUSE_WINDOW_DAYS = 7
RECURRING_CAUSE_LOOKBACK_SESSIONS = 5
RECURRING_CAUSE_MIN_REPEAT = 2

#: Rule 3 — failed / stuck RCA sessions.
FAILED_SESSION_WINDOW_DAYS = 7
QUEUED_TIMEOUT_MINUTES = 30

#: Rule 4 — RCA coverage gap vs alerts.
COVERAGE_GAP_WINDOW_DAYS = 30

#: Rule 5 — unreliable report conclusions.
LOW_CONFIDENCE_WINDOW_DAYS = 30
LOW_CONFIDENCE_THRESHOLD = 0.5
LOW_CONFIDENCE_MIN_REPORTS = 3
LOW_CONFIDENCE_RATIO_THRESHOLD = 0.5

#: In-process response cache.
CACHE_TTL_SECONDS = 60
CACHE_MAX_ENTRIES = 128

#: Summary top services.
SUMMARY_TOP_SERVICES = 5

#: Row scan cap per source table (keeps a single request bounded).
SCAN_LIMIT = 2000

_SEVERITY_ORDER: dict[str, int] = {"high": 0, "medium": 1, "low": 2}

#: Placeholder for sessions / reports without a service name.
UNKNOWN_SERVICE = "未命名服务"


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class SuggestionItem(BaseModel):
    id: str
    severity: Literal["high", "medium", "low"]
    service: str | None = None
    title: str
    reason: str
    evidence: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    related_session_ids: list[int] = Field(default_factory=list)
    suggested_action: str


class SuggestionStats(BaseModel):
    """``total`` / ``by_severity`` / ``services`` describe the returned items."""

    total: int
    by_severity: dict[str, int]
    services: int


class SuggestionList(BaseModel):
    generated_at: datetime
    items: list[SuggestionItem] = Field(default_factory=list)
    stats: SuggestionStats


class TopService(BaseModel):
    service: str
    count: int


class PatrolSummary(BaseModel):
    generated_at: datetime
    total: int
    by_severity: dict[str, int]
    top_services: list[TopService] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════════
# Cache (process-local, 60s TTL)
# ═══════════════════════════════════════════════════════════════════════════════

_CACHE: dict[tuple[int, str | None], tuple[float, datetime, list[SuggestionItem]]] = {}


def _cache_get(
    key: tuple[int, str | None],
) -> tuple[datetime, list[SuggestionItem]] | None:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    expires_at, generated_at, items = entry
    if expires_at <= time.monotonic():
        _CACHE.pop(key, None)
        return None
    return generated_at, items


def _cache_set(
    key: tuple[int, str | None],
    generated_at: datetime,
    items: list[SuggestionItem],
) -> None:
    now = time.monotonic()
    _CACHE[key] = (now + CACHE_TTL_SECONDS, generated_at, items)
    if len(_CACHE) <= CACHE_MAX_ENTRIES:
        return
    # Drop expired entries first, then the oldest insertion (dict is ordered).
    for stale in [k for k, (expires_at, _, _) in _CACHE.items() if expires_at <= now]:
        _CACHE.pop(stale, None)
    while len(_CACHE) > CACHE_MAX_ENTRIES:
        oldest = next(iter(_CACHE))
        if oldest == key:
            break
        _CACHE.pop(oldest, None)


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _clean_text(value: Any, limit: int = 300) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def _clean_service(value: Any) -> str | None:
    text = _clean_text(value, 255)
    return text or None


def _service_key(value: Any) -> str | None:
    name = _clean_service(value)
    return name.casefold() if name else None


def _digest(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _fmt_dt(value: datetime | None) -> str:
    dt = _as_utc(value)
    if dt is None:
        return "—"
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def _ids(values: list[int]) -> str:
    """Render up to 10 ids compactly for evidence strings."""
    shown = values[:10]
    suffix = f" 等 {len(values)} 个" if len(values) > len(shown) else ""
    return "、".join(f"#{value}" for value in shown) + suffix


def _earlier(current: datetime | None, candidate: datetime | None) -> datetime | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    current_utc = _as_utc(current)
    candidate_utc = _as_utc(candidate)
    assert current_utc is not None and candidate_utc is not None
    return candidate if candidate_utc < current_utc else current


def _later(current: datetime | None, candidate: datetime | None) -> datetime | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    current_utc = _as_utc(current)
    candidate_utc = _as_utc(candidate)
    assert current_utc is not None and candidate_utc is not None
    return candidate if candidate_utc > current_utc else current


def _display_service(key: str | None, names: dict[str | None, set[str]]) -> str:
    values = names.get(key)
    if values:
        return min(values)
    return UNKNOWN_SERVICE


def _root_cause_text(session: RcaSession, report: RcaReport | None) -> str | None:
    """Best root-cause text for one session (report first, summary fallback).

    System-written summaries (``【失败】`` / ``【系统接管】``) are not real
    conclusions and must not feed the recurrence rule.
    """
    text = _clean_text(report.root_cause if report is not None else None, 400)
    if not text:
        text = _clean_text(session.root_cause_summary, 400)
    if not text or text.startswith("【失败】") or text.startswith("【系统接管】"):
        return None
    return text


def _suggestion_id(rule: str, service_key: str | None) -> str:
    return f"{rule}:{_digest(service_key or UNKNOWN_SERVICE)}"


def _by_severity(items: list[SuggestionItem]) -> dict[str, int]:
    counts = {"high": 0, "medium": 0, "low": 0}
    for item in items:
        counts[item.severity] += 1
    return counts


def _sorted_items(items: list[SuggestionItem]) -> list[SuggestionItem]:
    return sorted(
        items,
        key=lambda item: (
            _SEVERITY_ORDER[item.severity],
            -item.confidence,
            item.service or "",
            item.id,
        ),
    )


class _AlertStat:
    """Merged per-service alert counters (SQL groups, Python merges variants)."""

    __slots__ = ("count", "first_at", "last_at")

    def __init__(self) -> None:
        self.count = 0
        self.first_at: datetime | None = None
        self.last_at: datetime | None = None

    def merge(
        self,
        count: int,
        first_at: datetime | None,
        last_at: datetime | None,
    ) -> None:
        self.count += count
        self.first_at = _earlier(self.first_at, first_at)
        self.last_at = _later(self.last_at, last_at)


# ═══════════════════════════════════════════════════════════════════════════════
# Data loading + rules
# ═══════════════════════════════════════════════════════════════════════════════


async def _compute_suggestions(
    db: AsyncSession,
    team_id: int,
    service: str | None,
) -> tuple[datetime, list[SuggestionItem]]:
    """Run all five rules over one team's recent data (SELECTs only)."""
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=HIGH_ALERT_WINDOW_HOURS)
    cutoff_7d = now - timedelta(days=RECURRING_CAUSE_WINDOW_DAYS)
    cutoff_30d = now - timedelta(days=COVERAGE_GAP_WINDOW_DAYS)
    pattern = f"%{service.strip()}%" if service else None

    names: dict[str | None, set[str]] = defaultdict(set)
    items: list[SuggestionItem] = []

    # ── alerts: 24h and 30d aggregates per service ────────────────────────
    alert_service = func.coalesce(
        func.nullif(Alert.ci_application, ""),
        func.nullif(Alert.ci_name, ""),
    )
    alert_time = func.coalesce(Alert.alert_time, Alert.created_at)

    def _alert_query(since: datetime):
        conditions = [
            Alert.team_id == team_id,
            alert_time >= since,
            alert_service.is_not(None),
        ]
        if pattern:
            conditions.append(
                or_(
                    Alert.ci_application.ilike(pattern),
                    Alert.ci_name.ilike(pattern),
                )
            )
        return (
            select(
                alert_service.label("service"),
                func.count().label("total"),
                func.min(alert_time).label("first_at"),
                func.max(alert_time).label("last_at"),
            )
            .where(*conditions)
            .group_by(alert_service)
        )

    alerts_30d: dict[str, _AlertStat] = {}
    alerts_24h: dict[str, _AlertStat] = {}
    for row in (await db.execute(_alert_query(cutoff_30d))).all():
        name = _clean_service(row.service)
        if not name:
            continue
        key = name.casefold()
        names[key].add(name)
        alerts_30d.setdefault(key, _AlertStat()).merge(
            int(row.total), row.first_at, row.last_at
        )
    for row in (await db.execute(_alert_query(cutoff_24h))).all():
        name = _clean_service(row.service)
        if not name:
            continue
        key = name.casefold()
        names[key].add(name)
        alerts_24h.setdefault(key, _AlertStat()).merge(
            int(row.total), row.first_at, row.last_at
        )

    # ── RCA sessions (30d, plus any still-QUEUED session of any age) ──────
    session_stmt = (
        select(RcaSession)
        .where(
            RcaSession.team_id == team_id,
            or_(
                RcaSession.created_at >= cutoff_30d,
                RcaSession.status == RcaStatus.QUEUED,
            ),
        )
        .order_by(RcaSession.created_at.desc(), RcaSession.id.desc())
        .limit(SCAN_LIMIT)
    )
    if pattern:
        session_stmt = session_stmt.where(RcaSession.service_name.ilike(pattern))
    sessions = list((await db.execute(session_stmt)).scalars())

    sessions_by_service: dict[str | None, list[RcaSession]] = defaultdict(list)
    failed_by_service: dict[str | None, list[RcaSession]] = defaultdict(list)
    queued_by_service: dict[str | None, list[RcaSession]] = defaultdict(list)
    queued_cutoff = now - timedelta(minutes=QUEUED_TIMEOUT_MINUTES)

    for session in sessions:
        key = _service_key(session.service_name)
        if key is not None:
            names[key].add(_clean_service(session.service_name) or key)
        sessions_by_service[key].append(session)

        created_at = _as_utc(session.created_at)
        if (
            session.status == RcaStatus.FAILED
            and created_at is not None
            and created_at >= cutoff_7d
        ):
            failed_by_service[key].append(session)
        elif (
            session.status == RcaStatus.QUEUED
            and created_at is not None
            and created_at <= queued_cutoff
        ):
            queued_by_service[key].append(session)

    # ── structured reports (30d, joined to their team-scoped session) ─────
    report_stmt = (
        select(RcaReport, RcaSession)
        .join(RcaSession, RcaSession.id == RcaReport.session_id)
        .where(
            RcaSession.team_id == team_id,
            RcaSession.created_at >= cutoff_30d,
        )
        .order_by(RcaSession.created_at.desc(), RcaReport.id.desc())
        .limit(SCAN_LIMIT)
    )
    if pattern:
        report_stmt = report_stmt.where(
            or_(
                RcaReport.service_name.ilike(pattern),
                RcaSession.service_name.ilike(pattern),
            )
        )
    report_rows = (await db.execute(report_stmt)).all()

    reports_by_session: dict[int, RcaReport] = {}
    reports_by_service: dict[str, list[RcaReport]] = defaultdict(list)
    for report, session in report_rows:
        reports_by_session[report.session_id] = report
        key = _service_key(report.service_name) or _service_key(session.service_name)
        if key is None:
            continue
        display = (
            _clean_service(report.service_name)
            or _clean_service(session.service_name)
        )
        if display:
            names[key].add(display)
        reports_by_service[key].append(report)

    # Services covered by at least one RCA session in the last 30 days.
    covered_stmt = (
        select(RcaSession.service_name)
        .where(
            RcaSession.team_id == team_id,
            RcaSession.created_at >= cutoff_30d,
            RcaSession.service_name.is_not(None),
        )
        .distinct()
    )
    if pattern:
        covered_stmt = covered_stmt.where(RcaSession.service_name.ilike(pattern))
    covered_services = {
        key
        for raw in (await db.execute(covered_stmt)).scalars()
        if (key := _service_key(raw)) is not None
    }

    # ── rule 1: high-frequency alerts in 24h ──────────────────────────────
    sessions_24h: dict[str, list[int]] = defaultdict(list)
    for session in sessions:
        created_at = _as_utc(session.created_at)
        if created_at is not None and created_at >= cutoff_24h:
            key = _service_key(session.service_name)
            if key is not None:
                sessions_24h[key].append(session.id)

    for key, stat in alerts_24h.items():
        count = stat.count
        first_at = stat.first_at
        last_at = stat.last_at
        if count <= HIGH_ALERT_THRESHOLD:
            continue
        display = _display_service(key, names)
        severity = "high" if count >= HIGH_ALERT_THRESHOLD * 2 else "medium"
        confidence = round(
            min(0.95, 0.55 + 0.4 * (count - HIGH_ALERT_THRESHOLD) / HIGH_ALERT_THRESHOLD),
            2,
        )
        related = sessions_24h.get(key, [])[:10]
        evidence = [
            f"近 {HIGH_ALERT_WINDOW_HOURS} 小时告警 {count} 条（阈值 {HIGH_ALERT_THRESHOLD}）",
            f"首条 {_fmt_dt(first_at)}，最近 {_fmt_dt(last_at)}",
        ]
        if related:
            evidence.append(f"同期关联 RCA 会话 {len(related)} 个：{_ids(related)}")
        items.append(
            SuggestionItem(
                id=_suggestion_id("high_alert_freq", key),
                severity=severity,
                service=display,
                title=f"{display} 高频告警（24h 内 {count} 条）",
                reason="同服务短时告警量超过阈值，疑似持续故障或告警风暴。",
                evidence=evidence,
                confidence=confidence,
                related_session_ids=related,
                suggested_action="检查告警来源与依赖链路，合并/抑制重复告警，并视情况触发 RCA。",
            )
        )

    # ── rule 2: recurring root cause in the last 5 RCA sessions ──────────
    for key, service_sessions in sessions_by_service.items():
        considered: list[tuple[RcaSession, str]] = []
        for session in service_sessions:
            created_at = _as_utc(session.created_at)
            if created_at is None or created_at < cutoff_7d:
                continue
            text = _root_cause_text(session, reports_by_session.get(session.id))
            if not text:
                continue
            considered.append((session, text))
            if len(considered) >= RECURRING_CAUSE_LOOKBACK_SESSIONS:
                break
        if len(considered) < RECURRING_CAUSE_MIN_REPEAT:
            continue

        grouped: dict[str, list[tuple[RcaSession, str]]] = defaultdict(list)
        for session, text in considered:
            grouped[text.casefold()].append((session, text))
        _, hits = max(
            grouped.items(),
            key=lambda pair: (
                len(pair[1]),
                _as_utc(pair[1][0][0].created_at) or now,
            ),
        )
        repeat = len(hits)
        if repeat < RECURRING_CAUSE_MIN_REPEAT:
            continue
        display = _display_service(key, names)
        severity = "high" if repeat >= 3 else "medium"
        confidence = round(
            min(0.95, 0.6 + 0.1 * (repeat - RECURRING_CAUSE_MIN_REPEAT)),
            2,
        )
        cause_label = _clean_text(hits[0][1], 200)
        related = [session.id for session, _ in hits][:10]
        evidence = [
            f"最近 {len(considered)} 次 RCA 中 {repeat} 次为同一根因"
            f"（近 {RECURRING_CAUSE_WINDOW_DAYS} 天，回看上限 {RECURRING_CAUSE_LOOKBACK_SESSIONS} 次）",
            f"根因：{cause_label}",
            f"命中会话：{_ids([session.id for session, _ in hits])}",
            f"最近命中：{_fmt_dt(hits[0][0].created_at)}",
        ]
        items.append(
            SuggestionItem(
                id=_suggestion_id("recurring_cause", key),
                severity=severity,
                service=display,
                title=f"{display} 根因复发（{repeat} 次）",
                reason="同一根因在最近多次 RCA 中重复出现，说明上次处置未覆盖根因或发生回滚。",
                evidence=evidence,
                confidence=confidence,
                related_session_ids=related,
                suggested_action="复核上次处置与变更记录，制定永久修复方案并补充巡检项。",
            )
        )

    # ── rule 3: FAILED sessions / stuck QUEUED sessions ───────────────────
    for key in set(failed_by_service) | set(queued_by_service):
        failed = failed_by_service.get(key, [])
        queued = queued_by_service.get(key, [])
        if not failed and not queued:
            continue
        display = _display_service(key, names)
        severity = "high" if failed else "medium"
        confidence = 0.9 if failed else 0.75
        related = [session.id for session in (*failed, *queued)][:10]
        evidence: list[str] = []
        if failed:
            evidence.append(f"近 {FAILED_SESSION_WINDOW_DAYS} 天 FAILED 会话 {len(failed)} 个")
            evidence.append(
                f"最近失败：#{failed[0].id}（{_fmt_dt(failed[0].created_at)}）"
            )
        if queued:
            oldest = min(queued, key=lambda session: _as_utc(session.created_at) or now)
            minutes = int(
                (now - (_as_utc(oldest.created_at) or now)).total_seconds() // 60
            )
            evidence.append(
                f"QUEUED 超过 {QUEUED_TIMEOUT_MINUTES} 分钟未启动 {len(queued)} 个"
            )
            evidence.append(
                f"最早滞留：#{oldest.id}（{_fmt_dt(oldest.created_at)}，已排队 {minutes} 分钟）"
            )
        items.append(
            SuggestionItem(
                id=_suggestion_id("failed_sessions", key),
                severity=severity,
                service=None if key is None else display,
                title=f"{display} RCA 会话失败/滞留",
                reason="RCA 会话失败或长时间排队，需要人工介入确认结论与系统可用性。",
                evidence=evidence,
                confidence=confidence,
                related_session_ids=related,
                suggested_action="人工复核失败原因与 Hermes 可用性，必要时重新触发；滞留会话检查队列与并发槽位。",
            )
        )

    # ── rule 4: alerts without RCA coverage in 30 days ────────────────────
    for key, stat in alerts_30d.items():
        if key in covered_services:
            continue
        count = stat.count
        last_at = stat.last_at
        display = _display_service(key, names)
        items.append(
            SuggestionItem(
                id=_suggestion_id("coverage_gap", key),
                severity="medium",
                service=display,
                title=f"{display} 有告警但近 {COVERAGE_GAP_WINDOW_DAYS} 天无 RCA",
                reason="告警未进入 RCA 分析，可能缺少自动触发规则或人工处置遗漏。",
                evidence=[
                    f"近 {COVERAGE_GAP_WINDOW_DAYS} 天告警 {count} 条",
                    f"最近告警：{_fmt_dt(last_at)}",
                    f"近 {COVERAGE_GAP_WINDOW_DAYS} 天 RCA 会话数：0",
                ],
                confidence=0.8,
                related_session_ids=[],
                suggested_action="为该服务配置告警触发规则并纳入 RCA 覆盖，或安排人工复盘。",
            )
        )

    # ── rule 5: low-confidence report share in 30 days ────────────────────
    for key, reports in reports_by_service.items():
        scored = [
            (report, max(0.0, min(1.0, float(report.confidence))))
            for report in reports
            if report.confidence is not None
        ]
        if len(scored) < LOW_CONFIDENCE_MIN_REPORTS:
            continue
        low = [
            (report, value)
            for report, value in scored
            if value < LOW_CONFIDENCE_THRESHOLD
        ]
        if not low:  # defensive: a 0 ratio can never reach the threshold below
            continue
        ratio = len(low) / len(scored)
        if ratio < LOW_CONFIDENCE_RATIO_THRESHOLD:
            continue
        display = _display_service(key, names)
        percent = round(ratio * 100)
        severity = "high" if ratio >= 0.75 and len(scored) >= 5 else "medium"
        confidence = round(min(0.95, 0.6 + 0.3 * ratio), 2)
        average = sum(value for _, value in scored) / len(scored)
        lowest_report, lowest_value = min(low, key=lambda pair: pair[1])
        related = [report.session_id for report, _ in low][:10]
        items.append(
            SuggestionItem(
                id=_suggestion_id("low_confidence", key),
                severity=severity,
                service=display,
                title=f"{display} 低置信度报告占比 {percent}%",
                reason="RCA 结论置信度持续偏低，报告结论可能不可靠。",
                evidence=[
                    f"近 {LOW_CONFIDENCE_WINDOW_DAYS} 天有效报告 {len(scored)} 份，"
                    f"其中 {len(low)} 份置信度 <{LOW_CONFIDENCE_THRESHOLD}（{percent}%）",
                    f"最低置信度 {lowest_value:.2f}（会话 #{lowest_report.session_id}，"
                    f"{_fmt_dt(lowest_report.created_at)}）",
                    f"平均置信度 {average:.2f}",
                ],
                confidence=confidence,
                related_session_ids=related,
                suggested_action="补充证据与数据源、人工复核低置信度结论，并优化 RCA 上下文注入。",
            )
        )

    return now, _sorted_items(items)


async def _get_suggestions(
    db: AsyncSession,
    team_id: int,
    service: str | None,
) -> tuple[datetime, list[SuggestionItem]]:
    """Return cached suggestions (60s TTL), computing them on a miss."""
    key = (team_id, service)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    generated_at, items = await _compute_suggestions(db, team_id, service)
    _cache_set(key, generated_at, items)
    return generated_at, items


def _stats(items: list[SuggestionItem]) -> SuggestionStats:
    return SuggestionStats(
        total=len(items),
        by_severity=_by_severity(items),
        services=len({item.service or UNKNOWN_SERVICE for item in items}),
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/suggestions", response_model=SuggestionList)
async def patrol_suggestions(
    service: str | None = Query(
        None,
        max_length=255,
        description="按服务名过滤（不区分大小写，子串匹配）",
    ),
    limit: int = Query(50, ge=1, le=200, description="返回建议数量上限"),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SuggestionList:
    """Deterministic inspection suggestions for the caller's team (read-only)."""
    cleaned = _clean_service(service)
    key = cleaned.casefold() if cleaned else None
    generated_at, all_items = await _get_suggestions(db, user.team_id, key)
    items = all_items[:limit]
    return SuggestionList(
        generated_at=generated_at,
        items=items,
        stats=_stats(items),
    )


@router.get("/summary", response_model=PatrolSummary)
async def patrol_summary(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PatrolSummary:
    """Team-wide patrol counts + the services with the most suggestions."""
    generated_at, items = await _get_suggestions(db, user.team_id, None)
    counts: dict[str, int] = defaultdict(int)
    for item in items:
        counts[item.service or UNKNOWN_SERVICE] += 1
    top = sorted(
        counts.items(), key=lambda pair: (-pair[1], pair[0])
    )[:SUMMARY_TOP_SERVICES]
    return PatrolSummary(
        generated_at=generated_at,
        total=len(items),
        by_severity=_by_severity(items),
        top_services=[TopService(service=name, count=count) for name, count in top],
    )
