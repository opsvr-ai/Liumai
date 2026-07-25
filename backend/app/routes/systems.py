"""Application system profiles — lightweight index backed by Hermes mem0."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_user, require_admin
from app.models import AppSystem, AppSystemResource, User
from app.models.database import get_db_session

router = APIRouter()

# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════

VALID_TIERS = {"L0", "L1", "L2"}
VALID_STATUSES = {"active", "inactive", "archived"}


class SystemResourceRef(BaseModel):
    id: int
    resource_type: str
    resource_id: int


class SystemOut(BaseModel):
    id: int
    name: str
    tier: str
    status: str
    description: str | None = None
    resources: list[SystemResourceRef] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SystemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    tier: str = Field("L2", pattern="^(L0|L1|L2)$")
    description: str | None = None


class SystemUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    tier: str | None = Field(None, pattern="^(L0|L1|L2)$")
    status: str | None = Field(None, pattern="^(active|inactive|archived)$")
    description: str | None = None


class ResourceAttach(BaseModel):
    resource_type: str = Field(..., min_length=1, max_length=30)
    resource_id: int


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


async def _load_resources(db: AsyncSession, system_id: int) -> list[SystemResourceRef]:
    rows = await db.execute(
        select(AppSystemResource).where(AppSystemResource.system_id == system_id)
    )
    return [
        SystemResourceRef(id=r.id, resource_type=r.resource_type, resource_id=r.resource_id)
        for r in rows.scalars()
    ]


async def _system_to_out(db: AsyncSession, sys: AppSystem) -> SystemOut:
    resources = await _load_resources(db, sys.id)
    return SystemOut(
        id=sys.id,
        name=sys.name,
        tier=sys.tier,
        status=sys.status,
        description=sys.description,
        resources=resources,
        created_at=sys.created_at,
        updated_at=sys.updated_at,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=list[SystemOut])
async def list_systems(
    search: str | None = Query(None),
    tier: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[SystemOut]:
    """List application systems with optional search and tier filter."""
    q = select(AppSystem).order_by(AppSystem.tier.asc(), AppSystem.name.asc())

    if search:
        q = q.where(AppSystem.name.ilike(f"%{search}%"))
    if tier:
        q = q.where(AppSystem.tier == tier)

    rows = (await db.execute(q)).scalars().all()
    return [await _system_to_out(db, s) for s in rows]


@router.get("/{system_id}", response_model=SystemOut)
async def get_system(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SystemOut:
    """Get a single system with its resource associations."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    return await _system_to_out(db, sys)


@router.post("", response_model=SystemOut, status_code=201)
async def create_system(
    body: SystemCreate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemOut:
    """Create a new application system index record (after onboarding interview)."""
    # Check uniqueness
    existing = await db.execute(select(AppSystem).where(AppSystem.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="同名系统已存在")

    sys = AppSystem(name=body.name, tier=body.tier, description=body.description)
    db.add(sys)
    await db.flush()
    await db.refresh(sys)
    logger.info("AppSystem created: id={} name={!r} tier={!r}", sys.id, sys.name, sys.tier)
    return await _system_to_out(db, sys)


@router.put("/{system_id}", response_model=SystemOut)
async def update_system(
    system_id: int,
    body: SystemUpdate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemOut:
    """Update system metadata (name, tier, status, description)."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="没有提供要更新的字段")

    for key, val in update_data.items():
        setattr(sys, key, val)

    await db.flush()
    await db.refresh(sys)
    return await _system_to_out(db, sys)


@router.delete("/{system_id}")
async def delete_system(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a system and its resource associations."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    await db.delete(sys)
    await db.flush()
    logger.info("AppSystem deleted: id={}", system_id)
    return Response(status_code=204)


# ═══════════════════════════════════════════════════════════════════════════════
# Resource associations
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/{system_id}/resources", response_model=list[SystemResourceRef])
async def list_system_resources(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[SystemResourceRef]:
    """List resources associated with a system."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    return await _load_resources(db, system_id)


@router.post("/{system_id}/resources", response_model=SystemResourceRef, status_code=201)
async def attach_resource(
    system_id: int,
    body: ResourceAttach,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemResourceRef:
    """Associate a resource (alert rule, data source, etc.) with a system."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")

    rel = AppSystemResource(
        system_id=system_id,
        resource_type=body.resource_type,
        resource_id=body.resource_id,
    )
    db.add(rel)
    await db.flush()
    await db.refresh(rel)
    return SystemResourceRef(id=rel.id, resource_type=rel.resource_type, resource_id=rel.resource_id)


@router.delete("/{system_id}/resources/{resource_id}")
async def detach_resource(
    system_id: int,
    resource_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Remove a resource association."""
    rel = await db.get(AppSystemResource, resource_id)
    if not rel or rel.system_id != system_id:
        raise HTTPException(status_code=404, detail="关联不存在")
    await db.delete(rel)
    await db.flush()
    return Response(status_code=204)
