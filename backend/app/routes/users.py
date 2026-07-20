"""User and role management endpoints (admin only)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, hash_password, require_admin
from app.models import AuthType, User, UserRole
from app.models.database import get_db_session

router = APIRouter()


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    auth_type: str
    team_id: int
    created_at: str | None = None
    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=6)
    role: str = Field(default="VIEWER")
    team_id: int = Field(default=1)


class UserUpdate(BaseModel):
    role: str | None = None
    password: str | None = Field(default=None, min_length=6)
    team_id: int | None = None


@router.get("", response_model=list[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> list[UserOut]:
    """List all users (admin only)."""
    rows = await db.execute(select(User).order_by(User.id))
    return [
        UserOut(
            id=u.id, username=u.username, role=u.role.value,
            auth_type=u.auth_type.value,
            team_id=u.team_id,
            created_at=u.created_at.isoformat() if u.created_at else None,
        )
        for u in rows.scalars()
    ]


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> UserOut:
    """Create a new user (admin only)."""
    existing = await db.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="用户名已存在")
    role = body.role.upper()
    if role not in {r.value for r in UserRole}:
        raise HTTPException(status_code=400, detail=f"无效角色: {role}")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=UserRole(role),
        team_id=body.team_id,
        auth_type=AuthType.LOCAL,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return UserOut(id=user.id, username=user.username, role=user.role.value, auth_type=user.auth_type.value, team_id=user.team_id)


@router.put("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int, body: UserUpdate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> UserOut:
    """Update a user's role or password (admin only)."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.role:
        role = body.role.upper()
        if role not in {r.value for r in UserRole}:
            raise HTTPException(status_code=400, detail=f"无效角色: {role}")
        user.role = UserRole(role)
    if body.password:
        user.password_hash = hash_password(body.password)
    if body.team_id is not None:
        user.team_id = body.team_id
    await db.flush()
    await db.refresh(user)
    return UserOut(id=user.id, username=user.username, role=user.role.value, auth_type=user.auth_type.value, team_id=user.team_id)


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a user (admin only)."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.id == 1:
        raise HTTPException(status_code=400, detail="不能删除默认管理员")
    await db.delete(user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
