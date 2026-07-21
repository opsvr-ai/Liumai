"""Application configuration via environment variables.

All settings are loaded from environment variables at startup.
Sensitive values (secrets, passwords) must NEVER be logged or exposed in error responses.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BeforeValidator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _coerce_int_placeholder(v: Any) -> int:
    """Coerce env-var strings (including placeholder values) to int.

    Gracefully handles cases where ``.env`` still has template values like
    ``your_agent_id`` — returns 0 (disabled) instead of crashing startup.
    """
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip():
        try:
            return int(v)
        except ValueError:
            return 0
    return 0


def _check_jwt_secret(v: Any) -> str:
    """Reject well-known default / empty JWT secrets."""
    if not isinstance(v, str) or v.strip() == "":
        raise ValueError(
            "JWT_SECRET must be set to a strong random value. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    forbidden = {"change-me-in-production", "change-me", "your-secret-key"}
    if v.strip().lower() in forbidden:
        raise ValueError(
            "JWT_SECRET is set to an insecure default. "
            "Generate a strong random secret."
        )
    return v


class Settings(BaseSettings):
    """Pydantic-v2 settings model, loaded from environment / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        validate_default=True,
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
    WECOM_AGENT_ID: Annotated[int, BeforeValidator(_coerce_int_placeholder)] = Field(
        default=0,
        description="WeCom self-built app AgentId.",
    )

    # ── Redis ─────────────────────────────────────────────────────────────
    REDIS_URL: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL (for queue state, caching).",
    )

    # ── RCA ───────────────────────────────────────────────────────────────
    RCA_MAX_CONCURRENCY: Annotated[int, BeforeValidator(_coerce_int_placeholder)] = Field(
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

    # ── Auth ──────────────────────────────────────────────────────────────
    JWT_SECRET: Annotated[str, BeforeValidator(_check_jwt_secret)] = Field(
        default="",
        description="HMAC secret for signing JWT tokens.  Must be set to a "
                    "strong random value in production.",
    )
    JWT_ALGORITHM: str = Field(
        default="HS256",
        description="JWT signing algorithm.",
    )
    JWT_EXPIRE_MINUTES: int = Field(
        default=480,
        ge=1,
        description="JWT token expiry in minutes.",
    )

    # ── LDAP ──────────────────────────────────────────────────────────────
    LDAP_ENABLED: bool = Field(
        default=False,
        description="Enable LDAP/AD authentication.",
    )
    LDAP_SERVER: str = Field(
        default="ldap://localhost:389",
        description="LDAP server URI.",
    )
    LDAP_BASE_DN: str = Field(
        default="dc=example,dc=com",
        description="LDAP base DN for user search.",
    )
    LDAP_USER_FILTER: str = Field(
        default="(uid={username})",
        description="LDAP filter template for user lookup.",
    )
    LDAP_BIND_DN: str = Field(
        default="",
        description="Optional bind DN for LDAP search.",
    )
    LDAP_BIND_PASSWORD: str = Field(
        default="",
        description="Optional bind password for LDAP search.",
    )
    LDAP_USERNAME_ATTR: str = Field(
        default="uid",
        description="LDAP attribute mapped to username.",
    )
    LDAP_AUTO_CREATE_USER: bool = Field(
        default=True,
        description="Auto-create local user on first LDAP login.",
    )


settings = Settings()
"""Singleton settings instance. Import this in other modules."""
