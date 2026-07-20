"""Authentication endpoints — login, token refresh, password change."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import create_token, get_current_user, hash_password, require_admin, verify_password
from app.models import AuthType, User, UserRole
from app.models.database import get_db_session
from app.services.ldap import authenticate_ldap, test_ldap_connection

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str


# ── Setup (first-time admin creation) ──────────────────────────────────────
class SetupStatus(BaseModel):
    needs_setup: bool


class SetupRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=6)


@router.get("/setup/status", response_model=SetupStatus)
async def setup_status(
    db: AsyncSession = Depends(get_db_session),
) -> SetupStatus:
    """Check whether the platform needs initial admin setup."""
    row = await db.execute(
        select(func.count(User.id)).where(User.auth_type == AuthType.LOCAL)
    )
    count = row.scalar()
    return SetupStatus(needs_setup=count == 0)


@router.post("/setup", response_model=LoginResponse)
async def setup(
    body: SetupRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Create the first platform admin.  Rejected if setup already complete."""
    row = await db.execute(
        select(func.count(User.id)).where(User.auth_type == AuthType.LOCAL)
    )
    if row.scalar() > 0:
        raise HTTPException(status_code=409, detail="系统已初始化")

    if await db.execute(
        select(User).where(User.username == body.username)
    ).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="用户名已存在")

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=UserRole.ADMIN,
        team_id=1,
        auth_type=AuthType.LOCAL,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return LoginResponse(
        token=create_token(user), username=user.username, role=user.role.value,
    )


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
        if not user.password_hash:
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        if not verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        return LoginResponse(
            token=create_token(user), username=user.username, role=user.role.value,
        )

    # 3. LDAP auth — enterprise users
    from app.services.ldap import _ldap_enabled, _ldap_auto_create_user
    if _ldap_enabled:
        ldap_user = await authenticate_ldap(body.username, body.password)
        if ldap_user:
            if user is None:
                if _ldap_auto_create_user:
                    user = User(
                        username=ldap_user.username,
                        role=UserRole.OPERATOR,
                        team_id=1,
                        auth_type=AuthType.LDAP,
                    )
                    db.add(user)
                    await db.flush()
                    await db.refresh(user)
                else:
                    raise HTTPException(status_code=401, detail="用户不存在且未启用自动创建")
            return LoginResponse(
                token=create_token(user), username=user.username, role=user.role.value,
            )

    # 4. Neither local nor LDAP matched
    raise HTTPException(status_code=401, detail="用户名或密码错误")


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> Response:
    """Change the authenticated user's password."""
    if user.password_hash and not verify_password(body.old_password, user.password_hash):
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
    username_attr: str = "uid"
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
        bind_password=_get("ldap_bind_password", ""),
        username_attr=_get("ldap_username_attr", "uid"),
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
        "ldap_bind_password": body.bind_password,
        "ldap_username_attr": body.username_attr,
        "ldap_auto_create_user": "true" if body.auto_create_user else "false",
    }

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

    return body


# ── Hermes config ──────────────────────────────────────────────────────────

class HermesConfigOut(BaseModel):
    url: str = "http://host.docker.internal:8642/v1"
    api_key: str = ""


@router.get("/hermes-config", response_model=HermesConfigOut)
async def get_hermes_config(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Return current Hermes Gateway configuration."""
    from app.models import SystemConfig

    rows = await db.execute(select(SystemConfig))
    cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}
    return HermesConfigOut(
        url=cfg.get("hermes_url", "http://host.docker.internal:8642/v1"),
        api_key=cfg.get("hermes_api_key", ""),
    )


@router.put("/hermes-config", response_model=HermesConfigOut)
async def save_hermes_config(
    body: HermesConfigOut,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Save Hermes Gateway configuration. Changes take effect for new connections."""
    from app.models import SystemConfig

    entries = {
        "hermes_url": body.url,
        "hermes_api_key": body.api_key,
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

    return body
