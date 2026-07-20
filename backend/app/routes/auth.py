"""Authentication endpoints — login, token refresh, password change."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import create_token, get_current_user, hash_password, verify_password
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
    from app.config import settings as s

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
    if s.LDAP_ENABLED:
        ldap_user = await authenticate_ldap(body.username, body.password)
        if ldap_user:
            if user is None:
                if s.LDAP_AUTO_CREATE_USER:
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


@router.get("/ldap-status", response_model=LdapStatus)
async def ldap_status(
    _admin: User = Depends(get_current_user),
) -> LdapStatus:
    """Test LDAP connectivity (admin only)."""
    from app.config import settings as s

    ok, msg = await test_ldap_connection()
    return LdapStatus(enabled=s.LDAP_ENABLED, ok=ok, message=msg)
