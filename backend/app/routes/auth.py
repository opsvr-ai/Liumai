"""Authentication endpoints — login, token refresh, password change."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import create_token, get_current_user, hash_password, verify_password
from app.models import User
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


@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Authenticate and return a JWT.  Tries LDAP first, then local password."""
    from app.config import settings as s

    # 1. Try LDAP
    ldap_user = await authenticate_ldap(body.username, body.password)
    if ldap_user:
        # Find or create local user
        row = await db.execute(select(User).where(User.username == ldap_user.username))
        user: User | None = row.scalar_one_or_none()
        if user is None and s.LDAP_AUTO_CREATE_USER:
            user = User(
                username=ldap_user.username,
                role=UserRole.OPERATOR,
                team_id=1,
            )
            db.add(user)
            await db.flush()
            await db.refresh(user)
        if user:
            return LoginResponse(token=create_token(user), username=user.username, role=user.role.value)

    # 2. Fall back to local password
    row = await db.execute(select(User).where(User.username == body.username))
    user = row.scalar_one_or_none()
    if user is None or not user.password_hash:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return LoginResponse(
        token=create_token(user),
        username=user.username,
        role=user.role.value,
    )


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> None:
    """Change the authenticated user's password."""
    if user.password_hash and not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    user.password_hash = hash_password(body.new_password)
    await db.flush()


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
