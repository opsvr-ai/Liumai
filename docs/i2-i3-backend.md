# I2 / I3 · 知识图谱与巡检建议（后端）

> 改动文件：`backend/app/routes/graph.py`（新建）、`backend/app/routes/patrol.py`（新建）、
> `backend/app/main.py`（仅新增两个 `include_router`）、`docs/i2-i3-backend.md`（新建）。
> 未改前端、未改其它 routes、未改 models、未改表结构；未执行任何
> `docker build/up/restart`，未启动新服务。
>
> 两个模块均为**只读聚合**：只发 SELECT，不写库、不触发 RCA、不调用 LLM。
> 所有查询按 `user.team_id` 过滤；无数据时返回 200 + 空结构（邻居接口除未知节点外）。

## 0. 路由注册（`main.py`）

```python
from app.routes import (..., graph, ..., patrol, ...)  # 字母序插入

app.include_router(graph.router, prefix="/api/graph", tags=["graph"])
app.include_router(patrol.router, prefix="/api/patrol", tags=["patrol"])
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/graph/overview` | 团队知识图谱总览 |
| GET | `/api/graph/neighbors` | 单节点邻居子图（depth 1~2） |
| GET | `/api/patrol/suggestions` | 巡检建议列表 |
| GET | `/api/patrol/summary` | 巡检汇总 |

四个接口都依赖 `get_current_user`：未携带 / 失效令牌 → 401。

---

# I2 · 知识图谱（`GET /api/graph`）

## 1.1 数据来源与扫描范围

| 数据 | 来源 | 字段 | 单次扫描上限 |
| --- | --- | --- | --- |
| 服务 | `rca_sessions.service_name`、`rca_reports.service_name`、`alerts.ci_application / ci_name` | 服务名 | 500（最新） |
| 告警 | `alerts` | `ci_application` → `ci_name` | 500 条（按 `alert_time || created_at` 倒序） |
| 根因 | `rca_reports.root_cause` | 文本 | 500 份报告 |
| 处置 | `rca_reports.recommended_actions` | JSONB 数组 | 同上 |
| 影响服务 | `rca_reports.impacted_services` | JSONB 数组 | 每报告最多 10 个 |

报告通过 `RcaReport.session_id → RcaSession.id` 关联，并以**所属会话的
`team_id`** 作为租户边界（与 `incidents.py` 一致）。三张表的扫描上限是模块常量
`ALERT_SCAN_LIMIT / SESSION_SCAN_LIMIT / REPORT_SCAN_LIMIT = 500`，与 `limit`
（返回节点数上限）相互独立。

## 1.2 `GET /api/graph/overview`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | string | 无 | 服务名过滤（不区分大小写、子串匹配）；只保留命中的服务子图 |
| `limit` | int | 200 | 返回节点总数上限，`1 ≤ limit ≤ 1000`；非法 → 422 |

### 响应契约

```json
{
  "nodes": [
    {
      "id": "svc:Nginx",
      "type": "service",
      "label": "Nginx",
      "weight": 33,
      "meta": {"alerts": 25, "sessions": 5, "reports": 3, "last_seen": "2026-10-17T12:00:00Z"}
    },
    {
      "id": "cause:9f2c1d7a4b3e",
      "type": "cause",
      "label": "连接池配置过小导致耗尽",
      "weight": 2,
      "meta": {"occurrences": 2, "services": ["Nginx"], "avg_confidence": 0.3}
    }
  ],
  "edges": [
    {"source": "svc:Nginx", "target": "cause:9f2c1d7a4b3e", "type": "root_cause", "weight": 2},
    {"source": "svc:Nginx", "target": "alert:1", "type": "had_alert", "weight": 1}
  ],
  "stats": {"services": 2, "alerts": 30, "causes": 3, "actions": 4}
}
```

### 节点

| type | id | label | weight | meta |
| --- | --- | --- | --- | --- |
| `service` | `svc:<服务名>` | 服务名 | 告警数 + 会话数 + 报告数（最小 1） | `alerts / sessions / reports / last_seen` |
| `alert` | `alert:<alerts.id>` | 告警内容（回退 uid / metric / `告警 #id`，截断 160） | 1 | `service / severity / status / time` |
| `cause` | `cause:<sha1(归一化根因)[:12]>` | 根因文本（截断 160） | 出现次数 | `occurrences / services / avg_confidence` |
| `action` | `act:<sha1(归一化处置)[:12]>` | 处置文本（截断 160） | 出现次数 | `occurrences / services` |

实现细节：

- 根因 / 处置按“压缩空白 + `casefold()`”归一化后哈希；大小写、换行差异会合并为同一节点。
- 服务节点按 `casefold()` 合并大小写变体；`id` 与 `label` 取变体中字典序最小者，保证同样数据下 id 稳定。
- 告警服务解析：`ci_application → ci_name`；两者都为空的告警无法落到服务节点，直接忽略
  （`source` 是监控来源而非服务，不参与解析）。
- 报告服务解析：`report.service_name → session.service_name`；两者皆空时跳过该报告。
- `impacted_services` 会创建服务节点并累加其 `reports` 计数；每报告最多取 10 个。
- `severity` 优先用 `severity_level` 映射中文级别（1 严重 … 5 提示），否则回退原始 `severity`。
- `time` 为 `alert_time || created_at`；所有时间均为 UTC ISO-8601（`Z` 结尾）。
- `cause.meta.avg_confidence` 只统计有 `confidence` 的报告，可能为 `null`。

### 边（权重 = 出现次数）

| type | 方向 | 生成规则 | weight |
| --- | --- | --- | --- |
| `had_alert` | service → alert | 告警归属该服务 | 单条告警固定 1 |
| `root_cause` | service → cause | 该服务的报告命中该根因 | 命中报告数 |
| `action` | cause → action | 该根因的报告推荐了该处置 | 推荐次数（同一报告内重复文本只计一次） |
| `action`（回退） | service → action | 报告有处置但无根因文本 | 同上 |
| `similar` | service ↔ service | ① 报告把 B 列为 A 的影响服务；② A、B 共享同一根因 | 关联报告数 / 共享根因数 |

- `similar` 是无向关系，写入时按 `(source, target)` 字典序规范方向；同一对服务的两种来源权重会累加。
- 共享根因生成 `similar` 时，每个根因最多取关联次数最高的 10 个服务做两两配对，避免 O(n²) 爆炸。
- 边只保留两端节点都在返回节点集合内的项，不会出现悬空 id。

### `stats` 与 `limit`

- `stats` 统计的是**本次返回的节点**（`limit` 截断之后），不是全库总量；四个键恒存在。
- 节点选择优先级固定为：**service（weight 降序）→ cause → action → alert（weight 降序、时间倒序）**。
  因此 `limit` 较小时优先保留“服务—根因—处置”骨架；剩余名额才填充告警节点。
- 无任何数据（或 `service` 无命中）→ `200 {"nodes":[],"edges":[],"stats":{...全 0}}`。
- `service` 过滤在 SQL 层先按告警应用/CI 名、会话服务名、报告/会话服务名做子串匹配，
  构建后再裁剪为“命中服务 + 其告警/根因/处置”；不匹配的 `impacted_services` 上下文会被移除。

## 1.3 `GET /api/graph/neighbors`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `service / alert / cause / action` | 是 | 非法值 → 422 |
| `id` | string | 是 | 节点 id（如 `svc:nginx`），也可传裸值（`Nginx` → `svc:Nginx`） |
| `depth` | int | 否 | 默认 1，范围 `1~2`；越界 → 422 |

响应：

```json
{
  "node": {"id": "svc:Nginx", "type": "service", "label": "Nginx", "weight": 33, "meta": {}},
  "nodes": [{"id": "svc:Nginx", "...": "..."}, {"id": "alert:1", "...": "..."}],
  "edges": [{"source": "svc:Nginx", "target": "alert:1", "type": "had_alert", "weight": 1}]
}
```

约定：

- `node` 是查询到的中心节点，**同时包含在 `nodes` 中**（`nodes[0]` 恒为中心节点）。
- 邻居通过 BFS 计算 1~2 跳；`nodes` 按“跳数 → weight 降序 → 类型 → id”稳定排序。
- `edges` 只包含两端都在 `nodes` 中的边（闭合子图）。
- `id` 解析顺序：完整 id → 按 `type` 补前缀 → 同类型 id 后缀大小写不敏感匹配。
- 节点不存在 / 属于其它团队 → `404 {"detail":"节点不存在"}`（与不存在不可区分，防止跨租户探测）；
  无邻居但节点存在 → 200 + 仅中心节点。
- 邻居接口使用不带 `service` 过滤的图谱快照；若目标是 service 且未命中，会再用该服务名
  重试一次（兼容“先按 service 过滤看 overview，再查邻居”的用法）。

---

# I3 · 巡检建议（`GET /api/patrol`）

规则引擎全部是确定性的 SQL/内存计算，**不调用 LLM**；所有阈值集中在
`patrol.py` 顶部常量，便于验收时调整。

## 2.1 阈值常量

| 常量 | 默认值 | 用途 |
| --- | --- | --- |
| `HIGH_ALERT_WINDOW_HOURS` | 24 | 高频告警窗口 |
| `HIGH_ALERT_THRESHOLD` | 20 | 高频告警阈值（严格大于） |
| `RECURRING_CAUSE_WINDOW_DAYS` | 7 | 复发根因窗口 |
| `RECURRING_CAUSE_LOOKBACK_SESSIONS` | 5 | 回看最近 N 次有根因的 RCA |
| `RECURRING_CAUSE_MIN_REPEAT` | 2 | 复发判定次数 |
| `FAILED_SESSION_WINDOW_DAYS` | 7 | FAILED 会话窗口 |
| `QUEUED_TIMEOUT_MINUTES` | 30 | QUEUED 滞留判定 |
| `COVERAGE_GAP_WINDOW_DAYS` | 30 | 覆盖缺口窗口 |
| `LOW_CONFIDENCE_WINDOW_DAYS` | 30 | 低置信度报告窗口 |
| `LOW_CONFIDENCE_THRESHOLD` | 0.5 | 低置信度阈值（严格小于） |
| `LOW_CONFIDENCE_MIN_REPORTS` | 3 | 统计低置信度占比的最少报告数 |
| `LOW_CONFIDENCE_RATIO_THRESHOLD` | 0.5 | 低置信度占比阈值 |
| `CACHE_TTL_SECONDS` | 60 | 进程内缓存 TTL |
| `SUMMARY_TOP_SERVICES` | 5 | summary 返回的 top 服务数 |

“最近 7/30 天”均以请求时刻（UTC）为基准；会话/告警时间使用 `created_at`
（告警优先 `alert_time || created_at`）。

## 2.2 `GET /api/patrol/suggestions`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | string | 无 | 服务名过滤（不区分大小写、子串匹配） |
| `limit` | int | 50 | 返回条数上限，`1 ≤ limit ≤ 200`；非法 → 422 |

```json
{
  "generated_at": "2026-10-17T12:00:00Z",
  "items": [
    {
      "id": "high_alert_freq:3f9a1c2b7d4e",
      "severity": "medium",
      "service": "Nginx",
      "title": "Nginx 高频告警（24h 内 25 条）",
      "reason": "同服务短时告警量超过阈值，疑似持续故障或告警风暴。",
      "evidence": [
        "近 24 小时告警 25 条（阈值 20）",
        "首条 2026-10-17 08:05:00 UTC，最近 2026-10-17 11:55:00 UTC",
        "同期关联 RCA 会话 1 个：#5"
      ],
      "confidence": 0.65,
      "related_session_ids": [5],
      "suggested_action": "检查告警来源与依赖链路，合并/抑制重复告警，并视情况触发 RCA。"
    }
  ],
  "stats": {
    "total": 5,
    "by_severity": {"high": 1, "medium": 4, "low": 0},
    "services": 2
  }
}
```

- `id` = `<规则 key>:<sha1(服务)[:12]>`，同一团队同一服务在同一规则下稳定；跨规则唯一。
- `stats` 描述**本次返回的 items**（已应用 `limit`）：`total = len(items)`，
  `by_severity` 恒含 `high/medium/low` 三个键，`services` 为去重后的服务数
  （无服务名的建议统一归入 `未命名服务`）。
- 排序：`high → medium → low`，同级按 `confidence` 降序，再按服务名 / id。
- 每个 item 的 `related_session_ids` 最多 10 个；`evidence` 带具体计数与 UTC 时间。
- 无数据 → `200 {"generated_at": "...", "items": [], "stats": {...全 0}}`。

### 规则明细

| # | id 前缀 | 触发条件 | severity | confidence | evidence 示例 |
| --- | --- | --- | --- | --- | --- |
| ① | `high_alert_freq` | 同服务 24h 告警数 **> 20** | ≥ 2×阈值 → high，否则 medium | `0.55 + 0.4×(count-20)/20`，上限 0.95 | 24h 条数、阈值、首/末告警时间、同期会话 |
| ② | `recurring_cause` | 最近 7 天内、最近 5 次“有根因”的 RCA 中，同一根因出现 ≥ 2 次 | 重复 ≥ 3 → high，否则 medium | `0.6 + 0.1×(repeat-2)`，上限 0.95 | 回看次数、重复次数、根因摘要、命中会话、最近命中时间 |
| ③ | `failed_sessions` | 近 7 天存在 **FAILED** 会话，或 **QUEUED** 超过 30 分钟仍未启动（不限年龄） | 有 FAILED → high，仅滞留 → medium | 有 FAILED 0.9，仅滞留 0.75 | FAILED 个数/最近失败时间、滞留个数/最早创建时间/已排队分钟数 |
| ④ | `coverage_gap` | 近 30 天有告警，但该服务近 30 天内**没有任何 RCA 会话** | medium | 0.8 | 30 天告警条数、最近告警时间、30 天会话数 0 |
| ⑤ | `low_confidence` | 近 30 天有效报告 ≥ 3 份，且 `confidence < 0.5` 占比 ≥ 50% | 占比 ≥ 75% 且样本 ≥ 5 → high，否则 medium | `0.6 + 0.3×占比`，上限 0.95 | 有效报告数、低置信度数/占比、最低/平均置信度及对应会话 |

规则实现说明：

- 根因取值：`RcaReport.root_cause` 优先，回退 `RcaSession.root_cause_summary`；
  以 `【失败】` / `【系统接管】` 开头的系统摘要不参与复发判定。
- ② 的“最近 5 次”只统计**能解析出根因**的会话（不足 5 次则按实际次数），并按 `created_at` 倒序。
- ③ 的 FAILED 按 `created_at` 落在 7 天内；QUEUED 不限制创建时间，只要超过 30 分钟。
  FAILED 与滞留会话按服务聚合为一条建议。
- ④ 的“有 RCA”按 `rca_sessions` 是否存在（任何状态）判断；即 FAILED / QUEUED 也视为已覆盖。
- ⑤ 只统计有 `confidence` 的报告；置信度先截断到 `[0,1]` 再参与阈值/均值计算。
- 告警服务解析同样为 `ci_application → ci_name`。

### 缓存

- 进程内 `dict` 缓存，键为 `(team_id, 规范化 service)`，TTL **60 秒**；`service`
  为空时 key 中的 service 为 `None`。
- 缓存保存的是**未截断**的完整建议列表与计算时刻；`limit` 在出缓存后应用，
  因此同一服务不同 `limit` 共享一次计算。
- `generated_at` 是本次计算时刻（命中缓存则为首次计算时刻）；缓存不落库、不跨进程。
- 每个条目最多 128 个 key，写入时顺带清理过期项。

## 2.3 `GET /api/patrol/summary`

无参数。使用团队级（无 service 过滤）的建议缓存：

```json
{
  "generated_at": "2026-10-17T12:00:00Z",
  "total": 5,
  "by_severity": {"high": 1, "medium": 4, "low": 0},
  "top_services": [
    {"service": "Nginx", "count": 4},
    {"service": "MySQL", "count": 1}
  ]
}
```

- `total` 与 `by_severity` 基于全部建议（不受 suggestions 的 `limit` 影响）。
- `top_services` 按“该服务的建议条数降序、服务名升序”取前 5；无服务名归入 `未命名服务`。

---

## 3. 验收命令

### 3.1 语法检查（仓库根目录）

```bash
python -m py_compile backend/app/routes/graph.py backend/app/routes/patrol.py backend/app/main.py
# 无输出、退出码 0 即通过
```

### 3.2 路由注册自检（`backend/` 目录，需 JWT_SECRET）

```bash
cd backend
JWT_SECRET=test python -c "
from fastapi import FastAPI
from app.routes import graph, patrol
app = FastAPI()
app.include_router(graph.router,  prefix='/api/graph')
app.include_router(patrol.router, prefix='/api/patrol')
print(sorted(r.path for r in app.routes if getattr(r, 'path', '').startswith('/api/')))
"
# 预期：
# ['/api/graph/neighbors', '/api/graph/overview',
#  '/api/patrol/suggestions', '/api/patrol/summary']
```

PowerShell 等价写法：`$env:JWT_SECRET='test'; python -c "..."`。

### 3.3 登录后接口冒烟

```bash
BASE=http://localhost:8000
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r .token)

# I2 — 总览：节点/边/统计
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/overview?limit=20" \
  | jq '{nodes:(.nodes|length), edges:(.edges|length), stats}'

# I2 — 服务过滤 + 无命中空结构
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/overview?service=Nginx&limit=50" | jq '.stats'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/overview?service=__no_such_service__" | jq '{nodes,edges,stats}'

# I2 — 邻居（取 overview 里真实的节点 id；裸值/完整 id 均可）
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/neighbors?type=service&id=Nginx&depth=1" \
  | jq '{node:.node.id, nodes:(.nodes|length), edges:(.edges|length)}'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/neighbors?type=alert&id=1&depth=2" | jq '.node'

# I3 — 建议与汇总
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/patrol/suggestions?limit=10" \
  | jq '{generated_at, stats, rules:[.items[].id|split(":")[0]]}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/patrol/summary" \
  | jq '{total, by_severity, top_services}'

# 边界：401 / 404 / 422
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/graph/overview"                       # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/neighbors?type=service&id=__missing__"                                 # 404
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/graph/neighbors?type=service&id=Nginx&depth=3"                               # 422
```

### 3.4 只读 / 隔离抽查

```sql
-- 只读验证：接口调用前后下列表行数/内容应完全一致
SELECT count(*) FROM alerts;
SELECT count(*) FROM rca_sessions;
SELECT count(*) FROM rca_reports;

-- 团队隔离：用 A 团队 token 查不到 B 团队的 service / cause / alert
-- （overview 中应无 B 团队服务名；neighbors 对 B 团队节点返回 404）
```

### 3.5 规则抽查（造数）

在测试团队数据中构造以下场景，刷新 `GET /api/patrol/suggestions`：

1. 同一 `service_name` 24h 内插入 21+ 条 `alerts` → 出现 `high_alert_freq`，`evidence[0]` 含条数与阈值 20。
2. 同服务最近 5 次 RCA 中 2 次相同 `root_cause` → 出现 `recurring_cause`，`repeat`/会话 id 正确。
3. 会话置 `FAILED`（7 天内）或 `QUEUED` 且 `created_at` 超过 30 分钟 → 出现 `failed_sessions`。
4. 服务近 30 天有 5 条告警、无任何 `rca_sessions` → 出现 `coverage_gap`。
5. 服务近 30 天 3 份报告、`confidence` 均 < 0.5 → 出现 `low_confidence`（占比 100%）。

60 秒内重复请求应命中缓存（`generated_at` 不变）；等待 60 秒后新增数据会重新计算。

---

## 4. 本次验证记录

- `python -m py_compile backend/app/routes/graph.py backend/app/routes/patrol.py backend/app/main.py` → 通过。
- FastAPI 路由自检：`/api/graph/overview`、`/api/graph/neighbors`、
  `/api/patrol/suggestions`、`/api/patrol/summary` 均注册为 GET。
- 使用临时 SQLite fixture（`aiosqlite`，不依赖 Postgres、不触碰容器）直调路由函数与
  ASGI 层，以下场景全部通过：
  - 图谱：服务/告警/根因/处置节点与四类边、权重聚合、`limit` 截断、`service` 过滤、
    `depth=1/2` 邻居、空团队空结构、跨团队数据不可见、未知节点 404；
  - 巡检：五条规则同时命中、severity/confidence/evidence/related ids 正确、
    服务过滤、`limit`、60s 缓存命中、summary 计数与 top 服务、空团队空结构；
  - HTTP：四个接口的响应字段形状、`limit=3` 截断、无命中 200、depth 3 → 422、
    非法 type → 422、无令牌 → 401。
- 未执行任何 `docker build/up/restart`；未修改前端、models、其它 routes。
