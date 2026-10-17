"""JWT authentication and RBAC helpers for the 六脉 platform.

Provides token creation, verification, and role-based access control
via FastAPI dependency injection.
"""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
import bcrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import settings
from app.models import User, UserRole
from app.models.database import get_db_session

# ── Password hashing ───────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    """Return a bcrypt hash of *password*."""
    return bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(),
    ).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Check *plain* against *hashed*."""
    return bcrypt.checkpw(
        plain.encode("utf-8"), hashed.encode("utf-8"),
    )


# ── JWT ────────────────────────────────────────────────────────────────────────


def create_token(user: User) -> str:
    """Create a signed JWT for *user*."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role.value if isinstance(user.role, UserRole) else user.role,
        "team_id": user.team_id,
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT.  Raises JWTError on failure."""
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])


# ── Request ID ─────────────────────────────────────────────────────────────────

REQUEST_ID_HEADER = "X-Request-ID"

# Accept only short, printable ASCII ids from clients.  This keeps the value
# safe for response headers and logs and prevents header/log injection.
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

#: ContextVar mirror of the current request id — handy for loguru bindings.
_request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")


def _incoming_request_id(scope: Scope) -> str | None:
    """Return a client-supplied X-Request-ID if it is safe to reuse."""
    for name, value in scope.get("headers", ()):
        if name.lower() == b"x-request-id":
            try:
                candidate = value.decode("latin-1").strip()
            except (UnicodeDecodeError, AttributeError):
                return None
            return candidate if _REQUEST_ID_RE.match(candidate) else None
    return None


def get_request_id(request: Request) -> str:
    """Return the request id for *request*, generating one if middleware ran late."""
    request_id = getattr(request.state, "request_id", None) or _request_id_ctx.get()
    if not request_id:
        request_id = uuid.uuid4().hex
    request.state.request_id = request_id
    return request_id


class RequestIDMiddleware:
    """Pure-ASGI middleware adding a request id to every HTTP request.

    - Reuses an inbound ``X-Request-ID`` (when safe) so proxies can correlate.
    - Otherwise generates a uuid4 hex id.
    - Stores it on ``request.state.request_id`` (and a ContextVar).
    - Echoes it as the ``X-Request-ID`` response header on every response,
      including handled 4xx/5xx responses produced by exception handlers.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        token = _request_id_ctx.set(request_id)

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            _request_id_ctx.reset(token)


# ── FastAPI dependencies ────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
    db: AsyncSession = Depends(get_db_session),
) -> User:
    """FastAPI dependency — return the authenticated User or 401."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未提供认证令牌",
        )
    try:
        payload = decode_token(credentials.credentials)
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="无效令牌")
        user_id_int = int(user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="令牌验证失败")
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="无效令牌")

    row = await db.get(User, user_id_int)
    if row is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    # Touch last_active_at (throttled: max once per 60s to reduce writes)
    now = datetime.now(timezone.utc)
    if row.last_active_at is None or (now - row.last_active_at).total_seconds() > 60:
        row.last_active_at = now
        await db.flush()
    return row


def require_role(*roles: str):
    """Factory: return a dependency that requires one of *roles*."""

    async def checker(
        user: Annotated[User, Depends(get_current_user)],
    ) -> User:
        user_role = user.role.value if isinstance(user.role, UserRole) else str(user.role)
        if user_role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="权限不足",
            )
        return user

    return checker


require_admin = require_role("ADMIN")


# ── Fine-grained permissions ───────────────────────────────────────────────────
#
# The 12 bits below mirror the legacy 六脉RCA平台 permission catalog.  They are
# *capability* permissions for mutating operations; read access stays governed by
# authentication + the existing role checks until business routes are wired up.
# Do not change the keys — the frontend, audit records and role matrices use
# them verbatim.

PERM_POLICY = "policy"                    # 改变触发策略
PERM_MODEL = "model"                      # 调整模型
PERM_TRIGGER_MODE = "trigger_mode"        # 调整触发模式
PERM_INBOX_DELETE = "inbox_delete"        # 告警列表·删除所选
PERM_INBOX_AUTOCLEAR = "inbox_autoclear"  # 告警列表·定时清空
PERM_TRASH_CLEAR = "trash_clear"          # 垃圾箱·清空全部
PERM_TRASH_AUTOCLEAR = "trash_autoclear"  # 垃圾箱·定时清空
PERM_RCA_TERMINATE = "rca_terminate"      # 批量终止
PERM_REPORT_EXPORT = "report_export"      # 导出报告
PERM_KB_ANNOTATE = "kb_annotate"          # 知识库标注
PERM_KB_EDIT = "kb_edit"                  # 根因库维护
PERM_KB_ADVICE = "kb_advice"              # 处置建议维护

PERMISSION_KEYS: tuple[str, ...] = (
    PERM_POLICY,
    PERM_MODEL,
    PERM_TRIGGER_MODE,
    PERM_INBOX_DELETE,
    PERM_INBOX_AUTOCLEAR,
    PERM_TRASH_CLEAR,
    PERM_TRASH_AUTOCLEAR,
    PERM_RCA_TERMINATE,
    PERM_REPORT_EXPORT,
    PERM_KB_ANNOTATE,
    PERM_KB_EDIT,
    PERM_KB_ADVICE,
)

#: Ordered catalog served by ``GET /api/auth/permissions`` for the settings UI.
PERMISSION_CATALOG: tuple[dict[str, str], ...] = (
    {
        "key": PERM_POLICY,
        "label": "改变触发策略",
        "description": "修改自动触发策略（触发通道 / 阈值 / 组件白名单）",
    },
    {
        "key": PERM_MODEL,
        "label": "调整模型",
        "description": "切换 RCA 分析所用的模型",
    },
    {
        "key": PERM_TRIGGER_MODE,
        "label": "调整触发模式",
        "description": "切换自动 / 人工触发模式",
    },
    {
        "key": PERM_INBOX_DELETE,
        "label": "告警列表·删除所选",
        "description": "删除告警列表中勾选的告警",
    },
    {
        "key": PERM_INBOX_AUTOCLEAR,
        "label": "告警列表·定时清空",
        "description": "配置告警列表的定时清空",
    },
    {
        "key": PERM_TRASH_CLEAR,
        "label": "垃圾箱·清空全部",
        "description": "清空告警垃圾箱的全部记录",
    },
    {
        "key": PERM_TRASH_AUTOCLEAR,
        "label": "垃圾箱·定时清空",
        "description": "配置告警垃圾箱的定时清空",
    },
    {
        "key": PERM_RCA_TERMINATE,
        "label": "批量终止",
        "description": "终止分析中的 RCA 任务（含批量）",
    },
    {
        "key": PERM_REPORT_EXPORT,
        "label": "导出报告",
        "description": "批量导出报告 zip（报告库）",
    },
    {
        "key": PERM_KB_ANNOTATE,
        "label": "知识库标注",
        "description": "根因知识库确认根因 / 标记误报",
    },
    {
        "key": PERM_KB_EDIT,
        "label": "根因库维护",
        "description": "根因知识库：手工添加 / 编辑 / 勾选删除",
    },
    {
        "key": PERM_KB_ADVICE,
        "label": "处置建议维护",
        "description": "处置建议知识库：新增 / 编辑 / 删除 / 上传",
    },
)

PERMISSION_LABELS: dict[str, str] = {
    item["key"]: item["label"] for item in PERMISSION_CATALOG
}

#: Default role → permission set.  Derived from ``User.role`` — no schema change.
#:
#: * ADMIN    — every capability.
#: * OPERATOR — day-to-day alert/RCA operations plus root-cause annotation.
#:              Governance (policy/model) and knowledge authoring stay admin-only.
#: * VIEWER   — read-only: no mutating capability at all.
_OPERATOR_PERMISSIONS = frozenset(
    {
        PERM_TRIGGER_MODE,
        PERM_INBOX_DELETE,
        PERM_INBOX_AUTOCLEAR,
        PERM_TRASH_CLEAR,
        PERM_TRASH_AUTOCLEAR,
        PERM_RCA_TERMINATE,
        PERM_REPORT_EXPORT,
        PERM_KB_ANNOTATE,
    }
)

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "ADMIN": frozenset(PERMISSION_KEYS),
    "OPERATOR": _OPERATOR_PERMISSIONS,
    "VIEWER": frozenset(),
}


def role_key(user: User) -> str:
    """Return an upper-case role key for *user* (tolerates str/Enum/None)."""
    role = getattr(user, "role", None)
    if isinstance(role, UserRole):
        return role.value
    return str(role or "").strip().upper()


def user_permissions(user: User) -> list[str]:
    """Return the effective permission keys for *user*.

    Unknown roles fall back to the least-privilege (VIEWER) set.  The result is
    ordered like :data:`PERMISSION_CATALOG` so UI rendering is deterministic.
    """
    granted = ROLE_PERMISSIONS.get(role_key(user), frozenset())
    return [key for key in PERMISSION_KEYS if key in granted]


def user_has_permission(user: User, perm: str) -> bool:
    """Return whether *user* holds permission bit *perm*."""
    return perm in ROLE_PERMISSIONS.get(role_key(user), frozenset())


def require_permission(perm: str):
    """Factory: FastAPI dependency requiring a single fine-grained permission.

    Business routes are intentionally not wired up yet — this only provides the
    dependency.  A denial is raised as an ``HTTPException`` whose dict ``detail``
    is expanded into the unified error envelope (``code=PERMISSION_DENIED``).
    """
    if perm not in PERMISSION_KEYS:
        raise ValueError(f"未知权限位: {perm!r}")

    async def checker(
        user: Annotated[User, Depends(get_current_user)],
    ) -> User:
        if user_has_permission(user, perm):
            return user
        label = PERMISSION_LABELS.get(perm, perm)
        role = role_key(user)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "PERMISSION_DENIED",
                "message": f"权限不足：当前角色缺少「{label}」权限",
                "permission": perm,
                "permission_label": label,
                "role": role,
            },
        )

    return checker
