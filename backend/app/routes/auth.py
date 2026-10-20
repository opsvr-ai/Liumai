"""Authentication endpoints — login, token refresh, password change."""

from __future__ import annotations

import re
import secrets as _secrets
import string as _string
import time

from fastapi import APIRouter, Depends, HTTPException, Response, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    PERMISSION_CATALOG,
    create_token,
    get_current_user,
    hash_password,
    require_admin,
    role_key,
    user_permissions,
    verify_password,
)
from app.models import AuthType, User, UserRole
from app.models.database import get_db_session
from app.services.ldap import (
    LDAP_UNAVAILABLE_ERRORS,
    STAGE_AUTO_CREATE,
    STAGE_SERVICE_BIND,
    LdapAuthResult,
    LdapUser,
    authenticate_ldap_detailed,
    test_ldap_connection,
)

router = APIRouter()

# Dummy bcrypt hash used for constant-time comparison when the target user
# does not exist — prevents username enumeration via timing side-channel.
# (bcrypt hash of "dummy_dummy_dummy")
HASH_DUMMY = "$2b$12$HlecgoPIhDe2E1maMkRVIeKxvyl/gJpAPsJKtDfrIGXRwyLphOKjS"


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str
    auth_type: str


# ── LDAP local-account provisioning ────────────────────────────────────────


def _auto_create_failure_detail(exc: Exception) -> str:
    """Turn a DB failure during LDAP provisioning into an actionable message.

    The raw exception is logged server-side; the client gets enough detail to
    tell a unique-constraint clash from a team/role problem without leaking SQL.
    """
    text = str(exc).lower()
    if (
        isinstance(exc, IntegrityError)
        or "unique constraint" in text
        or "duplicate key" in text
    ):
        return (
            "域认证成功，但自动创建本地账号失败：用户名唯一约束冲突"
            "（本地已存在同名账号或并发创建）。请联系管理员核对该账号。"
        )
    if "foreign key" in text or "team" in text or "role" in text:
        return (
            "域认证成功，但自动创建本地账号失败：默认团队或角色关联无效。"
            "请检查团队数据后重试。"
        )
    return (
        "域认证成功，但自动创建本地账号失败"
        f"（{type(exc).__name__}）。请联系管理员查看后端日志。"
    )


def _clean_profile_value(value: str | None) -> str | None:
    """Trim an LDAP profile value; blank values are stored as NULL."""
    text = (value or "").strip()
    return text or None


_LDAP_PROFILE_FIELDS = ("display_name", "email", "department")


def _sync_ldap_profile(user: User, ldap_user: LdapUser) -> bool:
    """Mirror non-empty LDAP profile values onto an existing local account.

    Empty LDAP values never clear a populated local field.  Returns True when
    at least one field changed so the caller can decide whether to flush.
    """
    changed = False
    for field in _LDAP_PROFILE_FIELDS:
        incoming = _clean_profile_value(getattr(ldap_user, field, None))
        if incoming is None or getattr(user, field) == incoming:
            continue
        setattr(user, field, incoming)
        changed = True
    return changed


async def _create_ldap_user(db: AsyncSession, ldap_user: LdapUser) -> User:
    """Create the local mirror account for a successfully authenticated user."""
    from app.models import Team

    team = await db.get(Team, 1)
    if team is None:
        team = Team(id=1, name="Default Team")
        db.add(team)
        await db.flush()

    user = User(
        username=ldap_user.username,
        role=UserRole.OPERATOR,
        team_id=team.id,
        auth_type=AuthType.LDAP,
        display_name=_clean_profile_value(ldap_user.display_name),
        email=_clean_profile_value(ldap_user.email),
        department=_clean_profile_value(ldap_user.department),
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


async def _ensure_ldap_local_user(
    db: AsyncSession, existing: User | None, ldap_user: LdapUser,
) -> User:
    """Return the local account for an LDAP login, auto-creating it if allowed."""
    if existing is not None:
        # Every successful LDAP login refreshes the mirrored profile fields;
        # role/team entitlements are managed locally and stay untouched.
        if _sync_ldap_profile(existing, ldap_user):
            await db.flush()
        return existing

    from app.services.ldap import _ldap_auto_create_user

    if not _ldap_auto_create_user:
        # Do not reveal that LDAP itself succeeded when provisioning is off.
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    try:
        return await _create_ldap_user(db, ldap_user)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — unique/team/role failures matter
        logger.exception(
            "LDAP auto-create failed for username={} (type={})",
            ldap_user.username, type(exc).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail=_auto_create_failure_detail(exc),
        ) from exc


# ── Setup (first-time admin creation) ──────────────────────────────────────

# Password policy — enforced for the initial admin account
MIN_PASSWORD_LENGTH = 10
PASSWORD_POLICY_MSG = (
    "密码不符合安全要求："
    "至少 10 位，且必须包含大写字母、小写字母、数字和特殊字符"
)


def _validate_password_strength(pw: str) -> str | None:
    """Return an error message if *pw* is too weak, or None if it passes."""
    if len(pw) < MIN_PASSWORD_LENGTH:
        return f"密码至少 {MIN_PASSWORD_LENGTH} 位"
    if not any(c.isupper() for c in pw):
        return "密码必须包含至少一个大写字母"
    if not any(c.islower() for c in pw):
        return "密码必须包含至少一个小写字母"
    if not any(c.isdigit() for c in pw):
        return "密码必须包含至少一个数字"
    if not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?/~`" for c in pw):
        return "密码必须包含至少一个特殊字符 (!@#$% 等)"
    return None


def _generate_secure_password(length: int = 20) -> str:
    """Generate a cryptographically random password meeting the strength policy."""
    upper = _secrets.choice(_string.ascii_uppercase)
    lower = _secrets.choice(_string.ascii_lowercase)
    digit = _secrets.choice(_string.digits)
    special = _secrets.choice("!@#$%^&*()_+-=[]{}|;:,.<>?")
    remaining = length - 4
    alphabet = _string.ascii_letters + _string.digits + "!@#$%^&*()_+-=[]{}|;:,.<>?"
    rest = "".join(_secrets.choice(alphabet) for _ in range(remaining))
    # Shuffle to avoid predictable positions
    combined = list(upper + lower + digit + special + rest)
    _secrets.SystemRandom().shuffle(combined)
    return "".join(combined)


class SetupStatus(BaseModel):
    needs_setup: bool


class SetupRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=MIN_PASSWORD_LENGTH)
    password_confirm: str = Field(..., min_length=MIN_PASSWORD_LENGTH)


class GeneratedPassword(BaseModel):
    password: str
    length: int


@router.get("/setup/status", response_model=SetupStatus)
async def setup_status(
    db: AsyncSession = Depends(get_db_session),
) -> SetupStatus:
    """Check whether the platform needs initial admin setup."""
    row = await db.execute(select(func.count(User.id)))
    count = row.scalar()
    return SetupStatus(needs_setup=count == 0)


@router.post("/setup", response_model=LoginResponse)
async def setup(
    body: SetupRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Create the first platform admin.  Rejected if any users already exist."""
    # Validate password strength
    pw_err = _validate_password_strength(body.password)
    if pw_err:
        raise HTTPException(status_code=400, detail=pw_err)

    # Validate password confirmation
    if body.password != body.password_confirm:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")

    # Use PostgreSQL advisory lock to prevent race condition when two
    # concurrent setup requests both pass the count==0 check.
    from sqlalchemy import text
    await db.execute(text("SELECT pg_advisory_xact_lock(1001)"))
    row = await db.execute(select(func.count(User.id)))
    if row.scalar() > 0:
        raise HTTPException(status_code=409, detail="系统已初始化")

    existing = await db.execute(
        select(User).where(User.username == body.username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="用户名已存在")

    # Ensure default team exists (needed for FK constraint)
    from app.models import Team
    team = await db.get(Team, 1)
    if team is None:
        team = Team(id=1, name="Default Team")
        db.add(team)
        await db.flush()

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=UserRole.ADMIN,
        team_id=team.id,
        auth_type=AuthType.LOCAL,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return LoginResponse(
        token=create_token(user), username=user.username, role=user.role.value,
        auth_type=user.auth_type.value,
    )


@router.get("/setup/generate-password", response_model=GeneratedPassword)
async def generate_setup_password() -> GeneratedPassword:
    """Return a cryptographically strong random password meeting the policy.

    Only available when the platform has not yet been initialised.
    """
    pw = _generate_secure_password()
    return GeneratedPassword(password=pw, length=len(pw))


# ── Login ──────────────────────────────────────────────────────────────────
@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Authenticate and return a JWT.

    Routing rules:
    - User exists with auth_type=LOCAL → verify local bcrypt password.
    - User does NOT exist, or exists with auth_type=LDAP → try LDAP bind.
      Auto-create on first successful LDAP login (when LDAP_AUTO_CREATE_USER).
    """
    # 1. Look up by username
    row = await db.execute(select(User).where(User.username == body.username))
    user: User | None = row.scalar_one_or_none()

    # 2. LOCAL auth — platform administrator
    if user and user.auth_type == AuthType.LOCAL:
        if not user.password_hash or not verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        return LoginResponse(
            token=create_token(user), username=user.username, role=user.role.value,
            auth_type=user.auth_type.value,
        )

    # 3. LDAP auth — enterprise users
    from app.services.ldap import _ldap_enabled

    # Mitigate timing side-channel: always run bcrypt against a dummy hash when
    # the user does NOT exist, so response time does not leak valid usernames.
    if user is None:
        verify_password(body.password, HASH_DUMMY)

    if _ldap_enabled:
        try:
            result = await authenticate_ldap_detailed(body.username, body.password)
        except Exception:  # noqa: BLE001 — infrastructure failure, not bad creds
            logger.exception("LDAP authentication raised in login route")
            raise HTTPException(
                status_code=503,
                detail="LDAP 认证服务异常，请稍后重试或联系管理员",
            )

        if result.ok and result.user is not None:
            user = await _ensure_ldap_local_user(db, user, result.user)
            return LoginResponse(
                token=create_token(user), username=user.username, role=user.role.value,
                auth_type=user.auth_type.value,
            )

        # Service/config failures are NOT wrong passwords: surface a 503 with
        # the classified Chinese reason so users stop resetting valid passwords.
        if result.error in LDAP_UNAVAILABLE_ERRORS:
            raise HTTPException(
                status_code=503,
                detail=result.detail or "LDAP 服务不可用或配置错误，请联系管理员",
            )

        # Unknown user, bad password, locked/expired account → uniform 401.
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    # 4. Neither local nor LDAP matched
    raise HTTPException(status_code=401, detail="用户名或密码错误")


# ── Permissions (current user) ─────────────────────────────────────────────

class PermissionItem(BaseModel):
    key: str
    label: str
    description: str


class PermissionsResponse(BaseModel):
    role: str
    permissions: list[str]
    catalog: list[PermissionItem]


@router.get("/permissions", response_model=PermissionsResponse)
async def get_permissions(
    user: User = Depends(get_current_user),
) -> PermissionsResponse:
    """Return the current user's permission bits plus the permission catalog.

    Permissions are derived from ``User.role`` (ADMIN/OPERATOR/VIEWER) — no
    schema change.  Routes should enforce them with ``Depends(require_permission(...))``.
    """
    return PermissionsResponse(
        role=role_key(user),
        permissions=user_permissions(user),
        catalog=[PermissionItem(**item) for item in PERMISSION_CATALOG],
    )


class CurrentUserOut(BaseModel):
    """Current-user profile (``GET /api/auth/me``), including LDAP-mirrored fields."""
    id: int
    username: str
    display_name: str | None = None
    email: str | None = None
    department: str | None = None
    role: str
    auth_type: str
    team_id: int
    avatar_url: str | None = None


@router.get("/me", response_model=CurrentUserOut)
async def get_current_user_profile(
    user: User = Depends(get_current_user),
) -> CurrentUserOut:
    """Return the authenticated user's profile with mirrored LDAP fields."""
    return CurrentUserOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        department=user.department,
        role=role_key(user),
        auth_type=user.auth_type.value,
        team_id=user.team_id,
        avatar_url=user.avatar_url,
    )


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> Response:
    """Change the authenticated user's password (LOCAL users only)."""
    if user.auth_type != AuthType.LOCAL:
        raise HTTPException(status_code=403, detail="域账号用户请通过 LDAP 修改密码")
    if not user.password_hash or not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    user.password_hash = hash_password(body.new_password)
    await db.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class LdapStatus(BaseModel):
    enabled: bool
    ok: bool
    message: str


class LdapConfig(BaseModel):
    """All LDAP configuration fields exposed to the admin UI."""
    enabled: bool = False
    server: str = "ldap://localhost:389"
    base_dn: str = "dc=example,dc=com"
    user_filter: str = "(uid={username})"
    bind_dn: str = ""
    bind_password: str = ""
    bind_password_set: bool = False  # read-only flag: a password is stored
    username_attr: str = "uid"
    display_name_attr: str = "displayName"
    email_attr: str = "mail"
    department_attr: str = "department"
    auto_create_user: bool = True


@router.get("/ldap-status", response_model=LdapStatus)
async def ldap_status(
    _admin: User = Depends(get_current_user),
) -> LdapStatus:
    """Test LDAP connectivity (admin only)."""
    ok, msg = await test_ldap_connection()
    from app.services.ldap import _ldap_enabled
    return LdapStatus(enabled=_ldap_enabled, ok=ok, message=msg)


@router.get("/ldap-config", response_model=LdapConfig)
async def get_ldap_config(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LdapConfig:
    """Return current LDAP configuration (from DB, falling back to env vars)."""
    from app.models import SystemConfig

    rows = await db.execute(select(SystemConfig))
    cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}

    def _get(key: str, default: str = "") -> str:
        return cfg.get(key, default)

    return LdapConfig(
        enabled=_get("ldap_enabled", "false") == "true",
        server=_get("ldap_server", "ldap://localhost:389"),
        base_dn=_get("ldap_base_dn", "dc=example,dc=com"),
        user_filter=_get("ldap_user_filter", "(uid={username})"),
        bind_dn=_get("ldap_bind_dn", ""),
        bind_password="",  # Never return the actual password
        bind_password_set=bool(_get("ldap_bind_password", "")),
        username_attr=_get("ldap_username_attr", "uid"),
        display_name_attr=(
            (_get("ldap_display_name_attr", "displayName") or "").strip()
            or "displayName"
        ),
        email_attr=(
            (_get("ldap_email_attr", "mail") or "").strip() or "mail"
        ),
        department_attr=(
            (_get("ldap_department_attr", "department") or "").strip()
            or "department"
        ),
        auto_create_user=_get("ldap_auto_create_user", "true") == "true",
    )


@router.put("/ldap-config", response_model=LdapConfig)
async def save_ldap_config(
    body: LdapConfig,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LdapConfig:
    """Save LDAP configuration to the database. Changes take effect immediately."""
    from app.models import SystemConfig

    entries: dict[str, str] = {
        "ldap_enabled": "true" if body.enabled else "false",
        "ldap_server": body.server,
        "ldap_base_dn": body.base_dn,
        "ldap_user_filter": body.user_filter,
        "ldap_bind_dn": body.bind_dn,
        "ldap_username_attr": body.username_attr,
        "ldap_display_name_attr": (body.display_name_attr or "").strip() or "displayName",
        "ldap_email_attr": (body.email_attr or "").strip() or "mail",
        "ldap_department_attr": (body.department_attr or "").strip() or "department",
        "ldap_auto_create_user": "true" if body.auto_create_user else "false",
    }

    # Resolve the bind password.  The UI never receives the stored value, so an
    # empty field means "keep what is already saved"; it must NOT wipe the
    # password and it must NOT drop it from the runtime reload either (the old
    # code only added it when non-empty, so saving unrelated settings silently
    # reset the in-memory password to the env default until restart).
    current = {r.key: r.value for r in (await db.execute(select(SystemConfig))).scalars()}
    stored_pw = current.get("ldap_bind_password", "")
    incoming_pw = (body.bind_password or "").strip()
    resolved_pw = incoming_pw or stored_pw
    entries["ldap_bind_password"] = resolved_pw

    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))

    await db.flush()

    # Reload the LDAP config into the running process
    from app.services.ldap import reload_ldap_config
    reload_ldap_config(entries)

    # Mask password in response
    body.bind_password = ""
    body.bind_password_set = bool(resolved_pw)
    return body


# ── Domain-user login diagnostics (admin) ──────────────────────────────────

class LdapTestUserRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class LdapTestUserResponse(BaseModel):
    """Contract for ``POST /api/auth/ldap-test-user``.

    ``stage`` is one of:
    ``service_bind`` / ``search`` / ``user_bind`` / ``auto_create``.
    ``detail`` is a Chinese explanation and never contains the password or a
    full distinguished name.
    """

    ok: bool
    stage: str
    detail: str


@router.post("/ldap-test-user", response_model=LdapTestUserResponse)
async def test_ldap_user_login(
    body: LdapTestUserRequest,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LdapTestUserResponse:
    """Diagnose a domain-user login end-to-end without logging the password.

    Runs the same LDAP chain as ``/login`` and then verifies the local-account
    provisioning step.  Auto-creation is exercised inside a savepoint and rolled
    back, so a successful test does not create a user.
    """
    result: LdapAuthResult = await authenticate_ldap_detailed(
        body.username, body.password,
    )
    if not result.ok or result.user is None:
        return LdapTestUserResponse(
            ok=False,
            stage=result.stage or STAGE_SERVICE_BIND,
            detail=result.detail or "LDAP 认证失败",
        )

    row = await db.execute(select(User).where(User.username == result.user.username))
    existing: User | None = row.scalar_one_or_none()

    if existing is not None:
        if existing.auth_type == AuthType.LDAP:
            return LdapTestUserResponse(
                ok=True,
                stage="user_bind",
                detail=f"LDAP 认证成功；本地账号已存在（角色 {role_key(existing)}）",
            )
        return LdapTestUserResponse(
            ok=False,
            stage=STAGE_AUTO_CREATE,
            detail=(
                "LDAP 认证成功，但本地已存在同名 LOCAL 账号；"
                "登录会走本地密码校验，域密码不会生效。请更换用户名或由管理员处理该账号。"
            ),
        )

    from app.services.ldap import _ldap_auto_create_user

    if not _ldap_auto_create_user:
        return LdapTestUserResponse(
            ok=False,
            stage=STAGE_AUTO_CREATE,
            detail=(
                "LDAP 认证成功，但未开启「LDAP 用户首次登录时自动创建本地账号」，"
                "当前配置下登录会被拒绝（401）。"
            ),
        )

    # Exercise the real create path inside a savepoint, then roll it back.
    try:
        nested = await db.begin_nested()
        try:
            await _create_ldap_user(db, result.user)
            await nested.rollback()
        except Exception:
            await nested.rollback()
            raise
    except Exception as exc:  # noqa: BLE001 — this endpoint reports, not raises
        logger.exception(
            "LDAP test-user auto-create failed for username={} (type={})",
            result.user.username, type(exc).__name__,
        )
        return LdapTestUserResponse(
            ok=False,
            stage=STAGE_AUTO_CREATE,
            detail=_auto_create_failure_detail(exc),
        )

    return LdapTestUserResponse(
        ok=True,
        stage=STAGE_AUTO_CREATE,
        detail="LDAP 认证成功，自动创建本地账号校验通过（测试未写入数据库）。",
    )


# ── Helpers ────────────────────────────────────────────────────────────────


def _mask_key(key: str) -> str:
    """Mask an API key for safe display: ``sk-1a...f9a``."""
    if not key or len(key) < 8:
        return key
    return f"{key[:4]}...{key[-3:]}"


def _resolve_secret(incoming: str | None, stored: str | None) -> str:
    """Decide which secret to persist.

    The settings form shows a **masked** key (``sk-1...9fa``).  Saving the form
    untouched used to write that mask back into the database, silently breaking
    every Hermes call with 401 while ``/health`` (public) still looked green.
    An empty or unchanged-mask value therefore keeps the stored secret; only a
    genuinely new value replaces it.
    """
    incoming = (incoming or "").strip()
    stored = (stored or "").strip()
    if not incoming:
        return stored
    if stored and incoming == _mask_key(stored):
        return stored
    return incoming


# ── Hermes config ──────────────────────────────────────────────────────────

class HermesConfigOut(BaseModel):
    url: str = "http://host.docker.internal:8642/v1"
    api_key: str = ""


@router.get("/hermes-config", response_model=HermesConfigOut)
async def get_hermes_config(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Return Hermes Gateway configuration (DB first, env vars as fallback)."""
    from app.config import settings as s
    from app.models import SystemConfig

    rows = await db.execute(select(SystemConfig))
    cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}
    raw_key = cfg.get("hermes_api_key") or s.HERMES_API_KEY or ""
    return HermesConfigOut(
        url=cfg.get("hermes_url") or s.HERMES_GATEWAY_URL,
        api_key=_mask_key(raw_key),
    )


@router.put("/hermes-config", response_model=HermesConfigOut)
async def save_hermes_config(
    body: HermesConfigOut,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Save Hermes Gateway configuration. Changes take effect for new connections."""
    from app.models import SystemConfig

    current = {r.key: r.value for r in (await db.execute(select(SystemConfig))).scalars()}
    entries = {
        "hermes_url": body.url,
        "hermes_api_key": _resolve_secret(body.api_key, current.get("hermes_api_key")),
    }
    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))

    await db.flush()

    from app.services.hermes import reload_hermes_config
    reload_hermes_config(entries)

    return HermesConfigOut(url=body.url, api_key=_mask_key(entries["hermes_api_key"]))


class HermesTestAttempt(BaseModel):
    url: str
    status: int | None = None
    error: str | None = None
    auth: str | None = None


class HermesTestResult(BaseModel):
    ok: bool
    message: str
    hint: str | None = None
    warning: str | None = None
    url: str | None = None
    status: int | None = None
    latency_ms: int | None = None
    attempts: list[HermesTestAttempt] = Field(default_factory=list)


@router.post("/hermes-test", response_model=HermesTestResult)
async def test_hermes_connection(
    _admin: User = Depends(require_admin),
) -> HermesTestResult:
    """Test Hermes connectivity through the shared health fallback chain.

    Uses ``HermesClient.get_health_detailed`` (``/health/detailed`` →
    ``/health`` → ``/v1/health``, Bearer with one unauthenticated retry) so the
    result matches what the chat layer actually sees.  The response carries the
    actionable hint and every attempted URL/status; the UI renders those
    instead of a single opaque "无法获取" message.
    """
    from app.services.hermes import HermesClient

    client = HermesClient(timeout=15.0)
    t0 = time.monotonic()
    try:
        health = await client.get_health_detailed()
    except Exception as exc:  # defensive: the probe itself never raises
        logger.exception("hermes-test probe failed")
        return HermesTestResult(
            ok=False,
            message=f"Hermes 连接失败: {exc}",
            hint="健康探测异常 — 请查看后端日志",
            latency_ms=round((time.monotonic() - t0) * 1000),
        )
    finally:
        try:
            await client.close()
        except Exception:
            logger.debug("hermes-test: client close failed")

    latency_ms = round((time.monotonic() - t0) * 1000)
    probe = health.get("_probe") if isinstance(health, dict) else None
    probe = probe if isinstance(probe, dict) else {}
    attempts = [HermesTestAttempt(**a) for a in (probe.get("attempts") or [])]

    if probe.get("ok"):
        status_code = probe.get("status")
        url = probe.get("url")
        warning = probe.get("warning")
        message = f"Hermes 服务正常 (HTTP {status_code}, {url})"
        if warning:
            message = f"{message} — {warning}"
        return HermesTestResult(
            ok=True,
            message=message,
            warning=warning,
            url=url,
            status=status_code,
            latency_ms=latency_ms,
            attempts=attempts,
        )

    hint = probe.get("hint") or "健康端点探测失败 — 请检查 API 地址、端口与 API Key"
    return HermesTestResult(
        ok=False,
        message=f"Hermes 连接失败：{hint}",
        hint=hint,
        latency_ms=latency_ms,
        attempts=attempts,
    )


# ── LLM model config (platform-internal use) ────────────────────────────────

class LlmConfigOut(BaseModel):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    welcome_prompt: str = ""


@router.get("/llm-config", response_model=LlmConfigOut)
async def get_llm_config(
    _admin: User = Depends(require_admin),
) -> LlmConfigOut:
    """Get the configured platform LLM settings."""
    from app.models import SystemConfig
    from app.models.database import async_session_factory
    async with async_session_factory() as s:
        rows = await s.execute(
            select(SystemConfig).where(SystemConfig.key.in_(["llm_base_url", "llm_api_key", "llm_model"]))
        )
        cfg = {r.key: r.value for r in rows.scalars()}
    raw_key = cfg.get("llm_api_key", "")
    return LlmConfigOut(
        base_url=cfg.get("llm_base_url", ""),
        api_key=_mask_key(raw_key),
        model=cfg.get("llm_model", ""),
    )


@router.put("/llm-config", response_model=LlmConfigOut)
async def save_llm_config(
    body: LlmConfigOut,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LlmConfigOut:
    """Save platform LLM settings."""
    from app.models import SystemConfig
    current = {r.key: r.value for r in (await db.execute(select(SystemConfig))).scalars()}
    entries = {
        "llm_base_url": body.base_url,
        "llm_api_key": _resolve_secret(body.api_key, current.get("llm_api_key")),
        "llm_model": body.model,
        "welcome_prompt": body.welcome_prompt,
    }
    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))
    await db.flush()
    return LlmConfigOut(
        base_url=body.base_url,
        api_key=_mask_key(entries["llm_api_key"]),
        model=body.model,
        welcome_prompt=body.welcome_prompt,
    )


# ── LLM model probe (admin-only, read-only discovery) ───────────────────────

# (base_url, api_key[:6]) -> (monotonic_timestamp, response_payload)
# Successful *and* failed probe results are cached for 60s so a repeatedly
# clicked button cannot hammer an external endpoint; invalid-input failures
# never reach the network and are not cached.
_LLM_PROBE_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_LLM_PROBE_TTL_SECONDS = 60.0


class LlmProbeRequest(BaseModel):
    base_url: str = ""
    api_key: str | None = None


def _normalize_probe_base(raw: str) -> str:
    return (raw or "").strip().rstrip("/")


def _probe_url_candidates(base: str) -> list[str]:
    """Return the model-list URLs to try, in order.

    A base that already ends in ``/v1`` gets ``/models`` appended; every other
    base first tries the OpenAI-compatible ``/v1/models`` path and only falls
    back to ``/models`` when the upstream answers 400/404.
    """
    base = (base or "").strip().rstrip("/")
    if base.endswith("/models"):
        return [base]
    if base.endswith("/v1") or "/v1/" in base:
        return [f"{base}/models"]
    return [f"{base}/v1/models", f"{base}/models"]


def _probe_endpoint(url: str) -> str:
    from urllib.parse import urlsplit

    return urlsplit(url).path or "/"


def _scrub_secret(text: object, secret: str) -> str:
    """Remove the API key (and key-shaped tokens) from an error string."""
    out = str(text or "")
    if secret:
        masked = _mask_key(secret) if len(secret) >= 8 else "***"
        out = out.replace(secret, masked)
    out = re.sub(r"sk-[A-Za-z0-9_\-]{6,}", lambda m: f"{m.group(0)[:5]}...", out)
    out = re.sub(
        r"([?&](?:api_?key|key|token)=)[^&\s]+",
        r"\1***",
        out,
        flags=re.IGNORECASE,
    )
    return out


def _parse_probe_models(payload: object) -> list[dict[str, str]]:
    """Accept ``{data: [{id, owned_by}]}`` and bare arrays of objects/strings."""
    raw: object = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return []
    models: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, str):
            model_id, owned_by = item, ""
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("model") or ""
            owned_by = item.get("owned_by") or ""
        else:
            continue
        model_id = str(model_id).strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append({"id": model_id, "owned_by": str(owned_by or "")})
    return models


def _probe_failure(reason: str) -> dict:
    """Failure envelope — HTTP 200 so the settings form keeps its normal state."""
    return {"ok": False, "error": reason, "hint": "可手动填写模型名"}


@router.post("/llm-models/probe")
async def probe_llm_models(
    body: LlmProbeRequest,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Discover the models exposed by an OpenAI-compatible endpoint.

    Read-only: nothing is persisted and the API key is never logged or echoed
    back.  ``api_key`` may be omitted (or left as the masked value the settings
    form shows) to reuse the stored ``llm_api_key``.
    """
    import httpx
    from app.models import SystemConfig

    base = _normalize_probe_base(body.base_url)
    if not base:
        return _probe_failure("Base URL 为空")
    if not base.startswith(("http://", "https://")):
        return _probe_failure("Base URL 必须以 http:// 或 https:// 开头")

    row = await db.get(SystemConfig, "llm_api_key")
    stored_key = ((row.value if row else "") or "").strip()

    api_key = (body.api_key or "").strip()
    if not api_key or (stored_key and api_key == _mask_key(stored_key)):
        api_key = stored_key

    cache_key = (base, api_key[:6])
    cached = _LLM_PROBE_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < _LLM_PROBE_TTL_SECONDS:
        return cached[1]

    def _remember(payload: dict) -> dict:
        _LLM_PROBE_CACHE[cache_key] = (time.monotonic(), payload)
        return payload

    def _fail(reason: str) -> dict:
        return _remember(_probe_failure(reason))

    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    candidates = _probe_url_candidates(base)
    last_reason = "未知错误"

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=True
    ) as client:
        for index, url in enumerate(candidates):
            try:
                resp = await client.get(url, headers=headers)
            except httpx.TimeoutException:
                return _fail("连接超时，请检查 Base URL 和网络")
            except httpx.ConnectError:
                return _fail("无法连接到服务，请检查 Base URL 和网络")
            except Exception as exc:  # noqa: BLE001 — never leak a traceback to the UI
                return _fail(_scrub_secret(f"请求失败：{exc}", api_key))

            if resp.status_code == 401:
                return _fail("API Key 无效")
            if resp.status_code == 403:
                return _fail("API Key 无权限（HTTP 403）")
            if resp.status_code in (400, 404):
                last_reason = (
                    "接口不存在（HTTP 404），请确认 Base URL"
                    if resp.status_code == 404
                    else "请求被拒绝（HTTP 400），请确认 Base URL"
                )
                # Only the OpenAI-style /v1/models path gets a fallback.
                if index + 1 < len(candidates):
                    continue
                return _fail(last_reason)
            if resp.status_code >= 400:
                return _fail(f"服务返回 HTTP {resp.status_code}")

            try:
                payload = resp.json()
            except Exception:  # noqa: BLE001
                return _fail("响应不是有效的 JSON")

            return _remember({
                "ok": True,
                "models": _parse_probe_models(payload),
                "endpoint": _probe_endpoint(url),
            })

    return _fail(last_reason)


# ── Welcome message generation ──────────────────────────────────────────────

class WelcomeRequest(BaseModel):
    username: str


@router.post("/generate-welcome")
async def generate_welcome(
    body: WelcomeRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Generate a personalised welcome message using the configured LLM."""
    from app.models import SystemConfig
    from app.models.database import async_session_factory
    import httpx

    # Load config
    async with async_session_factory() as s:
        rows = await s.execute(
            select(SystemConfig).where(SystemConfig.key.in_([
                "llm_base_url", "llm_api_key", "llm_model", "welcome_prompt",
            ]))
        )
        cfg = {r.key: r.value for r in rows.scalars()}

    base_url = cfg.get("llm_base_url", "").strip()
    api_key = cfg.get("llm_api_key", "").strip()
    model = cfg.get("llm_model", "").strip()

    if not base_url or not model:
        return {"text": (
            "你好！我是六脉智能运维助手。\n\n"
            "我可以帮你：\n"
            "• 实时监控系统指标与告警\n"
            "• 追踪故障根因，定位问题源头\n"
            "• 分析历史数据，发现潜在风险\n"
            "• 协调应急响应，推荐处置方案\n\n"
            "随时向我提问，让我们一起保障系统稳定运行。"
        ).replace("\n", " ")}  # single-line for typewriter; newlines preserved via spaces

    prompt = cfg.get("welcome_prompt", "").strip()
    if not prompt:
        prompt = (
            "你是六脉（Liumai）AIOps 智能运维平台的 AI 助手。"
            "请为用户 {username} 生成一段热情、专业的欢迎语（80-120字），"
            "介绍你能提供的核心能力：实时监控与告警分析、故障根因定位（RCA）、"
            "历史数据洞察、应急协作调度、以及智能问答。"
            "语气自信而亲和，让用户感到你是一个可靠的队友。"
            "只返回欢迎语正文，不要加引号或前缀。"
        )

    # Use the authenticated user's own username (ignore request body)
    system_prompt = prompt.replace("{username}", user.username)

    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # URL 拼接规则（与 Hermes / 直连 LLM 的约定一致）：
        #   * 已以 /chat/completions 结尾 → 原样使用；
        #   * 已含 /v1（如 http://host:8642/v1）→ 拼 /chat/completions；
        #   * 其它（如 http://host:8642）→ 补 /v1/chat/completions。
        # 旧实现两个分支完全相同，base 不带 /v1 时会请求 /chat/completions，
        # 必然 404，欢迎语永远落到兜底文案。
        base = base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            url = base
        elif base.endswith("/v1") or "/v1/" in base:
            url = f"{base}/chat/completions"
        else:
            url = f"{base}/v1/chat/completions"

        # 欢迎语只是装饰，用较短超时（15s）避免拖慢登录后的首屏。
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            resp = await client.post(
                url,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": "你好"},
                    ],
                    "max_tokens": 60,
                    "temperature": 0.8,
                },
                headers=headers,
            )
        if resp.status_code < 500:
            data = resp.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if text:
                return {"text": text.strip().strip('"').strip("'")}
        return {"text": "可以问我关于系统状态、故障排查、指标分析等问题"}
    except Exception:
        return {"text": "可以问我关于系统状态、故障排查、指标分析等问题"}
