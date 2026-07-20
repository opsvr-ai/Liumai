"""CRUD for external data sources (Prometheus, Zabbix, ClickHouse, Kafka, API)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DataSource
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
