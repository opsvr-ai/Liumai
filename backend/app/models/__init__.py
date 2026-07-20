"""SQLAlchemy ORM models for the 六脉 platform.

All models use integer auto-increment primary keys and UTC timestamps.
JSONB columns leverage PostgreSQL's native JSON support for flexible schemas.
"""

from __future__ import annotations

import enum

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.models.database import Base

# ═══════════════════════════════════════════════════════════════════════════════
# Enum types
# ═══════════════════════════════════════════════════════════════════════════════


class UserRole(str, enum.Enum):
    """RBAC roles within a single tenant (team)."""

    ADMIN = "ADMIN"
    OPERATOR = "OPERATOR"
    VIEWER = "VIEWER"


class AuthType(str, enum.Enum):
    """How a user authenticates — local password or LDAP/AD."""

    LOCAL = "LOCAL"
    LDAP = "LDAP"


class RcaTriggerType(str, enum.Enum):
    """How the RCA session was initiated."""

    PASSIVE = "PASSIVE"
    ACTIVE = "ACTIVE"


class RcaStatus(str, enum.Enum):
    """Lifecycle state of an RCA session."""

    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class CollaborationEventType(str, enum.Enum):
    """Types of events in the emergency collaboration timeline."""

    GROUP_CREATED = "GROUP_CREATED"
    MEMBER_JOINED = "MEMBER_JOINED"
    AGENT_PROGRESS = "AGENT_PROGRESS"
    MANUAL_FINDING = "MANUAL_FINDING"
    BOT_MENTIONED = "BOT_MENTIONED"
    RCA_COMPLETED = "RCA_COMPLETED"


# ═══════════════════════════════════════════════════════════════════════════════
# ORM Models
# ═══════════════════════════════════════════════════════════════════════════════


class Team(Base):
    """A tenant / team within the single-enterprise deployment."""

    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False, unique=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Team id={self.id} name={self.name!r}>"


class User(Base):
    """Platform user with team-scoped RBAC role."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    team_id = Column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    username = Column(String(255), nullable=False, unique=True)
    password_hash = Column(String(255), nullable=True)
    role = Column(
        Enum(UserRole, name="user_role", create_type=True),
        nullable=False,
        default=UserRole.VIEWER,
    )
    auth_type = Column(
        Enum(AuthType, name="auth_type", create_type=True),
        nullable=False,
        default=AuthType.LDAP,
    )
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} username={self.username!r} role={self.role.value}>"


class AlertRule(Base):
    """Alert-to-RCA trigger rule.

    Conditions are stored as a JSONB array of condition objects.
    Actions are stored as a JSONB array of action descriptors.
    """

    __tablename__ = "alert_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    team_id = Column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True, default="")
    conditions = Column(JSONB, nullable=False, default=list)
    actions = Column(JSONB, nullable=False, default=list)
    created_by = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<AlertRule id={self.id} name={self.name!r} enabled={self.enabled}>"


class RcaSession(Base):
    """A single Root Cause Analysis investigation session.

    Maps 1:1 to a Hermes agent subprocess (hermes_session_id).
    """

    __tablename__ = "rca_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    team_id = Column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    rule_id = Column(
        Integer,
        ForeignKey("alert_rules.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    trigger_type = Column(
        Enum(RcaTriggerType, name="rca_trigger_type", create_type=True),
        nullable=False,
    )
    status = Column(
        Enum(RcaStatus, name="rca_status", create_type=True),
        nullable=False,
        default=RcaStatus.QUEUED,
        index=True,
    )
    time_window_start = Column(DateTime(timezone=True), nullable=True)
    time_window_end = Column(DateTime(timezone=True), nullable=True)
    hermes_session_id = Column(String(255), nullable=True, unique=True)
    wecom_chat_id = Column(String(255), nullable=True)
    root_cause_summary = Column(Text, nullable=True)
    evidence = Column(JSONB, nullable=True, default=list)
    created_by = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    completed_at = Column(DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return (
            f"<RcaSession id={self.id} status={self.status.value} "
            f"trigger={self.trigger_type.value}>"
        )


class CollaborationEvent(Base):
    """Timeline entry for emergency collaboration within an RCA session."""

    __tablename__ = "collaboration_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    rca_session_id = Column(
        Integer,
        ForeignKey("rca_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_type = Column(
        Enum(
            CollaborationEventType,
            name="collab_event_type",
            create_type=True,
        ),
        nullable=False,
    )
    content = Column(Text, nullable=True)
    metadata_ = Column("metadata", JSONB, nullable=True, default=dict)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<CollaborationEvent id={self.id} "
            f"type={self.event_type.value} "
            f"session={self.rca_session_id}>"
        )


class ChatSession(Base):
    """A single chat conversation thread."""

    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    mode_slug = Column(String(50), nullable=True, default=None)
    title = Column(String(255), nullable=False, default="新对话")
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<ChatSession id={self.id} title={self.title!r}>"


class ChatMessage(Base):
    """A single message within a chat session."""

    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(
        Integer,
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role = Column(String(20), nullable=False)  # user / assistant / tool
    content = Column(Text, nullable=False, default="")
    tool_calls = Column(JSONB, nullable=True)  # serialised ToolCallDelta[]
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<ChatMessage id={self.id} role={self.role!r} "
            f"session={self.session_id}>"
        )


class SystemConfig(Base):
    """Key-value configuration store for runtime settings (e.g. LDAP, WeCom).

    Persists admin-configurable settings so they survive container restarts
    without requiring environment-variable edits.  Env vars still act as
    initial defaults on first startup — DB values take precedence once saved.
    """

    __tablename__ = "system_config"

    key = Column(String(255), primary_key=True)
    value = Column(Text, nullable=False, default="")
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<SystemConfig key={self.key!r} value={self.value[:40]!r}>"


class ChatMode(Base):
    """A conversation mode with its own system prompt and config.

    Pre-seeded with 'default', 'rca', and 'knowledge' modes.  Admins can
    edit the system_prompt through the settings UI.
    """

    __tablename__ = "chat_modes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    slug = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    system_prompt = Column(Text, nullable=False, default="")
    config = Column(JSONB, nullable=False, default=dict)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<ChatMode slug={self.slug!r} name={self.name!r}>"
