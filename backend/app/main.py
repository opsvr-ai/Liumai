"""FastAPI application entry point for 六脉 (Liumai) AIOps Platform.

Initializes middleware, registers routers, and manages the database
connection pool lifecycle via the lifespan handler.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

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

    yield

    logger.info("Shutting down 六脉 backend ...")
    await dispose_db()


# ── Application ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="六脉 — AIOps Platform API",
    description=(
        "Backend API for the 六脉 intelligent operations platform. "
        "Provides alert ingestion, RCA orchestration, rule management, "
        "and audit-trail history."
    ),
    version="0.1.0",
    lifespan=lifespan,
)


# ── Middleware ───────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        "version": "0.1.0",
    }


# ── Router registration ─────────────────────────────────────────────────────

from app.routes import alerts, auth, chat, datasources, history, jobs, rca, rules, users  # noqa: E402

app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(rca.router, prefix="/api/rca", tags=["rca"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(history.router, prefix="/api/history", tags=["history"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(datasources.router, prefix="/api/datasources", tags=["datasources"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["jobs"])


# ── Static files (uploaded avatars) ─────────────────────────────────────────

from fastapi.staticfiles import StaticFiles
from pathlib import Path

_avatar_dir = Path("/app/data/avatars")
_avatar_dir.mkdir(parents=True, exist_ok=True)
app.mount("/avatars", StaticFiles(directory=str(_avatar_dir)), name="avatars")
