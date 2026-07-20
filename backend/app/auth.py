"""JWT authentication and RBAC helpers for the 六脉 platform.

Provides token creation, verification, and role-based access control
via FastAPI dependency injection.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import User, UserRole
from app.models.database import get_db_session

# ── Password hashing ───────────────────────────────────────────────────────────

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """Return a bcrypt hash of *password*."""
    return _pwd_ctx.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """Check *plain* against *hashed*."""
    return _pwd_ctx.verify(plain, hashed)


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
    except JWTError:
        raise HTTPException(status_code=401, detail="令牌验证失败")

    row = await db.get(User, int(user_id))
    if row is None:
        raise HTTPException(status_code=401, detail="用户不存在")
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
