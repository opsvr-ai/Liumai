# I1 · 事件作战室（Incident Workspace）

> 改动文件：`backend/app/routes/incidents.py`、`src/pages/incident-workspace.tsx`（新建）、
> `src/routes.tsx`、`src/pages/incidents.tsx`（仅加“作战室”入口）、`docs/i1-incident-workspace.md`（新建）。
> 未改表结构、未改 `src/lib/api.ts` / `src/hooks/**` / 其它 pages / `nav-config.ts`；
> 新增接口为只读聚合，现有告警 / RCA / 报告接口语义保持不变。

阶段三创新 I1 的目标是把「单次事件」升级为「作战室」：一页看全上下文并直接行动。
事件中心（`/incidents`）的每一行新增「作战室」入口，进入
`/incidents/{kind}/{id}`；`kind = alert | rca | report`，`id` 为源表主键。

## 1. 后端：`GET /api/incidents/{kind}/{id}`

注册位置：`main.py` 已有 `app.include_router(incidents.router, prefix="/api/incidents")`，
本次只在该 router 内新增详情路由，`main.py` 无需改动。

| 项目 | 行为 |
| --- | --- |
| 鉴权 | `Depends(get_current_user)`；未登录 / 令牌失效 → 401 |
| 团队隔离 | 源记录、关联会话、告警、时间线全部按 `user.team_id` 校验；跨团队与不存在统一 404 |
| 404 语义 | `kind` 非法、`id` 不存在、记录属于其它团队 → `404 {"detail": "事件不存在"}`，不泄露存在性 |
| 只读 | 仅 SELECT；不写库、不改状态、不触发 RCA；写操作由前端复用既有 `rerun` / `cancel` 接口 |
| 幂等 | 可安全重放 / 刷新 / 5 秒轮询 |

### 1.1 响应契约

`200 OK`：

```json
{
  "kind": "rca",
  "id": 42,
  "title": "Nginx · RCA #42",
  "service": "Nginx",
  "severity": "重要",
  "status": "RUNNING",
  "created_at": "2026-10-17T11:58:00Z",
  "time_window": {
    "start": "2026-10-17T10:58:00Z",
    "end": "2026-10-17T11:58:00Z"
  },
  "alerts": [
    {
      "id": 7,
      "uid": "alert-uid-7",
      "severity": "严重",
      "content": "Nginx 5xx 比例超过 30%",
      "time": "2026-10-17T11:55:00Z"
    }
  ],
  "rca": {
    "session_id": 42,
    "status": "RUNNING",
    "trigger_reason": "auto:critical_component",
    "root_cause": "连接池配置过小导致耗尽",
    "confidence": 0.82,
    "top3": ["[1] 连接池耗尽（评分 0.9）", "（派生）连接数持续上涨"],
    "evidence": ["pool_size=10，peak=48", "5xx 与连接等待时间同步上升"],
    "recommended_actions": ["将连接池上调到 50 并观察 15 分钟"]
  },
  "timeline": [
    {
      "at": "2026-10-17T11:58:00Z",
      "type": "AGENT_PROGRESS",
      "content": "开始分析：聚合 3 条告警"
    }
  ],
  "report": {
    "available": true,
    "download": {
      "md": "/api/rca/sessions/42/report/download?format=md",
      "html": "/api/rca/sessions/42/report/download?format=html"
    }
  },
  "actions": [
    { "key": "open_rca", "label": "查看 RCA 详情", "enabled": true, "reason": null },
    { "key": "rerun", "label": "重新分析", "enabled": false, "reason": "分析进行中，无法重新分析" },
    { "key": "cancel", "label": "终止", "enabled": true, "reason": null },
    { "key": "download_md", "label": "下载报告 MD", "enabled": false, "reason": "暂无报告（分析未完成或失败）" },
    { "key": "download_html", "label": "下载报告 HTML", "enabled": false, "reason": "暂无报告（分析未完成或失败）" }
  ],
  "related": [
    {
      "id": "rca-41",
      "title": "Nginx · RCA #41",
      "status": "COMPLETED",
      "created_at": "2026-10-17T09:12:00Z"
    }
  ]
}
```

字段说明：

- `kind / id`：请求的 kind 与**源表主键**（告警 / 会话 / 报告的主键，不是复合字符串）。
- `title`：告警取 content（回退 uid / ci_name / `告警 #id`）；RCA 取 `服务 · RCA #id`；
  报告取根因（回退分类 / 服务）。统一压缩空白并截断 200 字。
- `service`：告警取 `ci_application → ci_name → source`；RCA 取 `service_name`；
  报告取 `report.service_name → session.service_name`。
- `severity`：告警按 `severity_level` 映射中文级别，无级别时回退原始 `severity`；
  RCA / 报告取关联告警中的最高级别（level 1 = 严重），无告警时为 `null`。
- `status`：告警为 `pending / triggered / coalesced / ...`；RCA / 报告取所属会话状态
  （`QUEUED / RUNNING / COMPLETED / FAILED`）。
- `time_window`：RCA / 报告取会话的分析窗口；告警优先取关联会话窗口，否则取
  `alert_time → created_at`（发生时间 → 入库时间）；两端都可为 `null`，整体也可为 `null`。
- `alerts`：该会话下的全部告警（告警事件至少包含自身）；无会话的告警只返回自身。
  `uid = alert_uid`，`time = alert_time || created_at`。
- `rca`：`alert` 有关联会话时返回该会话摘要，无会话时为 `null`；`rca` / `report` 恒返回。
  - `root_cause`：报告根因优先，回退 `session.root_cause_summary`；
  - `confidence`：来自 `RcaReport.confidence`，无报告时为 `null`；
  - `top3`：优先读 `session.evidence.top3`（兼容旧平台 dict 条目），缺失时由
    `report.evidence + report.recommended_actions` 派生，无报告时由 `session.evidence` 派生；
  - `evidence`：会话 evidence（兼容 dict / list 两种历史形状），为空时回退报告证据；
  - `recommended_actions`：报告处置建议，无报告时为空。
- `timeline`：所属会话的 `CollaborationEvent`，**排除 `metadata.kind = "rca_heartbeat"` 的心跳**，
  按时间倒序扫描后取最近 50 条并转正序（旧 → 新），字段为 `{at, type, content}`。
  告警无关联会话时为空数组。
- `report.available`：是否存在结构化报告；`download.md / html` 为带认证的既有下载路径
  （无报告时为 `null`）。
- `actions`：稳定的建议动作键，前端可按需渲染、未知键忽略：
  - `open_rca`：跳转 `/rca?s=<session_id>`；
  - `rerun`：`QUEUED/RUNNING` 时禁用，`reason` 说明原因；
  - `cancel`：仅 `QUEUED/RUNNING` 启用（report 事件不返回）；
  - `download_md / download_html`：无报告时禁用并给出 `reason`；
  - `open_alerts`：仅告警事件返回，跳转 `/alerts`。
- `related`：复合 id（`alert-* / rca-* / report-*`），与事件中心的行 id 一致，便于前端直接跳转：
  - `rca`：同团队、同服务、创建时间落在会话窗口内（窗口缺失时取 `created_at ±24h`）的
    最近 5 个**其它**会话；
  - `alert`：同团队、同服务、`alert_time`（缺失时 `created_at`）±24h 内的最近 5 条其它告警；
  - `report`：所属会话（第一条）+ 同服务同时段最近 4 个其它会话。

### 1.2 错误

| 场景 | 状态码 |
| --- | --- |
| 未携带 / 过期令牌 | 401（统一错误信封） |
| kind 不是 `alert/rca/report`、id 非数字 | 404 / 422（非法 kind 由路由显式 404；非数字 id 由 FastAPI 422） |
| 记录不存在或属于其它团队 | 404 `{"detail":"事件不存在"}` |
| 报告详情但所属会话不可见 | 404（同上，不泄露存在性） |

## 2. 前端：`/incidents/:kind/:id`

### 2.1 路由与入口

- `src/routes.tsx`：新增懒加载路由
  `{ path: "/incidents/:kind/:id", Component: lazy(() => import("@/pages/incident-workspace")) }`，
  位于 `/incidents` 之后。
- `src/pages/incidents.tsx`：每行操作区新增「作战室」按钮，从复合 id 解析数字主键后跳转
  `/incidents/{kind}/{id}`；原有「查看 RCA / 告警中心 / 下载报告 MD·HTML / 终止」保持不动。
- `nav-config.ts`：不新增导航；侧边栏「事件中心」的 `isNavItemActive` 已支持
  `/incidents/...` 子路径高亮（`pathname.startsWith("/incidents/")`）。

### 2.2 布局

页面使用现有 token / `Card` / `Badge` / `Button` / `ConfirmDialog` / `Skeleton`，不引入新依赖。

1. **顶部工具栏**：返回事件中心、最近刷新时间、手动刷新。
2. **头部卡片**：类型徽标、`#id`、级别、状态、标题、服务、时间窗、创建时间；
   右侧按 `actions` 渲染主行动按钮（重新分析 / 终止 / 下载 MD / 下载 HTML / 跳转 RCA 详情 /
   前往告警中心）。禁用按钮在悬停 `title` 中显示后端给出的 `reason`。
3. **三联布局**（`lg` 三列；窄屏自动纵向堆叠，列宽
   `1fr / 1.15fr / 1fr`）：
   - **左「上下文」**：关联告警列表（级别徽标、uid、时间）与「关联事件」（复合 id 跳转）。
   - **中「时间线」**：`CollaborationEvent` 纵向时间轴，显示时间、事件类型中文标签、内容；
     会话处于 `RUNNING` 时每 **5 秒**静默刷新（`GET` 详情，不闪加载态），终态 / 告警停止轮询；
     头部提示「运行中 · 每 5 秒自动刷新 / 已停止自动刷新」。
   - **右「根因与建议」**：根因结论、置信度（百分比 + 进度条）、Top3、证据（可滚动）、
     处置建议；无会话 / 无报告 / 无结论均有明确空态。
4. **底部「快速行动」**：
   - 复制摘要（标题、类型、服务、级别、状态、时间窗、根因、Top3、处置建议）；
   - 智能对话：有服务名时跳 `/chat?prompt=<编码后的服务名 + 事件提示>`，无服务名时普通 `/chat`；
   - 标记已关注：`localStorage` 键 `liumai_incident_follow:{kind}:{id}`，仅本机保存，不写后端。

### 2.3 请求与鉴权

- 详情请求在页面内 `fetch("/api/incidents/{kind}/{id}")`，显式携带
  `Authorization: Bearer <localStorage.liumai_token>`；401 时清理登录态并跳 `/login`，
  404 显示「事件不存在或无权访问」。
- 重新分析 / 终止复用既有 `rca.rerun(sessionId)` / `rca.cancel(sessionId)`；
  报告下载复用 `reportApi.download(sessionId, "md" | "html")`（Blob + object URL，token 不进 URL）。
- **未新增 `src/lib/api.ts` 方法**，未改 hooks。

### 2.4 空态与错误态

- 加载：头部 + 三列 + 快速行动骨架屏。
- 无效地址（kind/id 不合法）：错误卡片 + 返回事件中心。
- 详情加载失败：错误卡片 + 重试。
- 静默刷新失败：保留旧内容，顶部显示轻量错误条 + 重试。
- 各列独立空态：暂无关联告警 / 暂无同时段关联事件 / 暂无时间线 / 未关联 RCA /
  暂无 Top3 / 暂无证据 / 暂无处置建议。

## 3. 验收步骤

### 3.1 后端

```bash
# 1) 语法检查（本次改动文件）
python -m py_compile backend/app/routes/incidents.py

# 2) 路由注册自检（在 backend/ 下，需 JWT_SECRET）
JWT_SECRET=test python -c "
from fastapi import FastAPI
from app.routes import incidents
app = FastAPI(); app.include_router(incidents.router, prefix='/api/incidents')
print([r.path for r in app.routes if 'incidents' in getattr(r, 'path', '')])
"
# 预期包含 /api/incidents/{kind}/{incident_id}

# 3) 登录后逐个 kind 验证（替换 BASE / TOKEN / ID）
BASE=http://localhost:8000
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/incidents/alert/12" | jq '{kind,id,title,status,alerts,rca,report,actions,related}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/incidents/rca/42"    | jq '{kind,id,status,time_window,timeline,related}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/incidents/report/7" | jq '{kind,id,report,rca,related}'

# 4) 404 语义：不存在的 id / 其它团队 id / 非法 kind
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/api/incidents/rca/999999"   # 404
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/api/incidents/bogus/1"     # 404
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/incidents/rca/42"                                       # 401
```

### 3.2 前端

```bash
# TS7 已移除 baseUrl，直接跑 tsconfig.app.json 会报 TS5102。
# 用临时配置（复制 compilerOptions、去掉 baseUrl、保留 paths）复查：
#   在仓库根新建 .tsconfig.check.json（内容同下）后执行，检查完删除。
#   {
#     "compilerOptions": {
#       "target": "ES2020", "useDefineForClassFields": true,
#       "lib": ["ES2020", "DOM", "DOM.Iterable"], "module": "ESNext",
#       "skipLibCheck": true, "moduleResolution": "bundler",
#       "allowImportingTsExtensions": true, "isolatedModules": true,
#       "moduleDetection": "force", "noEmit": true, "jsx": "react-jsx",
#       "strict": true, "noUnusedLocals": false, "noUnusedParameters": false,
#       "noFallthroughCasesInSwitch": true,
#       "paths": { "@/*": ["./src/*"] }
#     },
#     "include": ["src"]
#   }
node node_modules/typescript/bin/tsc -p .tsconfig.check.json --noEmit
# 验收口径：src/pages/incident-workspace.tsx / src/routes.tsx / src/pages/incidents.tsx
# 无新增错误；仓库既有的 incident-timeline.tsx / datasources.tsx / users.tsx 报错保持原样。
```

人工验收（刷新现有 Web GUI，无需重启服务）：

1. 打开 `/incidents`，任一行点击「作战室」。
2. 检查头部标题 / 服务 / 级别 / 状态 / 时间窗；点「重新分析」「终止」出现二次确认，
   确认后调用既有接口并刷新详情；有报告时可下载 MD / HTML。
3. `RUNNING` 会话停留页面，观察时间线每 5 秒静默更新、更新时间变化；
   `COMPLETED / FAILED` 或告警事件不再轮询。
4. 左列告警与关联事件可点击跳转；右列根因 / 置信度 / Top3 / 证据 / 建议与 RCA 报告一致。
5. 底部复制摘要、智能对话、标记已关注（刷新后仍保留，换事件不串状态）。
6. 访问 `/incidents/rca/999999`、`/incidents/bogus/1`、无 token 场景，确认错误态与 401/404 行为。

## 4. 本次验证记录

- `python -m py_compile backend/app/routes/incidents.py` → 通过。
- 路由自检：`/api/incidents`、`/api/incidents/`、`/api/incidents/{kind}/{incident_id}` 均注册为 GET。
- Fake DB 直调 `get_incident_detail`：`rca` / `report` / `alert` 三种分支返回结构、`actions`、
  `related`、`report.download`、空态均符合契约；跨团队记录返回 404。
- 辅助函数直调：Top3 持久化 / 派生、证据兼容 dict/list、置信度、告警级别映射、时间窗均正常。
- `tsc`（临时等价 tsconfig）：本次新增 / 修改的前端文件 **0 错误**；
  仅剩改动前已存在的 `incident-timeline.tsx / datasources.tsx / users.tsx` 报错。
- 未执行任何 `docker build/up/restart`，未启动新服务，未修改 `src/lib/api.ts` / hooks / 其它 pages。
