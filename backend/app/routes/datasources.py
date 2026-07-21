"""CRUD for external data sources (Prometheus, Zabbix, ClickHouse, Kafka, API)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import DataSource, User
from app.models.database import get_db_session

router = APIRouter()

SOURCE_TYPES = ["prometheus", "zabbix", "clickhouse", "kafka", "api"]


# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DataSourceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    type: str = Field(..., pattern="^(prometheus|zabbix|clickhouse|kafka|api)$")
    config: dict[str, Any] = Field(default_factory=dict)


class DataSourceUpdate(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    enabled: bool | None = None


class DataSourceOut(BaseModel):
    id: int
    name: str
    type: str
    config: dict[str, Any]
    enabled: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=list[DataSourceOut])
async def list_sources(
    type_filter: str | None = Query(None, alias="type"),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[DataSourceOut]:
    """List all configured data sources."""
    q = select(DataSource).order_by(DataSource.name)
    if type_filter:
        q = q.where(DataSource.type == type_filter)
    rows = await db.execute(q)
    return [DataSourceOut.model_validate(r) for r in rows.scalars()]


@router.post("", response_model=DataSourceOut, status_code=201)
async def create_source(
    body: DataSourceCreate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> DataSourceOut:
    """Register a new data source."""
    ds = DataSource(name=body.name, type=body.type, config=body.config)
    db.add(ds)
    await db.flush()
    await db.refresh(ds)
    logger.info("DataSource created: id={} name={!r} type={!r}", ds.id, ds.name, ds.type)
    return DataSourceOut.model_validate(ds)


@router.get("/{source_id}", response_model=DataSourceOut)
async def get_source(
    source_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> DataSourceOut:
    """Get a single data source."""
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")
    return DataSourceOut.model_validate(ds)


@router.put("/{source_id}", response_model=DataSourceOut)
async def update_source(
    source_id: int,
    body: DataSourceUpdate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> DataSourceOut:
    """Update a data source."""
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")
    if body.name is not None:
        ds.name = body.name
    if body.config is not None:
        ds.config = body.config
    if body.enabled is not None:
        ds.enabled = body.enabled
    await db.flush()
    await db.refresh(ds)
    return DataSourceOut.model_validate(ds)


@router.delete("/{source_id}")
async def delete_source(
    source_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a data source."""
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")
    await db.delete(ds)
    await db.flush()
    return Response(status_code=204)


@router.post("/{source_id}/test")
async def test_source(
    source_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Test connectivity to a data source using its type-specific adapter."""
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")

    from app.services.datasource_adapters import get_adapter

    try:
        adapter = get_adapter(ds.type, ds.config or {})
        ok, msg = await adapter.test_connection()
    except ValueError as exc:
        ok, msg = False, str(exc)
    return {"ok": ok, "message": msg}


@router.post("/{source_id}/query")
async def query_source(
    source_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Execute a query against a data source and return results.

    Body: ``{query, params?, parse_path?}``
    """
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")

    from app.services.datasource_adapters import get_adapter

    query = body.get("query", "")
    params = body.get("params")
    parse_path = body.get("parse_path")

    adapter = get_adapter(ds.type, ds.config or {})
    result = await adapter.execute_query(query, params)

    response: dict = {"rows": result.rows, "count": len(result.rows)}
    if parse_path:
        response["parsed"] = adapter._parse_json_path(result.raw, parse_path)
    return response


# ═══════════════════════════════════════════════════════════
# Query templates + health check
# ═══════════════════════════════════════════════════════════

from app.models import QueryTemplate


class TemplateOut(BaseModel):
    id: int; name: str; source_type: str; query: str = ""; params: list = Field(default_factory=list); description: str = ""
    model_config = {"from_attributes": True}


class TemplateCreate(BaseModel):
    name: str = Field(..., min_length=1); source_type: str; query: str; params: list = Field(default_factory=list); description: str = ""


@router.get("/templates", response_model=list[TemplateOut])
async def list_templates(
    source_type: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[TemplateOut]:
    q = select(QueryTemplate).order_by(QueryTemplate.source_type, QueryTemplate.id)
    if source_type: q = q.where(QueryTemplate.source_type == source_type)
    rows = await db.execute(q)
    return [TemplateOut.model_validate(r) for r in rows.scalars()]


@router.post("/templates", response_model=TemplateOut, status_code=201)
async def create_template(
    body: TemplateCreate, db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> TemplateOut:
    t = QueryTemplate(**body.model_dump())
    db.add(t); await db.flush(); await db.refresh(t)
    return TemplateOut.model_validate(t)


@router.delete("/templates/{tpl_id}")
async def delete_template(tpl_id: int, db: AsyncSession = Depends(get_db_session),
                          _admin: User = Depends(require_admin)) -> Response:
    t = await db.get(QueryTemplate, tpl_id)
    if not t: raise HTTPException(status_code=404, detail="不存在")
    await db.delete(t); return Response(status_code=204)


@router.get("/health-check")
async def health_check_all(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    from app.services.datasource_adapters import get_adapter
    import time
    rows = await db.execute(select(DataSource).where(DataSource.enabled == True))
    results = []
    for ds in rows.scalars().all():
        t0 = time.monotonic()
        try:
            adapter = get_adapter(ds.type, ds.config or {})
            ok, msg = await adapter.test_connection()
            latency = round((time.monotonic() - t0) * 1000)
        except Exception as e: ok, msg, latency = False, str(e), 0
        results.append({"id": ds.id, "name": ds.name, "type": ds.type, "ok": ok, "message": msg, "latency_ms": latency})
    return results
