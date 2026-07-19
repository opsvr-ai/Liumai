"""Full CRUD for AlertRule configuration.

Supports creating, reading, updating, deleting, and toggling alert rules
that define which incoming alerts should trigger RCA sessions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AlertRule
from app.models.database import get_db_session

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RuleCreate(BaseModel):
    """Payload for creating a new alert rule."""

    team_id: int = Field(default=1, description="Team (tenant) identifier")
    name: str = Field(..., min_length=1, max_length=255)
    description: str = Field(default="")
    conditions: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "List of condition objects: ``[{field, operator, value}, ...]``"
        ),
    )
    actions: list[dict[str, Any]] = Field(
        default_factory=list,
        description="List of action objects to execute on match",
    )
    created_by: int | None = Field(default=None)
    enabled: bool = Field(default=True)


class RuleUpdate(BaseModel):
    """Payload for updating an existing rule (all fields optional)."""

    name: str | None = Field(default=None, max_length=255)
    description: str | None = None
    conditions: list[dict[str, Any]] | None = None
    actions: list[dict[str, Any]] | None = None
    enabled: bool | None = None


class RuleResponse(BaseModel):
    """Rule representation returned from the API."""

    id: int
    team_id: int
    name: str
    description: str | None
    conditions: list[Any]
    actions: list[Any]
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
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=PaginatedRules)
async def list_rules(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    team_id: int | None = Query(None),
    enabled: bool | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
) -> PaginatedRules:
    """List alert rules with pagination and optional filters."""
    query = select(AlertRule).order_by(AlertRule.created_at.desc())

    if team_id is not None:
        query = query.where(AlertRule.team_id == team_id)
    if enabled is not None:
        query = query.where(AlertRule.enabled.is_(enabled))

    total_q = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(total_q)
    total = total_result.scalar_one()

    offset = (page - 1) * page_size
    result = await db.execute(query.offset(offset).limit(page_size))
    rows = result.scalars().all()

    items = [
        RuleResponse(
            id=r.id,
            team_id=r.team_id,
            name=r.name,
            description=r.description,
            conditions=r.conditions or [],
            actions=r.actions or [],
            created_by=r.created_by,
            enabled=r.enabled,
            created_at=r.created_at,
            updated_at=r.updated_at,
        ).model_dump()
        for r in rows
    ]

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
) -> RuleResponse:
    """Create a new alert-rule configuration."""
    rule = AlertRule(
        team_id=payload.team_id,
        name=payload.name,
        description=payload.description,
        conditions=payload.conditions,
        actions=payload.actions,
        created_by=payload.created_by,
        enabled=payload.enabled,
    )
    db.add(rule)
    await db.flush()
    logger.info("AlertRule created: id={} name={!r}", rule.id, rule.name)

    return RuleResponse(
        id=rule.id,
        team_id=rule.team_id,
        name=rule.name,
        description=rule.description,
        conditions=rule.conditions or [],
        actions=rule.actions or [],
        created_by=rule.created_by,
        enabled=rule.enabled,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


@router.get("/{rule_id}", response_model=RuleResponse)
async def get_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
) -> RuleResponse:
    """Get a single alert rule by ID."""
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"AlertRule {rule_id} not found",
        )

    return RuleResponse(
        id=rule.id,
        team_id=rule.team_id,
        name=rule.name,
        description=rule.description,
        conditions=rule.conditions or [],
        actions=rule.actions or [],
        created_by=rule.created_by,
        enabled=rule.enabled,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


@router.put("/{rule_id}", response_model=RuleResponse)
async def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    db: AsyncSession = Depends(get_db_session),
) -> RuleResponse:
    """Update an existing alert rule (partial update)."""
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"AlertRule {rule_id} not found",
        )

    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    stmt = (
        update(AlertRule)
        .where(AlertRule.id == rule_id)
        .values(**update_data)
        .execution_options(synchronize_session="fetch")
    )
    await db.execute(stmt)
    await db.flush()

    # Re-fetch
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one()
    logger.info("AlertRule updated: id={}", rule.id)

    return RuleResponse(
        id=rule.id,
        team_id=rule.team_id,
        name=rule.name,
        description=rule.description,
        conditions=rule.conditions or [],
        actions=rule.actions or [],
        created_by=rule.created_by,
        enabled=rule.enabled,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
) -> None:
    """Delete an alert rule."""
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"AlertRule {rule_id} not found",
        )

    await db.delete(rule)
    await db.flush()
    logger.info("AlertRule deleted: id={}", rule_id)


@router.post("/{rule_id}/toggle", response_model=RuleResponse)
async def toggle_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db_session),
) -> RuleResponse:
    """Toggle the enabled/disabled state of an alert rule."""
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"AlertRule {rule_id} not found",
        )

    rule.enabled = not rule.enabled
    await db.flush()
    logger.info(
        "AlertRule toggled: id={} enabled={}", rule.id, rule.enabled
    )

    return RuleResponse(
        id=rule.id,
        team_id=rule.team_id,
        name=rule.name,
        description=rule.description,
        conditions=rule.conditions or [],
        actions=rule.actions or [],
        created_by=rule.created_by,
        enabled=rule.enabled,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )
