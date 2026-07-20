"""Alert ingestion and rule evaluation endpoints.

Implements D-05 (Event-Driven Alert Ingestion) and D-09 (Custom Alert Schema
with Adapter Layer). Accepts alerts via webhook, normalizes them through a
schema adapter, evaluates against configured rules, and triggers RCA sessions
when conditions are matched.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from fastapi import APIRouter, Depends
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AlertRule, RcaSession, RcaStatus, RcaTriggerType
from app.models.database import get_db_session
from app.services.hermes import HermesClient

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas for alert ingestion
# ═══════════════════════════════════════════════════════════════════════════════


class AlertSeverity(str, Enum):
    """Normalized alert severity levels (D-09 canonical form)."""

    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


class RawAlert(BaseModel):
    """Raw incoming alert payload — the enterprise custom schema (D-09).

    The adapter layer normalises this into ``CanonicalAlert``.
    Additional unknown fields are preserved in ``raw_payload``.
    """

    source: str = Field(..., description="Monitoring system identifier")
    title: str = Field(..., description="Alert title / summary")
    message: str = Field("", description="Detailed alert message")
    severity: str = Field("info", description="Raw severity string")
    service: str = Field("", description="Affected service name")
    timestamp: str | None = Field(None, description="ISO-8601 event timestamp")
    raw_payload: dict[str, Any] = Field(default_factory=dict)


class CanonicalAlert(BaseModel):
    """Normalised internal alert representation (D-09 canonical schema)."""

    alert_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:16])
    source: str
    title: str
    message: str
    severity: AlertSeverity
    service: str
    timestamp: datetime
    raw: dict[str, Any] = Field(default_factory=dict)


class IngestResponse(BaseModel):
    """Response returned after alert ingestion."""

    accepted: bool
    alert_id: str
    matched_rules: list[str] = Field(default_factory=list)
    rca_triggered: bool = False
    rca_session_id: int | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Schema adapter
# ═══════════════════════════════════════════════════════════════════════════════


def normalize_alert(raw: RawAlert) -> CanonicalAlert:
    """Adapt a raw enterprise alert into the canonical internal schema (D-09).

    Custom mappings for severity strings and timestamp parsing.
    Future: support field-mapping templates configured per data-source.
    """
    # ── Severity mapping ────────────────────────────────────────────────
    sev_map = {
        "p0": AlertSeverity.CRITICAL,
        "p1": AlertSeverity.CRITICAL,
        "critical": AlertSeverity.CRITICAL,
        "error": AlertSeverity.WARNING,
        "p2": AlertSeverity.WARNING,
        "warning": AlertSeverity.WARNING,
        "info": AlertSeverity.INFO,
        "ok": AlertSeverity.INFO,
    }
    severity = sev_map.get(raw.severity.strip().lower(), AlertSeverity.INFO)

    # ── Timestamp ───────────────────────────────────────────────────────
    ts: datetime
    if raw.timestamp:
        try:
            ts = datetime.fromisoformat(raw.timestamp)
        except (ValueError, TypeError):
            ts = datetime.now(timezone.utc)
    else:
        ts = datetime.now(timezone.utc)

    return CanonicalAlert(
        source=raw.source,
        title=raw.title,
        message=raw.message,
        severity=severity,
        service=raw.service,
        timestamp=ts,
        raw=raw.raw_payload,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Rule engine helpers
# ═══════════════════════════════════════════════════════════════════════════════


def evaluate_conditions(rule: AlertRule, alert: CanonicalAlert) -> bool:
    """Evaluate a rule's JSONB conditions against a canonical alert.

    Each condition is a dict with ``field``, ``operator``, and ``value``.
    Operators supported: ``eq``, ``neq``, ``contains``, ``regex``.

    Returns ``True`` if the alert matches *all* conditions (AND logic).
    """
    conditions: list[dict[str, Any]] = rule.conditions or []
    if not conditions:
        return False

    alert_data = alert.model_dump()

    for cond in conditions:
        field = cond.get("field", "")
        op = cond.get("operator", "eq")
        expected = cond.get("value", "")

        actual = _resolve_field(alert_data, field)
        if actual is None:
            return False

        match op:
            case "eq":
                if str(actual).lower() != str(expected).lower():
                    return False
            case "neq":
                if str(actual).lower() == str(expected).lower():
                    return False
            case "contains":
                if expected.lower() not in str(actual).lower():
                    return False
            case "regex":
                import re
                if not re.search(str(expected), str(actual), re.IGNORECASE):
                    return False
            case _:
                logger.warning("Unknown rule operator {!r}", op)
                return False

    return True


def _resolve_field(data: dict[str, Any], dotted: str) -> Any:
    """Resolve a dotted field path like ``raw.foo.bar`` from a dict."""
    parts = dotted.split(".")
    current: Any = data
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/ingest", response_model=IngestResponse)
async def ingest_alert(
    payload: RawAlert,
    db: AsyncSession = Depends(get_db_session),
) -> IngestResponse:
    """Ingest an alert from an external monitoring system.

    1. Normalise the raw alert into the canonical schema (adapter layer).
    2. Evaluate all *enabled* rules whose team context applies.
    3. If a rule matches, trigger an RCA session via Hermes Gateway.
    """
    alert = normalize_alert(payload)
    logger.info(
        "Alert ingested: source={} title={!r} severity={}",
        alert.source,
        alert.title,
        alert.severity.value,
    )

    # ── Load enabled rules ──────────────────────────────────────────────
    result = await db.execute(
        select(AlertRule).where(AlertRule.enabled.is_(True))
    )
    rules = result.scalars().all()

    matched_names: list[str] = []
    rca_session_id: int | None = None

    for rule in rules:
        if evaluate_conditions(rule, alert):
            matched_names.append(rule.name)
            logger.info("Rule matched: {} (rule {})", rule.name, rule.id)

    # ── Trigger RCA for the first matched rule ──────────────────────────
    if matched_names and rules:
        target_rule = next(r for r in rules if r.name == matched_names[0])
        hermes = HermesClient()

        rca = RcaSession(
            team_id=target_rule.team_id,
            rule_id=target_rule.id,
            trigger_type=RcaTriggerType.PASSIVE,
            status=RcaStatus.QUEUED,
            time_window_start=alert.timestamp,
            time_window_end=alert.timestamp,
        )
        db.add(rca)
        await db.flush()

        # Fire-and-forget: spawn Hermes agent session in background
        try:
            result = await hermes.trigger_skill(
                skill_name="rca-fault-delimitation",
                params={
                    "alert_id": alert.alert_id,
                    "title": alert.title,
                    "message": alert.message,
                    "severity": alert.severity.value,
                    "service": alert.service,
                    "time_window_start": alert.timestamp.isoformat(),
                    "time_window_end": alert.timestamp.isoformat(),
                    "rule_id": target_rule.id,
                },
            )
            rca.hermes_session_id = result["session_id"]
            rca.root_cause_summary = result["output"][:500]
            rca.status = RcaStatus.COMPLETED
            rca.completed_at = datetime.now(timezone.utc)
        except Exception:
            logger.exception("Failed to spawn Hermes RCA session")
            rca.status = RcaStatus.FAILED

        await db.flush()
        rca_session_id = rca.id

    return IngestResponse(
        accepted=True,
        alert_id=alert.alert_id,
        matched_rules=matched_names,
        rca_triggered=rca_session_id is not None,
        rca_session_id=rca_session_id,
    )
