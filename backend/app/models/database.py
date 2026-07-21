"""Async SQLAlchemy engine, session factory, and declarative base.

Uses asyncpg for PostgreSQL connectivity.
Engine is created once at application startup and disposed on shutdown.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from loguru import logger
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# ── Engine ──────────────────────────────────────────────────────────────────

engine = create_async_engine(
    settings.DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=False,
)

# ── Session factory ─────────────────────────────────────────────────────────

async_session_factory = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# ── Declarative base ────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    """SQLAlchemy declarative base for all ORM models."""


# ── Helpers ─────────────────────────────────────────────────────────────────

async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yield an async DB session.

    Usage in routes::

        from fastapi import Depends
        from sqlalchemy.ext.asyncio import AsyncSession

        @router.get("/items")
        async def list_items(db: AsyncSession = Depends(get_db_session)):
            ...
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db() -> None:
    """Create all tables (for development / testing).

    In production, use Alembic migrations instead.  Set DEV_MODE=true in
    the environment to enable this path; otherwise it is a no-op.
    """
    import os

    if os.environ.get("DEV_MODE", "").lower() not in ("1", "true", "yes"):
        logger.info("DEV_MODE not set — skipping create_all (use Alembic migrations)")
        return

    from app.models import (  # noqa: F401 — ensure models are registered
        AlertRule,
        ChatMessage,
        ChatMode,
        ChatSession,
        CollaborationEvent,
        DataSource,
        RcaSession,
        SystemConfig,
        Team,
        User,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    logger.info("Database tables verified (create_all).")


async def dispose_db() -> None:
    """Dispose of the engine connection pool (lifespan shutdown)."""
    await engine.dispose()
    logger.info("Database engine disposed.")
