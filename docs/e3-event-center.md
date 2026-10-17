# E3 · 统一事件中心 + 权限位接线

> 改动文件：`backend/app/routes/incidents.py`（新建）、`backend/app/main.py`、`backend/app/routes/alerts.py`、`backend/app/routes/rca.py`、`src/pages/incidents.tsx`（新建）、`src/routes.tsx`、`src/components/layout/nav-config.ts`、`docs/e3-event-center.md`（新建）。
> 未改表结构、未改 `src/lib/api.ts`、未改知识库 / RCA 页 / 告警页；现有接口语义保持不变，新增聚合接口为只读。

## 1. 后端：`GET /api/incidents`

注册位置：`main.py` → `app.include_router(incidents.router, prefix="/api/incidents")`。

| 项目 | 行为 |
| --- | --- |
| 鉴权 | 登录态（`Depends(get_current_user)`）；未登录 / 令牌失效 → 401 |
| 团队隔离 | 全部查询强制 `team_id == user.team_id`；跨团队数据不会出现在结果中，也没有可探测的单条详情路径 |
| 只读 | 仅 SELECT；不写库、不改状态、不触碰现有 `/api/alerts/*`、`/api/rca/*` 契约 |
| 幂等 | 可安全重放 / 刷新 / 轮询 |

### 1.1 Query 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tab` | `inbox` \| `active` \| `reports` | `inbox` | 非法值 → 422（FastAPI `Literal` 校验） |
| `page` | int ≥ 1 | 1 | 页码 |
| `page_size` | int 1–100 | 20 | 每页条数 |
| `search` | string ≤ 200 | — | 模糊搜索，按下述字段匹配；空白串按“无搜索”处理 |

### 1.2 三个 tab 的数据来源

| tab | 数据源 | 过滤条件 | 排序 |
| --- | --- | --- | --- |
| `inbox` | `alerts`（`Alert`） | `status IN ('pending','triggered','coalesced')`（复用 `alert_pipeline.INBOX_STATUSES`） | `created_at DESC, id DESC` |
| `active` | `rca_sessions`（`RcaSession`） | `status IN ('QUEUED','RUNNING')` | `created_at DESC, id DESC` |
| `reports` | `rca_reports` JOIN `rca_sessions` | 会话 `status = 'COMPLETED'`（团队归属以会话为准） | `rca_reports.created_at DESC, id DESC` |

搜索字段：
- inbox：`alert_uid / ci_name / ci_application / content / source / ip`，搜索串为纯数字时额外匹配 `alerts.id`；
- active：`service_name / trigger_reason / root_cause_summary`，纯数字时额外匹配 `rca_sessions.id`；
- reports：`service_name / category / root_cause / 会话 service_name`，纯数字时额外匹配 `rca_reports.id` 与 `session_id`。

### 1.3 响应契约

`200 OK`：

```json
{
  "items": [
    {
      "id": "alert-12",
      "kind": "alert",
      "title": "Nginx 连接池耗尽",
      "service": "Nginx",
      "severity": "重要",
      "status": "pending",
      "created_at": "2026-10-17T12:00:00Z",
      "rca_session_id": null,
      "actions": ["trigger", "dismiss", "open_alerts"]
    },
    {
      "id": "rca-42",
      "kind": "rca",
      "title": "Nginx · RCA #42",
      "service": "Nginx",
      "severity": null,
      "status": "RUNNING",
      "created_at": "2026-10-17T11:58:00Z",
      "rca_session_id": 42,
      "actions": ["open_rca", "cancel"]
    },
    {
      "id": "report-7",
      "kind": "report",
      "title": "连接池配置过小导致耗尽",
      "service": "Nginx",
      "severity": null,
      "status": "COMPLETED",
      "created_at": "2026-10-17T11:30:00Z",
      "rca_session_id": 42,
      "actions": ["open_rca", "download_md", "download_html"]
    }
  ],
  "total": 3,
  "counts": { "inbox": 12, "active": 2, "reports": 57 }
}
```

字段说明：
- `id`：复合字符串（`alert-*` / `rca-*` / `report-*`），因为三张表主键会重叠；`rca_session_id` 才是跨页跳转/下载用的会话主键。
- `kind`：`alert`（收件箱告警）/ `rca`（进行中会话）/ `report`（已完成报告）。
- `title`：告警取 content（回退 uid / ci_name / `告警 #id`）；进行中取 `服务 · RCA #id`；报告取根因结论（回退分类 / 服务）。服务端压缩空白并截断 200 字。
- `severity`：告警按 `severity_level` 映射中文级别（严重/重要/一般/告警/提示），无级别时回退原始 `severity`；进行中 / 报告为 `null`（源表无级别）。
- `status`：告警为 `pending/triggered/coalesced`；RCA / 报告为 `QUEUED/RUNNING/COMPLETED`。
- `actions`：建议动作键，前端可按需渲染、未知键忽略：
  - alert：`pending` 时 `["trigger","dismiss","open_alerts"]`；有 `rca_session_id` 时追加 `open_rca`；否则 `["open_alerts"]`；
  - active：`["open_rca","cancel"]`；
  - report：`["open_rca","download_md","download_html"]`。
- `total`：当前 tab + 当前 `search` 下的总条数。
- `counts`：三个 tab 的**团队级总数**，不受 `search` / `page` 影响（用于 tab 徽标）。

错误：未认证 401（统一错误信封，`request_id` 可用）；`tab`/`page`/`page_size`/`search` 非法 → 422。无单条详情接口，因此不存在 IDOR 探测面。

## 2. 前端：`/incidents` 事件中心

- `src/routes.tsx`：新增懒加载路由 `{ path: "/incidents", Component: lazy(() => import("@/pages/incidents")) }`。
- `nav-config.ts`：「工作台」组新增「事件中心」（`Inbox` 图标，`/incidents`），位置在「概览」之后；原「告警中心」「RCA 分析」「历史记录」入口全部保留。
- 页面三 tab：收件箱 / 进行中 / 报告库；tab 徽标显示 `counts`。
- 统一搜索：输入框 350ms 防抖写入 URL `search`，并把 `page` 重置为 1；清空搜索即删除该参数。
- 统一分页：上一页/下一页写入 URL `page`；`page_size` 固定 20（后端上限 100）。
- URL 同步：`?tab=active&page=2&search=nginx` 为唯一状态源，浏览器前进/后退、直接打开链接均可还原视图；默认无参数即 `tab=inbox&page=1`。
- 行内动作（只做跳转 / 下载，不改业务）：
  - `open_rca` → `navigate("/rca?s=<rca_session_id>")`（沿用 RCA 页已有的 `?s=` 打开详情逻辑）；
  - `open_alerts`（告警行）→ `navigate("/alerts")`；
  - 报告行 → `reportApi.download(sessionId, "md"|"html")`，Blob + object URL 客户端保存（token 不进 URL）；
  - `cancel`（仅进行中行、且当前用户含 `rca_terminate`）→ `ConfirmDialog` 二次确认后调用既有 `rca.cancel(sessionId)`，刷新列表。
- **未新增 `src/lib/api.ts` 方法**：聚合接口在页面内用 `fetch("/api/incidents?…")` + `Authorization: Bearer <token>`（`localStorage.liumai_token`）实现；401 与 api.ts 一致清理登录态并跳转 `/login`。
- 权限获取：`authApi.permissions()`（既有方法）读取 `rca_terminate`；接口失败时回退 `role === ADMIN || OPERATOR`。页面级按钮禁用（如无 `trigger_mode`/`inbox_delete` 时不渲染触发/忽略）留待后续，本次未做。
- 视觉：复用现有 `Card / Tabs / Badge / Button / ConfirmDialog / Skeleton`，表格与历史记录页风格一致；空态、加载骨架、错误重试均有。

## 3. 权限接线（12 权限位）

鉴权依赖统一为 `app.auth.require_permission(...)`（既有工厂）；只替换路由的权限依赖，未改任何业务逻辑、未改响应结构。所有 403 会落到统一错误信封：`error.code = "PERMISSION_DENIED"`，`error.details.permission` 为权限键。

| 接口 | 方法 | 接入权限常量 | 任务中的写法 | 说明 |
| --- | --- | --- | --- | --- |
| `/api/alerts/batch-trigger` | POST | `PERM_TRIGGER_MODE` (`trigger_mode`) | `PERM_TRIGGER` | `auth.py` 无 `PERM_TRIGGER`，12 位中与“触发”对应的实际常量为 `trigger_mode` |
| `/api/alerts/{id}/trigger` | POST | `PERM_TRIGGER_MODE` (`trigger_mode`) | `PERM_TRIGGER` | 单条人工触发，同上 |
| `/api/alerts/{id}/dismiss` | POST | `PERM_INBOX_DELETE` (`inbox_delete`) | `PERM_INBOX_DELETE` | 忽略 = 从收件箱移出 |
| `/api/alerts/trash/clear` | POST | `PERM_TRASH_CLEAR` (`trash_clear`) | `PERM_TRASH_CLEAR` | 清空垃圾箱 |
| `/api/alerts/purge` | POST | `PERM_TRASH_CLEAR` (`trash_clear`) | `PERM_TRASH_CLEAR` | 按保留期手动清理收件箱/垃圾箱（统一按“清空”映射） |
| `/api/alerts/policy` | PUT | `PERM_POLICY` (`policy`) | `PERM_POLICY` | 策略保存 |
| `/api/rca/sessions/{id}/rerun` | POST | `PERM_RCA_TERMINATE` (`rca_terminate`) | `PERM_RCA_TERMINATE` | 重新分析 |
| `/api/rca/sessions/{id}/cancel` | POST | `PERM_RCA_TERMINATE` (`rca_terminate`) | `PERM_RCA_TERMINATE` | 本次之前已接线，复核确认 |

说明：
- `alerts.py` 没有单条 / 批量“删除告警”接口（只有 `trash/clear` 与 `purge`）；任务中的“删除”落在 `PERM_INBOX_DELETE`（忽略/移出收件箱）与 `PERM_TRASH_CLEAR`（清空/清理）两处。
- Webhook 令牌管理（`/webhook-tokens`、`/webhook/rotate-token`）不在本次映射表内，保持 `require_admin` 不变。
- 角色矩阵（来自 `auth.py` 既有定义）：ADMIN 拥有全部 12 位；OPERATOR 拥有 `trigger_mode / inbox_delete / inbox_autoclear / trash_clear / trash_autoclear / rca_terminate / report_export / kb_annotate`；VIEWER 无任何写权限。
- 因此接线后：批量/单条触发、忽略、清空、重新分析、终止对 OPERATOR 开放；策略保存仍仅 ADMIN；VIEWER 全部 403。

## 4. 验收命令

```bash
# 0) 后端语法 / 路由注册
python -m py_compile backend/app/routes/incidents.py \
  backend/app/routes/alerts.py backend/app/routes/rca.py backend/app/main.py

# 0.1) 路由与权限依赖自检（在 backend/ 下，需 JWT_SECRET）
JWT_SECRET=test python -c "
from fastapi import FastAPI
from app.routes import incidents
app = FastAPI(); app.include_router(incidents.router, prefix='/api/incidents')
print([r.path for r in app.routes if 'incidents' in getattr(r, 'path', '')])
"

# 1) 登录拿 token（替换账号密码）
BASE=http://localhost:8000
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r .token)

# 2) 三个 tab（注意：counts 不随 search/page 变化）
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/incidents?tab=inbox&page=1&page_size=5" | jq '{total,counts,items:[.items[]|{id,kind,status,actions}]}'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/incidents?tab=active&page=1&page_size=5" | jq '{total,counts,items}'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/incidents?tab=reports&page=1&page_size=5" | jq '{total,counts,items}'

# 3) 搜索 + 分页
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/incidents?tab=inbox&search=Nginx&page=1&page_size=2" | jq '{total,counts,n:(.items|length)}'

# 4) 未认证 → 401；非法 tab → 422
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/incidents?tab=inbox"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/incidents?tab=bogus"

# 5) 权限位：VIEWER 调写接口应 403（code=PERMISSION_DENIED，details.permission=…）
curl -s -X POST -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"ids":[1]}' \
  "$BASE/api/alerts/batch-trigger" | jq '.error'
curl -s -X POST -H "Authorization: Bearer $VIEWER_TOKEN" "$BASE/api/alerts/1/dismiss" | jq '.error'
curl -s -X POST -H "Authorization: Bearer $VIEWER_TOKEN" "$BASE/api/rca/sessions/1/rerun" | jq '.error'
curl -s -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" "$BASE/api/alerts/trash/clear" | jq

# 6) 前端类型检查：TS7 已移除 baseUrl，`tsconfig.app.json` 直跑会报 TS5102。
#    复制其 compilerOptions、去掉 baseUrl（paths 保留）到临时文件后执行，检查完删除：
#    ./.tsconfig.check.json → ./node_modules/.bin/tsc -p .tsconfig.check.json --noEmit
```

前端人工验收：刷新现有 Web GUI → 侧边栏「工作台 → 事件中心」→ 切换三个 tab，观察 URL 变为
`/incidents?tab=active&page=1&search=…`；报告行下载 MD/HTML；进行中行（有 `rca_terminate` 的角色）出现「终止」。

## 5. 本次验证记录

- `python -m py_compile`（incidents / alerts / rca / main）→ 通过。
- 路由注册：`/api/incidents` 与 `/api/incidents/` 均为 GET；依赖注入自检显示：`purge`、`trash/clear` → `trash_clear`；`policy` PUT → `policy`；`batch-trigger`、`{id}/trigger` → `trigger_mode`；`{id}/dismiss` → `inbox_delete`；`rerun`、`cancel` → `rca_terminate`。
- 权限矩阵直调：ADMIN 全部允许；OPERATOR 允许 `trigger_mode / inbox_delete / trash_clear / rca_terminate`，拒绝 `policy`；VIEWER 全部 403。
- SQL 编译自检：inbox / active / reports 的列表与 count 语句在 PostgreSQL 方言下均可编译，reports 含 `JOIN rca_sessions`。
- Fake DB 直调 `list_incidents`：三个 tab 的条目、`actions`、`counts`、`total` 均符合契约。
- `tsc`（临时等价 tsconfig）：`src/pages/incidents.tsx`、`src/routes.tsx`、`src/components/layout/nav-config.ts` **0 新增错误**；其余报错为改动前已存在的 `incident-timeline.tsx / datasources.tsx / knowledge.tsx / users.tsx` 问题。
- 未执行任何 docker 命令，未启动新服务。
