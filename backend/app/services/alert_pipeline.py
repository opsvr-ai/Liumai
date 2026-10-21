"""Alert ingestion & RCA trigger policy.

This module is the FastAPI-native port of the core of the 六脉RCA平台
``webhook_rca_new.py`` service:

* ``normalize_alert``     — Tarsier / Tarsier-multi-source / Zabbix field mapping
* ``classify_alert``      — performance / error / hang / connectivity taxonomy
* ``severity_level``      — 5-level Tarsier severity mapping
* ``dedup_key``           — de-duplication fingerprint
* ``decide_trigger``      — multi-signal trigger policy (severity / critical
  component / high-risk signature / business fluctuation)
* ``ingest_alert``        — dedupe → classify → rule engine → policy →
  inbox/coalesce/trigger

Trigger priority: an enabled :class:`AlertRule` of the alert's team (evaluated
by :mod:`app.services.rule_engine`) wins over the global A/B/C policy.  Manual
mode still sends everything to the inbox before rules are evaluated.

Policy is persisted in ``system_config`` (``rca_alert_policy``), so administrators
can tune it at runtime without restarting the backend.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

from loguru import logger
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Alert,
    CollaborationEvent,
    CollaborationEventType,
    DataSource,
    RcaSession,
    RcaStatus,
    RcaTriggerType,
    SystemConfig,
)
from app.services.datasource_adapters import get_adapter, validate_readonly_sql
from app.services.rule_engine import RuleMatch, match_rule as match_alert_rule

CST = timezone(timedelta(hours=8))

# 收件箱 / 垃圾箱状态集合（保留期清理与列表查询共用，避免两处漂移）。
INBOX_STATUSES: tuple[str, ...] = ("pending", "triggered", "coalesced")
TRASH_STATUSES: tuple[str, ...] = ("filtered", "dismissed")

# 多团队 webhook 令牌（P2-13）：``system_config.alert_webhook_tokens`` 存
# JSON 数组 ``[{"id","token","team_id","name","enabled","created_at"}]``。
# 未配置该键（或数组为空）时保持旧的单令牌 / 开放接入行为，全部归 team 1。
WEBHOOK_TOKENS_KEY = "alert_webhook_tokens"
WEBHOOK_TOKEN_MASK_KEEP = 6
MAX_WEBHOOK_TOKENS = 50
RETENTION_DEFAULT_INBOX_DAYS = 7
RETENTION_DEFAULT_TRASH_DAYS = 30

# ═══════════════════════════════════════════════════════════════════════════════
# Path C defaults (ClickHouse business-volume fluctuation)
# ═══════════════════════════════════════════════════════════════════════════════

PATH_C_TIMEOUT_SECONDS = 3.0
PATH_C_CACHE_TTL_SECONDS = 60.0
PATH_C_CACHE_MAX_ENTRIES = 128
PATH_C_DEFAULT_WINDOW_MINUTES = 30
PATH_C_DEFAULT_BASELINE_MINUTES = 60
PATH_C_DEFAULT_DROP_PCT = 60.0
PATH_C_DEFAULT_METRIC = "count"
PATH_C_DEFAULT_TABLE = "opsobs.dist_metric_trans_min_server"
PATH_C_MAX_SQL_LENGTH = 8000

# Default query: one row per minute of absolute business volume.  The window /
# baseline sums are split in Python so an operator can point ``sql`` at another
# table/expression without changing the aggregation contract.
PATH_C_DEFAULT_SQL = (
    "SELECT toStartOfMinute(time) AS minute, "
    "sum(toFloat64OrZero({metric})) AS volume "
    f"FROM {PATH_C_DEFAULT_TABLE} "
    "WHERE time >= toDateTime('{baseline_start}') "
    "AND time < toDateTime('{window_end}') "
    "GROUP BY minute ORDER BY minute"
)

# Only a plain (optionally dotted) column identifier is interpolated into the
# default SQL; anything more complex must use the ``sql`` override.
_PATH_C_METRIC_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$"
)

# Process-local cache: datasource_id -> (monotonic expiry, result dict).  A
# datasource that is down is cached too, so a 3s timeout cannot be paid on
# every alert received during the same minute.
_PATH_C_CACHE: dict[int, tuple[float, dict[str, Any]]] = {}
_PATH_C_WARN_TS: dict[str, float] = {}


# ═══════════════════════════════════════════════════════════════════════════════
# Default policy (ported from alert_policy.json defaults in the source service)
# ═══════════════════════════════════════════════════════════════════════════════

DEFAULT_POLICY: dict[str, Any] = {
    "mode": "auto",  # auto | manual
    "trigger": {
        # 1=严重 2=重要 3=一般 4=告警 5=提示；<= severity_max 立即触发
        "severity_max": 2,
        "severity_trigger": True,
        "unrecognized_severity": "ignore",
        "analysis_start_offset_minutes": 5,
        "app_coalesce_window": 600,
        # Path C: ClickHouse 业务量（交易量）波动。默认关闭；启用后还需配置
        # datasource_id（data_sources 表中 type=clickhouse 且 enabled 的记录）。
        # metric 是默认 SQL 中参与聚合的列（安全标识符），sql 可整体覆盖查询。
        "path_c": {
            "enabled": False,
            "datasource_id": None,
            "window_minutes": PATH_C_DEFAULT_WINDOW_MINUTES,
            "baseline_minutes": PATH_C_DEFAULT_BASELINE_MINUTES,
            "drop_pct": PATH_C_DEFAULT_DROP_PCT,
            "metric": PATH_C_DEFAULT_METRIC,
            "sql": "",
        },
        "critical_components": [
            "Minio", "文件服务", "es数据库", "es 数据库", "移动网关", "EMASGWay", "EMAS",
            "理财", "业务网关", "运管", "esb", "ESB", "Nginx", "innerNginx",
            "前置", "网关", "Redis", "DBLink", "dblink", "数据源",
        ],
        "high_risk_keywords": [
            "暂停进程", "进程暂停", "进程不存在", "进程退出", "进程终止", "杀进程",
            "killed", "OOM", "oom",
            "CPU满载", "CPU 满载", "CPU使用率", "CPU占用", "内存使用率", "内存占用",
            "内存满", "内存溢出", "磁盘使用率", "磁盘满", "磁盘空间不足",
            "连接池满", "连接池耗尽", "文件句柄", "句柄超限", "CodeCache",
            "网络延迟", "延迟过大", "丢包", "丢包率", "网络不可达", "连接超时",
            "连接失败", "DNS解析", "DNS篡改", "TCP连接数", "TCP等待", "连接数大于",
            "包损坏", "包重排序", "主机重启", "系统重启", "不可达", "探活失败",
            "PING丢失", "心跳丢失", "Full GC", "full gc", "频繁GC", "JVM异常",
            "线程池耗尽", "调用延迟",
        ],
    },
    "dedup": {"window_seconds": 300},
    "multi": {"trigger_paths": {"A": True, "B": True, "C": False}},
    "rca": {"run_timeout_seconds": 1200, "concurrency": 3},
    "notify": {"enabled": False, "wecom_chat_id": ""},
    "webhook_token": "",
    # 告警保留期 / 定时清空（P2-8）：0 天表示该类别不自动清理。
    "retention": {
        "inbox_days": RETENTION_DEFAULT_INBOX_DAYS,
        "trash_days": RETENTION_DEFAULT_TRASH_DAYS,
        "auto_clear_enabled": True,
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge *override* into a copy of *base*."""
    out = json.loads(json.dumps(base, ensure_ascii=False))
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _clamp_float(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    return max(lo, min(hi, n))


def _clamp_bool(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off", ""):
            return False
    return default


def _action_override_int(
    actions: dict[str, Any], key: str, default: int, lo: int, hi: int
) -> int:
    """Read an optional integer override from a matched rule's ``actions``."""
    if not actions or key not in actions:
        return default
    return _clamp_int(actions.get(key), lo, hi, default)


def _normalize_path_c(raw: Any) -> dict[str, Any]:
    """Clamp/repair the ``trigger.path_c`` block (never raises)."""
    cfg = raw if isinstance(raw, dict) else {}
    datasource_id = _clamp_int(
        cfg.get("datasource_id"), 0, 2_147_483_647, 0,
    )
    metric = str(cfg.get("metric") or PATH_C_DEFAULT_METRIC).strip()
    if not _PATH_C_METRIC_RE.fullmatch(metric):
        # Invalid metric expressions are ignored; operators who need an
        # expression must use the validated ``sql`` override.
        metric = PATH_C_DEFAULT_METRIC
    return {
        "enabled": _clamp_bool(cfg.get("enabled"), False),
        "datasource_id": datasource_id or None,
        "window_minutes": _clamp_int(
            cfg.get("window_minutes"), 1, 1440, PATH_C_DEFAULT_WINDOW_MINUTES,
        ),
        "baseline_minutes": _clamp_int(
            cfg.get("baseline_minutes"), 1, 10080, PATH_C_DEFAULT_BASELINE_MINUTES,
        ),
        "drop_pct": _clamp_float(
            cfg.get("drop_pct"), 0.0, 100.0, PATH_C_DEFAULT_DROP_PCT,
        ),
        "metric": metric or PATH_C_DEFAULT_METRIC,
        "sql": str(cfg.get("sql") or "").strip()[:PATH_C_MAX_SQL_LENGTH],
    }


async def get_policy(db: AsyncSession) -> dict[str, Any]:
    """Load the effective alert policy (defaults ← DB overrides)."""
    keys = [
        "rca_alert_policy", "rca_alert_mode", "webhook_token",
        "alert_notify_enabled", "wecom_alert_chat_id",
    ]
    rows = await db.execute(select(SystemConfig).where(SystemConfig.key.in_(keys)))
    cfg = {r.key: r.value for r in rows.scalars()}
    stored: dict[str, Any] = {}
    try:
        stored = json.loads(cfg.get("rca_alert_policy") or "{}")
        if not isinstance(stored, dict):
            stored = {}
    except (TypeError, ValueError):
        stored = {}
    policy = _deep_merge(DEFAULT_POLICY, stored)
    policy["mode"] = (cfg.get("rca_alert_mode") or policy.get("mode") or "auto").lower()
    if policy["mode"] not in ("auto", "manual"):
        policy["mode"] = "auto"
    policy["webhook_token"] = cfg.get("webhook_token", policy.get("webhook_token", "")) or ""
    policy["notify"]["enabled"] = (cfg.get("alert_notify_enabled") or "false").lower() in ("1", "true", "yes")
    policy["notify"]["wecom_chat_id"] = cfg.get("wecom_alert_chat_id", "") or ""
    policy["trigger"]["severity_max"] = _clamp_int(
        policy["trigger"].get("severity_max"), 1, 5, 2,
    )
    policy["trigger"]["analysis_start_offset_minutes"] = _clamp_int(
        policy["trigger"].get("analysis_start_offset_minutes"), 0, 240, 5,
    )
    policy["trigger"]["app_coalesce_window"] = _clamp_int(
        policy["trigger"].get("app_coalesce_window"), 0, 86400, 600,
    )
    policy["trigger"]["path_c"] = _normalize_path_c(policy["trigger"].get("path_c"))
    policy["dedup"]["window_seconds"] = _clamp_int(
        policy["dedup"].get("window_seconds"), 0, 86400, 300,
    )
    policy["rca"]["run_timeout_seconds"] = _clamp_int(
        policy["rca"].get("run_timeout_seconds"), 60, 7200, 1200,
    )
    policy["rca"]["concurrency"] = _clamp_int(policy["rca"].get("concurrency"), 1, 16, 3)
    retention = policy.get("retention")
    if not isinstance(retention, dict):
        retention = {}
    policy["retention"] = {
        # 0 表示不清理该类别；上限 10 年，避免误填导致“全部清空”。
        "inbox_days": _clamp_int(
            retention.get("inbox_days"), 0, 3650, RETENTION_DEFAULT_INBOX_DAYS,
        ),
        "trash_days": _clamp_int(
            retention.get("trash_days"), 0, 3650, RETENTION_DEFAULT_TRASH_DAYS,
        ),
        "auto_clear_enabled": _clamp_bool(
            retention.get("auto_clear_enabled"), True,
        ),
    }
    return policy


async def save_policy(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist an operator-supplied policy and return the effective policy.

    Partial payloads are **merged** into the stored policy instead of replacing
    it wholesale, so fields the caller omitted (e.g. ``retention`` from an old
    UI, or a future field) survive an update.
    """
    payload = dict(payload or {})
    existing_row = await db.get(SystemConfig, "rca_alert_policy")
    existing: dict[str, Any] = {}
    if existing_row is not None and existing_row.value:
        try:
            parsed = json.loads(existing_row.value)
            if isinstance(parsed, dict):
                existing = parsed
        except (TypeError, ValueError):
            existing = {}
    incoming = {k: v for k, v in payload.items() if k not in ("webhook_token", "notify")}
    stored = _deep_merge(existing, incoming)
    if "mode" in payload:
        mode = str(payload.get("mode") or "").lower()
    else:
        # 部分更新（如只改 retention）不能把已保存的 auto/manual 模式冲掉。
        mode_row = await db.get(SystemConfig, "rca_alert_mode")
        mode = str(
            (mode_row.value if mode_row is not None else "")
            or stored.get("mode")
            or "auto"
        ).lower()
    if mode not in ("auto", "manual"):
        mode = "auto"
    entries = {
        "rca_alert_policy": json.dumps(stored, ensure_ascii=False),
        "rca_alert_mode": mode,
    }
    if "webhook_token" in payload:
        entries["webhook_token"] = str(payload.get("webhook_token") or "")
    notify = payload.get("notify") or {}
    if isinstance(notify, dict):
        if "enabled" in notify:
            entries["alert_notify_enabled"] = "true" if notify.get("enabled") else "false"
        if "wecom_chat_id" in notify:
            entries["wecom_alert_chat_id"] = str(notify.get("wecom_chat_id") or "")

    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
        else:
            db.add(SystemConfig(key=key, value=value))
    await db.flush()
    return await get_policy(db)


# ═══════════════════════════════════════════════════════════════════════════════
# Multi-team webhook tokens (P2-13, no schema change)
# ═══════════════════════════════════════════════════════════════════════════════
#
# ``system_config.alert_webhook_tokens`` holds a JSON array; one entry per
# inbound integration:
#
#   [{"id": "a1b2c3d4e5f6", "token": "<secret>", "team_id": 2,
#     "name": "支付团队", "enabled": true, "created_at": "2026-10-17T..."}]
#
# Backward compatibility:
#   * key absent / empty array  → old behaviour: optional global
#     ``webhook_token`` is checked, everything lands in team 1;
#   * key configured            → a token is mandatory; the matched entry's
#     ``team_id`` is threaded through ``ingest_alert``.  The legacy global
#     token, when still configured, remains accepted and maps to team 1.
#
# No in-process cache is kept: the policy already reads DB per request, and
# skipping a cache means every write is effective immediately (no stale reads
# to invalidate).


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def mask_webhook_token(token: str) -> str:
    """Return a display-only mask that never leaks the full secret."""
    token = (token or "").strip()
    if not token:
        return ""
    if len(token) <= WEBHOOK_TOKEN_MASK_KEEP:
        return "…" + token[-2:] if len(token) > 2 else "…"
    return token[:WEBHOOK_TOKEN_MASK_KEEP] + "…"


def normalize_webhook_tokens(raw: Any) -> list[dict[str, Any]]:
    """Parse/repair the stored JSON into a canonical list of token entries."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        token = str(item.get("token") or "").strip()
        if not token:
            continue
        team_id = _clamp_int(item.get("team_id"), 1, 2_147_483_647, 1)
        name = str(item.get("name") or f"team-{team_id}").strip()[:100]
        enabled = _clamp_bool(item.get("enabled"), True)
        created_at = str(item.get("created_at") or "").strip() or _utc_iso()
        token_id = str(item.get("id") or "").strip()
        entry = {
            "id": token_id or secrets.token_hex(6),
            "token": token,
            "team_id": team_id,
            "name": name or f"team-{team_id}",
            "enabled": enabled,
            "created_at": created_at,
        }
        out.append(entry)
    return out


async def get_webhook_tokens(db: AsyncSession) -> list[dict[str, Any]]:
    """Load the configured webhook→team token bindings (may be empty)."""
    row = await db.get(SystemConfig, WEBHOOK_TOKENS_KEY)
    return normalize_webhook_tokens(row.value if row is not None else None)


async def save_webhook_tokens(
    db: AsyncSession, tokens: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Persist the canonical token list; returns the normalised list."""
    canonical = normalize_webhook_tokens(tokens)
    value = json.dumps(canonical, ensure_ascii=False)
    row = await db.get(SystemConfig, WEBHOOK_TOKENS_KEY)
    if row is not None:
        row.value = value
    else:
        db.add(SystemConfig(key=WEBHOOK_TOKENS_KEY, value=value))
    await db.flush()
    return canonical


class WebhookAuth(NamedTuple):
    """Result of authenticating one inbound webhook request."""

    authorized: bool
    team_id: int
    mode: str  # "multi" | "legacy" | "open"
    entry: dict[str, Any] | None = None


async def resolve_webhook_auth(
    db: AsyncSession, supplied_token: str,
) -> WebhookAuth:
    """Authenticate a webhook token and resolve its team.

    * no ``alert_webhook_tokens`` configured → legacy mode: honour the global
      ``webhook_token`` if set (team 1), otherwise accept openly (team 1);
    * configured → token must match an **enabled** entry (team = entry's
      ``team_id``); unknown/disabled → not authorized.  The legacy global
      token is still honoured as team 1 for a smooth migration.
    """
    supplied = (supplied_token or "").strip()
    policy = await get_policy(db)
    legacy = (policy.get("webhook_token") or "").strip()
    tokens = await get_webhook_tokens(db)

    if tokens:
        if supplied:
            for entry in tokens:
                if not entry.get("enabled", True):
                    continue
                if secrets.compare_digest(supplied, entry["token"]):
                    return WebhookAuth(True, int(entry["team_id"]), "multi", entry)
            if legacy and secrets.compare_digest(supplied, legacy):
                # 旧全局令牌继续可用，视为 team 1（向后兼容，便于灰度迁移）。
                return WebhookAuth(True, 1, "legacy", None)
        return WebhookAuth(False, 1, "multi", None)

    if legacy:
        if supplied and secrets.compare_digest(supplied, legacy):
            return WebhookAuth(True, 1, "legacy", None)
        return WebhookAuth(False, 1, "legacy", None)
    return WebhookAuth(True, 1, "open", None)


# ═══════════════════════════════════════════════════════════════════════════════
# Retention / scheduled purge (P2-8)
# ═══════════════════════════════════════════════════════════════════════════════


async def purge_expired_alerts(
    db: AsyncSession,
    *,
    team_id: int | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Delete inbox/trash alerts older than the configured retention.

    ``team_id=None`` purges every team (used by the periodic task); an int
    scopes the purge to one team (manual admin action).  ``retention.*_days``
    of ``0`` disables that category.  Commits before returning.
    """
    policy = policy or await get_policy(db)
    retention = policy.get("retention") or {}
    inbox_days = _clamp_int(
        retention.get("inbox_days"), 0, 3650, RETENTION_DEFAULT_INBOX_DAYS,
    )
    trash_days = _clamp_int(
        retention.get("trash_days"), 0, 3650, RETENTION_DEFAULT_TRASH_DAYS,
    )
    now = datetime.now(timezone.utc)
    result: dict[str, Any] = {
        "team_id": team_id,
        "inbox_days": inbox_days,
        "trash_days": trash_days,
        "deleted_inbox": 0,
        "deleted_trash": 0,
        "deleted_total": 0,
        "executed_at": now.isoformat(),
    }

    if inbox_days > 0:
        stmt = delete(Alert).where(
            Alert.status.in_(INBOX_STATUSES),
            Alert.created_at < now - timedelta(days=inbox_days),
        )
        if team_id is not None:
            stmt = stmt.where(Alert.team_id == team_id)
        res = await db.execute(stmt)
        result["deleted_inbox"] = int(res.rowcount or 0)

    if trash_days > 0:
        stmt = delete(Alert).where(
            Alert.status.in_(TRASH_STATUSES),
            Alert.created_at < now - timedelta(days=trash_days),
        )
        if team_id is not None:
            stmt = stmt.where(Alert.team_id == team_id)
        res = await db.execute(stmt)
        result["deleted_trash"] = int(res.rowcount or 0)

    result["deleted_total"] = result["deleted_inbox"] + result["deleted_trash"]
    await db.commit()
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Alert normalisation
# ═══════════════════════════════════════════════════════════════════════════════


def _s(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = value if isinstance(value, str) else str(value)
    if text.strip().lower() in ("null", "none", "undefined"):
        return default
    return text


def _present(value: Any) -> bool:
    """True when *value* is worth picking (not missing, ``null`` or empty)."""
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() not in ("", "null", "none", "undefined")
    return True


# ── Java ``Map.toString()`` parsing ─────────────────────────────────────────
#
# Tarsier pushes ``eventInfo`` as a *stringified* Java Map, e.g.::
#
#   {SEVERITY=2, SUMMARY=错误信息:TCCM记账失败|告警信息(简要): 告警名称: 批次查证记账告警,
#    告警联系人: 毕玉朋 , SERIAL=HW3224009787-2269}
#
# A naive ``text.split(",")`` destroys the SUMMARY value (it contains ASCII
# commas, ``:``, ``|``, Chinese punctuation and balanced parentheses), so the
# split is driven by a **next ``KEY=`` look-ahead**: a top-level ASCII comma
# only starts a new entry when the text right after it matches
# ``\s*[A-Za-z_$][\w.$-]*\s*=``; any other comma is part of the value and is
# preserved verbatim.  ``=`` splits at the *first* occurrence (values may
# contain ``=``), the outer ``{}`` is stripped, ``null``/empty values are kept
# as empty strings, and nested ``{...}`` groups / double quotes / escapes are
# respected.  If the braces turn out to be unbalanced (free-text value with a
# stray ``{``) the split is retried without brace tracking so one malformed
# value cannot swallow the rest of the map.

_JAVA_MAP_KEY_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_.$-]*$")
_JAVA_MAP_KEY_START_RE = re.compile(r"\s*([A-Za-z_$][A-Za-z0-9_.$-]{0,63})\s*=")

# Field keys that identify a mapping as an alert payload; used to decide whether
# a wrapper dict still has to be unwrapped.
_ALERT_FIELD_KEYS = frozenset({
    "SUMMARY", "SOURCESUMMARY", "SEVERITY", "SOURCESEVERITY", "SERIAL", "ID",
    "CINAME", "CIAPPLICATION", "CIID", "CITYPE", "LASTOCCURRENCE",
    "SOURCEEVENTID", "KPINAME", "SOURCENAME",
    "alertContent", "alertId", "alertLevel", "alertTime", "alertSource",
    "ciName", "ciApplication", "content", "severity", "message", "source",
})


def _split_java_map_parts(
    inner: str, *, track_braces: bool = True,
) -> tuple[list[str], bool]:
    """Split a Java map body on top-level commas (see module notes above)."""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_quote = False
    i, n = 0, len(inner)
    while i < n:
        ch = inner[i]
        if in_quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < n:
                buf.append(inner[i + 1])
                i += 2
                continue
            if ch == '"':
                in_quote = False
        elif ch == '"':
            in_quote = True
            buf.append(ch)
        elif track_braces and ch == "{":
            depth += 1
            buf.append(ch)
        elif track_braces and ch == "}":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == "," and depth == 0:
            if _JAVA_MAP_KEY_START_RE.match(inner, i + 1):
                parts.append("".join(buf))
                buf = []
            else:
                # Comma inside a free-text value (SUMMARY 等) — keep it.
                buf.append(ch)
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts, depth == 0 and not in_quote


def _parse_java_map_string(text: str) -> dict[str, str] | None:
    """Parse a Java ``Map.toString()`` value such as ``{SEVERITY=2, CINAME=x}``."""
    if not isinstance(text, str):
        return None
    t = text.strip()
    if not (t.startswith("{") and t.endswith("}") and "=" in t):
        return None
    inner = t[1:-1]
    parts, balanced = _split_java_map_parts(inner)
    if not balanced:
        parts, _ = _split_java_map_parts(inner, track_braces=False)

    result: dict[str, str] = {}
    last_key: str | None = None
    for part in parts:
        part = part.strip()
        if not part:
            continue
        key, sep, value = part.partition("=")
        key = key.strip()
        if sep and _JAVA_MAP_KEY_RE.fullmatch(key):
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            result[key] = value
            last_key = key
        elif last_key is not None:
            # Heuristic misfire: a fragment without ``KEY=`` must not be
            # dropped, so append it back to the previous value.
            previous = result.get(last_key) or ""
            result[last_key] = f"{previous}, {part}" if previous else part
    return result or None


def _parse_mapping_string(text: str) -> dict[str, Any] | None:
    """Parse a stringified mapping: Java ``Map.toString()`` or a JSON object."""
    if not isinstance(text, str):
        return None
    parsed = _parse_java_map_string(text)
    if parsed:
        return parsed
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            value = json.loads(stripped)
        except (TypeError, ValueError):
            return None
        if isinstance(value, dict):
            return value
    return None


def parse_alert_time(value: Any) -> datetime | None:
    """Parse an alert timestamp into an aware datetime (defaults to +08:00)."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=CST)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            ts = float(value)
            if ts > 1e12:  # milliseconds
                ts /= 1000.0
            return datetime.fromtimestamp(ts, tz=CST)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value or "").strip()
    if not text:
        return None
    if text[:10].isdigit():
        try:
            return datetime.fromtimestamp(int(float(text[:10])), tz=CST)
        except (OverflowError, OSError, ValueError):
            return None
    iso = text.replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S"):
        try:
            dt = datetime.strptime(iso[: len(datetime.now().strftime(fmt)) + 4], fmt)
        except ValueError:
            try:
                dt = datetime.strptime(iso, fmt)
            except ValueError:
                continue
        if "+" in text or text.lower().endswith("z"):
            return dt.replace(tzinfo=timezone.utc)
        return dt.replace(tzinfo=CST)
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=CST)
    except ValueError:
        return None


def normalize_alert(raw: Any) -> dict[str, Any] | None:
    """Map a Tarsier / Tarsier-multi-source / Zabbix alert to our internal schema."""
    if isinstance(raw, list):
        # Single-element arrays come from monitoring systems that always push a
        # list; larger batches are ingested one-by-one by ``/webhook``.
        if len(raw) != 1:
            return None
        raw = raw[0]

    event_info_text: str | None = None

    if isinstance(raw, str):
        raw = _parse_mapping_string(raw)
    if not isinstance(raw, dict):
        return None

    # ``eventInfo`` may be a stringified Java Map (Tarsier), a JSON object
    # string, or an already-parsed dict (legacy / proxy-normalised payloads).
    for key in ("eventInfo", "eventinfo", "event_info"):
        if key not in raw:
            continue
        value = raw[key]
        if isinstance(value, dict):
            raw = value
            break
        if isinstance(value, str):
            parsed = _parse_mapping_string(value)
            if not parsed:
                # eventInfo 存在但无法解析成映射：保持旧的拒绝语义。
                return None
            event_info_text = value.strip()
            raw = parsed
            break
    if not isinstance(raw, dict):
        return None

    # Nested Java-map values (some Tarsier push formats wrap the payload).  Only
    # unwrap when the mapping does not already look like an alert, otherwise a
    # legitimately nested value could replace the payload.
    if not (_ALERT_FIELD_KEYS & set(raw)):
        for value in list(raw.values()):
            if isinstance(value, str) and value.strip().startswith("{"):
                parsed = _parse_mapping_string(value)
                if parsed:
                    raw = parsed
                    break

    def pick(*keys: str) -> Any:
        for key in keys:
            if key in raw and _present(raw[key]):
                return raw[key]
        return None

    ip = _s(pick("SOURCECINAME", "sourceCIName", "host_ip", "hostIp", "ciIP",
                 "ci_ip", "IP", "SOURCEIP", "sourceIp"))
    # ci_name ← CINAME，回退 SERVERNAME（最后兜底 source，见下方 return）。
    ci_name = _s(pick("ciName", "ci_name", "CINAME", "ciname", "SERVERNAME",
                      "servername", "hostname", "HOSTNAME"))
    # ci_application ← CIAPPLICATION，空则 CICATEGORYNAME（应用监控默认丰富 等）。
    app = _s(pick("ciApplication", "ci_application", "CIAPPLICATION",
                  "ciapplication", "CICATEGORYNAME", "cicategoryname",
                  "CICATEGORYID", "application", "service"))
    # content ← SUMMARY，空则 SOURCESUMMARY。
    content = _s(pick("alertContent", "alert_content", "SUMMARY", "summary",
                      "SOURCESUMMARY", "sourceSummary", "alertMessage",
                      "message", "title"))
    # severity ← SEVERITY（数字 1-5），回退 SOURCESEVERITY（如 ``2_2``）。
    severity = pick("alertLevel", "alert_level", "SEVERITY", "severity",
                    "SEVERITY_CODE", "severityCode", "SOURCESEVERITY",
                    "sourceseverity", "priority") or "normal"
    # alertTime ← LASTOCCURRENCE（ISO-8601）。
    alert_time_raw = pick("alertTime", "alert_time", "LASTOCCURRENCE",
                          "lastOccurrence", "FIRSTOCCURRENCE", "currentTime",
                          "timestamp")
    alert_time = parse_alert_time(alert_time_raw) or datetime.now(CST)
    # alertId ← SERIAL，回退 ID / DUPLICATESERIAL，空则 SOURCEEVENTID。
    alert_uid = _s(pick("alertId", "alert_id", "SERIAL", "ID",
                        "DUPLICATESERIAL", "IDENTIFIER", "SOURCEEVENTID"))
    # source ← SOURCENAME。
    source = _s(pick("alertSource", "alert_source", "SOURCENAME", "sourceName",
                     "SOURCEID", "sourceId", "source"), "unknown")
    # metric ← KPINAME。
    metric = _s(pick("metric", "KPINAME", "kpiname", "SOURCEALERTKEY",
                     "sourceAlertKey", "KPIINSTANCE"))
    ci_id = _s(pick("ciCode", "ci_code", "CIID", "ciid", "CIPRIMARYKEY",
                    "ciPrimaryKey"))
    # ci_type ← CITYPE。
    ci_type = _s(pick("ciType", "ci_type", "CITYPE", "citype",
                      "CICATEGORYNAME"))

    # raw 保留原始报文：解析后的映射 + 原始 eventInfo 字符串（截断），便于排障。
    raw_payload: dict[str, Any] = dict(raw)
    if event_info_text:
        raw_payload.setdefault("_eventInfo", event_info_text[:4000])

    return {
        "ip": ip.strip(),
        "ci_name": ci_name.strip() or (source if source not in ("", "unknown") else ""),
        "ci_application": app.strip(),
        "ci_id": ci_id.strip(),
        "content": content.strip(),
        "severity": severity,
        "alert_time": alert_time,
        "alert_uid": alert_uid.strip() or f"auto-{uuid.uuid4().hex[:12]}",
        "source": source.strip() or "unknown",
        "metric": metric.strip(),
        "ci_type": ci_type.strip(),
        "raw": raw_payload,
    }


def classify_alert(normalized: dict[str, Any]) -> str:
    """Classify the failure mode from alert text (same taxonomy as source)."""
    content = (normalized.get("content") or "").lower()
    metric = (normalized.get("metric") or "").lower()
    hay = content + " " + metric

    perf_keywords = [
        "内存", "cpu", "disk", "磁盘", "内存使用率", "cpu使用率", "memused", "memusedpct",
        "mem", "cpuused", "diskused", "耗时", "延迟", "响应", "response", "timeout",
        "超时", "latency", "throughput", "吞吐", "慢查询", "slow query", "io", "iowait",
    ]
    error_keywords = [
        "错误率", "error", "5xx", "失败", "异常", "fail", "exception", "error_spike", "交易失败",
    ]
    hang_keywords = [
        "hang", "oom", "outofmemory", "线程池", "deadlock", "探活", "health check",
        "full gc", "jvm",
    ]
    network_keywords = [
        "连接", "connect", "dns", "ssl", "防火墙", "网络", "connection refused",
        "timeout", "不可达",
    ]
    for keywords, label in (
        (perf_keywords, "performance_degradation"),
        (error_keywords, "error_spike"),
        (hang_keywords, "service_hang"),
        (network_keywords, "connectivity_loss"),
    ):
        if any(k in hay for k in keywords):
            return label
    return "unknown"


def severity_level(severity: Any) -> int:
    """Map a raw severity to the Tarsier 1-5 scale (1 = most severe)."""
    if isinstance(severity, (int, float)) and not isinstance(severity, bool):
        n = float(severity)
        if n <= 1:
            return 1
        if n <= 2:
            return 2
        if n <= 3:
            return 3
        if n <= 4:
            return 4
        return 5
    text = str(severity or "").strip().lower()
    if not text:
        return 4
    if text[-1] in "12345" and not text.isdigit():
        return max(1, min(5, int(text[-1])))
    mapping = {
        "1": 1, "紧急": 1, "严重": 1, "critical": 1, "fatal": 1, "p1": 1, "p0": 1,
        "2": 2, "重要": 2, "major": 2, "error": 2, "p2": 2,
        "3": 3, "一般": 3, "minor": 3, "p3": 3,
        "4": 4, "告警": 4, "warn": 4, "warning": 4, "p4": 4,
        "5": 5, "提示": 5, "info": 5, "notice": 5, "p5": 5,
    }
    return mapping.get(text, 4)


SEVERITY_LABELS = {1: "严重", 2: "重要", 3: "一般", 4: "告警", 5: "提示"}


def severity_label(level: int) -> str:
    return SEVERITY_LABELS.get(level, "未知")


def dedup_key(normalized: dict[str, Any]) -> str:
    aid = normalized.get("alert_uid")
    if aid:
        return f"rid:{aid}"[:512]
    app = normalized.get("ci_application") or normalized.get("ci_name") or ""
    return f"rid:{normalized.get('ip', '')}:{app}:{normalized.get('metric', '')}"[:512]


# ═══════════════════════════════════════════════════════════════════════════════
# Trigger policy
# ═══════════════════════════════════════════════════════════════════════════════


def _match_critical_component(normalized: dict[str, Any], policy: dict[str, Any]) -> str | None:
    hay = " ".join([
        normalized.get("ci_application") or "",
        normalized.get("ci_name") or "",
        normalized.get("content") or "",
    ]).lower()
    for comp in policy["trigger"].get("critical_components") or []:
        key = str(comp).strip().lower()
        if key and key in hay:
            return str(comp).strip()
    return None


def _match_high_risk(normalized: dict[str, Any], policy: dict[str, Any]) -> list[str]:
    hay = " ".join([
        normalized.get("content") or "",
        normalized.get("metric") or "",
    ]).lower()
    return [
        str(kw).strip()
        for kw in policy["trigger"].get("high_risk_keywords") or []
        if str(kw).strip() and str(kw).strip().lower() in hay
    ]


# ── Path C: ClickHouse business-volume fluctuation ──────────────────────────

_PATH_C_TIME_KEYS = (
    "minute", "ts", "time", "timestamp", "bucket", "start_time",
    "datetime", "window_start", "date",
)
_PATH_C_VALUE_KEYS = (
    "volume", "value", "count", "cnt", "total", "sum", "amount",
    "txn_count", "transaction_count",
)
_PATH_C_CURRENT_KEYS = (
    "current", "window_value", "window", "current_value", "now", "last",
)
_PATH_C_BASELINE_KEYS = (
    "baseline", "baseline_value", "base", "baseline_avg", "previous",
    "historical",
)


def _warn_path_c(key: str, message: str, *args: Any) -> None:
    """Rate-limit Path C warnings to one per cache window per key."""
    now = time.monotonic()
    last = _PATH_C_WARN_TS.get(key)
    if last is not None and now - last < PATH_C_CACHE_TTL_SECONDS:
        return
    _PATH_C_WARN_TS[key] = now
    logger.warning(message, *args)


def _coerce_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _render_path_c_sql(
    template: str,
    *,
    now: datetime,
    window_minutes: int,
    baseline_minutes: int,
) -> tuple[str, datetime, datetime, datetime]:
    """Fill time placeholders and return ``(sql, window_start, window_end, baseline_start)``."""
    fmt = "%Y-%m-%d %H:%M:%S"
    window_end = now
    window_start = window_end - timedelta(minutes=window_minutes)
    baseline_start = window_start - timedelta(minutes=baseline_minutes)
    values = {
        "window_start": window_start.strftime(fmt),
        "window_end": window_end.strftime(fmt),
        "baseline_start": baseline_start.strftime(fmt),
        "baseline_end": window_start.strftime(fmt),
        "anchor": window_end.strftime(fmt),
        "window_minutes": str(window_minutes),
        "baseline_minutes": str(baseline_minutes),
    }
    sql = template
    for key, value in values.items():
        sql = sql.replace("{" + key + "}", value)
    return sql, window_start, window_end, baseline_start


def _path_c_skeleton(cfg: dict[str, Any], datasource_id: int | None) -> dict[str, Any]:
    return {
        "enabled": True,
        "datasource_id": datasource_id,
        "window_minutes": _clamp_int(
            cfg.get("window_minutes"), 1, 1440, PATH_C_DEFAULT_WINDOW_MINUTES,
        ),
        "baseline_minutes": _clamp_int(
            cfg.get("baseline_minutes"), 1, 10080, PATH_C_DEFAULT_BASELINE_MINUTES,
        ),
        "drop_pct_threshold": _clamp_float(
            cfg.get("drop_pct"), 0.0, 100.0, PATH_C_DEFAULT_DROP_PCT,
        ),
        "metric": str(cfg.get("metric") or PATH_C_DEFAULT_METRIC),
        "available": False,
        "hit": False,
        "window_value": None,
        "baseline_value": None,
        "drop_pct": None,
        "evidence": "",
        "error": None,
        "cached": False,
        "evaluated_at": _utc_iso(),
    }


def _path_c_cache_get(datasource_id: int) -> dict[str, Any] | None:
    entry = _PATH_C_CACHE.get(datasource_id)
    if entry is None:
        return None
    expires_at, result = entry
    if time.monotonic() >= expires_at:
        _PATH_C_CACHE.pop(datasource_id, None)
        return None
    cached = dict(result)
    cached["cached"] = True
    return cached


def _path_c_cache_put(datasource_id: int, result: dict[str, Any]) -> None:
    if (
        datasource_id not in _PATH_C_CACHE
        and len(_PATH_C_CACHE) >= PATH_C_CACHE_MAX_ENTRIES
    ):
        _PATH_C_CACHE.pop(next(iter(_PATH_C_CACHE)), None)
    _PATH_C_CACHE[datasource_id] = (
        time.monotonic() + PATH_C_CACHE_TTL_SECONDS,
        dict(result),
    )


def _path_c_aggregate_values(
    rows: list[dict[str, Any]],
) -> tuple[float, float] | None:
    """Support an override SQL that returns one row with current+baseline."""
    for row in rows:
        if not isinstance(row, dict):
            continue
        lower = {str(key).lower(): value for key, value in row.items()}
        current_raw = next(
            (lower[key] for key in _PATH_C_CURRENT_KEYS if key in lower), None,
        )
        baseline_raw = next(
            (lower[key] for key in _PATH_C_BASELINE_KEYS if key in lower), None,
        )
        current = _coerce_number(current_raw)
        baseline = _coerce_number(baseline_raw)
        if current is not None and baseline is not None:
            return current, baseline
    return None


def _path_c_buckets(
    rows: list[dict[str, Any]],
) -> list[tuple[datetime, float]] | None:
    """Parse per-minute rows (time column + numeric volume column)."""
    buckets: list[tuple[datetime, float]] = []
    for row in rows:
        lower = {str(key).lower(): value for key, value in row.items()}
        time_raw = next(
            (lower[key] for key in _PATH_C_TIME_KEYS if key in lower), None,
        )
        value_raw = next(
            (lower[key] for key in _PATH_C_VALUE_KEYS if key in lower), None,
        )
        if time_raw is None or value_raw is None:
            return None
        timestamp = parse_alert_time(time_raw)
        value = _coerce_number(value_raw)
        if timestamp is None or value is None:
            return None
        buckets.append((timestamp, value))
    return buckets


def _analyse_path_c_rows(
    rows: Any,
    *,
    window_start: datetime,
    window_end: datetime,
    baseline_start: datetime,
    window_minutes: int,
    baseline_minutes: int,
) -> tuple[float | None, float | None, str | None]:
    """Return ``(current, baseline_scaled_to_window, error)``."""
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        rows = []
    dict_rows = [row for row in rows if isinstance(row, dict)]
    if not dict_rows:
        return None, None, "查询结果为空"

    aggregate = _path_c_aggregate_values(dict_rows)
    if aggregate is not None:
        # Override contract: the two values already refer to comparable windows.
        return aggregate[0], aggregate[1], None

    buckets = _path_c_buckets(dict_rows)
    if buckets is None:
        return (
            None, None,
            "查询结果缺少可识别的时间列/值列（需 minute/time+volume/count）",
        )
    window_values = [
        value for timestamp, value in buckets
        if window_start <= timestamp < window_end
    ]
    baseline_values = [
        value for timestamp, value in buckets
        if baseline_start <= timestamp < window_start
    ]
    if not window_values:
        return None, None, "最近窗口无数据"
    if not baseline_values:
        return None, None, "基线窗口无数据"
    current = float(sum(window_values))
    # Normalise the baseline total to the window length, otherwise a 60-minute
    # baseline would look constant compared with a 30-minute window.
    baseline = (
        float(sum(baseline_values)) * float(window_minutes) / float(baseline_minutes)
    )
    return current, baseline, None


async def _load_path_c_source(
    db: AsyncSession | None, datasource_id: int,
) -> DataSource | None:
    if db is None:
        return None
    result = await db.execute(
        select(DataSource)
        .where(
            DataSource.id == datasource_id,
            DataSource.type == "clickhouse",
            DataSource.enabled.is_(True),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _query_path_c(
    db: AsyncSession | None,
    cfg: dict[str, Any],
    datasource_id: int,
) -> dict[str, Any]:
    """Run the Path C query, never raising; failures return ``hit=False``."""
    result = _path_c_skeleton(cfg, datasource_id)
    metric = str(result["metric"])
    template = str(cfg.get("sql") or "").strip() or PATH_C_DEFAULT_SQL
    if not _PATH_C_METRIC_RE.fullmatch(metric):
        # ``metric`` only matters when it is interpolated into the SQL.  A full
        # sql override that does not use ``{metric}`` is still usable.
        if template == PATH_C_DEFAULT_SQL or "{metric}" in template:
            result["error"] = f"metric 非法（{metric[:60]}），未执行查询"
            result["evidence"] = result["error"]
            _warn_path_c(
                f"ds:{datasource_id}",
                "Path C 配置无效（datasource_id={}）：{}",
                datasource_id,
                result["error"],
            )
            return result
        metric = PATH_C_DEFAULT_METRIC
        result["metric"] = metric

    now = datetime.now(CST)
    sql, window_start, window_end, baseline_start = _render_path_c_sql(
        template.replace("{metric}", metric),
        now=now,
        window_minutes=int(result["window_minutes"]),
        baseline_minutes=int(result["baseline_minutes"]),
    )

    try:
        source = await _load_path_c_source(db, datasource_id)
        if source is None:
            result["error"] = f"未找到启用的 ClickHouse 数据源 id={datasource_id}"
        else:
            adapter = get_adapter("clickhouse", source.config or {})
            execute_readonly = getattr(adapter, "execute_readonly", None)
            execute_query = getattr(adapter, "execute_query", None)
            if callable(execute_readonly):
                query_result = await asyncio.wait_for(
                    execute_readonly(sql, timeout_seconds=PATH_C_TIMEOUT_SECONDS),
                    timeout=PATH_C_TIMEOUT_SECONDS,
                )
            elif callable(execute_query):
                # Fallback for adapter shims that only implement the generic
                # method: the SQL is still validated before execution.
                safe_sql = validate_readonly_sql(sql)
                query_result = await asyncio.wait_for(
                    execute_query(safe_sql),
                    timeout=PATH_C_TIMEOUT_SECONDS,
                )
            else:
                result["error"] = "ClickHouse 适配器不支持只读查询"
                query_result = None
            if query_result is not None:
                rows = getattr(query_result, "rows", None)
                if rows is None and isinstance(query_result, (list, dict)):
                    rows = query_result
                current, baseline, error = _analyse_path_c_rows(
                    rows,
                    window_start=window_start,
                    window_end=window_end,
                    baseline_start=baseline_start,
                    window_minutes=int(result["window_minutes"]),
                    baseline_minutes=int(result["baseline_minutes"]),
                )
                if error is not None:
                    result["error"] = error
                elif current is None or baseline is None:
                    result["error"] = "查询结果无法计算窗口值/基线"
                elif baseline <= 0:
                    result["window_value"] = current
                    result["baseline_value"] = baseline
                    result["error"] = (
                        f"基线为 0（窗口值 {current:.0f}），无法计算跌幅"
                    )
                else:
                    drop = (baseline - current) / baseline * 100.0
                    threshold = float(result["drop_pct_threshold"])
                    hit = drop >= threshold
                    label = (
                        "交易量" if metric == PATH_C_DEFAULT_METRIC
                        else f"交易量({metric})"
                    )
                    result.update({
                        "available": True,
                        "hit": hit,
                        "window_value": current,
                        "baseline_value": baseline,
                        "drop_pct": round(drop, 1),
                    })
                    if hit:
                        result["evidence"] = (
                            f"{label}骤降 {drop:.1f}%（窗口值 {current:.0f} / "
                            f"基线 {baseline:.0f} / 跌幅 {drop:.1f}%，"
                            f"阈值 {threshold:g}%）"
                        )
                    else:
                        result["evidence"] = (
                            f"{label}未达阈值（窗口值 {current:.0f} / "
                            f"基线 {baseline:.0f} / 跌幅 {drop:.1f}%，"
                            f"阈值 {threshold:g}%）"
                        )
    except asyncio.TimeoutError:
        result["error"] = f"查询超时（>{PATH_C_TIMEOUT_SECONDS:g}s）"
    except Exception as exc:  # noqa: BLE001 — Path C must never break ingestion
        result["error"] = f"查询失败: {type(exc).__name__}: {exc}"[:300]

    if result["error"]:
        result["evidence"] = result["error"]
        _warn_path_c(
            f"ds:{datasource_id}",
            "Path C 不可用，按不命中处理（datasource_id={}）：{}",
            datasource_id,
            result["error"],
        )
    return result


async def _evaluate_path_c(
    policy: dict[str, Any],
    db: AsyncSession | None,
) -> dict[str, Any] | None:
    """Evaluate Path C when enabled; always returns a result or ``None``."""
    trigger_cfg = policy.get("trigger") or {}
    paths = (policy.get("multi") or {}).get("trigger_paths") or {}
    cfg = trigger_cfg.get("path_c")
    cfg = cfg if isinstance(cfg, dict) else {}
    # ``multi.trigger_paths.C`` is kept as a legacy/master switch so the
    # existing UI checkbox still works; either switch enables Path C.
    enabled = _clamp_bool(cfg.get("enabled"), False) or _clamp_bool(paths.get("C"), False)
    if not enabled:
        return None

    datasource_id = _clamp_int(cfg.get("datasource_id"), 0, 2_147_483_647, 0)
    result = _path_c_skeleton(cfg, datasource_id or None)
    result["enabled"] = True
    if not datasource_id:
        result["error"] = "未配置 datasource_id"
        result["evidence"] = result["error"]
        _warn_path_c("path_c:no_datasource", "Path C 已启用但未配置 datasource_id，按不命中处理")
        return result

    cached = _path_c_cache_get(datasource_id)
    if cached is not None:
        cached["enabled"] = True
        return cached

    result = await _query_path_c(db, cfg, datasource_id)
    _path_c_cache_put(datasource_id, result)
    return result


async def decide_trigger(
    normalized: dict[str, Any],
    level: int,
    policy: dict[str, Any],
    db: AsyncSession | None = None,
) -> tuple[bool, str, dict[str, Any]]:
    """Multi-signal trigger decision (async; awaits Path C's ClickHouse query).

    Returns ``(should_trigger, human_reason, detail)``. ``detail`` is persisted so
    the UI can explain *why* an alert was filtered or triggered.  Path C is only
    evaluated when severity / A / B all miss, and any Path C failure degrades to
    ``hit=False`` (never blocks the ingestion path).  Passing ``db=None`` keeps
    the A/B/severity decision intact and degrades Path C to a non-hit.
    """
    trigger_cfg = policy["trigger"]
    paths = (policy.get("multi") or {}).get("trigger_paths") or {}
    severity_max = int(trigger_cfg.get("severity_max", 2))
    severity_hit = bool(trigger_cfg.get("severity_trigger", True)) and level <= severity_max
    component = _match_critical_component(normalized, policy)
    keywords = _match_high_risk(normalized, policy)

    path_a = bool(paths.get("A", True)) and bool(component) and level <= severity_max
    path_b = bool(paths.get("B", True)) and bool(keywords)

    # C: only worth querying when nothing else already triggered.
    path_c_result: dict[str, Any] | None = None
    path_c = False
    if not (severity_hit or path_a or path_b):
        try:
            path_c_result = await _evaluate_path_c(policy, db)
        except Exception as exc:  # noqa: BLE001 — defensive: never break ingestion
            logger.warning("Path C 评估异常，按不命中处理：{}", exc)
            path_c_result = None
        path_c = bool(path_c_result and path_c_result.get("hit"))

    triggered = severity_hit or path_a or path_b or path_c
    matched: list[str] = []
    if severity_hit:
        matched.append(f"严重级别{level}({severity_label(level)})")
    if path_a:
        matched.append(f"关键组件:{component}")
    if path_b:
        matched.append("高危签名:" + "+".join(keywords[:3]))
    if path_c and path_c_result is not None:
        matched.append("交易量波动:" + str(path_c_result.get("evidence") or "命中"))

    detail: dict[str, Any] = {
        "triggered": triggered,
        "severity_level": level,
        "severity_label": severity_label(level),
        "severity_hit": severity_hit,
        "component": component,
        "keywords": keywords,
        "matched": matched,
        "paths": {"A": path_a, "B": path_b, "C": path_c},
    }
    if path_c_result is not None:
        detail["path_c"] = path_c_result
    if triggered:
        return True, "multi:" + "+".join(matched), detail
    reason = (f"未命中触发信号：级别={level}({severity_label(level)})"
              f"{'，关键组件=' + component if component else '，非关键组件'}"
              f"{'，高危签名=' + ','.join(keywords[:3]) if keywords else '，无高危签名'}")
    if path_c_result is not None and path_c_result.get("evidence"):
        reason += f"，交易量波动={path_c_result['evidence']}"
    return False, reason, detail


# ═══════════════════════════════════════════════════════════════════════════════
# Ingestion orchestration
# ═══════════════════════════════════════════════════════════════════════════════


def _trim_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep the raw payload bounded so a chatty monitoring system cannot bloat DB rows."""
    try:
        if len(json.dumps(raw, ensure_ascii=False)) <= 32000:
            return raw
    except (TypeError, ValueError):
        return {"_unserializable": True}
    out: dict[str, Any] = {}
    for i, (key, value) in enumerate(raw.items()):
        if i >= 60:
            break
        if isinstance(value, str) and len(value) > 800:
            out[key] = value[:800] + "…"
        else:
            out[key] = value
    out["_raw_truncated"] = True
    return out


def _service_name(normalized: dict[str, Any]) -> str:
    return (normalized.get("ci_application") or normalized.get("ci_name")
            or normalized.get("source") or "unknown")[:255]


async def ingest_alert(
    db: AsyncSession,
    raw: Any,
    *,
    team_id: int = 1,
    source_ip: str = "",
    actor: str = "webhook",
) -> dict[str, Any]:
    """Full webhook ingestion pipeline.

    ``team_id`` is the tenant the alert belongs to (resolved from the webhook
    token for public ingestion); it scopes de-duplication, rule matching,
    coalescing and the created :class:`RcaSession`.

    The caller is responsible for scheduling ``run_rca_session`` when the
    returned dict contains ``run_session_id`` (after this coroutine commits).
    """
    try:
        team_id = max(1, int(team_id or 1))
    except (TypeError, ValueError):
        team_id = 1

    normalized = normalize_alert(raw)
    if normalized is None:
        return {"status": "error", "message": "无法解析告警格式"}

    policy = await get_policy(db)
    window = int(policy["dedup"]["window_seconds"])
    key = dedup_key(normalized)

    if window > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window)
        existing = await db.execute(
            select(Alert)
            .where(Alert.dedup_key == key, Alert.team_id == team_id,
                   Alert.created_at >= cutoff,
                   Alert.status != "dismissed")
            .order_by(Alert.created_at.desc())
            .limit(1)
        )
        dup = existing.scalar_one_or_none()
        if dup:
            return {
                "status": "duplicate",
                "alert_id": dup.alert_uid,
                "alert_row_id": dup.id,
                "message": f"重复告警（{window}s 去重窗口内），已忽略",
            }

    level = severity_level(normalized["severity"])
    alert_type = classify_alert(normalized)
    service = _service_name(normalized)

    alert = Alert(
        team_id=team_id,
        alert_uid=normalized["alert_uid"],
        dedup_key=key,
        source=normalized["source"][:100],
        ip=normalized["ip"][:100],
        ci_name=normalized["ci_name"][:255],
        ci_application=normalized["ci_application"][:255],
        ci_id=normalized["ci_id"][:255],
        content=normalized["content"],
        severity=str(normalized["severity"])[:50],
        severity_level=level,
        alert_type=alert_type,
        metric=normalized["metric"],
        alert_time=normalized["alert_time"],
        raw_payload=_trim_raw(normalized["raw"]),
        status="pending",
    )
    db.add(alert)
    await db.flush()

    # ── Manual mode: everything waits in the inbox ────────────────────────
    if policy["mode"] == "manual":
        alert.trigger_reason = "manual_mode"
        await db.flush()
        return {
            "status": "inboxed",
            "alert_id": normalized["alert_uid"],
            "alert_row_id": alert.id,
            "severity_level": level,
            "severity_label": severity_label(level),
            "alert_type": alert_type,
            "message": "人工触发模式：告警已入收件箱，可在告警中心勾选触发 RCA",
        }

    # ── Configured AlertRule (highest priority, evaluated before A/B/C) ───
    # A matching, enabled rule triggers RCA even when the global policy would
    # have ignored the alert (e.g. severity above ``severity_max``).  Manual
    # mode returned above, so its "everything waits in the inbox" semantics
    # are preserved.  An engine failure must never break ingestion: it is
    # logged and the alert falls back to the global policy.
    rule_match: RuleMatch | None = None
    try:
        rule_match = await match_alert_rule(db, team_id, normalized, level)
    except Exception as exc:
        logger.warning(
            "AlertRule 匹配失败，回落全局策略（team={} alert={}）：{}",
            team_id,
            normalized.get("alert_uid"),
            exc,
        )

    if rule_match is not None:
        triggered = True
        reason = rule_match.trigger_reason
        detail = {
            "triggered": True,
            "severity_level": level,
            "severity_label": severity_label(level),
            "severity_hit": False,
            "matched": [f"命中规则 {rule_match.rule_id}:{rule_match.rule_name}"],
            "paths": {"A": False, "B": False, "C": False, "rule": True},
            "rule": rule_match.to_detail(),
        }
    else:
        triggered, reason, detail = await decide_trigger(
            normalized, level, policy, db,
        )
    if not triggered:
        alert.status = "filtered"
        alert.trigger_reason = reason
        await db.flush()
        return {
            "status": "filtered",
            "alert_id": normalized["alert_uid"],
            "alert_row_id": alert.id,
            "severity_level": level,
            "severity_label": severity_label(level),
            "alert_type": alert_type,
            "detail": detail,
            "message": f"未命中触发信号，告警已进入垃圾箱：{reason}",
        }

    # ── Application-level coalescing: attach to an active RCA ─────────────
    coalesce_window = int(policy["trigger"]["app_coalesce_window"])
    if rule_match is not None:
        coalesce_window = _action_override_int(
            rule_match.actions, "coalesce_window", coalesce_window, 0, 86400
        )
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=coalesce_window)
    active = await db.execute(
        select(RcaSession)
        .where(
            RcaSession.team_id == team_id,
            RcaSession.service_name == service,
            RcaSession.status.in_([RcaStatus.QUEUED, RcaStatus.RUNNING]),
            RcaSession.created_at >= cutoff,
        )
        .order_by(RcaSession.created_at.desc())
        .limit(1)
    )
    active_session = active.scalar_one_or_none()
    if active_session:
        alert.status = "coalesced"
        alert.rca_session_id = active_session.id
        alert.trigger_reason = f"app_coalesce({reason})"
        active_session.alert_count = (active_session.alert_count or 1) + 1
        if normalized["alert_time"] and (
            active_session.time_window_end is None
            or normalized["alert_time"] > active_session.time_window_end
        ):
            active_session.time_window_end = normalized["alert_time"]
        rule_note = (
            f"；命中规则 {rule_match.rule_id}:{rule_match.rule_name}（{rule_match.summary}）"
            if rule_match is not None
            else ""
        )
        event_metadata: dict[str, Any] = {
            "alert_id": normalized["alert_uid"],
            "service": service,
        }
        if rule_match is not None:
            event_metadata["rule_id"] = rule_match.rule_id
        db.add(CollaborationEvent(
            rca_session_id=active_session.id,
            event_type=CollaborationEventType.AGENT_PROGRESS,
            content=(f"并入同应用告警 {normalized['alert_uid']}"
                     f"（{severity_label(level)} / {alert_type}），累计 "
                     f"{active_session.alert_count} 条{rule_note}"),
            metadata_=event_metadata,
        ))
        await db.flush()
        await db.commit()
        return {
            "status": "coalesced",
            "alert_id": normalized["alert_uid"],
            "alert_row_id": alert.id,
            "rca_id": f"rca-{active_session.id}",
            "rca_session_id": active_session.id,
            "severity_level": level,
            "severity_label": severity_label(level),
            "alert_type": alert_type,
            "trigger_reason": reason,
            "matched_rule_id": rule_match.rule_id if rule_match else None,
            "matched_rule_name": rule_match.rule_name if rule_match else None,
            "message": f"已并入同应用进行中的 RCA #{active_session.id}（未另起会话）",
        }

    # ── New RCA session ───────────────────────────────────────────────────
    offset = int(policy["trigger"]["analysis_start_offset_minutes"])
    if rule_match is not None:
        offset = _action_override_int(
            rule_match.actions, "analysis_offset_minutes", offset, 0, 240
        )
    start_dt = normalized["alert_time"] - timedelta(minutes=offset)
    session = RcaSession(
        team_id=team_id,
        rule_id=rule_match.rule_id if rule_match is not None else None,
        trigger_type=RcaTriggerType.PASSIVE,
        status=RcaStatus.QUEUED,
        service_name=service,
        alert_count=1,
        trigger_reason=reason,
        time_window_start=start_dt,
        time_window_end=normalized["alert_time"],
    )
    db.add(session)
    await db.flush()

    alert.status = "triggered"
    alert.rca_session_id = session.id
    alert.trigger_reason = reason
    event_metadata: dict[str, Any] = {
        "alert_id": normalized["alert_uid"],
        "source_ip": source_ip,
    }
    if rule_match is not None:
        event_metadata["rule_id"] = rule_match.rule_id
        event_content = (
            f"命中规则 {rule_match.rule_id}:{rule_match.rule_name}"
            f"（{rule_match.summary}）→ 告警触发 RCA：{normalized['alert_uid']} "
            f"（{severity_label(level)} / {alert_type} / {service}）"
        )
        logger.info(
            "AlertRule 触发 RCA：rule={} ({!r}) alert={} session={}",
            rule_match.rule_id,
            rule_match.rule_name,
            normalized["alert_uid"],
            session.id,
        )
    else:
        event_content = (
            f"告警触发 RCA：{normalized['alert_uid']} "
            f"（{severity_label(level)} / {alert_type} / {service}）— {reason}"
        )
    db.add(CollaborationEvent(
        rca_session_id=session.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=event_content,
        metadata_=event_metadata,
    ))
    await db.flush()
    await db.commit()

    return {
        "status": "accepted",
        "alert_id": normalized["alert_uid"],
        "alert_row_id": alert.id,
        "rca_id": f"rca-{session.id}",
        "rca_session_id": session.id,
        "severity_level": level,
        "severity_label": severity_label(level),
        "alert_type": alert_type,
        "trigger_reason": reason,
        "matched_rule_id": rule_match.rule_id if rule_match else None,
        "matched_rule_name": rule_match.rule_name if rule_match else None,
        "message": f"RCA 已触发（{reason}）",
        "run_session_id": session.id,
    }


async def create_manual_session(
    db: AsyncSession,
    alert: Alert,
    *,
    actor: str,
) -> RcaSession | None:
    """Create an RCA session for an inbox alert (manual trigger)."""
    if alert.rca_session_id:
        existing = await db.get(RcaSession, alert.rca_session_id)
        if existing and existing.status in (RcaStatus.QUEUED, RcaStatus.RUNNING):
            return None

    policy = await get_policy(db)
    offset = int(policy["trigger"]["analysis_start_offset_minutes"])
    alert_time = alert.alert_time or datetime.now(timezone.utc)
    service = (alert.ci_application or alert.ci_name or alert.source or "unknown")[:255]
    session = RcaSession(
        team_id=alert.team_id or 1,
        trigger_type=RcaTriggerType.PASSIVE,
        status=RcaStatus.QUEUED,
        service_name=service,
        alert_count=1,
        trigger_reason=f"manual_by:{actor}",
        time_window_start=alert_time - timedelta(minutes=offset),
        time_window_end=alert_time,
    )
    db.add(session)
    await db.flush()
    alert.rca_session_id = session.id
    alert.status = "triggered"
    alert.trigger_reason = f"manual_by:{actor}"
    db.add(CollaborationEvent(
        rca_session_id=session.id,
        event_type=CollaborationEventType.AGENT_PROGRESS,
        content=f"人工触发 RCA（操作人 {actor}，告警 {alert.alert_uid}）",
        metadata_={"alert_id": alert.alert_uid, "actor": actor},
    ))
    await db.flush()
    return session
