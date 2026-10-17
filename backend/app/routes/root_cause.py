"""Root-cause knowledge base API (L1 retrieval augmentation).

Merged from the 六脉RCA平台 knowledge module:
* every completed RCA seeds a ``pending`` candidate automatically
* operators confirm / mark false-positive (closing the loop)
* similar-case search uses the same Jaccard token similarity as the RCA runner
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import RcaSession, RootCauseKnowledge, User
from app.models.database import get_db_session
from app.services.audit import record_audit
from app.services.rca_runner import _jaccard, _tokens

router = APIRouter()

LABELS = ("pending", "confirmed", "false_positive")


class RootCauseOut(BaseModel):
    id: int
    session_id: int | None
    service_name: str | None
    alert_type: str | None
    title: str | None
    root_cause: str | None
    digest: str | None
    evidence: list[Any]
    label: str
    created_by: str | None
    created_at: datetime
    updated_at: datetime


class PaginatedRootCauses(BaseModel):
    items: list[RootCauseOut]
    total: int
    page: int
    page_size: int


def _out(item: RootCauseKnowledge) -> RootCauseOut:
    return RootCauseOut(
        id=item.id,
        session_id=item.session_id,
        service_name=item.service_name,
        alert_type=item.alert_type,
        title=item.title,
        root_cause=item.root_cause,
        digest=item.digest,
        evidence=item.evidence or [],
        label=item.label,
        created_by=item.created_by,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.get("/root-causes", response_model=PaginatedRootCauses)
async def list_root_causes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    label: str | None = Query(None),
    service: str | None = Query(None),
    search: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedRootCauses:
    query = select(RootCauseKnowledge).where(RootCauseKnowledge.team_id == user.team_id)
    if label:
        query = query.where(RootCauseKnowledge.label == label)
    if service:
        query = query.where(RootCauseKnowledge.service_name.ilike(f"%{service.strip()}%"))
    if search:
        like = f"%{search.strip()}%"
        query = query.where(or_(
            RootCauseKnowledge.root_cause.ilike(like),
            RootCauseKnowledge.service_name.ilike(like),
            RootCauseKnowledge.title.ilike(like),
        ))
    query = query.order_by(RootCauseKnowledge.created_at.desc())

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    return PaginatedRootCauses(
        items=[_out(item) for item in rows.scalars()],
        total=total, page=page, page_size=page_size,
    )


@router.get("/root-causes/similar")
async def similar_root_causes(
    query: str | None = Query(None),
    service: str | None = Query(None),
    session_id: int | None = Query(None),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Find similar historical root-cause cases (Jaccard similarity)."""
    text = query or ""
    if session_id:
        session = await db.get(RcaSession, session_id)
        if session is None or session.team_id != user.team_id:
            raise HTTPException(status_code=404, detail="RCA 会话不存在")
        service = service or session.service_name
        text = text or " ".join([session.service_name or "", session.root_cause_summary or ""])

    rows = await db.execute(
        select(RootCauseKnowledge)
        .where(RootCauseKnowledge.team_id == user.team_id)
        .order_by(RootCauseKnowledge.created_at.desc())
        .limit(300)
    )
    current = _tokens(text)
    scored: list[tuple[float, RootCauseKnowledge]] = []
    for item in rows.scalars():
        hay = " ".join([
            item.service_name or "", item.alert_type or "",
            item.root_cause or "", item.digest or "",
        ])
        sim = _jaccard(current, _tokens(hay))
        if service and item.service_name == service:
            sim += 0.1
        if sim > 0.01:
            scored.append((sim, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return {
        "query": text,
        "items": [
            {**_out(item).model_dump(), "similarity": round(score, 4)}
            for score, item in scored[:limit]
        ],
    }


@router.post("/root-causes", response_model=RootCauseOut, status_code=201)
async def create_root_cause(
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> RootCauseOut:
    """Create a manual root-cause entry."""
    root_cause = str(payload.get("root_cause") or "").strip()
    if not root_cause:
        raise HTTPException(status_code=400, detail="root_cause 不能为空")
    service = str(payload.get("service_name") or "").strip()[:255]
    alert_type = str(payload.get("alert_type") or "").strip()[:50]
    item = RootCauseKnowledge(
        team_id=user.team_id,
        session_id=payload.get("session_id"),
        service_name=service or None,
        alert_type=alert_type or None,
        title=str(payload.get("title") or (service or "手工根因"))[:255],
        root_cause=root_cause[:4000],
        digest=str(payload.get("digest") or f"{service} {alert_type} {root_cause}")[:4000],
        evidence=payload.get("evidence") or [],
        label=payload.get("label") if payload.get("label") in LABELS else "confirmed",
        created_by=user.username,
    )
    db.add(item)
    await db.flush()
    await record_audit(
        db, user.username, "根因库新增",
        detail=f"{service}｜{root_cause[:80]}",
        extra={"root_cause_id": item.id},
    )
    await db.refresh(item)
    return _out(item)


@router.put("/root-causes/{item_id}/label", response_model=RootCauseOut)
async def label_root_cause(
    item_id: int,
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> RootCauseOut:
    """Annotate a case: ``confirmed`` / ``false_positive`` / ``pending``."""
    label = str(payload.get("label") or "").strip()
    if label not in LABELS:
        raise HTTPException(status_code=400, detail=f"label 必须是 {LABELS}")
    item = await db.get(RootCauseKnowledge, item_id)
    if item is None or item.team_id != user.team_id:
        raise HTTPException(status_code=404, detail="根因条目不存在")
    item.label = label
    await record_audit(
        db, user.username, "根因标注",
        detail=f"#{item.id} → {label}", extra={"root_cause_id": item.id},
    )
    await db.flush()
    await db.refresh(item)
    return _out(item)


@router.delete("/root-causes/{item_id}")
async def delete_root_cause(
    item_id: int,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    item = await db.get(RootCauseKnowledge, item_id)
    if item is None or item.team_id != admin.team_id:
        raise HTTPException(status_code=404, detail="根因条目不存在")
    await db.delete(item)
    await record_audit(db, admin.username, "根因库删除", detail=f"#{item_id}")
    return {"deleted": item_id}
