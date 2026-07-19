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

    ADMIN = "admin"          # Global config, rule management
    OPERATOR = "operator"    # Trigger RCA, view results
    VIEWER = "viewer"        # Read-only history


class RcaTriggerType(str, enum.Enum):
    """How the RCA session was initiated."""

    PASSIVE = "passive"     # Alert rule match → auto-trigger
    ACTIVE = "active"       # Operator manual trigger


class RcaStatus(str, enum.Enum):
    """Lifecycle state of an RCA session."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class CollaborationEventType(str, enum.Enum):
    """Types of events in the emergency collaboration timeline."""

    GROUP_CREATED = "group_created"
    MEMBER_JOINED = "member_joined"
    AGENT_PROGRESS = "agent_progress"
    MANUAL_FINDING = "manual_finding"
    BOT_MENTIONED = "bot_mentioned"
    RCA_COMPLETED = "rca_completed"


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
    role = Column(
        Enum(UserRole, name="user_role", create_type=True),
        nullable=False,
        default=UserRole.VIEWER,
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
