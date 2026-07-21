"""Alembic environment configuration — async PostgreSQL backend.

Loads the SQLAlchemy engine URL from ``app.config.settings`` and
auto-discovers ORM models for autogenerate support.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings

# ── Alembic Config ───────────────────────────────────────────────────────────

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ── MetaData for autogenerate ────────────────────────────────────────────────

# Import all models so that Alembic can detect schema changes.
from app.models import (  # noqa: F401
    AlertRule,
    Base,
    ChatMessage,
    ChatSession,
    ChatMode,
    CollaborationEvent,
    DataSource,
    RcaSession,
    SystemConfig,
    Team,
    User,
)

target_metadata = Base.metadata

# ── Async engine ─────────────────────────────────────────────────────────────

connectable = create_async_engine(
    settings.DATABASE_URL,
    poolclass=pool.NullPool,
)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    Configures the context with just a URL and not an Engine,
    calling ``context.execute()`` emits the given SQL to the script output.
    """
    url = settings.DATABASE_URL
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """Run migrations with a live connection."""
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Run migrations in 'online' async mode."""
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    Wraps the async runner in an asyncio event loop.
    """
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
