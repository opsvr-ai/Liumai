"""Application configuration via environment variables.

All settings are loaded from environment variables at startup.
Sensitive values (secrets, passwords) must NEVER be logged or exposed in error responses.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Pydantic-v2 settings model, loaded from environment / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://liumai:liumai_dev@localhost:5432/liumai",
        description="PostgreSQL async DSN (asyncpg driver).",
    )

    # ── Hermes Gateway ────────────────────────────────────────────────────
    HERMES_GATEWAY_URL: str = Field(
        default="http://hermes-gateway:8080",
        description="Base URL for the Hermes Gateway API.",
    )
    HERMES_API_KEY: str | None = Field(
        default=None,
        description="Optional API key for Hermes Gateway authentication.",
    )

    # ── WeCom (WeChat Work) ───────────────────────────────────────────────
    WECOM_CORP_ID: str = Field(
        default="",
        description="WeCom enterprise ID (CorpId).",
    )
    WECOM_CORP_SECRET: str = Field(
        default="",
        description="WeCom self-built app secret.",
    )
    WECOM_AGENT_ID: int = Field(
        default=0,
        description="WeCom self-built app AgentId.",
    )

    # ── Redis ─────────────────────────────────────────────────────────────
    REDIS_URL: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL (for queue state, caching).",
    )

    # ── RCA ───────────────────────────────────────────────────────────────
    RCA_MAX_CONCURRENCY: int = Field(
        default=5,
        ge=1,
        le=100,
        description="Maximum concurrent RCA agent sessions.",
    )

    # ── RBAC ──────────────────────────────────────────────────────────────
    RBAC_ENABLED: bool = Field(
        default=True,
        description="Enable RBAC middleware (single-tenant team isolation).",
    )

    # ── Server ────────────────────────────────────────────────────────────
    CORS_ORIGINS: list[str] = Field(
        default=["*"],
        description="Allowed CORS origins.",
    )
    LOG_LEVEL: str = Field(
        default="INFO",
        description="Logging level (DEBUG, INFO, WARNING, ERROR).",
    )


settings = Settings()
"""Singleton settings instance. Import this in other modules."""
