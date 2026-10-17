"""FastAPI application entry point for 六脉 (Liumai) AIOps Platform.

Initializes middleware, registers routers, and manages the database
connection pool lifecycle via the lifespan handler.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.auth import RequestIDMiddleware, get_request_id
from app.config import settings
from app.models.database import dispose_db, init_db


# ── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler.

    Startup: create DB connection pool, initialize schema (dev only).
    Shutdown: dispose of DB engine and connections gracefully.
    """
    logger.info("六脉 backend starting up ...")
    logger.info(f"Log level: {settings.LOG_LEVEL}")
    logger.info(f"RBAC enabled: {settings.RBAC_ENABLED}")
    logger.info(f"RCA max concurrency: {settings.RCA_MAX_CONCURRENCY}")

    await init_db()

    # Background task: refresh Hermes skills cache periodically
    import asyncio
    from app.services.hermes import (
        refresh_skills_cache,
        get_cache_refresh_secs,
        get_cache_age_secs,
    )

    async def _skills_cache_loop():
        # Initial load after a short delay (let the server start)
        await asyncio.sleep(10)
        await refresh_skills_cache()
        while True:
            interval = get_cache_refresh_secs()
            await asyncio.sleep(interval)
            if get_cache_age_secs() >= interval:
                await refresh_skills_cache()

    _cache_task = asyncio.create_task(_skills_cache_loop())

    # Background task: auto-distill knowledge from chat history periodically
    from app.services.distiller import Distiller

    async def _auto_distill_loop():
        await asyncio.sleep(60)  # initial delay after startup
        while True:
            try:
                from app.models.database import async_session_factory
                from app.models import SystemConfig
                from sqlalchemy import select

                async with async_session_factory() as sess:
                    # Check if auto-distill is enabled
                    row = await sess.execute(
                        select(SystemConfig).where(SystemConfig.key == "distill_auto_enabled")
                    )
                    enabled = row.scalar_one_or_none()
                    if enabled and enabled.value == "true":
                        distiller = Distiller(sess)
                        result = await distiller.run(limit=10, min_score=70, auto_store=True)
                        if result["knowledge_extracted"] > 0:
                            logger.info("Auto-distill: {} new knowledge", result["knowledge_extracted"])
            except Exception:
                logger.exception("Auto-distill loop error")

            # Read interval from config (default: 3600s = 1 hour)
            interval = 3600
            try:
                async with async_session_factory() as sess:
                    row = await sess.execute(
                        select(SystemConfig).where(SystemConfig.key == "distill_interval_secs")
                    )
                    r = row.scalar_one_or_none()
                    if r and r.value.isdigit():
                        interval = max(300, int(r.value))  # min 5 minutes
            except Exception:
                pass
            await asyncio.sleep(interval)

    _distill_task = asyncio.create_task(_auto_distill_loop())

    # Load persisted config from DB (fall back to env vars)
    try:
        from app.models import SystemConfig
        from app.models.database import async_session_factory

        async with async_session_factory() as session:
            from sqlalchemy import select
            rows = await session.execute(select(SystemConfig))
            db_cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}

        logger.info("Loaded {} config keys from DB", len(db_cfg))

        from app.services.ldap import reload_ldap_config
        reload_ldap_config(db_cfg if db_cfg else {})

        from app.services.hermes import reload_hermes_config
        reload_hermes_config(db_cfg if db_cfg else {})

        # Restore skills cache refresh interval from DB
        if "skills_refresh_secs" in db_cfg:
            from app.services.hermes import set_cache_refresh_secs
            set_cache_refresh_secs(int(db_cfg["skills_refresh_secs"]))
    except Exception:
        logger.exception("Could not load config from DB — using env defaults")

    # ── RCA lifecycle recovery (P0-2) ─────────────────────────────────────
    # BackgroundTasks 不会跨进程存活：进程重启/崩溃后，上一进程留下的
    # QUEUED/RUNNING 会话没有任何东西会再推进它们。启动时做两件事：
    #   1. 把超过阈值仍停在 RUNNING/QUEUED 的会话置为 FAILED（时间线+审计），
    #      并幂等归还 Redis 并发槽位；
    #   2. 把「心跳已凉但尚未超时」的 QUEUED 会话重新投递（redis NX 票据去重）。
    # 随后启动 60s 巡检协程，随 lifespan 启停。
    from app.services.rca_runner import (
        ZOMBIE_SWEEP_INTERVAL_SECONDS,
        requeue_orphan_sessions,
        sweep_stale_sessions,
        takeover_stale_sessions,
    )

    async def _rca_watchdog_loop() -> None:
        while True:
            await asyncio.sleep(ZOMBIE_SWEEP_INTERVAL_SECONDS)
            try:
                result = await sweep_stale_sessions()
                expired = result.get("expired") or {}
                requeued = result.get("requeued") or {}
                if expired.get("expired"):
                    logger.warning(
                        "RCA 巡检回收僵尸会话: {}",
                        expired.get("session_ids"),
                    )
                if requeued.get("requeued"):
                    logger.info(
                        "RCA 巡检重新入队孤儿会话: {}",
                        requeued.get("session_ids"),
                    )
            except Exception:  # noqa: BLE001 — 巡检失败不能中断循环
                logger.exception("RCA 巡检循环异常")

    try:
        takeover = await takeover_stale_sessions()
        if takeover.get("expired"):
            logger.warning(
                "RCA 启动接管：{} 个超时会话已置为 FAILED: {}",
                takeover["expired"], takeover.get("session_ids"),
            )
        recovery = await requeue_orphan_sessions()
        if recovery.get("requeued"):
            logger.info(
                "RCA 启动恢复：{} 个 QUEUED 会话重新入队: {}",
                recovery["requeued"], recovery.get("session_ids"),
            )
    except Exception:  # noqa: BLE001 — 恢复失败不能阻塞服务启动
        logger.exception("RCA 启动接管/恢复失败")

    _rca_watchdog_task = asyncio.create_task(_rca_watchdog_loop())

    yield

    logger.info("Shutting down 六脉 backend ...")
    # Cancel background tasks
    for _task in (_cache_task, _distill_task, _rca_watchdog_task):
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    await dispose_db()


# ── Application ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="六脉 — AIOps Platform API",
    description=(
        "Backend API for the 六脉 intelligent operations platform. "
        "Provides alert ingestion, RCA orchestration, rule management, "
        "and audit-trail history."
    ),
    version="0.3.0",
    lifespan=lifespan,
)


# ── Unified error envelope ──────────────────────────────────────────────────
#
# Every handled 4xx/5xx response looks like:
#
#   {"error": {"code": "FORBIDDEN", "message": "权限不足",
#              "request_id": "…", "details": {…}?, "detail": "权限不足"},
#    "detail": <legacy FastAPI detail>}
#
# The top-level ``detail`` mirrors FastAPI's default shape so the current
# frontend (which reads ``detail``) keeps working during migration.

_ERROR_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    501: "NOT_IMPLEMENTED",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}

_ERROR_MESSAGES: dict[int, str] = {
    400: "请求参数有误",
    401: "未认证或认证已失效",
    403: "权限不足",
    404: "请求的资源不存在",
    405: "请求方法不允许",
    409: "资源状态冲突",
    413: "请求体过大",
    415: "不支持的媒体类型",
    422: "请求参数校验失败",
    429: "请求过于频繁，请稍后重试",
    500: "服务器内部错误，请稍后重试",
    501: "功能尚未实现",
    502: "上游服务不可用",
    503: "服务暂不可用",
    504: "上游服务响应超时",
}


def _machine_code(status_code: int) -> str:
    if status_code in _ERROR_CODES:
        return _ERROR_CODES[status_code]
    return "INTERNAL_ERROR" if status_code >= 500 else f"HTTP_{status_code}"


def _normalize_code(raw: Any) -> str | None:
    """Normalise a business-provided error code to ``UPPER_SNAKE``."""
    if not isinstance(raw, str):
        return None
    code = raw.strip().upper()
    code = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in code)
    return code.strip("_") or None


def _error_payload(
    request: Request,
    status_code: int,
    message: str,
    *,
    code: str | None = None,
    details: dict[str, Any] | None = None,
    detail: Any = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Build the envelope body + response headers for an error response."""
    request_id = get_request_id(request)
    error: dict[str, Any] = {
        "code": code or _machine_code(status_code),
        "message": message,
        "request_id": request_id,
        "detail": message,  # compatibility alias inside the envelope
    }
    if details:
        error["details"] = details

    body: dict[str, Any] = {
        "error": error,
        # Legacy FastAPI-compatible field; old frontends read ``detail`` directly.
        "detail": message if detail is None else detail,
    }
    return body, {"X-Request-ID": request_id}


async def _handle_http_exception(
    request: Request, exc: StarletteHTTPException,
) -> JSONResponse:
    """Handle all ``HTTPException``s (explicit raises and framework 404/405)."""
    status_code = exc.status_code
    original_detail = exc.detail
    message = _ERROR_MESSAGES.get(status_code, "请求失败")
    code: str | None = None
    details: dict[str, Any] | None = None

    if isinstance(original_detail, str):
        # A string detail is already the human-readable (Chinese) message.
        if original_detail.strip():
            message = original_detail
    elif isinstance(original_detail, dict):
        # Dict detail: optional ``code``/``message`` are promoted, the rest is
        # expanded into ``error.details`` so clients can act on structured data.
        expanded = dict(original_detail)
        code = _normalize_code(expanded.pop("code", None))
        raw_message = expanded.pop("message", expanded.pop("msg", None))
        if isinstance(raw_message, str) and raw_message.strip():
            message = raw_message.strip()
        if expanded:
            details = jsonable_encoder(expanded)

    body, headers = _error_payload(
        request,
        status_code,
        message,
        code=code,
        details=details,
        detail=jsonable_encoder(original_detail),
    )
    if exc.headers:
        # Preserve protocol headers (e.g. WWW-Authenticate) without letting an
        # upstream header override the request id we just assigned.
        headers = {**exc.headers, **headers}
    return JSONResponse(status_code=status_code, content=body, headers=headers)


async def _handle_validation_error(
    request: Request, exc: RequestValidationError,
) -> JSONResponse:
    """Handle Pydantic/FastAPI 422s; keeps the classic ``detail: [...]`` shape."""
    errors = jsonable_encoder(exc.errors())
    body, headers = _error_payload(
        request,
        422,
        "请求参数校验失败",
        code="VALIDATION_ERROR",
        details={"errors": errors},
        detail=errors,
    )
    return JSONResponse(status_code=422, content=body, headers=headers)


async def _handle_unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    """Last-resort 500 handler — never leaks exception text to clients."""
    request_id = get_request_id(request)
    logger.exception(
        "Unhandled error: {} {} (request_id={})",
        request.method, request.url.path, request_id,
    )
    body, headers = _error_payload(
        request,
        500,
        "服务器内部错误，请稍后重试",
        code="INTERNAL_ERROR",
        details={"type": type(exc).__name__},
    )
    return JSONResponse(status_code=500, content=body, headers=headers)


app.add_exception_handler(StarletteHTTPException, _handle_http_exception)
app.add_exception_handler(RequestValidationError, _handle_validation_error)
app.add_exception_handler(Exception, _handle_unhandled_exception)


# ── Middleware ───────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,  # JWT via Authorization header — credentials not needed
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)

# Added last → outermost: runs before CORS/exception handling, so request.state
# is populated for every handler and every response carries X-Request-ID.
app.add_middleware(RequestIDMiddleware)


# ── Health check ────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health_check() -> dict[str, str | int]:
    """Liveness / readiness probe.

    Returns basic application status. Used by Docker HEALTHCHECK and
    Kubernetes readiness probes.
    """
    return {
        "status": "ok",
        "service": "liumai-backend",
        "version": "0.3.0",
    }


# ── Router registration ─────────────────────────────────────────────────────

from app.routes import alerts, audit, auth, chat, datasources, graph, hermes, history, incidents, jobs, knowledge, patrol, rca, root_cause, rules, systems, users  # noqa: E402

app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(incidents.router, prefix="/api/incidents", tags=["incidents"])
app.include_router(rca.router, prefix="/api/rca", tags=["rca"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(history.router, prefix="/api/history", tags=["history"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])
app.include_router(hermes.router, prefix="/api/hermes", tags=["hermes"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(datasources.router, prefix="/api/datasources", tags=["datasources"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["jobs"])
app.include_router(knowledge.router, prefix="/api/knowledge", tags=["knowledge"])
app.include_router(root_cause.router, prefix="/api/knowledge", tags=["root-cause"])
app.include_router(systems.router, prefix="/api/systems", tags=["systems"])
app.include_router(audit.router, prefix="/api/audit", tags=["audit"])
app.include_router(graph.router, prefix="/api/graph", tags=["graph"])
app.include_router(patrol.router, prefix="/api/patrol", tags=["patrol"])


# ── Static files (uploaded avatars) ─────────────────────────────────────────

from fastapi.staticfiles import StaticFiles
from pathlib import Path

_avatar_dir = Path("/app/data/avatars")
_avatar_dir.mkdir(parents=True, exist_ok=True)
app.mount("/avatars", StaticFiles(directory=str(_avatar_dir)), name="avatars")
