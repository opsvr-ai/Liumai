"""Webhook alert ingestion, inbox, trigger policy and statistics.

Ported from the 六脉RCA平台 webhook service.  The public ``POST /webhook``
endpoint accepts Tarsier / Zabbix alert payloads, normalises them, applies the
runtime trigger policy (severity / critical component / high-risk signature),
de-duplicates, coalesces alerts from the same application, and automatically
launches an RCA session.

The authenticated endpoints power the 告警中心 UI:
  GET  /inbox          告警收件箱
  GET  /trash          垃圾箱（策略过滤 / 人工忽略）
  POST /batch-trigger  人工批量触发（1~50 条聚合为 1 个 RCA 会话）
  POST /{id}/trigger   人工触发 RCA
  POST /{id}/dismiss   忽略告警
  GET  /policy         查看触发策略
  PUT  /policy         修改触发策略（管理员）
  GET  /stats          告警 / RCA 统计
  GET/POST/DELETE /webhook-tokens  webhook 令牌 → 团队绑定（管理员）
  POST /purge          按保留期手动清理告警（管理员）
"""

from __future__ import annotations

import asyncio
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    HTTPException,
    Query,
    Request,
    status,
)
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import (
    Alert,
    CollaborationEvent,
    CollaborationEventType,
    RcaSession,
    RcaStatus,
    RcaTriggerType,
    Team,
    User,
)
from app.models.database import get_db_session
from app.services.alert_pipeline import (
    INBOX_STATUSES,
    MAX_WEBHOOK_TOKENS,
    TRASH_STATUSES,
    create_manual_session,
    get_policy,
    get_webhook_tokens,
    ingest_alert,
    mask_webhook_token,
    purge_expired_alerts,
    resolve_webhook_auth,
    save_policy,
    save_webhook_tokens,
    severity_label,
)
from app.services.audit import record_audit
from app.services.rca_runner import run_rca_session

router = APIRouter()

# 应用级合并（P1-3）：进行中会话的「存活」判定阈值。runner 每 30s 写一次
# 心跳时间线，300s 内没有心跳/开始事件的运行中会话视为已死，不再往里并入。
REUSE_FRESH_SECONDS = 300
# 人工批量聚合（P1-4）：一次最多聚合的告警数（老平台同为 1~50）。
MAX_BATCH_TRIGGER_IDS = 50
# 保留期清理（P2-8）：惰性触发的最小间隔（每小时最多一次）。
AUTO_CLEAR_MIN_INTERVAL_SECONDS = 3600


# ═══════════════════════════════════════════════════════════════════════════════
# Lazy scheduled purge (P2-8)
# ═══════════════════════════════════════════════════════════════════════════════
#
# 不修改 main.py 的 lifespan：webhook / 列表读取时惰性触发，进程内每小时
# 最多真正跑一次。多副本部署时每个副本各自每小时清理一次，DELETE 幂等。

_auto_clear_last_at: float | None = None
_auto_clear_lock: asyncio.Lock | None = None


def _auto_clear_lock_obj() -> asyncio.Lock:
    global _auto_clear_lock
    if _auto_clear_lock is None:
        _auto_clear_lock = asyncio.Lock()
    return _auto_clear_lock


async def _maybe_auto_clear(db: AsyncSession) -> None:
    """Best-effort purge of expired inbox/trash rows (at most once per hour)."""
    global _auto_clear_last_at
    now = time.monotonic()
    if (
        _auto_clear_last_at is not None
        and now - _auto_clear_last_at < AUTO_CLEAR_MIN_INTERVAL_SECONDS
    ):
        return
    lock = _auto_clear_lock_obj()
    if lock.locked():
        return
    async with lock:
        now = time.monotonic()
        if (
            _auto_clear_last_at is not None
            and now - _auto_clear_last_at < AUTO_CLEAR_MIN_INTERVAL_SECONDS
        ):
            return
        # 先记时间戳：即使本次失败也不会被每个请求反复重试刷屏。
        _auto_clear_last_at = now
        try:
            policy = await get_policy(db)
            if not (policy.get("retention") or {}).get("auto_clear_enabled", True):
                return
            result = await purge_expired_alerts(db, team_id=None, policy=policy)
            if result["deleted_total"]:
                logger.info(
                    "告警保留期自动清理：inbox={} trash={} (inbox_days={} trash_days={})",
                    result["deleted_inbox"],
                    result["deleted_trash"],
                    result["inbox_days"],
                    result["trash_days"],
                )
                await record_audit(
                    db, "system", "告警保留期自动清理",
                    detail=(
                        f"删除收件箱 {result['deleted_inbox']} 条、垃圾箱 "
                        f"{result['deleted_trash']} 条（保留 {result['inbox_days']}d / "
                        f"{result['trash_days']}d）"
                    )[:4000],
                    extra={
                        "deleted_inbox": result["deleted_inbox"],
                        "deleted_trash": result["deleted_trash"],
                        "scope": "all_teams",
                    },
                )
                await db.commit()
        except Exception:  # noqa: BLE001 — 清理失败不能影响接入/查询
            logger.exception("告警保留期自动清理失败")
            try:
                await db.rollback()
            except Exception:
                pass



# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


class AlertOut(BaseModel):
    id: int
    alert_uid: str | None
    source: str | None
    ip: str | None
    ci_name: str | None
    ci_application: str | None
    ci_id: str | None
    content: str | None
    severity: str | None
    severity_level: int | None
    severity_label: str
    alert_type: str | None
    metric: str | None
    alert_time: datetime | None
    status: str
    trigger_reason: str | None
    rca_session_id: int | None
    raw_payload: dict[str, Any] | None
    created_at: datetime


class PaginatedAlerts(BaseModel):
    items: list[AlertOut]
    total: int
    page: int
    page_size: int


class BatchTriggerRequest(BaseModel):
    """人工批量触发（P1-4）：勾选 1~50 条告警聚合成 1 个 RCA 会话。"""

    ids: list[int] = Field(
        ...,
        min_length=1,
        max_length=MAX_BATCH_TRIGGER_IDS,
        description="告警主键（alerts.id）列表，1~50 条",
    )


class WebhookTokenCreate(BaseModel):
    """Create a token→team binding. The full token is returned exactly once."""

    name: str | None = Field(None, max_length=100)
    team_id: int = Field(1, ge=1, le=2_147_483_647)
    enabled: bool = True
    token: str | None = Field(
        None,
        min_length=8,
        max_length=255,
        description="可选：自定义令牌（≥8 位）；省略则服务端生成随机令牌",
    )



def _alert_out(a: Alert) -> AlertOut:
    return AlertOut(
        id=a.id,
        alert_uid=a.alert_uid,
        source=a.source,
        ip=a.ip,
        ci_name=a.ci_name,
        ci_application=a.ci_application,
        ci_id=a.ci_id,
        content=a.content,
        severity=a.severity,
        severity_level=a.severity_level,
        severity_label=severity_label(a.severity_level or 4),
        alert_type=a.alert_type,
        metric=a.metric,
        alert_time=a.alert_time,
        status=a.status,
        trigger_reason=a.trigger_reason,
        rca_session_id=a.rca_session_id,
        raw_payload=a.raw_payload or {},
        created_at=a.created_at,
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


def _token_out(entry: dict[str, Any], team_names: dict[int, str]) -> dict[str, Any]:
    """Public (masked) view of one token entry — never exposes the secret."""
    token = str(entry.get("token") or "")
    return {
        "id": str(entry.get("id") or ""),
        "name": str(entry.get("name") or ""),
        "team_id": int(entry.get("team_id") or 1),
        "team_name": team_names.get(int(entry.get("team_id") or 1)),
        "enabled": bool(entry.get("enabled", True)),
        "created_at": str(entry.get("created_at") or ""),
        "token_prefix": token[:6],
        "masked": mask_webhook_token(token),
    }


async def _team_options(db: AsyncSession) -> list[dict[str, Any]]:
    rows = await db.execute(select(Team).order_by(Team.id.asc()))
    return [{"id": team.id, "name": team.name} for team in rows.scalars()]


async def _team_names(db: AsyncSession) -> dict[int, str]:
    return {item["id"]: item["name"] for item in await _team_options(db)}


# ═══════════════════════════════════════════════════════════════════════════════
# Application-level coalescing (P1-3)
# ═══════════════════════════════════════════════════════════════════════════════
#
# alert_pipeline 的合并判定只看「会话创建时间在窗口内」，长跑会话一旦超出
# app_coalesce_window 就会被重复触发。这里在 ingest 之后做一层「后置合并」：
# 若同应用存在**存活**的 RUNNING/QUEUED 会话（心跳新鲜），把刚建出来的新
# 会话整体折进旧会话（移动告警、累加计数、扩展窗口、写时间线/审计），
# 撤销新会话并跳过调度。这样即使窗口配置很短，也不会重复起会话。
#
# 说明：不改 alert_pipeline.py（另一任务写入范围），本层是幂等的兜底；
# 若 pipeline 自身改为「运行中无条件复用」，本层自然不会再命中（没有新会话）。


def _alert_service(alert: Alert) -> str:
    return (alert.ci_application or alert.ci_name or alert.source or "unknown")[:255]


def _fmt_dt(value: datetime | None) -> str:
    if value is None:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")


def _fresh_enough(reference: datetime | None, seconds: int = REUSE_FRESH_SECONDS) -> bool:
    if reference is None:
        return False
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - reference).total_seconds() <= seconds


async def _session_last_activity(db: AsyncSession, session_id: int) -> datetime | None:
    """最近一次心跳/开始事件时间（runner 30s 心跳；无心跳的老会话退回创建时间）。"""
    rows = await db.execute(
        select(func.max(CollaborationEvent.created_at)).where(
            CollaborationEvent.rca_session_id == session_id,
            CollaborationEvent.event_type == CollaborationEventType.AGENT_PROGRESS,
            CollaborationEvent.metadata_["kind"].astext.in_(
                ("rca_heartbeat", "rca_started")
            ),
        )
    )
    return rows.scalar_one_or_none()


async def _find_reusable_session(
    db: AsyncSession,
    *,
    team_id: int,
    service_name: str | None,
    exclude_id: int,
    before: tuple[datetime, int] | None = None,
) -> RcaSession | None:
    """同应用、状态 QUEUED/RUNNING、且仍有心跳的**最老**会话。

    ``before=(created_at, id)`` 只允许复用「严格早于新会话」的会话：
    并发 webhook 各自新建会话时，后建的一方并入先建的一方，先建的一方
    不会反向并入后建会话，避免互相删除/循环合并。
    """
    if not service_name:
        return None
    rows = await db.execute(
        select(RcaSession)
        .where(
            RcaSession.id != exclude_id,
            RcaSession.team_id == team_id,
            RcaSession.service_name == service_name,
            RcaSession.status.in_([RcaStatus.QUEUED, RcaStatus.RUNNING]),
            RcaSession.completed_at.is_(None),
        )
        .order_by(RcaSession.created_at.asc(), RcaSession.id.asc())
        .limit(10)
    )
    for session in rows.scalars():
        if before is not None and session.created_at is not None:
            if (session.created_at, session.id) >= before:
                continue
        last = await _session_last_activity(db, session.id)
        if _fresh_enough(last or session.created_at):
            return session
    return None


async def _fold_into_active_session(
    db: AsyncSession,
    new_session_id: int,
    *,
    actor: str,
) -> dict[str, Any] | None:
    """把刚创建的新会话折进同应用存活会话；无需合并时返回 None。"""
    new_session = await db.get(RcaSession, new_session_id)
    if (
        new_session is None
        or new_session.status != RcaStatus.QUEUED
        or new_session.completed_at is not None
    ):
        return None
    target = await _find_reusable_session(
        db,
        team_id=new_session.team_id,
        service_name=new_session.service_name,
        exclude_id=new_session.id,
        before=(
            (new_session.created_at, new_session.id)
            if new_session.created_at is not None else None
        ),
    )
    if target is None:
        return None

    target_id = target.id
    service = new_session.service_name
    try:
        moved_rows = await db.execute(
            select(Alert).where(Alert.rca_session_id == new_session.id)
        )
        moved = list(moved_rows.scalars())
        for alert in moved:
            alert.rca_session_id = target_id
            alert.status = "coalesced"
            alert.trigger_reason = f"app_coalesce({alert.trigger_reason or ''})"[:2000]

        target.alert_count = (target.alert_count or 1) + len(moved)
        starts = [
            value for value in
            (target.time_window_start, new_session.time_window_start) if value
        ]
        ends = [
            value for value in
            (target.time_window_end, new_session.time_window_end) if value
        ]
        target.time_window_start = min(starts) if starts else None
        target.time_window_end = max(ends) if ends else None

        db.add(CollaborationEvent(
            rca_session_id=target_id,
            event_type=CollaborationEventType.AGENT_PROGRESS,
            content=(
                f"应用级合并：{len(moved)} 条新告警并入进行中会话"
                f"（复用 #{target_id}，撤销新建会话 #{new_session.id}）。"
                "同应用存在存活会话时不再另起分析，不受合并窗口限制。"
            )[:1000],
            metadata_={
                "kind": "app_coalesce",
                "merged_session_id": new_session.id,
                "alert_ids": [a.id for a in moved],
                "alert_uids": [a.alert_uid for a in moved if a.alert_uid],
            },
        ))
        await record_audit(
            db, actor, "告警合并",
            detail=(
                f"新建会话 #{new_session.id} 并入 #{target_id}"
                f"（应用 {service}，{len(moved)} 条告警）"
            )[:4000],
            extra={"session_id": target_id, "merged_session_id": new_session.id},
        )
        # 先把 alerts.rca_session_id 落到目标会话，再删新会话（FK 为 SET NULL）。
        await db.flush()
        await db.delete(new_session)
        await db.commit()
    except Exception:  # noqa: BLE001 — 合并失败时退回「新建会话」原路径
        logger.exception(
            "应用级合并失败，保留新建会话: new_session_id={}", new_session_id,
        )
        try:
            await db.rollback()
        except Exception:
            pass
        return None

    return {
        "status": "coalesced",
        "rca_id": f"rca-{target_id}",
        "rca_session_id": target_id,
        "merged_from": new_session_id,
        "alerts": len(moved),
        "message": (
            f"已并入同应用进行中的 RCA #{target_id}"
            f"（复用会话，未另起 #{new_session_id}）"
        ),
    }


async def _merge_batch_into_session(
    db: AsyncSession,
    target: RcaSession,
    alerts: list[Alert],
    *,
    actor: str,
    reason: str,
    earliest: datetime,
    latest: datetime,
) -> dict[str, Any]:
    """人工批量触发命中同应用存活会话：并入而不是新起会话（P1-3）。"""
    target_id = target.id
    target.alert_count = (target.alert_count or 1) + len(alerts)
    starts = [v for v in (target.time_window_start, earliest) if v]
    ends = [v for v in (target.time_window_end, latest) if v]
    target.time_window_start = min(starts) if starts else None
    target.time_window_end = max(ends) if ends else None
    for alert in alerts:
        alert.rca_session_id = target_id
        alert.status = "coalesced"
        alert.trigger_reason = f"app_coalesce({reason})"[:2000]

    uids = "、".join(str(a.alert_uid) for a in alerts[:6])
    db.add(CollaborationEvent(
        rca_session_id=target_id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"人工批量触发：{len(alerts)} 条告警并入进行中 RCA #{target_id}"
            f"（不另起会话）：{uids}；窗口扩展至 "
            f"{_fmt_dt(target.time_window_start)} ~ {_fmt_dt(target.time_window_end)}"
        )[:1000],
        metadata_={
            "kind": "manual_batch_coalesce",
            "alert_ids": [a.id for a in alerts],
            "alert_uids": [a.alert_uid for a in alerts],
            "actor": actor,
        },
    ))
    await record_audit(
        db, actor, "人工批量触发RCA",
        detail=(
            f"并入进行中会话 #{target_id} alerts={len(alerts)} "
            f"ids={[a.id for a in alerts][:50]} reason={reason}"
        )[:4000],
        extra={"session_id": target_id, "alert_ids": [a.id for a in alerts]},
    )
    await db.commit()
    return {
        "status": "coalesced",
        "rca_session_id": target_id,
        "alerts": len(alerts),
        "service_name": target.service_name,
        "time_window_start": (
            target.time_window_start.isoformat() if target.time_window_start else None
        ),
        "time_window_end": (
            target.time_window_end.isoformat() if target.time_window_end else None
        ),
        "message": (
            f"同应用已有进行中的 RCA #{target_id}，已并入 {len(alerts)} 条告警"
            "（未另起会话）"
        ),
    }


async def _schedule_ingest(
    db: AsyncSession,
    background: BackgroundTasks,
    result: dict[str, Any],
    *,
    actor: str,
) -> dict[str, Any]:
    """先尝试并入存活会话，未命中才调度 runner。"""
    session_id = result.get("run_session_id")
    if not session_id:
        return result
    try:
        merged = await _fold_into_active_session(db, int(session_id), actor=actor)
    except Exception:  # noqa: BLE001 — 合并失败不能丢分析
        logger.exception("应用级合并异常，按新建会话继续")
        merged = None
    if merged is not None:
        merged_result = dict(result)
        merged_result.update(merged)
        merged_result.pop("run_session_id", None)
        if result.get("trigger_reason"):
            merged_result["trigger_reason"] = (
                f"app_coalesce({result['trigger_reason']})"
            )
        return merged_result
    background.add_task(run_rca_session, int(session_id))
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Public webhook
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/webhook")
async def webhook_alert(
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Receive one alert object, or a JSON array of alerts, from monitoring.

    Authentication / tenancy:
      * ``alert_webhook_tokens`` configured → the ``X-Webhook-Token`` header
        (or ``?token=``) selects an **enabled** binding and its ``team_id``;
        unknown or disabled tokens → 401;
      * not configured → backward-compatible single-team mode: the legacy
        global ``webhook_token`` (when set) is still required, everything is
        ingested into team 1.

    The resolved ``team_id`` is threaded through ``ingest_alert`` (alert row,
    de-duplication, rule matching, RCA session and coalescing).
    """
    supplied = (
        request.headers.get("x-webhook-token")
        or request.query_params.get("token")
        or ""
    ).strip()
    auth = await resolve_webhook_auth(db, supplied)
    if not auth.authorized:
        raise HTTPException(status_code=401, detail="Webhook 令牌无效")
    team_id = auth.team_id

    # 惰性定时清空（每小时最多一次）：放在鉴权之后，避免无效请求触发。
    await _maybe_auto_clear(db)

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="请求体必须是 JSON（单条对象或数组）",
        )

    source_ip = _client_ip(request)

    if isinstance(payload, list):
        results: list[dict[str, Any]] = []
        for item in payload:
            r = await ingest_alert(
                db, item, team_id=team_id, source_ip=source_ip,
            )
            r = await _schedule_ingest(db, background, r, actor="webhook")
            results.append(r)
        await record_audit(
            db, "webhook", "告警接入",
            detail=f"批量 {len(results)} 条（team={team_id}，{auth.mode}）",
            ip=source_ip,
            extra={
                "results": [r.get("status") for r in results][:50],
                "team_id": team_id,
                "auth_mode": auth.mode,
            },
        )
        return {"status": "batch_processed", "results": results}

    result = await ingest_alert(db, payload, team_id=team_id, source_ip=source_ip)
    result = await _schedule_ingest(db, background, result, actor="webhook")
    await record_audit(
        db, "webhook", "告警接入",
        detail=(f"{result.get('alert_id')} → {result.get('status')} "
                f"(team={team_id}) {(result.get('message') or '')[:200]}"),
        ip=source_ip,
        extra={
            "status": result.get("status"),
            "rca_session_id": result.get("rca_session_id"),
            "team_id": team_id,
            "auth_mode": auth.mode,
        },
    )
    return result


@router.get("/webhook-info")
async def webhook_info(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Return webhook URL + token + a ready-to-use curl example."""
    policy = await get_policy(db)
    token = policy.get("webhook_token") or ""
    bindings = await get_webhook_tokens(db)
    token_mode = "multi" if bindings else ("legacy" if token else "open")
    base = str(request.base_url).rstrip("/")
    sample = {
        "SOURCEID": "Goldendb",
        "SOURCENAME": "Goldendb",
        "SOURCECINAME": "10.0.0.8",
        "CINAME": "db-node-01",
        "CIAPPLICATION": "Nginx",
        "SEVERITY": 2,
        "SUMMARY": "Nginx 连接池耗尽",
        "KPINAME": "nginx.connections.active",
        "LASTOCCURRENCE": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "SERIAL": "alert-20261017-0001",
    }
    import json as _json
    body = _json.dumps(sample, ensure_ascii=False)
    # 多团队模式下若没有旧的全局令牌，curl 里用占位符提示需要带团队令牌。
    curl_token = token or ("<团队令牌>" if bindings else "")
    curl = (
        f"curl -X POST '{base}/api/alerts/webhook' "
        f"-H 'Content-Type: application/json' "
        + (f"-H 'X-Webhook-Token: {curl_token}' " if curl_token else "")
        + f"-d '{body}'"
    )
    return {
        "url": f"{base}/api/alerts/webhook",
        "token": token if user.role.value == "ADMIN" else "",
        "token_configured": bool(token),
        "token_mode": token_mode,
        "team_token_count": len(bindings),
        "sample_payload": sample,
        "curl": curl,
        "formats": [
            "Tarsier: SERIAL/CINAME/CIAPPLICATION/SEVERITY/SUMMARY/LASTOCCURRENCE…",
            "Tarsier 多源: {eventInfo: {SUMMARY, SEVERITY, SOURCECINAME…}}",
            "字段兼容: alertId/alertLevel/alertContent/host_ip/ciApplication…",
            "支持 Java Map.toString() 字符串与 JSON 数组批量推送",
        ],
    }


@router.post("/webhook/rotate-token")
async def rotate_webhook_token(
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    policy = await get_policy(db)
    new_token = secrets.token_urlsafe(24)
    policy["webhook_token"] = new_token
    updated = await save_policy(db, policy)
    await record_audit(
        db, admin.username, "Webhook令牌变更",
        detail="已生成新令牌" if new_token else "已清空令牌（开放接入）",
    )
    return {"token": updated.get("webhook_token", ""), "configured": bool(new_token)}


# ═══════════════════════════════════════════════════════════════════════════════
# Webhook token → team bindings (P2-13, system_config JSON, no schema change)
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/webhook-tokens")
async def list_webhook_tokens(
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """List token→team bindings (masked) plus the selectable team list.

    The full token is **never** returned here — only its first 6 characters.
    """
    tokens = await get_webhook_tokens(db)
    team_names = await _team_names(db)
    policy = await get_policy(db)
    return {
        "configured": bool(tokens),
        "mode": "multi" if tokens else "single",
        "items": [_token_out(entry, team_names) for entry in tokens],
        "teams": await _team_options(db),
        "legacy_token_configured": bool((policy.get("webhook_token") or "").strip()),
        "max_tokens": MAX_WEBHOOK_TOKENS,
    }


@router.post("/webhook-tokens", status_code=status.HTTP_201_CREATED)
async def create_webhook_token(
    payload: WebhookTokenCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Create one token→team binding and return the **full token once**."""
    tokens = await get_webhook_tokens(db)
    if len(tokens) >= MAX_WEBHOOK_TOKENS:
        raise HTTPException(
            status_code=400,
            detail=f"最多配置 {MAX_WEBHOOK_TOKENS} 个 webhook 令牌",
        )

    team = await db.get(Team, payload.team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="团队不存在")

    supplied = (payload.token or "").strip()
    token = supplied or secrets.token_urlsafe(24)
    if any(secrets.compare_digest(token, entry["token"]) for entry in tokens):
        raise HTTPException(status_code=409, detail="该令牌已存在")

    entry = {
        "id": secrets.token_hex(6),
        "token": token,
        "team_id": payload.team_id,
        "name": (payload.name or f"{team.name} 接入").strip()[:100],
        "enabled": bool(payload.enabled),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    updated = await save_webhook_tokens(db, [*tokens, entry])
    await record_audit(
        db, admin.username, "Webhook令牌创建",
        detail=f"name={entry['name']} team={payload.team_id} prefix={token[:6]}…",
        extra={
            "team_id": payload.team_id,
            "token_id": entry["id"],
            # 审计里只留前缀，绝不落明文令牌。
            "token_prefix": token[:6],
        },
    )
    saved = next((item for item in updated if item["id"] == entry["id"]), entry)
    return {
        "token": token,
        "item": _token_out(saved, {team.id: team.name}),
        "message": "令牌仅此一次完整展示，请立即复制保存",
    }


@router.delete("/webhook-tokens")
async def delete_webhook_token(
    token_id: str | None = Query(None, alias="id", description="条目 id 或数组索引"),
    prefix: str | None = Query(None, description="令牌前缀（前 N 位）"),
    token: str | None = Query(None, description="完整令牌或其前缀"),
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Delete a binding by entry ``id`` (or numeric index) or token prefix."""
    tokens = await get_webhook_tokens(db)
    if not tokens:
        raise HTTPException(status_code=404, detail="未配置任何 webhook 令牌")

    wanted_id = (token_id or "").strip()
    wanted_prefix = (prefix or token or "").strip()
    removed: dict[str, Any] | None = None

    if wanted_id:
        removed = next((e for e in tokens if str(e.get("id")) == wanted_id), None)
        if removed is None and wanted_id.isdigit():
            index = int(wanted_id)
            if 0 <= index < len(tokens):
                removed = tokens[index]
        if removed is None:
            raise HTTPException(status_code=404, detail="令牌条目不存在")
    elif wanted_prefix:
        matches = [
            entry for entry in tokens
            if entry["token"].startswith(wanted_prefix)
            or secrets.compare_digest(entry["token"], wanted_prefix)
        ]
        if not matches:
            raise HTTPException(status_code=404, detail="未找到匹配的令牌")
        if len(matches) > 1:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "前缀匹配到多个令牌，请改用条目 id 删除",
                    "candidates": [
                        {"id": e["id"], "name": e.get("name"), "team_id": e.get("team_id")}
                        for e in matches
                    ],
                },
            )
        removed = matches[0]
    else:
        raise HTTPException(
            status_code=400,
            detail="请提供 id、prefix 或 token 之一用于定位待删除令牌",
        )

    remaining = [entry for entry in tokens if entry is not removed]
    await save_webhook_tokens(db, remaining)
    await record_audit(
        db, admin.username, "Webhook令牌删除",
        detail=(
            f"name={removed.get('name')} team={removed.get('team_id')} "
            f"prefix={str(removed.get('token') or '')[:6]}…"
        ),
        extra={
            "team_id": removed.get("team_id"),
            "token_id": removed.get("id"),
            "token_prefix": str(removed.get("token") or "")[:6],
        },
    )
    return {
        "deleted": 1,
        "id": removed.get("id"),
        "name": removed.get("name"),
        "team_id": removed.get("team_id"),
        "remaining": len(remaining),
        "message": (
            "已删除最后一个令牌，webhook 回到单团队兼容模式"
            if not remaining else "令牌已删除"
        ),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Retention / manual purge (P2-8)
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/purge")
async def purge_alerts_now(
    all_teams: bool = Query(
        False,
        description="true = 清理所有团队（全局）；默认只清理当前管理员所属团队",
    ),
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Manually delete inbox/trash alerts beyond the configured retention."""
    policy = await get_policy(db)
    retention = policy.get("retention") or {}
    if not retention.get("inbox_days") and not retention.get("trash_days"):
        return {
            "team_id": None if all_teams else admin.team_id,
            "deleted_inbox": 0,
            "deleted_trash": 0,
            "deleted_total": 0,
            "inbox_days": retention.get("inbox_days", 0),
            "trash_days": retention.get("trash_days", 0),
            "message": "收件箱/垃圾箱保留期均为 0（不清理），未删除任何告警",
        }
    team_id = None if all_teams else admin.team_id
    result = await purge_expired_alerts(db, team_id=team_id, policy=policy)
    await record_audit(
        db, admin.username, "告警保留期手动清理",
        detail=(
            f"scope={'all_teams' if all_teams else f'team:{admin.team_id}'} "
            f"inbox={result['deleted_inbox']} trash={result['deleted_trash']} "
            f"({result['inbox_days']}d/{result['trash_days']}d)"
        )[:4000],
        extra={
            "team_id": team_id,
            "deleted_inbox": result["deleted_inbox"],
            "deleted_trash": result["deleted_trash"],
            "scope": "all_teams" if all_teams else "team",
        },
    )
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Inbox / trash
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/inbox", response_model=PaginatedAlerts)
async def list_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedAlerts:
    """List inbox alerts (pending / triggered / coalesced)."""
    await _maybe_auto_clear(db)
    query = select(Alert).where(Alert.team_id == user.team_id)
    if status_filter:
        wanted = [s.strip() for s in status_filter.split(",") if s.strip()]
        query = query.where(Alert.status.in_(wanted))
    else:
        query = query.where(Alert.status.in_(INBOX_STATUSES))
    if search:
        like = f"%{search.strip()}%"
        query = query.where(or_(
            Alert.alert_uid.ilike(like),
            Alert.ci_name.ilike(like),
            Alert.ci_application.ilike(like),
            Alert.content.ilike(like),
            Alert.source.ilike(like),
        ))
    query = query.order_by(Alert.created_at.desc())

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    offset = (page - 1) * page_size
    rows = await db.execute(query.offset(offset).limit(page_size))
    return PaginatedAlerts(
        items=[_alert_out(a) for a in rows.scalars()],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/trash", response_model=PaginatedAlerts)
async def list_trash(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    search: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> PaginatedAlerts:
    """List filtered / dismissed alerts (trash)."""
    await _maybe_auto_clear(db)
    query = select(Alert).where(
        Alert.team_id == user.team_id, Alert.status.in_(TRASH_STATUSES),
    )
    if search:
        like = f"%{search.strip()}%"
        query = query.where(or_(
            Alert.alert_uid.ilike(like),
            Alert.ci_name.ilike(like),
            Alert.ci_application.ilike(like),
            Alert.content.ilike(like),
        ))
    query = query.order_by(Alert.created_at.desc())
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    offset = (page - 1) * page_size
    rows = await db.execute(query.offset(offset).limit(page_size))
    return PaginatedAlerts(
        items=[_alert_out(a) for a in rows.scalars()],
        total=total, page=page, page_size=page_size,
    )


@router.post("/trash/clear")
async def clear_trash(
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Empty the current team's trash (filtered / dismissed alerts)."""
    result = await db.execute(
        delete(Alert).where(
            Alert.team_id == admin.team_id, Alert.status.in_(TRASH_STATUSES),
        )
    )
    await record_audit(
        db, admin.username, "清空垃圾箱",
        detail=f"删除 {result.rowcount} 条",
        extra={"team_id": admin.team_id},
    )
    return {"deleted": result.rowcount}


@router.get("/stats")
async def alert_stats(
    days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Dashboard counters for the 告警中心 page."""
    since = datetime.now(timezone.utc) - timedelta(days=days)

    status_rows = await db.execute(
        select(Alert.status, func.count())
        .where(Alert.team_id == user.team_id, Alert.created_at >= since)
        .group_by(Alert.status)
    )
    by_status = {row[0]: row[1] for row in status_rows}

    sev_rows = await db.execute(
        select(Alert.severity_level, func.count())
        .where(Alert.team_id == user.team_id, Alert.created_at >= since)
        .group_by(Alert.severity_level)
    )
    by_severity = {severity_label(row[0] or 4): row[1] for row in sev_rows}

    app_rows = await db.execute(
        select(Alert.ci_application, func.count())
        .where(Alert.team_id == user.team_id, Alert.created_at >= since,
               Alert.ci_application.is_not(None), Alert.ci_application != "")
        .group_by(Alert.ci_application)
        .order_by(func.count().desc())
        .limit(8)
    )
    top_services = [{"name": row[0], "count": row[1]} for row in app_rows]

    type_rows = await db.execute(
        select(Alert.alert_type, func.count())
        .where(Alert.team_id == user.team_id, Alert.created_at >= since)
        .group_by(Alert.alert_type)
        .order_by(func.count().desc())
        .limit(8)
    )
    by_type = [{"name": row[0] or "unknown", "count": row[1]} for row in type_rows]

    rca_rows = await db.execute(
        select(RcaSession.status, func.count(), func.avg(
            func.extract("epoch", RcaSession.completed_at - RcaSession.created_at)
        ))
        .where(RcaSession.team_id == user.team_id, RcaSession.created_at >= since)
        .group_by(RcaSession.status)
    )
    rca_by_status: dict[str, int] = {}
    avg_seconds: float | None = None
    durations: list[float] = []
    for st, count, avg in rca_rows:
        key = st.value if hasattr(st, "value") else str(st)
        rca_by_status[key] = count
        if avg:
            durations.append(float(avg))
    if durations:
        avg_seconds = sum(durations) / len(durations)

    return {
        "days": days,
        "total": sum(by_status.values()),
        "pending": by_status.get("pending", 0),
        "triggered": by_status.get("triggered", 0),
        "coalesced": by_status.get("coalesced", 0),
        "filtered": by_status.get("filtered", 0),
        "dismissed": by_status.get("dismissed", 0),
        "by_status": by_status,
        "by_severity": by_severity,
        "top_services": top_services,
        "by_type": by_type,
        "rca": {
            "by_status": rca_by_status,
            "completed": rca_by_status.get("COMPLETED", 0),
            "failed": rca_by_status.get("FAILED", 0),
            "running": rca_by_status.get("RUNNING", 0),
            "queued": rca_by_status.get("QUEUED", 0),
            "avg_seconds": round(avg_seconds, 1) if avg_seconds else None,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Trigger policy
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/policy")
async def read_policy(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    policy = await get_policy(db)
    if user.role.value != "ADMIN":
        policy["webhook_token"] = "***" if policy.get("webhook_token") else ""
    return policy


@router.put("/policy")
async def update_policy(
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db_session),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    updated = await save_policy(db, payload)
    await record_audit(
        db, admin.username, "触发策略变更",
        detail=f"mode={updated.get('mode')} "
               f"severity_max={updated['trigger'].get('severity_max')}",
        extra={"mode": updated.get("mode")},
    )
    return updated


# ═══════════════════════════════════════════════════════════════════════════════
# Manual trigger / dismiss
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/batch-trigger")
async def batch_trigger_alerts(
    payload: BatchTriggerRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """人工批量触发 RCA：1~50 条告警聚合为 **1 个** RcaSession（P1-4）。

    契约：
      * body ``{"ids": [1..50]}``（alerts.id；严格团队隔离，跨团队一律 404）；
      * ``service_name`` = 单应用用应用名；多应用用「众数、次多…等N系统」；
      * 时间窗 = 最早告警 − ``analysis_start_offset_minutes`` ~ 最晚告警；
      * 同一事务内建 1 个会话、回填全部告警的 ``rca_session_id`` /
        ``status=triggered``，写 1 条时间线 + 1 条审计，然后入队执行；
      * 所选告警全部已在同一活动会话中 → 幂等复用，返回 ``already_running``；
      * 单应用且同应用已有存活会话 → 直接并入该会话（``coalesced``），不新起；
      * 多应用批次 / 无存活会话 → 新建 1 个聚合会话（``accepted``）；
      * 部分告警已被活动会话占用 → 409（附 ``busy_ids`` / ``sessions``）。
    """
    ids = list(dict.fromkeys(payload.ids))
    if any(alert_id <= 0 for alert_id in ids):
        raise HTTPException(status_code=400, detail="ids 必须是正整数")
    if len(ids) > MAX_BATCH_TRIGGER_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"一次最多聚合 {MAX_BATCH_TRIGGER_IDS} 条告警",
        )

    rows = await db.execute(
        select(Alert).where(Alert.id.in_(ids), Alert.team_id == user.team_id)
    )
    found = {alert.id: alert for alert in rows.scalars()}
    missing = [alert_id for alert_id in ids if alert_id not in found]
    if missing:
        # 与单条触发一致：跨团队/不存在统一 404，避免 ID 探测。
        raise HTTPException(
            status_code=404,
            detail={"message": "部分告警不存在或无权访问", "missing_ids": missing},
        )
    ordered = [found[alert_id] for alert_id in ids]

    # ── 活动会话占用检查：全部指向同一活动会话时幂等复用 ─────────────
    referenced = {a.rca_session_id for a in ordered if a.rca_session_id}
    active_sessions: dict[int, RcaSession] = {}
    if referenced:
        session_rows = await db.execute(
            select(RcaSession).where(
                RcaSession.id.in_(referenced),
                RcaSession.team_id == user.team_id,
                RcaSession.status.in_([RcaStatus.QUEUED, RcaStatus.RUNNING]),
            )
        )
        active_sessions = {s.id: s for s in session_rows.scalars()}
    busy = {
        alert.id: alert.rca_session_id
        for alert in ordered
        if alert.rca_session_id in active_sessions
    }
    if busy:
        target_ids = set(busy.values())
        if len(busy) == len(ordered) and len(target_ids) == 1:
            target_id = next(iter(target_ids))
            return {
                "status": "already_running",
                "rca_session_id": target_id,
                "alerts": len(ordered),
                "service_name": active_sessions[target_id].service_name,
                "message": f"所选告警已在分析中，直接复用会话 #{target_id}",
            }
        raise HTTPException(
            status_code=409,
            detail={
                "message": "部分告警已在分析队列中，请取消勾选后重试",
                "busy_ids": sorted(busy.keys()),
                "sessions": {str(k): v for k, v in busy.items()},
            },
        )

    policy = await get_policy(db)
    offset = int(policy["trigger"]["analysis_start_offset_minutes"])
    times = [
        alert.alert_time or alert.created_at or datetime.now(timezone.utc)
        for alert in ordered
    ]
    earliest, latest = min(times), max(times)

    app_counts: dict[str, int] = {}
    for alert in ordered:
        name = _alert_service(alert)
        app_counts[name] = app_counts.get(name, 0) + 1
    ranked = [
        name for name, _ in sorted(
            app_counts.items(), key=lambda item: (-item[1], item[0]),
        )
    ]
    if len(ranked) == 1:
        service_name = ranked[0]
    else:
        service_name = "、".join(ranked[:3]) + (
            f"等{len(ranked)}系统" if len(ranked) > 3 else ""
        )
    service_name = service_name[:255]

    reason = f"manual_batch:{len(ordered)}:{user.username}"

    # P1-3：单应用且已有存活（RUNNING/QUEUED + 心跳新鲜）会话时直接并入，
    # 不再新起第二个会话；多应用批次仍按老平台语义新建聚合会话。
    if len(app_counts) == 1:
        target = await _find_reusable_session(
            db,
            team_id=user.team_id,
            service_name=service_name,
            exclude_id=0,
        )
        if target is not None:
            logger.info(
                "人工批量触发并入进行中会话: session_id={} alerts={} actor={}",
                target.id, len(ordered), user.username,
            )
            return await _merge_batch_into_session(
                db, target, ordered,
                actor=user.username, reason=reason,
                earliest=earliest, latest=latest,
            )

    session = RcaSession(
        team_id=user.team_id,
        trigger_type=RcaTriggerType.PASSIVE,
        status=RcaStatus.QUEUED,
        service_name=service_name,
        alert_count=len(ordered),
        trigger_reason=reason,
        time_window_start=earliest - timedelta(minutes=offset),
        time_window_end=latest,
        created_by=user.id,
    )
    db.add(session)
    await db.flush()

    for alert in ordered:
        alert.rca_session_id = session.id
        alert.status = "triggered"
        alert.trigger_reason = reason[:2000]

    uids = "、".join(str(alert.alert_uid) for alert in ordered[:6])
    if len(ordered) > 6:
        uids += f" 等{len(ordered)}条"
    db.add(CollaborationEvent(
        rca_session_id=session.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"人工批量触发 RCA（操作人 {user.username}，{len(ordered)} 条告警聚合）："
            f"{uids}；服务 {service_name}；窗口 "
            f"{_fmt_dt(session.time_window_start)} ~ {_fmt_dt(session.time_window_end)}"
        )[:1000],
        metadata_={
            "kind": "manual_batch",
            "alert_ids": ids,
            "alert_uids": [alert.alert_uid for alert in ordered],
            "actor": user.username,
            "service_name": service_name,
        },
    ))
    await record_audit(
        db, user.username, "人工批量触发RCA",
        detail=(
            f"session=#{session.id} alerts={len(ordered)} ids={ids[:50]} "
            f"service={service_name} window={_fmt_dt(session.time_window_start)}"
            f"~{_fmt_dt(session.time_window_end)}"
        )[:4000],
        extra={"session_id": session.id, "alert_ids": ids},
    )
    await db.commit()
    background.add_task(run_rca_session, session.id)

    logger.info(
        "人工批量触发 RCA: session_id={} alerts={} actor={} service={}",
        session.id, len(ordered), user.username, service_name,
    )
    return {
        "status": "accepted",
        "rca_session_id": session.id,
        "alerts": len(ordered),
        "service_name": service_name,
        "time_window_start": (
            session.time_window_start.isoformat() if session.time_window_start else None
        ),
        "time_window_end": (
            session.time_window_end.isoformat() if session.time_window_end else None
        ),
        "message": f"已聚合 {len(ordered)} 条告警触发 RCA #{session.id}",
    }


@router.post("/{alert_id}/trigger")
async def trigger_alert(
    alert_id: int,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Manually trigger RCA for one inbox/trash alert."""
    alert = await db.get(Alert, alert_id)
    if alert is None or alert.team_id != user.team_id:
        raise HTTPException(status_code=404, detail="告警不存在")
    if alert.status in ("triggered", "coalesced") and alert.rca_session_id:
        raise HTTPException(status_code=409, detail="该告警已触发 RCA")

    session = await create_manual_session(db, alert, actor=user.username)
    if session is None:
        raise HTTPException(status_code=409, detail="该告警已在分析队列中")
    session_id = session.id
    # 先落库，避免「合并失败回滚」把新建会话一起回滚掉。
    await db.commit()

    # P1-3：同应用仍有存活会话时直接复用，不为单条人工触发再起一个会话。
    merged = await _fold_into_active_session(db, session_id, actor=user.username)
    if merged is not None:
        return {
            "status": "coalesced",
            "alert_id": alert.alert_uid,
            "rca_session_id": merged["rca_session_id"],
            "message": merged["message"],
        }

    await record_audit(
        db, user.username, "人工触发RCA",
        detail=f"alert={alert.alert_uid} session=#{session_id}",
        extra={"alert_id": alert.id, "session_id": session_id},
    )
    await db.commit()
    background.add_task(run_rca_session, session_id)
    return {
        "status": "accepted",
        "alert_id": alert.alert_uid,
        "rca_session_id": session_id,
        "message": f"已触发 RCA #{session_id}",
    }


@router.post("/{alert_id}/dismiss")
async def dismiss_alert(
    alert_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    alert = await db.get(Alert, alert_id)
    if alert is None or alert.team_id != user.team_id:
        raise HTTPException(status_code=404, detail="告警不存在")
    alert.status = "dismissed"
    await record_audit(
        db, user.username, "忽略告警", detail=f"alert={alert.alert_uid}",
        extra={"alert_id": alert.id},
    )
    return {"status": "dismissed", "id": alert.id}


@router.post("/ingest")
async def ingest_legacy(
    background: BackgroundTasks,
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Deprecated: authenticated single-alert ingestion (kept for compatibility)."""
    result = await ingest_alert(db, payload, team_id=user.team_id, actor=user.username)
    result = await _schedule_ingest(
        db, background, result, actor=user.username,
    )
    await record_audit(db, user.username, "告警接入",
                       detail=f"{result.get('alert_id')} → {result.get('status')}")
    return result
