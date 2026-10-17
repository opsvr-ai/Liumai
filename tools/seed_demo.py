#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""六脉（Liumai）演示数据灌入脚本。

用途
----
一次性向本地 Docker 中的六脉平台写入可识别、可回滚的演示数据，用于验证：

* 事件中心 / 收件箱（alerts）
* 作战室（RCA 会话 + 报告 + 协作时间线）
* 知识图谱（graph overview）
* 巡检建议（patrol suggestions）
* 知识文档列表

所有演示数据共享 ``demo-`` 前缀（alert_uid / service_name / 文档标题 /
会话 trigger_reason），因此可以随时用 ``--reset`` 清理后重新灌入。

实现约定
--------
* 仅使用 Python 标准库，Windows 可直接运行。
* 写库通过 ``docker exec -i liumai-postgres psql ...`` 子进程完成，
  不重启 / 不重建容器。
* 不调用真实 RCA / Hermes：只写数据库行，等待 Hermes 的 worker 不会被触发。
* 后台 watchdog 会对“没有心跳的 QUEUED”会话做重启恢复并真正启动 RCA，
  因此演示用 QUEUED 会话会带一个 completed_at 终止标记，使 watchdog 跳过它；
  状态仍为 QUEUED，前端“进行中”页可正常展示。
* 协作事件只写 AGENT_PROGRESS（工具调用用 metadata.kind=tool_call 表达），
  绝不写 rca_heartbeat，避免影响巡检/存活判断。

用法
----
    python tools/seed_demo.py                 # 默认 16 个会话，先清理再灌入
    python tools/seed_demo.py --reset         # 显式清理 demo- 数据后重灌
    python tools/seed_demo.py --count 20      # 缩放会话总数（最少 4）
    python tools/seed_demo.py --dry-run       # 只打印计划与 SQL 预览

清理
----
    python tools/seed_demo.py --reset
    # 或者手工执行：
    # docker exec -i liumai-postgres psql -U liumai -d liumai
    #   DELETE ... WHERE ... LIKE 'demo-%'
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

# ═══════════════════════════════════════════════════════════════════════════════
# 环境常量
# ═══════════════════════════════════════════════════════════════════════════════

POSTGRES_CONTAINER = "liumai-postgres"
BACKEND_CONTAINER = "liumai-backend"
DB_USER = "liumai"
DB_NAME = "liumai"
API_BASE = "http://localhost:8000"

TEAM_ID = 1
ADMIN_USER_ID = 1
DEMO_PREFIX = "demo-"
DEFAULT_COUNT = 16
MIN_COUNT = 4

# ═══════════════════════════════════════════════════════════════════════════════
# 演示数据素材
# ═══════════════════════════════════════════════════════════════════════════════

SERVICES: list[dict[str, Any]] = [
    {
        "name": "demo-pay",
        "short": "pay",
        "base_alerts": 8,
        "source": "Prometheus",
        "ip": "10.10.1.21",
        "templates": [
            ("5xx 比例 12.4% 超过阈值 5%（5 分钟窗口）", "http_5xx_ratio", "availability"),
            ("接口 P99 延迟 2.8s 超过阈值 800ms", "http_p99_latency", "latency"),
            ("数据库连接池使用率 100%（200/200）", "db_pool_usage", "resource"),
            ("支付回调失败率 8.6% 持续上升", "callback_failure_ratio", "error"),
        ],
    },
    {
        "name": "demo-order",
        "short": "order",
        "base_alerts": 7,
        "source": "Prometheus",
        "ip": "10.10.1.22",
        "templates": [
            ("下单接口错误率 9.1% 超过阈值 3%", "http_error_ratio", "error"),
            ("调用 demo-pay 超时次数 5 分钟 187 次", "downstream_timeout", "latency"),
            ("订单消息积压 12,480 条，消费速率下降", "mq_backlog", "traffic"),
            ("库存校验接口 P99 延迟 1.9s", "inventory_p99", "latency"),
        ],
    },
    {
        "name": "demo-gateway",
        "short": "gateway",
        "base_alerts": 6,
        "source": "Zabbix",
        "ip": "10.10.1.23",
        "templates": [
            ("网关 502 比例 6.3% 持续 10 分钟", "gateway_502_ratio", "availability"),
            ("上游连接队列打满（1024/1024）", "conn_queue_usage", "resource"),
            ("路由转发延迟 P95 1.2s 超过阈值 500ms", "route_p95_latency", "latency"),
            ("限流触发次数突增 4.8 倍", "rate_limit_hits", "traffic"),
        ],
    },
    {
        "name": "demo-redis",
        "short": "redis",
        "base_alerts": 5,
        "source": "Zabbix",
        "ip": "10.10.1.24",
        "templates": [
            ("缓存命中率降至 61%（基线 94%）", "cache_hit_ratio", "resource"),
            ("Redis 内存使用率 92%，接近 maxmemory", "redis_memory_usage", "resource"),
            ("慢查询数量 5 分钟 43 次", "redis_slowlog", "latency"),
            ("主从复制延迟 18s 超过阈值 5s", "replication_lag", "availability"),
        ],
    },
    {
        "name": "demo-mysql",
        "short": "mysql",
        "base_alerts": 6,
        "source": "Prometheus",
        "ip": "10.10.1.25",
        "templates": [
            ("慢查询数量 10 分钟 76 次", "mysql_slow_queries", "latency"),
            ("连接数 480/500，接近上限", "mysql_connections", "resource"),
            ("主从延迟 32s，读一致性风险", "mysql_replica_lag", "availability"),
            ("InnoDB 缓冲池命中率降至 88%", "innodb_hit_ratio", "resource"),
        ],
    },
    {
        "name": "demo-scheduler",
        "short": "scheduler",
        "base_alerts": 5,
        "source": "Zabbix",
        "ip": "10.10.1.26",
        "templates": [
            ("定时任务重复执行 3 个实例", "job_duplicate_runs", "error"),
            ("任务堆积 2,340 个，超过阈值 500", "job_backlog", "traffic"),
            ("调度线程池活跃线程 100%（64/64）", "scheduler_pool_usage", "resource"),
            ("整点任务执行耗时 8.4 分钟（基线 40s）", "job_duration", "latency"),
        ],
    },
]

CAUSES: dict[int, dict[str, Any]] = {
    1: {
        "text": "数据库连接池耗尽导致请求排队超时",
        "category": "数据库",
        "evidence": [
            "连接池 active=200/200，等待队列持续增长至 137",
            "慢查询 Top1 耗时 8.4s，订单查询未走索引",
            "应用侧出现大量获取连接超时异常",
        ],
        "impacted": ["demo-order", "demo-gateway"],
        "actions": [
            "将数据库连接池上限从 200 提升至 400，并将获取连接超时设为 3 秒",
            "kill 长事务并优化未走索引的订单查询，补充连接泄漏检测",
            "为 demo-pay 增加连接池使用率告警阈值 80% 与容量水位巡检",
        ],
    },
    2: {
        "text": "下游服务接口超时引发级联熔断",
        "category": "依赖",
        "evidence": [
            "demo-order 调用 demo-pay 的 P99 延迟升至 3.2s",
            "熔断器在 5 分钟内打开 7 次，重试流量放大 3 倍",
            "网关线程池排队，错误率向入口层扩散",
        ],
        "impacted": ["demo-pay", "demo-gateway"],
        "actions": [
            "为 demo-order 调用下游增加 2 秒超时与熔断降级策略",
            "核查 demo-gateway 连接队列与线程池配置，限制重试次数",
            "补充下游超时与熔断打开的联动告警",
        ],
    },
    3: {
        "text": "缓存命中率骤降导致回源压力过大",
        "category": "缓存",
        "evidence": [
            "demo-redis 命中率从 94% 降至 61%",
            "同一批热点 Key 在 1 分钟内集中失效",
            "回源 QPS 增长 2.6 倍，数据库负载同步升高",
        ],
        "impacted": ["demo-redis", "demo-mysql"],
        "actions": [
            "扩容 demo-redis 集群并预热热点 Key，避免集中过期",
            "检查缓存过期策略，为热点 Key 增加随机 TTL 抖动",
            "为缓存命中率下降配置巡检项与自动告警",
        ],
    },
    4: {
        "text": "定时任务并发冲突造成资源争用",
        "category": "调度",
        "evidence": [
            "demo-scheduler 同一任务出现 3 个并发实例",
            "调度线程池 64/64 被打满，任务堆积 2,340 个",
            "数据库 CPU 在整点前后出现明显尖峰",
        ],
        "impacted": ["demo-scheduler", "demo-order"],
        "actions": [
            "限制 demo-scheduler 同一任务并发实例数为 1，并加分布式锁",
            "错峰调度高频任务，拆分大任务并设置执行超时",
            "补充任务堆积、重复执行与线程池水位告警",
        ],
    },
    5: {
        "text": "发布变更引入慢查询导致负载升高",
        "category": "变更",
        "evidence": [
            "发布后慢查询数量由 3 次/10 分钟升至 76 次/10 分钟",
            "新版本 SQL 缺少联合索引，扫描行数增长 40 倍",
            "数据库连接与 CPU 使用率同步上升",
        ],
        "impacted": ["demo-mysql", "demo-pay", "demo-order"],
        "actions": [
            "回滚最近一次发布并复核执行计划，确认索引命中",
            "为新增查询补充联合索引，并在发布流水线加入慢 SQL 门禁",
            "在变更窗口增加数据库负载与慢查询的对比巡检",
        ],
    },
}

# 每个服务按顺序使用的根因候选；demo-pay 连续复用 cause 1 制造“复发根因”。
CAUSE_BY_SERVICE: dict[str, list[int]] = {
    "demo-pay": [1, 1, 1, 1, 1],
    "demo-order": [2, 2, 2, 5, 2],
    "demo-gateway": [4, 3, 4, 3],
    "demo-mysql": [5, 3, 1],
    "demo-scheduler": [4, 1, 5],
}

# 每个服务按顺序使用的置信度；demo-order 前 3 份报告刻意低于 0.5。
CONFIDENCE_BY_SERVICE: dict[str, list[float]] = {
    "demo-pay": [0.92, 0.88, 0.86, 0.72, 0.55, 0.81, 0.63, 0.77],
    "demo-order": [0.42, 0.46, 0.44, 0.55, 0.61, 0.38, 0.49],
    "demo-gateway": [0.81, 0.67, 0.74, 0.58],
    "demo-mysql": [0.90, 0.64, 0.47, 0.83],
    "demo-scheduler": [0.74, 0.52, 0.68, 0.45],
}

# 服务 -> 已完成会话的创建时间（距今 N 天）。默认 16 个会话时：
# demo-pay 最近 3 次都在 7 天内且同根因 → 巡检 rule 2；demo-order 3 份低置信度 → rule 5。
COMPLETED_OFFSET_DAYS: dict[str, list[float]] = {
    "demo-pay": [2, 4, 6, 20, 12, 26, 9, 17],
    "demo-order": [3, 10, 25, 17, 6.5, 22, 13],
    "demo-gateway": [5, 15, 22, 9, 27],
    "demo-mysql": [9, 18, 4.5, 24],
    "demo-scheduler": [8, 16, 2.5, 28],
}

COMPLETED_ORDER = [
    "demo-pay", "demo-pay", "demo-pay",
    "demo-order", "demo-order", "demo-order",
    "demo-gateway", "demo-gateway",
    "demo-mysql",
    "demo-scheduler",
]
EXTRA_COMPLETED_ORDER = ["demo-pay", "demo-order", "demo-gateway", "demo-mysql", "demo-scheduler"]

CAUSE_OBSERVATIONS: dict[str, list[str]] = {
    "数据库": [
        "连接池 active=200/200，等待队列持续增长",
        "慢查询日志定位到未走索引的订单查询",
        "应用日志出现大量获取连接超时异常",
    ],
    "依赖": [
        "demo-pay 调用延迟 P99 升至 3.2s，熔断器反复打开",
        "demo-gateway 线程池排队，错误率向入口层扩散",
        "重试流量放大 3 倍，需要限制重试与超时",
    ],
    "缓存": [
        "demo-redis 命中率从 94% 降到 61%",
        "热点 Key 在同一分钟内集中失效",
        "回源 QPS 增长 2.6 倍，数据库负载升高",
    ],
    "调度": [
        "同一任务出现 3 个并发实例，疑似调度锁失效",
        "调度线程池 64/64 打满，任务堆积 2,340 个",
        "整点前后数据库出现明显 CPU 尖峰",
    ],
    "变更": [
        "发布后慢查询数量增长 25 倍",
        "新 SQL 扫描行数增长 40 倍，缺少联合索引",
        "数据库连接与 CPU 使用率同步上升",
    ],
}

SEVERITY_LABELS = {1: "严重", 2: "重要", 3: "一般", 4: "告警", 5: "提示"}
SEVERITY_CYCLE = [2, 1, 3, 5, 4]
STATUS_CYCLE = [
    "pending", "triggered", "filtered", "coalesced",
    "pending", "dismissed", "triggered", "filtered",
]

# 告警时间锚点（距现在 N 分钟）：45m / 4h / 11h / 2d / 4d / 6d / 10d / 22d
ALERT_ANCHORS_MIN = [45, 240, 660, 2880, 5760, 8640, 14400, 31680]

KNOWLEDGE_DOCS: list[dict[str, Any]] = [
    {
        "title": "demo-支付服务数据库连接池耗尽处置手册",
        "days": 15,
        "hits": 3,
        "summary": "支付服务连接池耗尽的定位、应急与永久修复步骤。",
        "tags": ["demo-pay", "连接池", "数据库", "应急处置"],
        "content": (
            "现象：demo-pay 接口 5xx 比例升高，日志出现获取数据库连接超时，"
            "连接池 active 达到上限且等待队列持续增长。\n\n"
            "排查：1）查询 pg_stat_activity 找出长事务与空闲连接；2）检查慢查询日志；"
            "3）对比最近发布，确认是否新增未走索引的 SQL；4）观察下游 demo-order 是否出现重试放大。\n\n"
            "处置：临时将连接池上限从 200 调到 400，获取连接超时设为 3 秒，"
            "kill 长事务并回滚可疑发布；永久修复包括优化慢 SQL、补充连接泄漏检测、"
            "增加连接池使用率 80% 的巡检与告警。"
        ),
    },
    {
        "title": "demo-订单服务下游超时与熔断排查指南",
        "days": 9,
        "hits": 2,
        "summary": "订单服务调用下游超时引发级联熔断时的排查路径。",
        "tags": ["demo-order", "超时", "熔断", "依赖治理"],
        "content": (
            "现象：demo-order 下单错误率升高，调用 demo-pay 的 P99 延迟超过 3s，"
            "熔断器频繁打开，demo-gateway 线程池出现排队。\n\n"
            "排查：1）按调用链定位最先出现超时的下游；2）检查超时、重试、熔断配置；"
            "3）确认重试是否放大流量；4）观察网关连接队列与线程池水位。\n\n"
            "处置：为下游调用设置 2 秒超时与熔断降级，限制重试次数；"
            "网关侧增加连接队列水位告警；发布后复核错误率与延迟恢复情况。"
        ),
    },
    {
        "title": "demo-缓存命中率下降应急处理",
        "days": 4,
        "hits": 1,
        "summary": "Redis 命中率骤降导致回源压力升高时的应急步骤。",
        "tags": ["demo-redis", "缓存", "命中率", "回源"],
        "content": (
            "现象：demo-redis 命中率从 94% 降至 61%，回源 QPS 增长，"
            "demo-mysql 负载同步升高。\n\n"
            "排查：1）检查热点 Key 是否集中过期；2）确认 Redis 内存与 maxmemory 策略；"
            "3）查看慢查询与主从延迟；4）对比最近发布是否修改了 Key 结构。\n\n"
            "处置：扩容集群并预热热点 Key，为热点 Key 增加随机 TTL 抖动，"
            "避免同一时间集中失效；补充命中率下降巡检项与自动告警。"
        ),
    },
    {
        "title": "demo-定时任务并发冲突复盘",
        "days": 2,
        "hits": 0,
        "summary": "定时任务重复执行、线程池打满的根因与治理方案。",
        "tags": ["demo-scheduler", "定时任务", "并发", "分布式锁"],
        "content": (
            "现象：demo-scheduler 同一任务出现多个并发实例，任务堆积 2,340 个，"
            "调度线程池 100% 占用，数据库在整点出现 CPU 尖峰。\n\n"
            "排查：1）确认任务是否具备幂等与分布式锁；2）检查调度器实例数量与选主状态；"
            "3）分析任务耗时与重试策略；4）核对整点任务是否集中触发。\n\n"
            "处置：同一任务并发实例数限制为 1，引入分布式锁；错峰调度并拆分大任务；"
            "补充任务堆积、重复执行和线程池水位告警。"
        ),
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# SQL / 子进程辅助
# ═══════════════════════════════════════════════════════════════════════════════


def q(value: Any) -> str:
    """SQL 字符串字面量（单引号转义）。"""
    text = "" if value is None else str(value)
    return "'" + text.replace("'", "''") + "'"


def sql_dt(value: datetime | None) -> str:
    """timestamptz 字面量；None -> NULL。"""
    if value is None:
        return "NULL"
    return q(value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"))


def j(value: Any) -> str:
    """JSONB 字面量。"""
    return q(json.dumps(value, ensure_ascii=False)) + "::jsonb"


def run_psql(sql: str, *, query: bool = False) -> str:
    """通过 docker exec 执行 psql；stdin 使用 UTF-8，返回 stdout 文本。"""
    cmd = [
        "docker", "exec", "-i", POSTGRES_CONTAINER,
        "psql", "-U", DB_USER, "-d", DB_NAME,
        "-X", "-q", "-v", "ON_ERROR_STOP=1",
    ]
    if query:
        cmd += ["-t", "-A", "-F", "|"]
    proc = subprocess.run(cmd, input=sql.encode("utf-8"), capture_output=True)
    out = proc.stdout.decode("utf-8", errors="replace")
    err = proc.stderr.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(
            f"psql 执行失败（exit={proc.returncode}）：\n{err.strip()[:4000]}"
        )
    return out


def fetch_demo_counts() -> dict[str, int]:
    """统计五张表中的 demo- 数据量。"""
    sql = """
SELECT
  (SELECT count(*) FROM alerts WHERE alert_uid LIKE 'demo-%'),
  (SELECT count(*) FROM rca_sessions WHERE trigger_reason LIKE 'demo-%'),
  (SELECT count(*) FROM rca_reports r
     JOIN rca_sessions s ON s.id = r.session_id
     WHERE s.trigger_reason LIKE 'demo-%'),
  (SELECT count(*) FROM collaboration_events e
     JOIN rca_sessions s ON s.id = e.rca_session_id
     WHERE s.trigger_reason LIKE 'demo-%'),
  (SELECT count(*) FROM knowledge_documents WHERE title LIKE 'demo-%');
"""
    lines = [line.strip() for line in run_psql(sql, query=True).splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("自检查询没有返回结果")
    parts = lines[-1].split("|")
    if len(parts) != 5:
        raise RuntimeError(f"自检查询结果格式异常：{lines[-1]!r}")
    keys = ("alerts", "sessions", "reports", "events", "documents")
    return {key: int(value) for key, value in zip(keys, parts)}


def make_admin_token() -> str:
    """在 backend 容器内用同一个 JWT_SECRET 生成 15 分钟管理员 token。"""
    code = (
        "from jose import jwt; from app.config import settings; import time; "
        "print(jwt.encode({'sub':'1','exp':int(time.time())+900}, "
        "settings.JWT_SECRET, algorithm='HS256'))"
    )
    proc = subprocess.run(
        ["docker", "exec", BACKEND_CONTAINER, "python", "-c", code],
        capture_output=True,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"生成管理员 token 失败：{err.strip()[:1000]}")
    token = proc.stdout.decode("utf-8", errors="replace").strip()
    if not token:
        raise RuntimeError("生成管理员 token 失败：输出为空")
    return token


def api_get(path: str, token: str) -> dict[str, Any]:
    url = API_BASE.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"{path} -> HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{path} -> 无法连接 {API_BASE}: {exc.reason}") from exc


# ═══════════════════════════════════════════════════════════════════════════════
# 计划构建
# ═══════════════════════════════════════════════════════════════════════════════


def split_statuses(total: int) -> tuple[int, int, int, int]:
    """把会话总数拆成 (completed, failed, running, queued)。"""
    if total < MIN_COUNT:
        raise ValueError(f"--count 至少为 {MIN_COUNT}")
    running = 2 if total >= 8 else 1
    queued = 2 if total >= 8 else 1
    failed = max(1, round(total * 0.12))
    completed = total - running - queued - failed
    if completed < 1:
        raise ValueError(f"--count={total} 太小，无法同时保留四种状态")
    return completed, failed, running, queued


def alert_offsets(count: int, service_index: int) -> list[int]:
    """为单个服务挑选覆盖 24h / 7d / 30d 的告警时间偏移（分钟）。"""
    if count <= 0:
        return []
    if count == 1:
        indexes = [0]
    else:
        span = len(ALERT_ANCHORS_MIN) - 1
        indexes = [round(i * span / (count - 1)) for i in range(count)]
    return [
        ALERT_ANCHORS_MIN[index] + ((service_index * 37 + i * 11) % 45)
        for i, index in enumerate(indexes)
    ]


def build_sessions(now: datetime, completed: int, failed: int, running: int, queued: int) -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []
    svc_seq: dict[str, int] = defaultdict(int)

    # ── COMPLETED + RcaReport ─────────────────────────────────────────────
    for i in range(completed):
        if i < len(COMPLETED_ORDER):
            service = COMPLETED_ORDER[i]
        else:
            service = EXTRA_COMPLETED_ORDER[(i - len(COMPLETED_ORDER)) % len(EXTRA_COMPLETED_ORDER)]
        seq = svc_seq[service]
        svc_seq[service] += 1

        offsets = COMPLETED_OFFSET_DAYS[service]
        days = offsets[seq] if seq < len(offsets) else 7 + (seq * 3) % 21
        created = now - timedelta(days=days, minutes=(i * 13) % 40)
        completed_at = created + timedelta(minutes=8 + (i * 3) % 8)
        cause_id = CAUSE_BY_SERVICE[service][seq % len(CAUSE_BY_SERVICE[service])]
        cause = CAUSES[cause_id]
        confidences = CONFIDENCE_BY_SERVICE[service]
        confidence = (
            confidences[seq]
            if seq < len(confidences)
            else round(0.4 + ((seq * 17) % 55) / 100, 2)
        )
        sessions.append({
            "service": service,
            "status": "COMPLETED",
            "trigger_type": "PASSIVE",
            "trigger_reason": (
                f"demo-被动触发：{service} 的{cause['category']}指标异常，"
                "自动创建 RCA 分析（已完成）"
            ),
            "created_at": created,
            "completed_at": completed_at,
            "time_window_start": created - timedelta(minutes=5),
            "time_window_end": completed_at,
            "root_cause": cause,
            "confidence": confidence,
            "alert_count": 2 + (i % 4),
            "root_cause_summary": cause["text"],
            "evidence": [
                f"已确认 {service} 在告警窗口内出现异常",
                cause["evidence"][0],
            ],
        })

    # ── FAILED（近 7 天，喂给巡检 rule 3）────────────────────────────────
    failed_services = ["demo-mysql", "demo-gateway", "demo-order", "demo-pay"]
    for i in range(failed):
        service = failed_services[i % len(failed_services)]
        days = [1, 3, 5, 6, 2, 4][i % 6]
        created = now - timedelta(days=days, minutes=(i * 17) % 50)
        sessions.append({
            "service": service,
            "status": "FAILED",
            "trigger_type": "PASSIVE",
            "trigger_reason": (
                f"demo-被动触发：{service} 高优先级告警自动创建分析，执行失败"
            ),
            "created_at": created,
            "completed_at": created + timedelta(minutes=3 + i % 4),
            "time_window_start": created - timedelta(minutes=5),
            "time_window_end": created + timedelta(minutes=3 + i % 4),
            "root_cause": None,
            "confidence": None,
            "alert_count": 1 + (i % 3),
            "root_cause_summary": (
                "【失败】Hermes 分析超时（超过 1200s），已保留部分证据"
            ),
            "evidence": ["已采集指标与日志，但模型分析超时", "失败原因：Hermes 执行超时"],
        })

    # ── RUNNING（进行中页）────────────────────────────────────────────────
    running_specs = [
        ("demo-scheduler", 12),
        ("demo-pay", 25),
        ("demo-order", 35),
        ("demo-gateway", 45),
    ]
    for i in range(running):
        service, minutes = running_specs[i % len(running_specs)]
        created = now - timedelta(minutes=minutes)
        sessions.append({
            "service": service,
            "status": "RUNNING",
            "trigger_type": "ACTIVE" if service == "demo-pay" else "PASSIVE",
            "trigger_reason": (
                f"demo-{'人工发起' if service == 'demo-pay' else '被动触发'}："
                f"{service} 告警分析进行中（RUNNING）"
            ),
            "created_at": created,
            "completed_at": None,
            "time_window_start": created - timedelta(minutes=5),
            "time_window_end": now,
            "root_cause": None,
            "confidence": None,
            "alert_count": 1 + (i % 2),
            "root_cause_summary": None,
            "evidence": ["分析进行中：正在采集指标、日志与变更记录"],
        })

    # ── QUEUED（进行中页）──────────────────────────────────────────────────
    # 注意：completed_at 在此处是“终止标记”，不是真的完成时间。
    # 六脉后台 watchdog 会重新投递 created_at 在 4h 内、无心跳的 QUEUED 会话，
    # 并真正启动 RCA（消耗 LLM）。带 completed_at 后，watchdog 的
    # requeue_orphan_sessions / _expire_stale_sessions 都会跳过它；
    # 状态仍是 QUEUED，前端“进行中”页可正常展示。
    queued_specs = [
        ("demo-scheduler", 35),
        ("demo-order", 50),
        ("demo-gateway", 65),
        ("demo-pay", 80),
    ]
    for i in range(queued):
        service, minutes = queued_specs[i % len(queued_specs)]
        created = now - timedelta(minutes=minutes)
        sessions.append({
            "service": service,
            "status": "QUEUED",
            "trigger_type": "PASSIVE",
            "trigger_reason": (
                f"demo-被动触发：{service} 告警等待调度（QUEUED）"
            ),
            "created_at": created,
            "completed_at": created + timedelta(minutes=1),
            "time_window_start": created - timedelta(minutes=5),
            "time_window_end": None,
            "root_cause": None,
            "confidence": None,
            "alert_count": 1,
            "root_cause_summary": None,
            "evidence": ["排队中：等待 RCA 并发槽位释放"],
        })

    for index, session in enumerate(sessions, start=1):
        session["key"] = f"{DEMO_PREFIX}hermes-{index:04d}"
        session["events"] = build_events(session, index - 1, now)
    return sessions


def build_events(session: dict[str, Any], seq: int, now: datetime) -> list[dict[str, Any]]:
    """为每个会话生成 3~8 条协作事件（绝不写心跳 kind）。"""
    status = session["status"]
    service = session["service"]
    count = 3 + (seq % 6)

    start = session["created_at"]
    if status in ("COMPLETED", "FAILED"):
        end = session["completed_at"]
    elif status == "RUNNING":
        end = now
    else:  # QUEUED：事件只写到入队后的 30 分钟内，避免伪造“仍在推进”
        end = min(now, start + timedelta(minutes=30))
    if end is None or end <= start:
        end = start + timedelta(minutes=count + 2)
    step = (end - start) / (count + 1)

    cause = session.get("root_cause")
    tool_names = ["prometheus.query", "loki.query", "mysql.explain", "redis.info"]
    events: list[dict[str, Any]] = []
    for i in range(count):
        at = start + step * (i + 1)
        is_last = i == count - 1
        if i == 0:
            content = f"接收告警并创建 RCA 会话：{service}，开始拉取近 30 分钟指标与日志"
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        elif is_last and status == "COMPLETED" and cause is not None:
            content = (
                f"根因收敛：{cause['text']}（置信度 {session['confidence']:.2f}），"
                "生成结构化报告"
            )
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        elif is_last and status == "FAILED":
            content = "分析失败：Hermes 执行超时，已保留已采集证据，等待人工重跑"
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        elif is_last and status == "RUNNING":
            content = "正在比对最近一次发布记录与慢查询日志，等待更多证据"
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        elif is_last and status == "QUEUED":
            content = "排队中：等待 RCA 并发槽位释放，尚未开始模型分析"
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        elif i % 2 == 1:
            tool = tool_names[(seq + i) % len(tool_names)]
            content = f"调用 {tool} 获取 {service} 的指标/日志证据"
            kind = "tool_call"
            metadata = {
                "source": "demo-seed",
                "kind": kind,
                "tool": tool,
                "service": service,
            }
        else:
            if status == "QUEUED":
                content = "任务已进入调度队列，等待并发槽位"
            elif status == "FAILED":
                content = "已采集部分证据，Hermes 调用耗时接近超时阈值"
            elif cause is not None:
                observations = CAUSE_OBSERVATIONS.get(cause["category"], []) or cause["evidence"]
                content = observations[(seq + i) % len(observations)]
            else:
                content = "正在核对监控指标、应用日志与最近变更记录"
            kind = "agent_progress"
            metadata = {"source": "demo-seed", "kind": kind}
        events.append({
            "at": at,
            "content": content,
            "event_type": "AGENT_PROGRESS",
            "metadata": metadata,
        })
    return events


def closest_terminal_session(sessions: list[dict[str, Any]], service: str, at: datetime) -> dict[str, Any] | None:
    """为触发类告警挑选时间最近、已结束的同服务会话。"""
    candidates = [
        s for s in sessions
        if s["service"] == service and s["status"] in ("COMPLETED", "FAILED")
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda s: abs((s["created_at"] - at).total_seconds()))


def build_alerts(now: datetime, count: int, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    for svc_index, svc in enumerate(SERVICES):
        service = svc["name"]
        target = max(3, round(svc["base_alerts"] * count / DEFAULT_COUNT))
        offsets = alert_offsets(target, svc_index)
        for i, offset in enumerate(offsets):
            at = now - timedelta(minutes=offset)
            level = SEVERITY_CYCLE[(i + svc_index) % len(SEVERITY_CYCLE)]
            template = svc["templates"][i % len(svc["templates"])]
            status = "pending" if i == 0 else STATUS_CYCLE[(i + svc_index) % len(STATUS_CYCLE)]
            linked: dict[str, Any] | None = None
            if status in ("triggered", "coalesced"):
                linked = closest_terminal_session(sessions, service, at)
                if linked is None:
                    status = "pending" if i % 2 == 0 else "filtered"
            if status == "pending" and i == 0:
                reason = "demo-待处理：已进入收件箱，等待人工触发 RCA"
            elif status == "triggered":
                reason = f"demo-自动触发：级别 {level} 命中触发策略"
            elif status == "coalesced":
                reason = "demo-合并：并入同服务进行中的 RCA 会话"
            elif status == "dismissed":
                reason = "demo-人工忽略：值班确认非故障"
            else:
                reason = "demo-不触发：未命中严重级别 / 关键组件策略"

            alerts.append({
                "service": service,
                "alert_uid": f"demo-alert-{svc['short']}-{i + 1:02d}",
                "dedup_key": f"demo-dedup-{svc['short']}-{i + 1:02d}",
                "source": svc["source"],
                "ip": svc["ip"],
                "ci_id": f"demo-ci-{svc['short']}-01",
                "content": f"{service} {template[0]}",
                "severity": str(level),
                "severity_level": level,
                "alert_type": template[2],
                "metric": template[1],
                "alert_time": at,
                "status": status,
                "trigger_reason": reason,
                "linked_key": linked["key"] if linked else None,
            })
    return alerts


def build_documents(now: datetime) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    for index, doc in enumerate(KNOWLEDGE_DOCS, start=1):
        created = now - timedelta(days=doc["days"])
        tags = doc["tags"]
        processed = [{
            "title": doc["title"],
            "summary": doc["summary"],
            "tags": tags,
            "content": doc["content"],
        }]
        docs.append({
            "title": doc["title"],
            "content": doc["content"],
            "processed": processed,
            "knowledge_id": f"demo-knowledge-{index:02d}",
            "hit_count": doc["hits"],
            "created_at": created,
        })
    return docs


# ═══════════════════════════════════════════════════════════════════════════════
# SQL 生成
# ═══════════════════════════════════════════════════════════════════════════════

CLEANUP_SQL = """
-- 按依赖顺序清理所有 demo- 数据（事件/报告 -> 告警 -> 会话 -> 文档）
DELETE FROM collaboration_events
 WHERE rca_session_id IN (
   SELECT id FROM rca_sessions
    WHERE team_id = 1 AND (trigger_reason LIKE 'demo-%' OR service_name LIKE 'demo-%')
 );

DELETE FROM rca_reports
 WHERE session_id IN (
   SELECT id FROM rca_sessions
    WHERE team_id = 1 AND (trigger_reason LIKE 'demo-%' OR service_name LIKE 'demo-%')
 )
    OR (team_id = 1 AND service_name LIKE 'demo-%');

DELETE FROM alerts
 WHERE team_id = 1
   AND (alert_uid LIKE 'demo-%' OR dedup_key LIKE 'demo-%'
        OR ci_application LIKE 'demo-%' OR ci_name LIKE 'demo-%');

DELETE FROM rca_sessions
 WHERE team_id = 1 AND (trigger_reason LIKE 'demo-%' OR service_name LIKE 'demo-%');

DELETE FROM knowledge_documents WHERE title LIKE 'demo-%';
"""


def session_insert(s: dict[str, Any]) -> str:
    return f"""
INSERT INTO rca_sessions (
  team_id, service_name, alert_count, trigger_reason, trigger_type, status,
  time_window_start, time_window_end, hermes_session_id, root_cause_summary,
  evidence, created_by, created_at, completed_at
) VALUES (
  {TEAM_ID}, {q(s['service'])}, {s['alert_count']}, {q(s['trigger_reason'])},
  {q(s['trigger_type'])}::rca_trigger_type,
  {q(s['status'])}::rca_status,
  {sql_dt(s['time_window_start'])}, {sql_dt(s['time_window_end'])},
  {q(s['key'])}, {q(s['root_cause_summary']) if s['root_cause_summary'] else 'NULL'},
  {j(s['evidence'])}, {ADMIN_USER_ID}, {sql_dt(s['created_at'])}, {sql_dt(s['completed_at'])}
);
""".strip()


def report_insert(s: dict[str, Any]) -> str:
    cause = s["root_cause"]
    report_evidence = [
        f"{s['service']} 告警窗口内错误率从 1.2% 升至 12.4%",
        *cause["evidence"],
        "已排除网络抖动与数据库主从切换，确认与本次变更/依赖异常相关",
    ]
    raw = json.dumps(
        {
            "demo": True,
            "service": s["service"],
            "root_cause": cause["text"],
            "confidence": s["confidence"],
        },
        ensure_ascii=False,
    )
    return f"""
INSERT INTO rca_reports (
  team_id, session_id, service_name, alert_count, category, root_cause,
  confidence, evidence, impacted_services, recommended_actions, raw_output, created_at
)
SELECT
  {TEAM_ID}, id, {q(s['service'])}, {s['alert_count']}, {q(cause['category'])},
  {q(cause['text'])}, {s['confidence']}, {j(report_evidence)},
  {j(cause['impacted'])}, {j(cause['actions'])}, {q(raw)}, {sql_dt(s['completed_at'])}
FROM rca_sessions
WHERE hermes_session_id = {q(s['key'])};
""".strip()


def event_insert(s: dict[str, Any], event: dict[str, Any]) -> str:
    return f"""
INSERT INTO collaboration_events (rca_session_id, event_type, content, metadata, created_at)
SELECT id, {q(event['event_type'])}::collab_event_type, {q(event['content'])},
       {j(event['metadata'])}, {sql_dt(event['at'])}
FROM rca_sessions
WHERE hermes_session_id = {q(s['key'])};
""".strip()


def alert_insert(a: dict[str, Any]) -> str:
    linked = (
        f"(SELECT id FROM rca_sessions WHERE hermes_session_id = {q(a['linked_key'])})"
        if a["linked_key"] else "NULL"
    )
    raw = json.dumps(
        {"demo": True, "seed": "tools/seed_demo.py", "service": a["service"]},
        ensure_ascii=False,
    )
    return f"""
INSERT INTO alerts (
  team_id, alert_uid, dedup_key, source, ip, ci_name, ci_application, ci_id,
  content, severity, severity_level, alert_type, metric, alert_time, status,
  trigger_reason, rca_session_id, raw_payload, created_at, updated_at
) VALUES (
  {TEAM_ID}, {q(a['alert_uid'])}, {q(a['dedup_key'])}, {q(a['source'])},
  {q(a['ip'])}, {q(a['service'])}, {q(a['service'])}, {q(a['ci_id'])},
  {q(a['content'])}, {q(a['severity'])}, {a['severity_level']},
  {q(a['alert_type'])}, {q(a['metric'])}, {sql_dt(a['alert_time'])},
  {q(a['status'])}, {q(a['trigger_reason'])}, {linked}, {j(raw)},
  {sql_dt(a['alert_time'])}, {sql_dt(a['alert_time'])}
);
""".strip()


def document_insert(d: dict[str, Any]) -> str:
    return f"""
INSERT INTO knowledge_documents (
  title, source_type, source_name, content, processed_content, status,
  knowledge_id, hit_count, created_at, updated_at
) VALUES (
  {q(d['title'])}, 'upload', 'demo-seed', {q(d['content'])},
  {j(d['processed'])}, 'stored', {q(d['knowledge_id'])},
  {d['hit_count']}, {sql_dt(d['created_at'])}, {sql_dt(d['created_at'])}
);
""".strip()


def build_plan(count: int, now: datetime) -> dict[str, Any]:
    completed_n, failed_n, running_n, queued_n = split_statuses(count)
    sessions = build_sessions(now, completed_n, failed_n, running_n, queued_n)
    alerts = build_alerts(now, count, sessions)
    documents = build_documents(now)

    statements: list[str] = []
    statements.extend(session_insert(s) for s in sessions)
    statements.extend(report_insert(s) for s in sessions if s["status"] == "COMPLETED")
    statements.extend(
        event_insert(s, event) for s in sessions for event in s["events"]
    )
    statements.extend(alert_insert(a) for a in alerts)
    statements.extend(document_insert(d) for d in documents)

    service_alert_counts = {svc["name"]: 0 for svc in SERVICES}
    for alert in alerts:
        service_alert_counts[alert["service"]] += 1

    return {
        "sessions": sessions,
        "alerts": alerts,
        "documents": documents,
        "statements": statements,
        "status_counts": {
            "COMPLETED": completed_n,
            "FAILED": failed_n,
            "RUNNING": running_n,
            "QUEUED": queued_n,
        },
        "report_count": sum(1 for s in sessions if s["status"] == "COMPLETED"),
        "event_count": sum(len(s["events"]) for s in sessions),
        "service_alert_counts": service_alert_counts,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 输出 / 自检
# ═══════════════════════════════════════════════════════════════════════════════


def print_plan(plan: dict[str, Any]) -> None:
    statuses = plan["status_counts"]
    print("[plan] 将写入以下 demo- 数据：")
    print(
        f"  sessions={len(plan['sessions'])}"
        f" (COMPLETED={statuses['COMPLETED']}, FAILED={statuses['FAILED']},"
        f" RUNNING={statuses['RUNNING']}, QUEUED={statuses['QUEUED']})"
    )
    print(f"  reports={plan['report_count']} events={plan['event_count']}"
          f" alerts={len(plan['alerts'])} documents={len(plan['documents'])}")
    print("  alerts by service: " + ", ".join(
        f"{name}={value}" for name, value in plan["service_alert_counts"].items()
    ))


def verify_database(plan: dict[str, Any]) -> dict[str, int]:
    counts = fetch_demo_counts()
    expected = {
        "alerts": len(plan["alerts"]),
        "sessions": len(plan["sessions"]),
        "reports": plan["report_count"],
        "events": plan["event_count"],
        "documents": len(plan["documents"]),
    }
    print("[db] demo- 计数：")
    for key in ("alerts", "sessions", "reports", "events", "documents"):
        flag = "OK" if counts[key] == expected[key] else f"期望 {expected[key]}"
        print(f"  {key}: {counts[key]} ({flag})")
    return counts


def verify_apis() -> bool:
    """调用 graph / patrol / incidents，并打印返回数量。"""
    print("[api] 管理员 token 自检：")
    token = make_admin_token()
    ok = True

    graph = api_get("/api/graph/overview?limit=200", token)
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    stats = graph.get("stats") or {}
    print(
        f"  GET /api/graph/overview -> nodes={len(nodes)} edges={len(edges)}"
        f" stats={stats}"
    )
    if not nodes:
        ok = False

    patrol = api_get("/api/patrol/suggestions?limit=50", token)
    items = patrol.get("items") or []
    pstats = patrol.get("stats") or {}
    print(
        f"  GET /api/patrol/suggestions -> items={len(items)}"
        f" total={pstats.get('total')} by_severity={pstats.get('by_severity')}"
    )
    if not items:
        ok = False

    for tab in ("inbox", "active", "reports"):
        page = api_get(f"/api/incidents?tab={tab}&page_size=5", token)
        total = page.get("total")
        counts = page.get("counts") or {}
        print(
            f"  GET /api/incidents?tab={tab} -> total={total}"
            f" returned={len(page.get('items') or [])} counts={counts}"
        )
        if not total:
            ok = False
    return ok


# ═══════════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════════


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="向本地 Docker 六脉平台灌入可回滚的 demo- 演示数据。",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="先删除所有 demo- 数据再灌入（默认同样会先清理以保证幂等）",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=DEFAULT_COUNT,
        help=f"RCA 会话总数（默认 {DEFAULT_COUNT}，最少 {MIN_COUNT}）；告警/事件按比例缩放",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印计划与 SQL 预览，不写数据库、不调用 API",
    )
    args = parser.parse_args(argv)

    if args.count < MIN_COUNT:
        parser.error(f"--count 不能小于 {MIN_COUNT}")
    if args.count > 200:
        parser.error("--count 不能大于 200（避免一次写入过多演示数据）")

    now = datetime.now(timezone.utc).replace(microsecond=0)
    plan = build_plan(args.count, now)

    print(f"[seed] team={TEAM_ID} count={args.count} reset={args.reset} dry_run={args.dry_run}")
    print_plan(plan)

    if args.dry_run:
        print("[dry-run] 不写库。SQL 预览（前 1800 字符）：")
        preview = "\n".join([CLEANUP_SQL.strip(), *plan["statements"][:2]])
        print(preview[:1800])
        return 0

    statements = [CLEANUP_SQL.strip(), *plan["statements"]]
    script = "BEGIN;\n" + "\n\n".join(statements) + "\nCOMMIT;\n"
    print("[db] 正在清理既有 demo- 数据并写入新数据 ...")
    try:
        run_psql(script)
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    try:
        counts = verify_database(plan)
    except RuntimeError as exc:
        print(f"[error] 数据库自检失败：{exc}", file=sys.stderr)
        return 1

    expected_total = sum(counts.values())
    if expected_total <= 0:
        print("[error] 数据库中没有 demo- 数据", file=sys.stderr)
        return 1

    try:
        api_ok = verify_apis()
    except RuntimeError as exc:
        print(f"[warn] API 自检失败：{exc}", file=sys.stderr)
        print("[warn] 数据已落库；请确认 backend 容器运行在 localhost:8000 后重试。")
        return 1

    if api_ok:
        print("[done] demo- 数据已落库，graph / patrol / incidents 均返回非空。")
        print("[cleanup] 清理命令：python tools/seed_demo.py --reset")
        return 0

    print("[warn] demo- 数据已落库，但部分 API 返回为空（巡检有 60s 进程内缓存，可稍后重试）。")
    print("[cleanup] 清理命令：python tools/seed_demo.py --reset")
    return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    raise SystemExit(main())
