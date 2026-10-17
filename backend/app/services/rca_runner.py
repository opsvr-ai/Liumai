"""Background RCA runner.

Consumes an ``RcaSession`` (created by the webhook pipeline or by a manual
trigger), calls the Hermes agent, stores a structured :class:`RcaReport`, updates
the session timeline, and seeds the root-cause knowledge base.

Concurrency is bounded by ``settings.RCA_MAX_CONCURRENCY`` — excess sessions stay
``QUEUED`` until a slot is free.  The gate is **cross-worker**: it uses a Redis
counter (``REDIS_URL``, Redis is already part of compose) and only falls back to
the in-process semaphore when Redis is unavailable.  See :func:`_rca_slot`.

Execution prefers the Hermes **Runs API** (``POST /v1/runs`` +
``GET /v1/runs/{id}/events``): tool lifecycle events and periodic model-output
summaries are streamed into the session timeline, so operators can watch a
10–30 minute RCA progress instead of a single "analysis started" line.  When the
Runs API is unavailable (Hermes answers 404/405/501/503, returns no ``run_id``,
or the event endpoint is missing), the runner transparently falls back to the
historical synchronous ``POST /v1/chat/completions`` path — no behaviour is lost.
"""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

from loguru import logger
from sqlalchemy import delete, func, select

from app.config import settings
from app.models import (
    Alert,
    CollaborationEvent,
    CollaborationEventType,
    RcaReport,
    RcaSession,
    RcaStatus,
    RootCauseKnowledge,
    User,
)
from app.models.database import async_session_factory
from app.services.alert_pipeline import (
    DEFAULT_POLICY,
    _deep_merge,
    get_policy,
    severity_label,
)
from app.services.audit import record_audit
from app.services.hermes import (
    RCA_SYSTEM_PROMPT,
    HermesClient,
    HermesRunError,
)
from app.services.notify import send_notification

_CST = timezone(timedelta(hours=8))

# ── Hermes Runs API: capability fallback + progress timeline tuning ──────────
#
# ``create_run`` / ``stream_run_events`` live in the same optional Hermes surface
# as the chat endpoints; older builds simply 404 them.  A single failure
# disables the Runs path for a while so we don't pay an extra round-trip (and an
# extra warning log) on every RCA for a permanently unsupported build.
RUNS_FALLBACK_STATUS_CODES = frozenset({400, 404, 405, 410, 415, 422, 501, 503})
RUNS_DISABLE_SECONDS = 300
RUNS_SKILL_NAME = "rca-fault-delimitation"
# 时间线写入节流：工具事件按批/按时间合并；message.delta 只写摘要，不逐 token 落库。
PROGRESS_FLUSH_SECONDS = 2.0
PROGRESS_FLUSH_BATCH = 8
MESSAGE_SUMMARY_SECONDS = 5.0
MESSAGE_SUMMARY_KEEP_CHARS = 600
RUN_STOP_GRACE_SECONDS = 5.0

_RUNS_DISABLED_UNTIL = 0.0


# ═══════════════════════════════════════════════════════════════════════════════
# Concurrency gate (Redis counter first, in-process semaphore as fallback)
# ═══════════════════════════════════════════════════════════════════════════════
#
# 进程内 ``asyncio.Semaphore`` 只在单 worker 下有效：uvicorn/gunicorn 起多个
# worker 时每个进程各有一把锁，``RCA_MAX_CONCURRENCY`` 会被成倍放大，DB 里
# 同时 RUNNING 的会话数也会超出上限。
#
# 因此优先用 Redis 原子计数（``INCR`` + ``EXPIRE``）作为跨进程闸门；Redis 在
# compose 中已提供（``REDIS_URL``）。Redis 不可用（未安装 / 连不上 / 超时）
# 时记录警告并回退到进程内信号量 —— 单 worker 下语义等价，多 worker 下只能
# 尽力而为（限制会按 worker 数放大）。

_RCA_SEMAPHORE: asyncio.Semaphore | None = None

_RCA_REDIS_CLIENT: Any = None
_RCA_REDIS_DISABLED = False
_RCA_REDIS_KEY = "liumai:rca:running"
# 槽位租约：进程崩溃来不及 DECR 时，计数由 TTL 自动回收。单次 RCA 的运行
# 上限是 1800s（policy.run_timeout_seconds），4 小时足以覆盖。
_RCA_REDIS_SLOT_TTL = 4 * 3600
# 每个会话一张「槽位所有权」票据：只有删掉票据的进程才扣减计数，
# 使 runner 正常释放、巡检回收、进程崩溃三条路径互不重复扣减。
_SLOT_OWNER_KEY = "liumai:rca:slot_owner:{session_id}"
_REQUEUE_CLAIM_KEY = "liumai:rca:requeue:{session_id}"


# ═══════════════════════════════════════════════════════════════════════════════
# Lifecycle constants — heartbeat / zombie takeover (P0-2)
# ═══════════════════════════════════════════════════════════════════════════════
#
# rca_sessions 没有 updated_at / heartbeat_at 列（只有 created_at / completed_at），
# 为满足「不新增表结构」的要求，心跳以时间线事件（collaboration_events）承载：
# 每个会话最多保留 **一条** 心跳事件，每 30s 覆盖更新其 created_at，因此
# 「最后一次活动时间」= 最新心跳事件时间，巡检与启动接管都据此判断存活。

HEARTBEAT_INTERVAL_SECONDS = 30          # 运行/排队期间心跳间隔
HEARTBEAT_FRESH_SECONDS = 180            # 心跳/时间线新鲜度阈值（巡检判活）
COALESCE_WATCH_INTERVAL_SECONDS = 15     # 分析期间监听新并入告警的间隔
ZOMBIE_SWEEP_INTERVAL_SECONDS = 60       # 后台巡检周期
# 启动接管阈值：默认 4 小时；若 RCA 超时配置得足够长则按 2× 超时放宽。
DEFAULT_TAKEOVER_TIMEOUT_SECONDS = 4 * 3600
RUN_TIMEOUT_GRACE_SECONDS = 120          # 运行中心跳丢失的宽限期
# 重启恢复：一次最多重新投递多少条 QUEUED 会话
REQUEUE_BATCH_SIZE = 50
REQUEUE_CLAIM_TTL_SECONDS = 300
HEARTBEAT_EVENT_KIND = "rca_heartbeat"
START_EVENT_KIND = "rca_started"
TAKEOVER_EVENT_KIND = "rca_takeover"
REQUEUE_EVENT_KIND = "rca_requeued"

# 重启恢复投递的 asyncio 任务必须保留强引用，否则可能被 GC 回收。
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def _fmt_cst(value: datetime | None) -> str:
    """Format a DB timestamp in Beijing time for timeline messages."""
    if value is None:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(_CST).strftime("%Y-%m-%d %H:%M")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    """Normalise DB timestamps (asyncpg returns aware, sqlite/legacy may not)."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)



def _semaphore() -> asyncio.Semaphore:
    global _RCA_SEMAPHORE
    if _RCA_SEMAPHORE is None:
        _RCA_SEMAPHORE = asyncio.Semaphore(max(1, settings.RCA_MAX_CONCURRENCY))
    return _RCA_SEMAPHORE


def _mask_redis_url(url: str) -> str:
    """隐藏 Redis URL 里的口令，避免日志泄露凭据。"""
    return re.sub(r"//[^/@]*@", "//***@", url or "")


async def _redis_client() -> Any | None:
    """惰性建立 Redis 连接并 ping；失败一次后本进程内不再重试。"""
    global _RCA_REDIS_CLIENT, _RCA_REDIS_DISABLED
    if _RCA_REDIS_DISABLED:
        return None
    if _RCA_REDIS_CLIENT is not None:
        return _RCA_REDIS_CLIENT
    try:
        from redis.asyncio import Redis

        client = Redis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
        )
        await client.ping()
        _RCA_REDIS_CLIENT = client
        logger.info(
            "RCA 并发闸门使用 Redis 计数（跨 worker）: url={}",
            _mask_redis_url(settings.REDIS_URL),
        )
        return client
    except Exception as exc:  # noqa: BLE001 — 任何失败都必须能回退
        _RCA_REDIS_DISABLED = True
        logger.warning(
            "Redis 不可用（{}），RCA 并发闸门回退到进程内信号量；"
            "多 worker 部署时 RCA_MAX_CONCURRENCY 会按 worker 数放大",
            exc,
        )
        return None


async def _redis_try_acquire(client: Any, session_id: int) -> bool:
    """尝试占用一个 Redis 槽位；超限立即归还并返回 False。

    占用成功时额外写入 ``slot_owner:<session_id>`` 票据（TTL 与计数一致），
    释放槽位时必须先删除票据；这样「runner 正常结束」「巡检回收僵尸」
    「进程崩溃后 TTL 回收」三条路径不会对同一个槽位重复 DECR。
    """
    current = int(await client.incr(_RCA_REDIS_KEY))
    if current > max(1, settings.RCA_MAX_CONCURRENCY):
        await client.decr(_RCA_REDIS_KEY)
        return False
    try:
        # 每次成功占用都续租整个计数键，崩溃进程留下的僵尸计数 TTL 后清零。
        await client.expire(_RCA_REDIS_KEY, _RCA_REDIS_SLOT_TTL)
        await client.set(
            _SLOT_OWNER_KEY.format(session_id=session_id),
            "1",
            ex=_RCA_REDIS_SLOT_TTL,
        )
    except Exception as exc:  # noqa: BLE001 — 续租失败不阻塞本次运行
        logger.warning("Redis RCA 槽位续租/票据写入失败: {}", exc)
    return True


async def _redis_release(client: Any) -> None:
    """归还 Redis 槽位；计数不会被扣成负数。"""
    try:
        remaining = int(await client.decr(_RCA_REDIS_KEY))
        if remaining < 0:
            await client.set(_RCA_REDIS_KEY, 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Redis 释放 RCA 并发槽位失败（{}），计数将由 TTL {}s 自动回收",
            exc,
            _RCA_REDIS_SLOT_TTL,
        )


async def _release_slot(session_id: int, *, reason: str = "runner") -> bool:
    """幂等归还某会话占用的 Redis 槽位（票据不存在时不 DECR）。

    供三处调用：runner 正常结束、僵尸巡检回收、启动接管。
    """
    client = await _redis_client()
    if client is None:
        return False
    try:
        deleted = int(await client.delete(_SLOT_OWNER_KEY.format(session_id=session_id)))
        if not deleted:
            return False
        await _redis_release(client)
        logger.info("RCA 槽位已释放: session_id={} reason={}", session_id, reason)
        return True
    except Exception as exc:  # noqa: BLE001 — 释放失败交给 TTL 兜底
        logger.warning("Redis 释放 RCA 槽位票据失败: session_id={} err={}", session_id, exc)
        return False


async def _log_queued(session_id: int) -> None:
    """排队期间在会话时间线里留一条可见记录（失败不影响主流程）。"""
    try:
        async with async_session_factory() as db:
            session = await db.get(RcaSession, session_id)
            if session and session.status == RcaStatus.QUEUED:
                db.add(CollaborationEvent(
                    rca_session_id=session_id,
                    event_type=CollaborationEventType.AGENT_PROGRESS,
                    content=(
                        f"排队中：已有 {settings.RCA_MAX_CONCURRENCY} 个分析会话在运行，"
                        "等待空槽…"
                    ),
                ))
                await db.commit()
    except Exception:  # noqa: BLE001 — 时间线写失败不能拖垮分析
        logger.exception("RCA 排队事件写入失败: session_id={}", session_id)


@asynccontextmanager
async def _rca_slot(session_id: int) -> AsyncIterator[None]:
    """获取/释放一个 RCA 并发槽位：Redis 计数优先，进程内信号量兜底。

    排队期间每 30s 写一次心跳：巡检/重启恢复据此区分「真有任务在等槽」
    与「调度丢失的孤儿 QUEUED」，避免误回收或重复投递。
    """
    global _RCA_REDIS_DISABLED

    client = await _redis_client()
    backend = "semaphore"

    if client is not None:
        try:
            if await _redis_try_acquire(client, session_id):
                backend = "redis"
            else:
                await _log_queued(session_id)
                await _heartbeat_tick(session_id)
                last_beat = time.monotonic()
                # 简单轮询等待空槽：释放后最多 1s 内可见。
                while True:
                    await asyncio.sleep(1.0)
                    if time.monotonic() - last_beat >= HEARTBEAT_INTERVAL_SECONDS:
                        last_beat = time.monotonic()
                        await _heartbeat_tick(session_id)
                    if await _redis_try_acquire(client, session_id):
                        backend = "redis"
                        break
        except Exception as exc:  # noqa: BLE001 — Redis 中途故障回退信号量
            _RCA_REDIS_DISABLED = True
            logger.warning(
                "Redis RCA 并发计数异常（{}），回退进程内信号量", exc
            )
            client = None
            backend = "semaphore"

    if backend == "redis":
        try:
            yield
        finally:
            # 幂等释放：巡检回收过的僵尸不会在这里被二次 DECR。
            await _release_slot(session_id, reason="runner")
        return

    # ── 回退：进程内信号量（单 worker 等价；多 worker 会按进程数放大）──
    sem = _semaphore()
    if sem.locked():
        await _log_queued(session_id)
        await _heartbeat_tick(session_id)
        last_beat = time.monotonic()
        while sem.locked():
            await asyncio.sleep(1.0)
            if time.monotonic() - last_beat >= HEARTBEAT_INTERVAL_SECONDS:
                last_beat = time.monotonic()
                await _heartbeat_tick(session_id)
    await sem.acquire()
    try:
        yield
    finally:
        sem.release()



# ═══════════════════════════════════════════════════════════════════════════════
# Lifecycle: heartbeat / zombie takeover / restart recovery (P0-2)
# ═══════════════════════════════════════════════════════════════════════════════
#
# 设计要点（无 schema 变更）：
#   * ``rca_sessions`` 只有 ``created_at`` / ``completed_at``，没有心跳列；
#     因此心跳写在 ``collaboration_events``，每个会话最多一条
#     ``metadata.kind = "rca_heartbeat"`` 的事件，每 30s 覆盖其 ``created_at``。
#   * 巡检「最后活动时间」= 最新心跳事件时间，退化时用 ``created_at``。
#   * 启动接管阈值 = max(4h, 2×RCA 超时)（RCA 超时上限 30min，因此默认 4h）；
#     运行中巡检阈值 = RCA 超时 + 120s（有 30s 心跳，该阈值足以区分活/死）；
#     没有「新版本开始事件」的旧 RUNNING 会话退回 4h 阈值（避免滚动升级误杀）。
#   * 巡检/接管置 FAILED 时写时间线 + 审计 + ``root_cause_summary`` 前缀
#     ``【系统接管】``（等价于 error_message），并幂等归还 Redis 并发槽位。


def _heartbeat_kind():
    """JSONB ``metadata.kind`` 表达式（PostgreSQL ``->>``）。"""
    return CollaborationEvent.metadata_["kind"].astext


async def _upsert_heartbeat(
    db, session_id: int, *, status: RcaStatus,
) -> None:
    """写入/刷新会话心跳（每个会话最多一条，按最新 id 覆盖）。"""
    row = await db.execute(
        select(CollaborationEvent)
        .where(
            CollaborationEvent.rca_session_id == session_id,
            CollaborationEvent.event_type == CollaborationEventType.AGENT_PROGRESS,
            _heartbeat_kind() == HEARTBEAT_EVENT_KIND,
        )
        .order_by(CollaborationEvent.id.desc())
        .limit(1)
    )
    event = row.scalar_one_or_none()
    now = _now()
    label = "排队中" if status == RcaStatus.QUEUED else "分析进行中"
    content = (
        f"【心跳】RCA {label}"
        f"（{now.astimezone(_CST).strftime('%H:%M:%S')} 自动刷新，用于存活检测）"
    )
    if event is None:
        db.add(CollaborationEvent(
            rca_session_id=session_id,
            event_type=CollaborationEventType.AGENT_PROGRESS,
            content=content,
            metadata_={"kind": HEARTBEAT_EVENT_KIND, "status": status.value},
        ))
    else:
        event.content = content
        event.created_at = now
        event.metadata_ = {
            **(event.metadata_ or {}),
            "kind": HEARTBEAT_EVENT_KIND,
            "status": status.value,
        }


async def _heartbeat_tick(session_id: int) -> bool:
    """写一次心跳；返回 False 表示会话已不在 QUEUED/RUNNING，可以停止心跳。"""
    try:
        async with async_session_factory() as db:
            session = await db.get(RcaSession, session_id)
            if session is None or session.status not in (
                RcaStatus.QUEUED, RcaStatus.RUNNING,
            ):
                return False
            await _upsert_heartbeat(db, session_id, status=session.status)
            await db.commit()
        return True
    except Exception:  # noqa: BLE001 — 心跳写失败不能拖垮分析
        logger.exception("RCA 心跳写入失败 session_id={}", session_id)
        return True


async def _heartbeat_loop(session_id: int, stop_event: asyncio.Event) -> None:
    """30s 心跳循环：runner 存活期间持续刷新最后活动时间。"""
    while True:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=HEARTBEAT_INTERVAL_SECONDS)
            return
        except asyncio.TimeoutError:
            pass
        if not await _heartbeat_tick(session_id):
            return


async def _clear_heartbeat(db, session_id: int) -> None:
    """会话收尾时删除心跳行，避免时间线在结束后仍显示「分析进行中」。"""
    try:
        await db.execute(
            delete(CollaborationEvent).where(
                CollaborationEvent.rca_session_id == session_id,
                _heartbeat_kind() == HEARTBEAT_EVENT_KIND,
            )
        )
    except Exception:  # noqa: BLE001
        logger.exception("RCA 心跳清理失败 session_id={}", session_id)


async def _stop_background(tasks: list[asyncio.Task], stop_event: asyncio.Event) -> None:
    """停止心跳/监听协程（幂等，可重复调用）。"""
    stop_event.set()
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _last_activity_map(db, session_ids: list[int]) -> dict[int, datetime]:
    """批量取每个会话的最后活动时间（心跳优先，其次是开始事件）。"""
    if not session_ids:
        return {}
    rows = await db.execute(
        select(
            CollaborationEvent.rca_session_id,
            func.max(CollaborationEvent.created_at),
        )
        .where(
            CollaborationEvent.rca_session_id.in_(session_ids),
            CollaborationEvent.event_type == CollaborationEventType.AGENT_PROGRESS,
            _heartbeat_kind().in_((HEARTBEAT_EVENT_KIND, START_EVENT_KIND)),
        )
        .group_by(CollaborationEvent.rca_session_id)
    )
    activity: dict[int, datetime] = {}
    for session_id, last_seen in rows:
        if last_seen is not None:
            activity[int(session_id)] = _aware(last_seen)
    return activity


async def _sessions_with_start_event(db, session_ids: list[int]) -> set[int]:
    """返回带「新版本开始事件」的会话 id。

    升级前旧进程启动的 RUNNING 会话没有心跳/开始事件元数据，不能用
    20 分钟级的运行阈值去杀（可能还在正常跑），应退回 4h 接管阈值。
    """
    if not session_ids:
        return set()
    rows = await db.execute(
        select(CollaborationEvent.rca_session_id)
        .where(
            CollaborationEvent.rca_session_id.in_(session_ids),
            CollaborationEvent.event_type == CollaborationEventType.AGENT_PROGRESS,
            _heartbeat_kind() == START_EVENT_KIND,
        )
        .distinct()
    )
    return {int(session_id) for session_id in rows.scalars()}


async def _mark_session_failed(
    db,
    session: RcaSession,
    *,
    reason: str,
    last_activity: datetime | None,
    now: datetime,
) -> None:
    """把僵尸会话置为 FAILED：写时间线 + 审计 + 摘要（等价 error_message）。"""
    previous = session.status
    session.status = RcaStatus.FAILED
    session.completed_at = now
    session.root_cause_summary = f"【系统接管】{reason}"[:500]
    # 僵尸会话不会再有 runner 收尾：由巡检删除心跳行，避免时间线停在「进行中」。
    await _clear_heartbeat(db, session.id)
    db.add(CollaborationEvent(
        rca_session_id=session.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"【系统接管】{reason}；会话已置为 FAILED（原状态 {previous.value}）。"
            f"最后活动：{_fmt_cst(last_activity)}。如仍需分析，请重跑该会话。"
        )[:1000],
        metadata_={
            "kind": TAKEOVER_EVENT_KIND,
            "reason": reason,
            "previous_status": previous.value,
            "last_activity": last_activity.isoformat() if last_activity else None,
        },
    ))
    await record_audit(
        db, "system", "RCA僵尸会话回收",
        detail=(
            f"session=#{session.id} {previous.value}→FAILED；{reason}；"
            f"last_activity={_fmt_cst(last_activity)}"
        )[:4000],
        extra={"session_id": session.id, "previous_status": previous.value},
    )


async def _expire_stale_sessions(
    statuses: tuple[RcaStatus, ...],
    *,
    running_threshold: str = "runtime",
    limit: int = 500,
) -> dict[str, Any]:
    """扫描并回收超时会话。

    ``running_threshold``:
      * ``"startup"`` — 启动接管，RUNNING 用 max(4h, 2×超时)；
      * ``"runtime"`` — 60s 巡检，RUNNING 用「RCA 超时 + 120s」。
    QUEUED 一律用启动接管阈值（排队 4h 还没被调度即为僵尸）。
    """
    expired: list[int] = []
    scanned = 0
    try:
        async with async_session_factory() as db:
            policy = await get_policy(db)
            effective_timeout = min(int(policy["rca"]["run_timeout_seconds"]), 1800)
            takeover_threshold = max(
                DEFAULT_TAKEOVER_TIMEOUT_SECONDS, 2 * effective_timeout,
            )
            running_limit = (
                takeover_threshold
                if running_threshold == "startup"
                else effective_timeout + RUN_TIMEOUT_GRACE_SECONDS
            )
            now = _now()
            rows = await db.execute(
                select(RcaSession)
                .where(
                    RcaSession.status.in_(statuses),
                    RcaSession.completed_at.is_(None),
                )
                .order_by(RcaSession.created_at.asc())
                .limit(limit)
            )
            candidates = list(rows.scalars())
            scanned = len(candidates)
            session_ids = [s.id for s in candidates]
            activity = await _last_activity_map(db, session_ids)
            started = await _sessions_with_start_event(db, session_ids)
            for session in candidates:
                last = activity.get(session.id) or _aware(session.created_at)
                if last is None:
                    continue
                if session.status == RcaStatus.RUNNING:
                    # 升级前的旧会话没有心跳/开始事件元数据 → 退回 4h 接管阈值，
                    # 避免滚动升级时误杀旧进程里仍在跑的分析。
                    threshold = (
                        running_limit if session.id in started else takeover_threshold
                    )
                    reason = (
                        f"运行中会话 {threshold} 秒内没有心跳/时间线活动"
                        "（进程可能已崩溃或任务已丢失）"
                    )
                else:
                    threshold = takeover_threshold
                    reason = (
                        f"会话排队超过 {threshold // 3600} 小时仍未被调度"
                    )
                if (now - last).total_seconds() <= threshold:
                    continue
                previous = session.status.value
                await _mark_session_failed(
                    db, session, reason=reason, last_activity=last, now=now,
                )
                expired.append(session.id)
                logger.warning(
                    "RCA 僵尸会话回收: session_id={} {}→FAILED reason={}",
                    session.id, previous, reason,
                )
            if expired:
                await db.commit()
    except Exception:  # noqa: BLE001 — 巡检失败不能影响主服务
        logger.exception("RCA 僵尸会话巡检失败")
        return {"scanned": scanned, "expired": 0, "session_ids": [], "error": True}

    for session_id in expired:
        # 僵尸 RUNNING 可能还占着 Redis 计数；幂等归还（票据机制防重复 DECR）。
        await _release_slot(session_id, reason="zombie")
    return {"scanned": scanned, "expired": len(expired), "session_ids": expired}


async def _claim_requeue(session_id: int) -> bool:
    """跨 worker 抢占「重新入队」资格（防多 worker 同时启动重复投递）。"""
    client = await _redis_client()
    if client is None:
        return True  # Redis 不可用时退化为单 worker 假设
    try:
        return bool(await client.set(
            _REQUEUE_CLAIM_KEY.format(session_id=session_id),
            "1", nx=True, ex=REQUEUE_CLAIM_TTL_SECONDS,
        ))
    except Exception as exc:  # noqa: BLE001
        logger.warning("RCA 重新入队票据写入失败: session_id={} err={}", session_id, exc)
        return True


async def requeue_orphan_sessions() -> dict[str, Any]:
    """重启/调度丢失恢复：把「没有存活任务」的 QUEUED 会话重新投递。

    判活依据是心跳：排队中的 runner 每 30s 写心跳，因此只有
    ``created_at > 180s`` 且 180s 内无心跳的 QUEUED 会话才会被接管。
    多 worker 场景用 Redis NX 票据互斥，避免同一会话被重复投递。
    """
    requeued: list[int] = []
    scanned = 0
    try:
        async with async_session_factory() as db:
            policy = await get_policy(db)
            effective_timeout = min(int(policy["rca"]["run_timeout_seconds"]), 1800)
            takeover_threshold = max(
                DEFAULT_TAKEOVER_TIMEOUT_SECONDS, 2 * effective_timeout,
            )
            now = _now()
            rows = await db.execute(
                select(RcaSession)
                .where(
                    RcaSession.status == RcaStatus.QUEUED,
                    RcaSession.completed_at.is_(None),
                    RcaSession.created_at >= now - timedelta(seconds=takeover_threshold),
                    RcaSession.created_at <= now - timedelta(seconds=HEARTBEAT_FRESH_SECONDS),
                )
                .order_by(RcaSession.created_at.asc())
                .limit(REQUEUE_BATCH_SIZE)
            )
            candidates = list(rows.scalars())
            scanned = len(candidates)
            activity = await _last_activity_map(db, [s.id for s in candidates])
            for session in candidates:
                last = activity.get(session.id)
                if last is not None and (now - last).total_seconds() <= HEARTBEAT_FRESH_SECONDS:
                    continue  # 仍有存活任务在排队，别抢
                if not await _claim_requeue(session.id):
                    continue
                db.add(CollaborationEvent(
                    rca_session_id=session.id,
                    event_type=CollaborationEventType.AGENT_PROGRESS,
                    content=(
                        "服务重启/调度丢失，已自动重新入队"
                        f"（最后活动：{_fmt_cst(last)}）"
                    ),
                    metadata_={"kind": REQUEUE_EVENT_KIND, "previous_status": "QUEUED"},
                ))
                requeued.append(session.id)
            if requeued:
                await record_audit(
                    db, "system", "RCA重启恢复",
                    detail=f"重新入队 {len(requeued)} 个 QUEUED 会话: "
                           f"{', '.join(f'#{sid}' for sid in requeued[:50])}",
                    extra={"session_ids": requeued},
                )
                await db.commit()
    except Exception:  # noqa: BLE001 — 恢复失败不能阻塞启动
        logger.exception("RCA 重启恢复扫描失败")
        return {"scanned": scanned, "requeued": 0, "session_ids": [], "error": True}

    for session_id in requeued:
        task = asyncio.create_task(run_rca_session(session_id))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)
        logger.info("RCA 会话重新入队: session_id={}", session_id)
    return {"scanned": scanned, "requeued": len(requeued), "session_ids": requeued}


async def takeover_stale_sessions() -> dict[str, Any]:
    """启动接管（main.py lifespan 调用）：超时 RUNNING/QUEUED 置 FAILED。"""
    return await _expire_stale_sessions(
        (RcaStatus.RUNNING, RcaStatus.QUEUED), running_threshold="startup",
    )


async def sweep_stale_sessions() -> dict[str, Any]:
    """60s 后台巡检：回收超时会话 + 重新投递丢失调度的 QUEUED 会话。"""
    expired = await _expire_stale_sessions(
        (RcaStatus.RUNNING, RcaStatus.QUEUED), running_threshold="runtime",
    )
    requeued = await requeue_orphan_sessions()
    return {"expired": expired, "requeued": requeued}


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort extraction of the JSON object returned by Hermes."""
    if not text:
        return None
    cleaned = text.strip()
    # Strip ```json fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", cleaned):
        try:
            obj, _ = decoder.raw_decode(cleaned[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [value]
    return [value]


def _top3_entry_text(item: Any) -> str:
    """Normalise one Top3 entry into a display line.

    Hermes (new skill format) returns dicts like
    ``{rank, summary, confidence, score, conclusion}``; the old platform also
    accepted ``hypothesis_analysis`` entries ``{id, title, score}``.  Plain
    strings are passed through unchanged.
    """
    if isinstance(item, dict):
        text = str(
            item.get("summary")
            or item.get("title")
            or item.get("root_cause")
            or item.get("conclusion")
            or ""
        ).strip()
        if not text:
            return ""
        rank = item.get("rank")
        if rank not in (None, ""):
            text = f"[{rank}] {text}"
        score = item.get("score", item.get("confidence"))
        if score not in (None, ""):
            text += f"（评分 {score}）"
        return text[:500]
    if item is None:
        return ""
    text = str(item).strip()
    return text[:500]


def _normalise_top3(
    payload: dict[str, Any], evidence: list[Any], actions: list[Any],
) -> list[str]:
    """Keep the model's Top3 (or derive one) instead of silently dropping it.

    Order of preference:
      1. ``top3_root_causes`` / ``top3`` (top level or under ``root_cause``);
      2. derive from ``evidence`` (first two candidates) and
         ``recommended_actions`` (first candidate) so the field is never empty
         when the analysis produced material.
    """
    raw: Any = payload.get("top3_root_causes")
    if raw is None:
        raw = payload.get("top3")
    if raw is None and isinstance(payload.get("root_cause"), dict):
        raw = payload["root_cause"].get("top3")
    if isinstance(raw, dict):
        raw = [raw]
    entries = [
        line
        for line in (_top3_entry_text(item) for item in _as_list(raw))
        if line
    ]
    if entries:
        return entries[:3]

    derived: list[str] = []
    for value in [*evidence[:2], *actions[:1]]:
        if value is None:
            continue
        line = (
            value.strip()
            if isinstance(value, str)
            else json.dumps(value, ensure_ascii=False)
        )
        if line:
            derived.append(f"（派生）{line}"[:500])
    return derived[:3]


def _normalise_report(payload: dict[str, Any], raw_output: str) -> dict[str, Any]:
    root = payload.get("root_cause")
    if isinstance(root, dict):
        root_cause = str(root.get("summary") or root.get("root_cause") or "")
    else:
        root_cause = str(root or payload.get("summary") or "")
    confidence: float | None = None
    raw_conf = payload.get("confidence")
    if raw_conf is None and isinstance(payload.get("root_cause"), dict):
        raw_conf = payload["root_cause"].get("confidence")
    try:
        confidence = float(str(raw_conf).rstrip("%"))
        if confidence > 1:
            confidence /= 100.0
        confidence = max(0.0, min(1.0, confidence))
    except (TypeError, ValueError):
        confidence = None
    evidence = _as_list(payload.get("evidence"))
    actions = _as_list(payload.get("recommended_actions"))
    return {
        "root_cause": root_cause or raw_output[:1000],
        "confidence": confidence,
        "evidence": evidence,
        "impacted_services": _as_list(payload.get("impacted_services")),
        "recommended_actions": actions,
        "category": payload.get("category"),
        "top3": _normalise_top3(payload, evidence, actions),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Hermes Runs API: live progress → timeline (P1-5)
# ═══════════════════════════════════════════════════════════════════════════════
#
# The Runs API decouples submit from watch: ``POST /v1/runs`` returns a run id
# immediately, and ``GET /v1/runs/{id}/events`` streams ``tool.started`` /
# ``tool.completed`` / ``message.delta`` / ``run.completed`` … as SSE.  A single
# RCA can run for 10–30 minutes, so the runner translates those events into
# ``CollaborationEvent`` rows for the session detail drawer.
#
# 写入必须节流：``message.delta`` 是逐 token 的，绝不能一个 token 一行。这里
# 把工具事件攒成批（最多 8 条 / 2s），模型输出每 5s 只写一条「累计 N 字」摘要。


class _RunsUnavailable(RuntimeError):
    """The Hermes build does not support the Runs API (fall back to chat)."""


def _runs_available() -> bool:
    return time.monotonic() >= _RUNS_DISABLED_UNTIL


def _mark_runs_unavailable(reason: str) -> None:
    global _RUNS_DISABLED_UNTIL
    _RUNS_DISABLED_UNTIL = time.monotonic() + RUNS_DISABLE_SECONDS
    logger.warning(
        "Hermes Runs API 不可用（{}），{}s 内 RCA 直接使用非流式回退",
        reason,
        RUNS_DISABLE_SECONDS,
    )


def _mark_runs_available() -> None:
    global _RUNS_DISABLED_UNTIL
    _RUNS_DISABLED_UNTIL = 0.0


def _rca_user_message(params: dict[str, Any]) -> str:
    """Build the same user message ``run_rca`` sends (prompt parity on fallback)."""
    lines = [f"技能名称: {RUNS_SKILL_NAME}"]
    for key, value in params.items():
        lines.append(f"{key}: {value}")
    return "\n".join(lines)


def _sse_payload(frame: str) -> str | None:
    """Join all ``data:`` lines of one SSE frame (comments keepalives → None)."""
    data_lines: list[str] = []
    for line in frame.split("\n"):
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    return "\n".join(data_lines) if data_lines else None


class _ProgressTimeline:
    """Throttled timeline writer for Runs API progress events."""

    def __init__(self, session_id: int, run_id: str | None = None) -> None:
        self.session_id = session_id
        self.run_id = run_id
        self._pending: list[tuple[str, dict[str, Any]]] = []
        self._last_flush = 0.0

    async def add(
        self,
        content: str,
        metadata: dict[str, Any] | None = None,
        *,
        force: bool = False,
    ) -> None:
        text = re.sub(r"\s+", " ", str(content or "")).strip()
        if not text:
            return
        meta: dict[str, Any] = {
            "kind": "rca_progress",
            "source": "runs",
            **(metadata or {}),
        }
        if self.run_id:
            meta.setdefault("run_id", self.run_id)
        self._pending.append((text[:1000], meta))
        now = time.monotonic()
        if (
            force
            or len(self._pending) >= PROGRESS_FLUSH_BATCH
            or (now - self._last_flush) >= PROGRESS_FLUSH_SECONDS
        ):
            await self.flush()

    async def flush(self) -> None:
        if not self._pending:
            return
        batch, self._pending = self._pending, []
        self._last_flush = time.monotonic()
        try:
            async with async_session_factory() as db:
                for content, meta in batch:
                    db.add(CollaborationEvent(
                        rca_session_id=self.session_id,
                        event_type=CollaborationEventType.AGENT_PROGRESS,
                        content=content,
                        metadata_=meta,
                    ))
                await db.commit()
        except Exception:  # noqa: BLE001 — 进度写失败不能拖垮分析
            logger.warning(
                "RCA 进度时间线写入失败 session_id={} events={}",
                self.session_id,
                len(batch),
            )


async def _append_progress(
    session_id: int,
    content: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write a single progress event (fallback paths / one-off notices)."""
    try:
        async with async_session_factory() as db:
            db.add(CollaborationEvent(
                rca_session_id=session_id,
                event_type=CollaborationEventType.AGENT_PROGRESS,
                content=str(content)[:1000],
                metadata_=metadata or {"kind": "rca_progress"},
            ))
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("RCA 进度事件写入失败 session_id={}", session_id)


async def _stop_run_quietly(client: HermesClient, run_id: str) -> None:
    """Best-effort ``stop_run`` so a timed-out run does not linger upstream."""
    try:
        await asyncio.wait_for(
            client.stop_run(run_id), timeout=RUN_STOP_GRACE_SECONDS,
        )
        logger.info("Hermes Runs 已请求停止: run_id={}", run_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 停止失败只告警
        logger.warning("Hermes Runs 停止请求失败: run_id={} err={}", run_id, exc)


async def _run_rca_via_runs(
    client: HermesClient,
    params: dict[str, Any],
    *,
    session_id: int,
    timeout: float,
    watch_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Submit an RCA through the Runs API and watch it to completion.

    Returns the same envelope as :meth:`HermesClient.run_rca` so the caller's
    report-parsing path is shared.  Raises :class:`_RunsUnavailable` when the
    capability is missing **before any model output is produced**, which is the
    signal for the caller to fall back to the synchronous chat endpoint.
    """
    if not _runs_available():
        raise _RunsUnavailable("Runs API 近期不可用（冷却中）")

    try:
        created = await client.create_run(
            input=_rca_user_message(params),
            instructions=RCA_SYSTEM_PROMPT,
        )
    except HermesRunError as exc:
        if exc.status_code in RUNS_FALLBACK_STATUS_CODES:
            raise _RunsUnavailable(
                f"create_run HTTP {exc.status_code}: {exc.detail}"
            ) from exc
        raise

    run_id = str(created.get("run_id") or "").strip()
    if not run_id:
        raise _RunsUnavailable("create_run 未返回 run_id")
    hermes_session_id = str(created.get("session_id") or "").strip()
    logger.info(
        "RCA Runs created: session_id={} run_id={} hermes_session={}",
        session_id,
        run_id,
        hermes_session_id or "-",
    )

    timeline = _ProgressTimeline(session_id, run_id)
    await timeline.add(
        f"已提交 Hermes Runs 任务（run_id={run_id}），开始接收执行事件…",
        {"kind": "rca_run_submitted"},
        force=True,
    )

    if watch_state is not None:
        async def _steer(text: str) -> Any:
            return await client.steer_run(run_id, text)

        # P1-3 的迟到告警监听在拿到 run_id 后即可真正 steer，而不是只写备注。
        watch_state["steer"] = _steer

    output_parts: list[str] = []
    state: dict[str, Any] = {
        "output": "",
        "usage": None,
        "finish_reason": "stop",
    }

    async def _consume() -> None:
        buffer = ""
        message_chars = 0
        message_tail = ""
        last_summary = time.monotonic()
        # SSE chunks can split a multi-byte UTF-8 character; decode incrementally
        # so Chinese progress summaries never contain replacement characters.
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        stream = client.stream_run_events(run_id)
        try:
            async for chunk in stream:
                if isinstance(chunk, (bytes, bytearray)):
                    text = decoder.decode(bytes(chunk))
                else:
                    text = str(chunk)
                buffer = (buffer + text).replace("\r\n", "\n")
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    raw = _sse_payload(frame)
                    if not raw:
                        continue  # `: keepalive` / `: open` comments
                    if raw.strip() == "[DONE]":
                        return
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        logger.debug("Hermes Runs 无法解析的 SSE: {!r}", raw[:200])
                        continue
                    if not isinstance(event, dict):
                        continue
                    name = str(event.get("event") or event.get("type") or "")

                    if name == "message.delta":
                        delta = event.get("delta")
                        if isinstance(delta, str) and delta:
                            output_parts.append(delta)
                            message_chars += len(delta)
                            message_tail = (
                                message_tail + delta
                            )[-MESSAGE_SUMMARY_KEEP_CHARS:]
                            now = time.monotonic()
                            if now - last_summary >= MESSAGE_SUMMARY_SECONDS:
                                last_summary = now
                                snippet = re.sub(
                                    r"\s+", " ", message_tail
                                )[-200:]
                                await timeline.add(
                                    f"模型输出进展（累计 {message_chars} 字）：{snippet}",
                                    {
                                        "kind": "rca_model_progress",
                                        "chars": message_chars,
                                    },
                                )

                    elif name == "tool.started":
                        tool = str(event.get("tool") or "tool")
                        preview = str(event.get("preview") or "").strip()
                        line = f"🔧 调用工具 {tool}"
                        if preview:
                            line += f"：{preview[:160]}"
                        await timeline.add(
                            line,
                            {
                                "kind": "rca_tool",
                                "phase": "started",
                                "tool": tool,
                                "tool_call_id": str(
                                    event.get("tool_call_id") or ""
                                ),
                            },
                        )

                    elif name == "tool.completed":
                        tool = str(event.get("tool") or "tool")
                        error = event.get("error")
                        duration = event.get("duration")
                        if error:
                            line = f"❌ 工具 {tool} 执行失败：{str(error)[:200]}"
                            phase = "failed"
                        else:
                            line = f"✅ 工具 {tool} 执行完成"
                            if duration not in (None, ""):
                                line += f"（耗时 {duration}s）"
                            phase = "completed"
                        await timeline.add(
                            line,
                            {
                                "kind": "rca_tool",
                                "phase": phase,
                                "tool": tool,
                                "tool_call_id": str(
                                    event.get("tool_call_id") or ""
                                ),
                            },
                        )

                    elif name == "approval.request":
                        desc = str(
                            event.get("description")
                            or event.get("command")
                            or ""
                        ).strip()
                        await timeline.add(
                            "🛡️ 工具审批请求："
                            f"{desc[:200] or '未提供描述'}；"
                            "后台 RCA 无人值守，自动批准一次",
                            {"kind": "rca_approval", "phase": "requested"},
                            force=True,
                        )
                        approval_id = str(
                            event.get("request_id")
                            or event.get("approval_id")
                            or event.get("id")
                            or ""
                        ) or None
                        try:
                            await asyncio.wait_for(
                                client.respond_approval(
                                    run_id, "once", approval_id=approval_id,
                                ),
                                timeout=10.0,
                            )
                            await timeline.add(
                                "✅ 工具审批已自动通过（once）",
                                {"kind": "rca_approval", "phase": "approved"},
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "RCA 自动审批失败 run_id={} err={}", run_id, exc,
                            )

                    elif name == "run.completed":
                        out = event.get("output")
                        if isinstance(out, str) and out.strip():
                            state["output"] = out
                        if isinstance(event.get("usage"), dict):
                            state["usage"] = event["usage"]
                        state["finish_reason"] = str(
                            event.get("finish_reason") or "stop"
                        )
                        produced = state["output"] or "".join(output_parts)
                        await timeline.add(
                            f"✅ Hermes Runs 执行完成（输出 {len(produced)} 字）",
                            {
                                "kind": "rca_run_completed",
                                "usage": state["usage"],
                            },
                            force=True,
                        )
                        return

                    elif name in ("run.failed", "error"):
                        err = (
                            event.get("error")
                            or event.get("message")
                            or "Runs 执行失败"
                        )
                        await timeline.add(
                            f"❌ Hermes Runs 执行失败：{str(err)[:300]}",
                            {"kind": "rca_run_failed"},
                            force=True,
                        )
                        raise RuntimeError(f"Hermes Runs 执行失败：{err}")

                    elif name in ("run.cancelled", "run.interrupted"):
                        await timeline.add(
                            "⚠️ Hermes Runs 被取消/中断",
                            {"kind": "rca_run_cancelled"},
                            force=True,
                        )
                        raise RuntimeError("Hermes Runs 执行被取消")

                    # run.queued / run.steered / approval.responded /
                    # subagent.* / replay.truncated are bookkeeping only.
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # noqa: BLE001 — 关闭上游流失败不影响结果
                    pass

    try:
        await asyncio.wait_for(_consume(), timeout=timeout)
    except asyncio.TimeoutError:
        await timeline.add(
            "⏰ Hermes Runs 执行超时，已请求停止",
            {"kind": "rca_run_timeout"},
            force=True,
        )
        await _stop_run_quietly(client, run_id)
        raise
    except asyncio.CancelledError:
        await _stop_run_quietly(client, run_id)
        raise
    except HermesRunError as exc:
        if (
            exc.status_code in RUNS_FALLBACK_STATUS_CODES
            and not output_parts
            and not state["output"]
        ):
            await _stop_run_quietly(client, run_id)
            raise _RunsUnavailable(
                f"run events HTTP {exc.status_code}: {exc.detail}"
            ) from exc
        raise RuntimeError(f"Hermes Runs 事件流中断：{exc.detail}") from exc
    finally:
        await timeline.flush()
        if watch_state is not None:
            watch_state.pop("steer", None)

    output = state["output"] or "".join(output_parts)
    if not output.strip():
        raise RuntimeError("Hermes Runs 未返回任何模型输出")

    return {
        "session_id": hermes_session_id,
        "status": "completed",
        "finish_reason": state["finish_reason"],
        "result": {"output": output},
        "run_id": run_id,
        "usage": state["usage"],
    }


_TOKEN_RE = re.compile(r"[a-zA-Z0-9_.-]+|[\u4e00-\u9fff]+")


def _tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for chunk in _TOKEN_RE.findall((text or "").lower()):
        if chunk and chunk[0] >= "\u4e00":
            if len(chunk) == 1:
                tokens.add(chunk)
            else:
                tokens.update(chunk[i : i + 2] for i in range(len(chunk) - 1))
        else:
            tokens.add(chunk)
    return tokens


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _knowledge_digest(
    service: str, alert_type: str, root_cause: str, evidence: list[Any],
) -> str:
    evidence_text = " ".join(str(e) for e in evidence[:5])
    return f"{service} {alert_type} {root_cause} {evidence_text}"[:4000]


async def _find_similar_cases(
    db,
    service: str,
    alert_type: str,
    digest: str,
    limit: int = 3,
) -> list[RootCauseKnowledge]:
    rows = await db.execute(
        select(RootCauseKnowledge)
        .where(RootCauseKnowledge.label.in_(["confirmed", "false_positive", "pending"]))
        .order_by(RootCauseKnowledge.created_at.desc())
        .limit(300)
    )
    current = _tokens(digest)
    scored: list[tuple[float, RootCauseKnowledge]] = []
    for item in rows.scalars():
        hay = " ".join([
            item.service_name or "", item.alert_type or "",
            item.root_cause or "", item.digest or "",
        ])
        sim = _jaccard(current, _tokens(hay))
        if item.service_name and service and item.service_name == service:
            sim += 0.1  # same-service prior
        if sim > 0.02:
            scored.append((sim, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:limit]]


def _summarise_alerts(alerts: list[Alert]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for alert in alerts:
        out.append({
            "alert_id": alert.alert_uid,
            "source": alert.source,
            "ip": alert.ip,
            "ci_name": alert.ci_name,
            "ci_application": alert.ci_application,
            "content": alert.content,
            "severity": alert.severity,
            "severity_label": severity_label(alert.severity_level or 4),
            "alert_type": alert.alert_type,
            "metric": alert.metric,
            "alert_time": alert.alert_time.isoformat() if alert.alert_time else None,
            "raw": alert.raw_payload,
        })
    return out


def _report_text_payload(report: dict[str, Any], alerts: list[dict[str, Any]]) -> str:
    return json.dumps({
        "trigger": "alert_webhook",
        "alerts": alerts,
        "report": report,
    }, ensure_ascii=False)


async def _notify(
    policy: dict[str, Any],
    *,
    title: str,
    markdown: str,
    links: list[dict[str, str]] | None = None,
    session_id: int | None = None,
) -> None:
    """Send one notification through every channel enabled by the policy.

    Delegates to :func:`app.services.notify.send_notification` (WeCom /
    Webhook / e-mail).  Notifications are strictly best-effort: a disabled
    policy, unconfigured channels and transport failures are at most a single
    warning and never affect the RCA session.
    """
    try:
        await send_notification(
            policy, title, markdown, links or [], session_id=session_id,
        )
    except Exception as exc:  # noqa: BLE001 — 通知失败只 warning
        logger.warning("RCA 通知发送失败（不影响分析）: {}", exc)


def _public_base_url() -> str:
    """Platform base URL used in notification links.

    Read from ``PUBLIC_BASE_URL`` (env / .env) first, then a ``settings`` field
    if one is ever added, finally ``http://localhost:3000``.  No config.py edit
    is required, so the default deployment keeps working unchanged.
    """
    raw = (
        os.getenv("PUBLIC_BASE_URL")
        or os.getenv("RCA_PUBLIC_BASE_URL")
        or getattr(settings, "PUBLIC_BASE_URL", "")
        or "http://localhost:3000"
    )
    return str(raw).strip().rstrip("/") or "http://localhost:3000"


def _session_status_url(session_id: int) -> str:
    return f"{_public_base_url()}/rca?s={session_id}"


def _report_download_url(session_id: int, fmt: str = "html") -> str:
    return (
        f"{_public_base_url()}/api/rca/sessions/{session_id}"
        f"/report/download?format={fmt}"
    )


async def _notify_started(
    policy: dict[str, Any],
    *,
    session_id: int,
    service: str | None,
    alert_count: int,
    window_start: datetime | None,
    window_end: datetime | None,
) -> None:
    """「分析开始」通知：服务 / 会话 id / 时间窗 / 实时状态链接。"""
    await _notify(
        policy,
        title="六脉 RCA 分析开始",
        markdown="\n".join([
            "**六脉 RCA 分析开始**",
            f"> 会话：#{session_id}",
            f"> 服务：{service or '—'}",
            f"> 告警：{alert_count} 条",
            f"> 时间窗：{_fmt_cst(window_start)} ~ {_fmt_cst(window_end)}",
            f"> 状态：[查看实时进度]({_session_status_url(session_id)})",
        ]),
        links=[{"label": "查看实时进度", "url": _session_status_url(session_id)}],
        session_id=session_id,
    )


async def _notify_finished(
    policy: dict[str, Any],
    *,
    session_id: int,
    service: str | None,
    success: bool,
    root_cause: str = "",
    confidence: float | None = None,
    elapsed: float | None = None,
    top3: list[str] | None = None,
    error: str = "",
) -> None:
    """结束通知：成功/失败、根因摘要、置信度、报告下载绝对链接、Top3。"""
    status = "✅ 分析完成" if success else "❌ 分析失败"
    lines = [
        f"**六脉 RCA {status}**",
        f"> 会话：#{session_id}",
        f"> 服务：{service or '—'}",
        f"> 状态：{status}",
    ]
    if success:
        lines.append(f"> 根因：{(root_cause or '—')[:300]}")
        conf = (
            f"{max(0.0, min(1.0, confidence)) * 100:.0f}%"
            if confidence is not None else "—"
        )
        lines.append(f"> 置信度：{conf}")
        if top3:
            lines.append("> **Top3 根因**")
            lines.extend(f"> {i}. {line}" for i, line in enumerate(top3[:3], 1))
        if elapsed is not None:
            lines.append(f"> 耗时：{elapsed:.0f}s")
        # 平台详情页链接是「登录后可用」的入口；下载直链按需求给出绝对 URL
        # （受 Bearer 鉴权保护，浏览器直接打开需已登录态）。
        lines.append(
            f"> 报告：[在平台查看/下载]({_session_status_url(session_id)})"
        )
        lines.append(
            f"> 下载直链（需登录）："
            f"[HTML]({_report_download_url(session_id, 'html')})"
            f" · [Markdown]({_report_download_url(session_id, 'md')})"
        )
    else:
        lines.append(f"> 原因：{(error or '—')[:300]}")
        lines.append(f"> 状态：[查看会话]({_session_status_url(session_id)})")
    links = [{"label": "会话详情", "url": _session_status_url(session_id)}]
    if success:
        links.extend([
            {
                "label": "HTML 报告（需登录）",
                "url": _report_download_url(session_id, "html"),
            },
            {
                "label": "Markdown 报告（需登录）",
                "url": _report_download_url(session_id, "md"),
            },
        ])
    await _notify(
        policy,
        title=f"六脉 RCA {status}",
        markdown="\n".join(lines),
        links=links,
        session_id=session_id,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Late-coalescing visibility (P1-3)
# ═══════════════════════════════════════════════════════════════════════════════


def _late_alert_brief(alert: Alert) -> dict[str, Any]:
    return {
        "id": alert.id,
        "alert_uid": alert.alert_uid,
        "severity_level": alert.severity_level,
        "content": (alert.content or "")[:200],
        "alert_time": alert.alert_time.isoformat() if alert.alert_time else None,
    }


async def _watch_coalesced_alerts(
    session_id: int,
    initial_ids: set[int],
    stop_event: asyncio.Event,
    state: dict[str, Any],
) -> None:
    """分析期间监听「新增附着」的告警。

    Runs API 可用时优先 ``steer_run`` 把新告警注入正在进行的推理；否则退化为
    「写时间线 + 记录待补充告警」：
      1. 立即把新告警写进时间线（运维可感知「报告口径不含这些告警」）；
      2. 记录到 ``state["late_alerts"]``，供结束时在报告口径里标注；
      3. 无法 steer 的告警另记到 ``state["pending_late_alerts"]``，成功结束后
         会由 :func:`_create_followup_session` 自动补一次分析（见 Runner）。
    ``state["steer"]`` 由 :func:`_run_rca_via_runs` 在拿到 run_id 后注入，
    非流式回退路径不会设置它。
    """
    known = set(initial_ids)
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=COALESCE_WATCH_INTERVAL_SECONDS,
            )
            return
        except asyncio.TimeoutError:
            pass
        try:
            async with async_session_factory() as db:
                rows = await db.execute(
                    select(Alert)
                    .where(Alert.rca_session_id == session_id)
                    .order_by(Alert.alert_time.asc())
                )
                fresh = [a for a in rows.scalars() if a.id not in known]
                if not fresh:
                    continue
                known.update(a.id for a in fresh)
                briefs = [_late_alert_brief(a) for a in fresh]
                state.setdefault("late_alerts", []).extend(briefs)
                uids = "、".join(str(b["alert_uid"]) for b in briefs[:5]) or "—"

                steer_status = "unavailable"
                steer_error = ""
                steer_fn = state.get("steer")
                if callable(steer_fn):
                    steer_text = (
                        f"【新增告警】分析开始后又并入 {len(briefs)} 条告警，"
                        "请在后续推理中一并纳入：\n"
                        + "\n".join(
                            f"- {b['alert_uid']}: {(b['content'] or '')[:150]}"
                            for b in briefs[:5]
                        )
                    )
                    try:
                        await asyncio.wait_for(
                            steer_fn(steer_text[:2000]), timeout=15.0,
                        )
                        steer_status = "ok"
                        state["steer_ok"] = True
                        state.setdefault("steered_ids", set()).update(
                            b["id"] for b in briefs
                        )
                    except Exception as exc:  # noqa: BLE001 — steer 失败降级
                        steer_status = "failed"
                        steer_error = str(exc)[:200]
                        logger.warning(
                            "RCA 迟到告警 steer 失败 session_id={} err={}",
                            session_id,
                            exc,
                        )

                if steer_status == "ok":
                    content = (
                        f"分析开始后并入 {len(briefs)} 条告警（{uids}），"
                        "已通过 Runs API steer 注入正在进行的推理。"
                    )
                elif steer_status == "failed":
                    content = (
                        f"分析开始后并入 {len(briefs)} 条告警（{uids}）。"
                        f"Runs API steer 注入失败（{steer_error}），"
                        "已计入会话告警数；如需完整覆盖请在本次结束后重跑。"
                    )
                else:
                    # 非 Runs 回退路径：没有 steer 能力，把这些告警记为「待补充」，
                    # 本次成功结束后自动创建补充分析会话（失败/取消不创建）。
                    state.setdefault("pending_late_alerts", []).extend(briefs)
                    content = (
                        f"分析开始后并入 {len(briefs)} 条告警（{uids}）。"
                        "当前执行路径不支持中途 steer 注入；"
                        "已计入会话告警数并记为待补充告警，"
                        "本次分析完成后将自动创建补充分析会话。"
                    )
                db.add(CollaborationEvent(
                    rca_session_id=session_id,
                    event_type=CollaborationEventType.AGENT_PROGRESS,
                    content=content[:1000],
                    metadata_={
                        "kind": "rca_coalesce_late",
                        "alert_ids": [b["id"] for b in briefs],
                        "steer": steer_status,
                        "steer_error": steer_error or None,
                    },
                ))
                await db.commit()
        except Exception:  # noqa: BLE001 — 监听失败不能拖垮分析
            logger.exception("RCA 分析期告警监听失败 session_id={}", session_id)


# ── 补充分析（followup）：非 Runs 回退路径的实时 steer 等价能力 ──────────────
#
# Runs API 可用时，分析期并入的告警能通过 ``steer_run`` 注入正在进行的推理；
# 非流式回退路径没有这个能力，只能等本次分析结束。为了不丢覆盖，成功后自动
# 创建一个「补充分析会话」：
#   * 同一 service，时间窗 = late alerts 的 min~max alert_time；
#   * trigger_reason = ``followup:<parent_id>``，alert_count = late 告警数；
#   * status = QUEUED，通过 asyncio task 入队（与 webhook 触发同一执行器）。
# 失败/取消分支不会走到这里（只在成功落库分支创建）。followup 会话本身不再
# 生成 followup（``trigger_reason`` 前缀判断），因此不会无限递归。

FOLLOWUP_TRIGGER_PREFIX = "followup:"


def _is_followup_session(session: RcaSession) -> bool:
    """True for sessions created by the late-alert supplement path."""
    return str(session.trigger_reason or "").strip().startswith(
        FOLLOWUP_TRIGGER_PREFIX
    )


async def _create_followup_session(
    db,
    parent: RcaSession,
    late_briefs: list[dict[str, Any]],
) -> int | None:
    """Create the supplement session covering alerts merged after start.

    The late ``Alert`` rows are re-pointed at the follow-up session so the
    runner's normal ``alerts WHERE rca_session_id = ...`` query feeds them to
    Hermes with no schema change; the parent keeps its already persisted
    report/count snapshot.  Returns the new session id (or ``None`` when there
    is nothing to do / this is already a follow-up).
    """
    if not late_briefs or _is_followup_session(parent):
        return None
    alert_ids = [int(b["id"]) for b in late_briefs if b.get("id") is not None]
    if not alert_ids:
        return None
    rows = await db.execute(select(Alert).where(Alert.id.in_(alert_ids)))
    late_rows = list(rows.scalars())
    if not late_rows:
        return None

    alert_times = [a.alert_time for a in late_rows if a.alert_time is not None]
    window_start = min(alert_times) if alert_times else _now()
    window_end = max(alert_times) if alert_times else window_start
    followup = RcaSession(
        team_id=parent.team_id,
        rule_id=parent.rule_id,
        trigger_type=parent.trigger_type,
        status=RcaStatus.QUEUED,
        service_name=parent.service_name,
        alert_count=len(late_rows),
        trigger_reason=f"{FOLLOWUP_TRIGGER_PREFIX}{parent.id}",
        time_window_start=window_start,
        time_window_end=window_end,
    )
    db.add(followup)
    await db.flush()
    for alert in late_rows:
        alert.rca_session_id = followup.id

    uids = "、".join(str(a.alert_uid or a.id) for a in late_rows[:5])
    db.add(CollaborationEvent(
        rca_session_id=parent.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"已自动创建补充分析会话 #{followup.id}，覆盖分析期间并入的 "
            f"{len(late_rows)} 条告警（{uids}）。"
        )[:1000],
        metadata_={
            "kind": "rca_followup_created",
            "followup_session_id": followup.id,
            "alert_ids": [a.id for a in late_rows],
        },
    ))
    db.add(CollaborationEvent(
        rca_session_id=followup.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=(
            f"补充分析会话：由 #{parent.id} 在其分析结束后自动创建，"
            f"纳入当时未能 steer 注入的 {len(late_rows)} 条告警。"
        )[:1000],
        metadata_={"kind": "rca_followup", "parent_session_id": parent.id},
    ))
    try:
        await record_audit(
            db, "system", "RCA补充分析",
            detail=(
                f"session=#{parent.id} → followup=#{followup.id} "
                f"alerts={len(late_rows)} service={parent.service_name or '—'}"
            ),
            extra={
                "session_id": parent.id,
                "followup_session_id": followup.id,
            },
        )
    except Exception:  # noqa: BLE001 — 审计失败不影响补充分析
        logger.exception("RCA 补充分析审计写入失败 session_id={}", parent.id)
    logger.info(
        "RCA 补充分析会话已创建: parent={} followup={} alerts={}",
        parent.id,
        followup.id,
        len(late_rows),
    )
    return followup.id


def _schedule_followup(session_id: int) -> None:
    """Queue the supplement session on the normal background runner."""
    task = asyncio.create_task(run_rca_session(session_id))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    logger.info("RCA 补充分析会话已入队: session_id={}", session_id)


# ═══════════════════════════════════════════════════════════════════════════════
# Runner
# ═══════════════════════════════════════════════════════════════════════════════


async def run_rca_session(session_id: int) -> None:
    """Execute one RCA session end-to-end in the background."""
    # 跨 worker 并发闸门（Redis 计数优先，Redis 不可用时回退进程内信号量）。
    # 排队等待期间由 _rca_slot 写入时间线事件，状态保持 QUEUED。
    async with _rca_slot(session_id):
        async with async_session_factory() as db:
            session = await db.get(RcaSession, session_id)
            if session is None:
                return
            if session.status not in (RcaStatus.QUEUED, RcaStatus.RUNNING):
                return
            session.status = RcaStatus.RUNNING
            db.add(CollaborationEvent(
                rca_session_id=session_id,
                event_type=CollaborationEventType.AGENT_PROGRESS,
                content=(f"RCA 开始分析：服务 {session.service_name or '—'}，"
                         f"告警 {session.alert_count or 1} 条，"
                         f"窗口 {_fmt_cst(session.time_window_start)} ~ "
                         f"{_fmt_cst(session.time_window_end)}")
                if session.time_window_start and session.time_window_end else "RCA 开始分析",
                metadata_={"kind": START_EVENT_KIND},
            ))
            await db.commit()

            started = _now()
            policy = await get_policy(db)
            # P1-5：分析开始通知（服务/会话 id/时间窗/状态链接），由
            # notify.send_notification 按 policy.notify.channels 分发到
            # 企业微信 / Webhook / 邮件；未配置的通道静默跳过，不影响 RCA。
            try:
                await _notify_started(
                    policy,
                    session_id=session_id,
                    service=session.service_name,
                    alert_count=session.alert_count or 1,
                    window_start=session.time_window_start,
                    window_end=session.time_window_end,
                )
            except Exception as exc:  # noqa: BLE001 — 通知失败不得影响分析
                logger.warning(
                    "RCA 开始通知发送失败 session_id={} err={}", session_id, exc,
                )
            # 心跳 + 分析期告警监听：随本次执行启停（finally 中统一取消）。
            stop_event = asyncio.Event()
            watch_state: dict[str, Any] = {
                "late_alerts": [],
                "pending_late_alerts": [],
            }
            keepalive: list[asyncio.Task] = [
                asyncio.create_task(_heartbeat_loop(session_id, stop_event)),
            ]
            try:
                # P1-3：拿到并发槽后再刷新一次会话与关联告警，把状态切换/排队
                # 期间并入的告警纳入本次提示词（避免「UI 显示 5 条、报告只覆盖 1 条」）。
                db.expire_all()
                session = await db.get(RcaSession, session_id)
                if session is None or session.status != RcaStatus.RUNNING:
                    logger.info(
                        "RCA session {} 在开始前已不在 RUNNING（可能被巡检回收），跳过",
                        session_id,
                    )
                    return
                alert_rows = await db.execute(
                    select(Alert)
                    .where(Alert.rca_session_id == session_id)
                    .order_by(Alert.alert_time.asc())
                )
                alerts = list(alert_rows.scalars())
                alert_dicts = _summarise_alerts(alerts)
                analysis_alert_ids = {a.id for a in alerts}
                session.alert_count = max(
                    session.alert_count or 1, len(alerts) or 1,
                )
                keepalive.append(asyncio.create_task(
                    _watch_coalesced_alerts(
                        session_id, analysis_alert_ids, stop_event, watch_state,
                    )
                ))

                service = session.service_name or "unknown"
                alert_type = alerts[0].alert_type if alerts else "unknown"
                digest = _knowledge_digest(
                    service, alert_type or "",
                    " ".join(str(a.get("content") or "") for a in alert_dicts),
                    [a.get("content") for a in alert_dicts],
                )
                prior = await _find_similar_cases(db, service, alert_type or "", digest)
                prior_payload = [{
                    "service": item.service_name,
                    "alert_type": item.alert_type,
                    "root_cause": item.root_cause,
                    "label": item.label,
                } for item in prior]

                params = {
                    "service_name": service,
                    "alert_type": alert_type,
                    "alert_count": len(alert_dicts) or 1,
                    "trigger_reason": session.trigger_reason,
                    "time_window_start": session.time_window_start.isoformat()
                    if session.time_window_start else None,
                    "time_window_end": session.time_window_end.isoformat()
                    if session.time_window_end else None,
                    "alerts": alert_dicts,
                    "knowledge_history": prior_payload,
                    "instruction": (
                        "请按 rca-fault-delimitation 技能对告警做根因分析；"
                        "时间窗必须严格使用 time_window_start ~ time_window_end；"
                        "knowledge_history 中的 confirmed 案例可作为参考，false_positive 案例应避免误判。"
                        "仅返回 JSON：root_cause/confidence/evidence/impacted_services/recommended_actions。"
                    ),
                }

                timeout = min(int(policy["rca"]["run_timeout_seconds"]), 1800)
                client = HermesClient(timeout=timeout)
                try:
                    if _runs_available():
                        try:
                            # 首选：Runs API + SSE，执行过程写入时间线。
                            result = await _run_rca_via_runs(
                                client,
                                params,
                                session_id=session_id,
                                timeout=timeout,
                                watch_state=watch_state,
                            )
                            _mark_runs_available()
                        except _RunsUnavailable as exc:
                            # 能力缺失（Hermes 404/405/501/503…）：本次回退到
                            # 历史非流式路径，并在一段时间内直接走回退，避免每次
                            # RCA 都多付一次探测请求。
                            _mark_runs_unavailable(str(exc))
                            await _append_progress(
                                session_id,
                                f"Hermes Runs API 不可用（{exc}），"
                                "本次自动回退非流式分析。",
                                {
                                    "kind": "rca_runs_fallback",
                                    "reason": str(exc)[:500],
                                },
                            )
                            result = await asyncio.wait_for(
                                client.run_rca(RUNS_SKILL_NAME, params),
                                timeout=timeout + 5,
                            )
                    else:
                        await _append_progress(
                            session_id,
                            "Hermes Runs API 处于冷却期，本次使用非流式分析。",
                            {"kind": "rca_runs_fallback", "reason": "cooldown"},
                        )
                        result = await asyncio.wait_for(
                            client.run_rca(RUNS_SKILL_NAME, params),
                            timeout=timeout + 5,
                        )
                finally:
                    await client.close()

                # Hermes 已返回：停止心跳/监听，后面只做落库。
                await _stop_background(keepalive, stop_event)
                late_alerts = list(watch_state.get("late_alerts") or [])
                pending_followup_alerts = list(
                    watch_state.get("pending_late_alerts") or []
                )
                steered_ids = set(watch_state.get("steered_ids") or set())
                # 分析期间可能又有告警并入：按实际附着数刷新计数，保证
                # 列表 alert_count 与 DB 一致；报告口径仍记录「实际参与推理」的条数。
                attached_rows = await db.execute(
                    select(Alert)
                    .where(Alert.rca_session_id == session_id)
                    .order_by(Alert.alert_time.asc())
                )
                attached_alerts = list(attached_rows.scalars())
                total_alerts = len(attached_alerts)
                session.alert_count = max(len(alerts) or 1, total_alerts)

                # 收尾兜底：监听协程每 15s 才轮询一次，最后一刻并入的告警可能
                # 还没被发现。按「实际附着 − 已参与推理 − 已成功 steer」补齐
                # 待补充集合，让 followup 判断不依赖轮询时机。
                pending_ids = {b["id"] for b in pending_followup_alerts}
                late_ids = {b["id"] for b in late_alerts}
                for attached in attached_alerts:
                    if attached.id in analysis_alert_ids:
                        continue
                    if attached.id in steered_ids:
                        continue
                    brief = _late_alert_brief(attached)
                    if attached.id not in pending_ids:
                        pending_followup_alerts.append(brief)
                        pending_ids.add(attached.id)
                    if attached.id not in late_ids:
                        late_alerts.append(brief)
                        late_ids.add(attached.id)

                raw_output = str(result.get("result", {}).get("output") or "")
                payload = _extract_json_object(raw_output) or {}
                report_data = _normalise_report(payload, raw_output)

                # 输出被 max_tokens 截断时 JSON 往往不完整：保留告警日志，
                # 便于调大 RCA_MAX_TOKENS 后重跑定位。
                finish_reason = result.get("finish_reason")
                if finish_reason == "length":
                    logger.warning(
                        "RCA session {} output truncated (finish_reason=length, "
                        "raw_output_chars={})",
                        session_id,
                        len(raw_output),
                    )

                exists = await db.execute(
                    select(RcaReport).where(RcaReport.session_id == session_id)
                )
                report = exists.scalar_one_or_none()
                if report is None:
                    report = RcaReport(session_id=session_id, team_id=session.team_id)
                    db.add(report)
                report.service_name = service
                report.alert_count = len(alert_dicts) or 1
                report.category = (report_data.get("category") or alert_type or "unknown")[:50]
                report.root_cause = report_data["root_cause"]
                report.confidence = report_data["confidence"]
                report.evidence = report_data["evidence"]
                report.impacted_services = report_data["impacted_services"]
                report.recommended_actions = report_data["recommended_actions"]
                report.raw_output = raw_output[:50000]

                session.status = RcaStatus.COMPLETED
                session.completed_at = datetime.now(timezone.utc)
                # 只写 Hermes 真实返回的会话 id；拿不到就保持 NULL（该列
                # unique，空串会让多个会话互相冲突，也误导排查）。
                #
                # 注意 Hermes 在调用方未显式传会话头时会用「system prompt +
                # 首条用户消息」派生 ``api-<hash>``，完全相同的 RCA 参数可能
                # 得到相同 id。此时不能硬写，否则 UNIQUE 约束会让整次已经
                # 完成的分析 commit 失败 —— 重复时保持 NULL 并告警。
                hermes_sid = result.get("session_id") or None
                if hermes_sid:
                    dup = await db.execute(
                        select(RcaSession.id).where(
                            RcaSession.hermes_session_id == hermes_sid,
                            RcaSession.id != session_id,
                        )
                    )
                    if dup.scalar_one_or_none() is not None:
                        logger.warning(
                            "RCA session {}: Hermes session id {} 已被其它会话"
                            "占用，本次不写入（避免 UNIQUE 冲突）",
                            session_id,
                            hermes_sid,
                        )
                        hermes_sid = None
                session.hermes_session_id = hermes_sid
                session.root_cause_summary = report_data["root_cause"][:500]
                # P1-5：Top3 不新增列，复用现有 JSONB 字段。``evidence`` 从
                # 「纯列表」升级为结构化对象，读取方需兼容两种形状（见
                # routes/rca.py 的 _session_evidence / _session_top3）。
                session.evidence = {
                    "evidence": report_data["evidence"],
                    "top3": report_data["top3"],
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "run_id": result.get("run_id") or None,
                }

                db.add(CollaborationEvent(
                    rca_session_id=session_id,
                    event_type=CollaborationEventType.RCA_COMPLETED,
                    content=f"RCA 完成：{report_data['root_cause'][:300]}",
                    metadata_={
                        "confidence": report_data["confidence"],
                        "analyzed_alert_count": len(alert_dicts) or 1,
                        "late_alert_count": len(late_alerts),
                        "top3": report_data["top3"],
                        "run_id": result.get("run_id") or None,
                    },
                ))
                if late_alerts:
                    # 报告口径与 UI 告警数的差异必须显式留痕（P1-3）。
                    steered = bool(watch_state.get("steer_ok"))
                    followup_expected = bool(
                        pending_followup_alerts
                        and not _is_followup_session(session)
                    )
                    if steered:
                        coverage_note = (
                            "已通过 Runs API steer 注入正在进行的推理。"
                        )
                    elif followup_expected:
                        coverage_note = (
                            "未纳入本次推理；已记录为待补充告警，"
                            "本次完成后自动创建补充分析会话。"
                        )
                    else:
                        coverage_note = (
                            "未纳入本次推理。会话告警数已按实际附着数更新，"
                            "如需完整覆盖请重跑。"
                        )
                    db.add(CollaborationEvent(
                        rca_session_id=session_id,
                        event_type=CollaborationEventType.AGENT_PROGRESS,
                        content=(
                            f"口径提示：本次推理基于分析开始时的 "
                            f"{len(alert_dicts) or 1} 条告警；分析期间另有 "
                            f"{len(late_alerts)} 条并入（"
                            f"{'、'.join(str(b['alert_uid']) for b in late_alerts[:5])}），"
                            + coverage_note
                        )[:1000],
                        metadata_={
                            "kind": "rca_coalesce_summary",
                            "analyzed_alert_count": len(alert_dicts) or 1,
                            "late_alert_ids": [b["id"] for b in late_alerts],
                            "steer": "ok" if steered else "unavailable",
                            "followup_pending": followup_expected,
                        },
                    ))

                # Seed the root-cause knowledge base as a pending candidate
                knowledge = RootCauseKnowledge(
                    team_id=session.team_id,
                    session_id=session_id,
                    service_name=service,
                    alert_type=alert_type,
                    title=f"{service} · {alert_type or 'unknown'}",
                    root_cause=report_data["root_cause"][:4000],
                    digest=digest,
                    evidence=report_data["evidence"],
                    label="pending",
                    created_by="system",
                )
                db.add(knowledge)
                await record_audit(
                    db, "system", "RCA完成",
                    detail=f"session=#{session_id} service={service} "
                           f"root_cause={report_data['root_cause'][:120]}",
                    extra={"session_id": session_id},
                )
                await _clear_heartbeat(db, session_id)
                await db.commit()

                # 非 Runs 回退路径的实时 steer 等价能力：仅成功分支创建补充
                # 分析会话（失败/取消走 except，不会创建）；followup 会话自身
                # 不再生成 followup（前缀判断），避免无限递归。
                followup_id: int | None = None
                if pending_followup_alerts and not _is_followup_session(session):
                    try:
                        # 独立事务：补分析创建失败既不影响已提交的本次分析，
                        # 也不会把父会话事务带入失败状态。
                        async with async_session_factory() as followup_db:
                            followup_id = await _create_followup_session(
                                followup_db, session, pending_followup_alerts,
                            )
                            await followup_db.commit()
                    except Exception:  # noqa: BLE001 — 补分析失败只 warning
                        logger.exception(
                            "RCA 补充分析会话创建失败 session_id={}", session_id,
                        )
                        followup_id = None
                if followup_id is not None:
                    _schedule_followup(followup_id)

                elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                try:
                    await _notify_finished(
                        policy,
                        session_id=session_id,
                        service=service,
                        success=True,
                        root_cause=report_data["root_cause"],
                        confidence=report_data["confidence"],
                        elapsed=elapsed,
                        top3=report_data["top3"],
                    )
                except Exception as exc:  # noqa: BLE001 — 通知失败不得影响已完成状态
                    logger.warning(
                        "RCA 完成通知发送失败 session_id={} err={}",
                        session_id,
                        exc,
                    )
                logger.info("RCA session {} completed in {:.0f}s", session_id, elapsed)

            except asyncio.TimeoutError:
                logger.warning("RCA session {} timed out", session_id)
                await _fail_session(
                    db, session_id, "RCA 分析超时（Hermes 未在配置时间内返回）",
                )
            except Exception as exc:  # noqa: BLE001 — background task must never crash
                logger.exception("RCA session {} failed", session_id)
                await _fail_session(db, session_id, f"RCA 分析失败：{exc}")
            finally:
                # 无论成功/失败/取消，都必须停掉心跳与监听，避免孤儿协程。
                await _stop_background(keepalive, stop_event)
                # 心跳协程可能在收尾瞬间又抢写了一条：再清一次（失败无视）。
                try:
                    await _clear_heartbeat(db, session_id)
                    await db.commit()
                except Exception:  # noqa: BLE001
                    try:
                        await db.rollback()
                    except Exception:
                        pass


async def _fail_session(db, session_id: int, message: str) -> None:
    try:
        await db.rollback()
    except Exception:
        pass
    session = await db.get(RcaSession, session_id)
    service = session.service_name if session is not None else None
    if session:
        session.status = RcaStatus.FAILED
        session.completed_at = datetime.now(timezone.utc)
        # rca_sessions 没有 error_message 列：用时间线承载完整原因，
        # root_cause_summary 加【失败】前缀让列表页可见（等价 error_message）。
        session.root_cause_summary = f"【失败】{message}"[:500]
        db.add(CollaborationEvent(
            rca_session_id=session_id,
            event_type=CollaborationEventType.AGENT_PROGRESS,
            content=message[:1000],
            metadata_={"kind": "rca_failed", "error": message[:2000]},
        ))
        await _clear_heartbeat(db, session_id)
        await record_audit(db, "system", "RCA失败",
                           detail=f"session=#{session_id} {message[:200]}",
                           extra={"session_id": session_id})
        await db.commit()
    try:
        policy = await get_policy(db)
        await _notify_finished(
            policy,
            session_id=session_id,
            service=service,
            success=False,
            error=message,
        )
    except Exception as exc:  # noqa: BLE001 — 失败通知不能掩盖原始错误
        logger.warning(
            "RCA 失败通知发送失败 session_id={} err={}", session_id, exc,
        )
