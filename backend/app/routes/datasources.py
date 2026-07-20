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
    """Test connectivity to a data source."""
    ds = await db.get(DataSource, source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="数据源不存在")

    cfg = ds.config or {}
    ok, msg = await _test_connectivity(ds.type, cfg)
    return {"ok": ok, "message": msg}


# ═══════════════════════════════════════════════════════════════════════════════
# Connectivity tests (skeleton — real adapters in Phase 3)
# ═══════════════════════════════════════════════════════════════════════════════


async def _test_connectivity(type_: str, config: dict) -> tuple[bool, str]:
    """Try to reach a data source and return (ok, message)."""
    import httpx

    if type_ == "prometheus":
        url = config.get("url", "")
        if not url:
            return False, "未配置 Prometheus URL"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as c:
                r = await c.get(f"{url.rstrip('/')}/api/v1/status/buildinfo")
            return r.status_code < 500, f"Prometheus 响应 HTTP {r.status_code}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    elif type_ == "clickhouse":
        host = config.get("host", "localhost")
        port = config.get("port", 8123)
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as c:
                r = await c.get(f"http://{host}:{port}/ping")
            return r.text.strip() == "Ok", f"ClickHouse 响应: {r.text.strip()[:100]}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    elif type_ == "zabbix":
        url = config.get("url", "")
        if not url:
            return False, "未配置 Zabbix URL"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as c:
                r = await c.post(
                    f"{url.rstrip('/')}/api_jsonrpc.php",
                    json={"jsonrpc": "2.0", "method": "apiinfo.version", "id": 1, "params": []},
                )
            if r.status_code == 200:
                data = r.json()
                ver = data.get("result", "unknown")
                return True, f"Zabbix API 版本: {ver}"
            return False, f"Zabbix 响应 HTTP {r.status_code}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    elif type_ == "kafka":
        brokers = config.get("brokers", [])
        if not brokers:
            return False, "未配置 Kafka brokers"
        try:
            from kafka import KafkaAdminClient
            admin = KafkaAdminClient(bootstrap_servers=brokers, request_timeout_ms=5000)
            topics = admin.list_topics()
            admin.close()
            return True, f"Kafka 连接成功，{len(topics)} 个 topic"
        except ImportError:
            return False, "kafka-python 库未安装"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    elif type_ == "api":
        url = config.get("url", "")
        method = config.get("method", "GET").upper()
        if not url:
            return False, "未配置 API URL"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as c:
                r = await c.request(method, url)
            return r.status_code < 500, f"API 响应 HTTP {r.status_code}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    return False, f"不支持的数据源类型: {type_}"
