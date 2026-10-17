"""CRUD for :class:`AlertRule` configuration.

Rules are evaluated by :mod:`app.services.rule_engine` inside
``alert_pipeline.ingest_alert`` (a hit has priority over the global A/B/C
policy).  Conditions are accepted/returned as structured rows
``[{field, op, value}, ...]`` with AND semantics; legacy free-text
``condition_expr`` payloads are still parsed on write and echoed read-only on
responses.  Every mutation invalidates the in-process rule cache.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import AlertRule, User
from app.models.database import get_db_session
from app.services import rule_engine

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RuleCreate(BaseModel):
    """Payload for creating a new alert rule.

    ``conditions`` is an array of structured condition rows
    ``[{field, op, value}, ...]`` (AND semantics).  Legacy free-text payloads
    are still accepted either as a plain string or through the deprecated
    ``condition_expr`` field; they are parsed into structured rows on write.
    """

    team_id: int = Field(
        default=1,
        description="Deprecated: owning team is taken from the authenticated admin",
    )
    name: str = Field(..., min_length=1, max_length=255)
    description: str = Field(default="")
    conditions: list[Any] | str | None = Field(
        default=None,
        description=(
            "条件行数组 ``[{field, op, value}, ...]``（AND 语义）。"
            "兼容旧版自由文本表达式字符串。"
        ),
    )
    actions: list[Any] | dict[str, Any] | None = Field(
        default=None,
        description="Action descriptors; optional overrides such as coalesce_window",
    )
    created_by: int | None = Field(default=None, description="Deprecated: set to the admin id")
    enabled: bool = Field(default=True)
    condition_expr: str | None = Field(
        default=None,
        description="Deprecated free-text condition expression (read-only on responses)",
    )


class RuleUpdate(BaseModel):
    """Payload for updating an existing rule (all fields optional)."""

    name: str | None = Field(default=None, max_length=255)
    description: str | None = None
    conditions: list[Any] | str | None = None
    actions: list[Any] | dict[str, Any] | None = None
    enabled: bool | None = None
    condition_expr: str | None = None


class RuleResponse(BaseModel):
    """Rule representation returned from the API."""

    id: int
    team_id: int
    name: str
    description: str | None
    conditions: list[Any]
    actions: list[Any]
    condition_expr: str | None = None
    created_by: int | None
    enabled: bool
    created_at: datetime
    updated_at: datetime


class PaginatedRules(BaseModel):
    """Paginated rule list."""

    items: list[Any]
    total: int
    page: int
    page_size: int


# ═══════════════════════════════════════════════════════════════════════════════
# Payload normalisation helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _parse_conditions(
    value: Any,
    *,
    fallback_expr: str | None = None,
) -> list[dict[str, Any]]:
    """Validate/normalise submitted conditions, raising 422 on bad input."""
    raw = value
    if raw is None or raw == "" or raw == []:
        raw = fallback_expr if fallback_expr else []
    try:
        return rule_engine.normalize_conditions(raw)
    except rule_engine.ConditionValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"条件配置无效：{exc}",
        ) from exc


def _parse_actions(value: Any) -> list[dict[str, Any]]:
    """Accept a single action object or a list; always store a list."""
    if value is None:
        return []
    items = [value] if isinstance(value, dict) else value
    if not isinstance(items, (list, tuple)):
        return []
    return [dict(item) for item in items if isinstance(item, dict)]


def _serialize_rule(rule: AlertRule) -> RuleResponse:
    """Build the API DTO, normalising legacy free-text conditions for readers."""
    raw_conditions = rule.conditions
    legacy_expr = rule_engine.legacy_expression(raw_conditions)
    try:
        conditions = rule_engine.normalize_conditions(raw_conditions)
    except rule_engine.ConditionValidationError as exc:
        logger.warning(
            "AlertRule {} stored conditions cannot be parsed: {}", rule.id, exc
        )
        conditions = []
    actions = rule.actions if isinstance(rule.actions, list) else []
    return RuleResponse(
        id=rule.id,
        team_id=rule.team_id,
        name=rule.name,
        description=rule.description,
        conditions=conditions,
        actions=actions,
        condition_expr=legacy_expr,
        created_by=rule.created_by,
        enabled=rule.enabled,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


async def _get_scoped_rule(db: AsyncSession, rule_id: int, user: User) -> AlertRule:
    """Load an alert rule owned by *user*'s team.

    Cross-team access is reported as 404 (not 403) so that rule IDs cannot be
    probed across tenants. Admins are not exempt: an admin is still scoped to
    their own team (same convention as ``alerts.py`` / ``root_cause.py``).
    """
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if rule is None or rule.team_id != user.team_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="告警规则不存在",
        )
    return rule


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=PaginatedRules)
async def list_rules(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    team_id: int | None = Query(None),
    enabled: bool | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedRules:
    """List alert rules with pagination and optional filters.

    Results are always scoped to the caller's team. An explicit ``team_id``
    filter may only narrow that scope — asking for another team is rejected.
    """
    if team_id is not None and team_id != user.team_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无权访问其他团队的告警规则",
        )

    query = (
        select(AlertRule)
        .where(AlertRule.team_id == user.team_id)
        .order_by(AlertRule.created_at.desc())
    )

    if enabled is not None:
        query = query.where(AlertRule.enabled.is_(enabled))

    total_q = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(total_q)
    total = total_result.scalar_one()

    offset = (page - 1) * page_size
    result = await db.execute(query.offset(offset).limit(page_size))
    rows = result.scalars().all()

    items = [_serialize_rule(r).model_dump() for r in rows]

    return PaginatedRules(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=RuleResponse, status_code=201)
async def create_rule(
    payload: RuleCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> RuleResponse:
    """Create a new alert-rule configuration.

    The owning team always comes from the authenticated admin, never from the
    request body, so a rule cannot be created in another tenant.
    """
    conditions = _parse_conditions(
        payload.conditions, fallback_expr=payload.condition_expr
    )
    rule = AlertRule(
        team_id=admin.team_id,
        name=payload.name,
        description=payload.description,
        conditions=conditions,
        actions=_parse_actions(payload.actions),
        created_by=admin.id,
        enabled=payload.enabled,
    )
    db.add(rule)
    await db.flush()
    rule_engine.invalidate_rule_cache(admin.team_id)
    logger.info(
        "AlertRule created: id={} name={!r} conditions={}",
        rule.id,
        rule.name,
        len(conditions),
    )

    return _serialize_rule(rule)


@router.get("/{rule_id}", response_model=RuleResponse)
async def get_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> RuleResponse:
    """Get a single alert rule by ID (own team only)."""
    rule = await _get_scoped_rule(db, rule_id, user)
    return _serialize_rule(rule)


@router.put("/{rule_id}", response_model=RuleResponse)
async def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> RuleResponse:
    """Update an existing alert rule (partial update, own team only)."""
    rule = await _get_scoped_rule(db, rule_id, admin)

    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    legacy_expr = update_data.pop("condition_expr", None)
    conditions_supplied = "conditions" in update_data or legacy_expr is not None
    if conditions_supplied:
        raw_conditions = update_data.pop("conditions", None)
        update_data["conditions"] = _parse_conditions(
            raw_conditions, fallback_expr=legacy_expr
        )
    if "actions" in update_data:
        update_data["actions"] = _parse_actions(update_data["actions"])
    # Ownership is never client-controlled.
    update_data.pop("created_by", None)
    update_data.pop("team_id", None)

    stmt = (
        update(AlertRule)
        .where(AlertRule.id == rule_id)
        .values(**update_data)
        .execution_options(synchronize_session="fetch")
    )
    await db.execute(stmt)
    await db.flush()
    rule_engine.invalidate_rule_cache(admin.team_id)

    # Re-fetch
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one()
    logger.info("AlertRule updated: id={}", rule.id)

    return _serialize_rule(rule)


@router.delete("/{rule_id}")
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> Response:
    """Delete an alert rule (own team only)."""
    rule = await _get_scoped_rule(db, rule_id, admin)

    await db.delete(rule)
    await db.flush()
    rule_engine.invalidate_rule_cache(admin.team_id)
    logger.info("AlertRule deleted: id={}", rule_id)
    return Response(status_code=204)


@router.post("/{rule_id}/toggle", response_model=RuleResponse)
async def toggle_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> RuleResponse:
    """Toggle the enabled/disabled state of an alert rule (own team only)."""
    rule = await _get_scoped_rule(db, rule_id, admin)

    rule.enabled = not rule.enabled
    await db.flush()
    rule_engine.invalidate_rule_cache(admin.team_id)
    # ``updated_at`` is server-generated on UPDATE (DB-side), so refresh to
    # avoid lazy-loading an expired attribute in the async response build.
    await db.refresh(rule)
    logger.info(
        "AlertRule toggled: id={} enabled={}", rule.id, rule.enabled
    )

    return _serialize_rule(rule)
