"""User and role management endpoints (admin only)."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, hash_password, require_admin
from app.models import AuthType, User, UserRole
from app.models.database import get_db_session

router = APIRouter()


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str | None = None
    email: str | None = None
    department: str | None = None
    role: str
    auth_type: str
    team_id: int
    last_active_at: str | None = None
    created_at: str | None = None
    model_config = {"from_attributes": True}


def _user_out(user: User) -> UserOut:
    """Serialise a user row, including the LDAP-mirrored profile fields."""
    return UserOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        department=user.department,
        role=user.role.value,
        auth_type=user.auth_type.value,
        team_id=user.team_id,
        last_active_at=(
            user.last_active_at.isoformat() if user.last_active_at else None
        ),
        created_at=user.created_at.isoformat() if user.created_at else None,
    )


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
    return [_user_out(u) for u in rows.scalars()]


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
    return _user_out(user)


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
    return _user_out(user)


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


# ═══════════════════════════════════════════════════════════════════════════════
# Current-user profile endpoints
# ═══════════════════════════════════════════════════════════════════════════════


class UserProfileOut(BaseModel):
    id: int
    username: str
    display_name: str | None = None
    email: str | None = None
    department: str | None = None
    role: str
    auth_type: str
    team_id: int
    avatar_url: str | None = None
    created_at: str | None = None
    model_config = {"from_attributes": True}


def _profile_out(user: User) -> UserProfileOut:
    return UserProfileOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        department=user.department,
        role=user.role.value,
        auth_type=user.auth_type.value,
        team_id=user.team_id,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat() if user.created_at else None,
    )


class UserProfileUpdate(BaseModel):
    avatar_url: str | None = None


@router.get("/me", response_model=UserProfileOut)
async def get_my_profile(
    user: User = Depends(get_current_user),
) -> UserProfileOut:
    """Return the current user's profile."""
    return _profile_out(user)


@router.put("/me", response_model=UserProfileOut)
async def update_my_profile(
    body: UserProfileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> UserProfileOut:
    """Update the current user's profile (avatar URL)."""
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    await db.flush()
    await db.refresh(user)
    return _profile_out(user)


@router.get("/me/sessions")
async def list_my_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """List the current user's chat sessions."""
    from app.models import ChatSession as ChatSessionModel
    offset = (page - 1) * page_size
    total_q = await db.execute(
        select(func.count()).select_from(ChatSessionModel).where(
            ChatSessionModel.user_id == user.id
        )
    )
    total = total_q.scalar_one()
    rows = await db.execute(
        select(ChatSessionModel)
        .where(ChatSessionModel.user_id == user.id)
        .order_by(ChatSessionModel.updated_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    sessions = rows.scalars().all()
    return {
        "items": [
            {
                "id": s.id,
                "title": s.title,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in sessions
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.delete("/me/sessions/{session_id}")
async def delete_my_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Delete one of the current user's chat sessions."""
    from app.models import ChatSession as ChatSessionModel, ChatMessage as ChatMessageModel
    row = await db.execute(
        select(ChatSessionModel).where(
            ChatSessionModel.id == session_id,
            ChatSessionModel.user_id == user.id,
        )
    )
    session = row.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    await db.execute(
        delete(ChatMessageModel).where(ChatMessageModel.session_id == session_id)
    )
    await db.delete(session)
    await db.flush()
    return {"ok": True}


@router.get("/me/stats")
async def get_my_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Return usage statistics for the current user."""
    from app.models import ChatSession as ChatSessionModel, ChatMessage as ChatMessageModel
    sessions_q = await db.execute(
        select(func.count()).select_from(ChatSessionModel).where(
            ChatSessionModel.user_id == user.id
        )
    )
    total_sessions = sessions_q.scalar_one()

    messages_q = await db.execute(
        select(func.count()).select_from(ChatMessageModel).join(
            ChatSessionModel, ChatMessageModel.session_id == ChatSessionModel.id
        ).where(ChatSessionModel.user_id == user.id)
    )
    total_messages = messages_q.scalar_one()

    return {
        "total_sessions": total_sessions,
        "total_messages": total_messages,
    }


# Avatar upload directory
AVATAR_DIR = Path("/app/data/avatars")
AVATAR_MAX_BYTES = 2 * 1024 * 1024  # 2 MB

# Allowed image magic bytes (first bytes of common image formats)
_IMAGE_MAGIC = {
    b"\x89PNG\r\n\x1a\n":    ".png",
    b"\xff\xd8\xff":          ".jpg",
    b"GIF87a":               ".gif",
    b"GIF89a":               ".gif",
    b"RIFF":                 ".webp",  # RIFF....WEBP
    b"<?xml":                ".svg",   # SVG starts with XML declaration
    b"<svg":                 ".svg",
}


def _validate_image_bytes(data: bytes) -> None:
    """Verify that *data* starts with a known image magic-byte sequence."""
    for magic, _ext in _IMAGE_MAGIC.items():
        if data[:len(magic)] == magic:
            return
    raise HTTPException(status_code=400, detail="文件内容不是有效的图片格式")


@router.post("/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Upload a profile avatar image.  Returns the avatar URL."""
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="仅支持图片文件")
    body = await file.read()
    if len(body) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=400, detail="图片不能超过 2MB")

    # Validate file magic bytes (not just Content-Type header)
    _validate_image_bytes(body)

    # Generate unique filename preserving extension
    ext = os.path.splitext(file.filename or "avatar.png")[1] or ".png"
    safe_ext = ext if ext.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"} else ".png"
    filename = f"{uuid.uuid4().hex}{safe_ext}"
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    filepath = AVATAR_DIR / filename
    filepath.write_bytes(body)
    # Update user record
    avatar_url = f"/avatars/{filename}"
    user.avatar_url = avatar_url
    await db.flush()
    return {"avatar_url": avatar_url}
