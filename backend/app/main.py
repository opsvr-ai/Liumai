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

from app.routes import alerts, chat, history, rca, rules  # noqa: E402

app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(rca.router, prefix="/api/rca", tags=["rca"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(history.router, prefix="/api/history", tags=["history"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])
