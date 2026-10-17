# 六脉 Liumai 平台重构路线图（可执行版）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0（架构评审稿） |
| 代码快照 | 2026-10-17 21:10（`git HEAD=127a71d` + 未提交改动：`backend/app/routes/hermes.py`、`docs/hermes-gateway-layer.md`、`main.py` 挂载、Path C、报告库 ZIP） |
| 分析方式 | **只读静态分析**：`read` + `rg`，未修改任何代码文件，未执行任何 `docker` 命令 |
| 范围 | 前端 `src/`、后端 `backend/app/`、`docker/nginx`、Hermes 源码 `api_server.py`、`docs/` 与 `hermes-docs/` |
| 约束 | 行业域=AIOps；目标=前端极简/丝滑、后端吃满 Hermes；交付=三阶段路线图 + 不丢功能迁移 + 回滚 |

> 阅读顺序：§0 结论 → §4 路线图 → §5 迁移与回滚。§1/§2 是证据，评审时可跳读。
> 行号基于上述快照；`routes/hermes.py` 为并发进行中的新文件，行号可能漂移。

---

## 0. 结论摘要

1. **平台已经从"demo"长成"多入口单体"**：前端 53 文件 / 14,357 行、后端 31 文件 / 16,755 行、148 个 HTTP 端点、18 个前端 API 域、**0 个自动化测试**。规模不是问题，**边界缺失**才是。
2. **Hermes 访问散在 6 个模块、约 11 处临时 `httpx` 调用、5 套 URL 拼装规则**（`auth.py`、`chat.py`、`jobs.py`、`knowledge.py`、`distiller.py`、`hermes.py`）。同一件事（把 `/v1` 去掉/补上）被正则、`endswith`、字符串切片各写一遍。这是后端最大的结构性债务。
3. **已启动的只读 `routes/hermes.py` 方向正确但层次偏低**：它是"路由级代理"，不是"网关客户端"；且把能力位/超时/错误映射散在路由里，写操作仍留在 4 个老路由。正确做法是**下沉为 `integrations/hermes/` 服务层，路由只做鉴权+透传**（§2.3）。
4. **Hermes 有一半能力没用上**：`/api/sessions` 全生命周期（列表/搜索/改标题/pin/归档/fork/消息/模型锁）、`resolve-unknown`、`Idempotency-Key`、`/v1/artifacts`、`/api/model/options` 均 **0 引用**。`/v1/responses` 与 Runs 重叠，建议**明确不引入**。
5. **对话的"丝滑"有个硬伤**：`chat_sessions` 表**没有 `hermes_session_id` 列**，会话映射只活在 React state 里；`loadSession` 主动把 `hermesSessionId` 置空（`useChat.ts:579`），于是**每次从历史打开会话都要全量重放历史**，且**切换页面会 abort 正在跑的 run**（`useChat.ts:632-634`）。运维场景下"去看一眼告警再回来"= 任务被杀。
6. **前端设计 token 已存在，但执行层在漏**：`globals.css` 定义了完整的 surface/text/interactive/status/motion 语义层，页面却在用 `bg-white`、`#6b6b80`、`text-[11px]` 硬编码；暗色主题因此**半失效**。同时 `App.tsx` 内联 13 个导航项、双层嵌套 `<Routes>`、全量同步 import（无 lazy），首屏与可维护性双输。
7. **信息架构有三处同义反复**：`/rca`（含"分析会话/报告库/根因知识库"）、`/history`（"所有 RCA 分析会话"）、`/alerts`（含触发与报告入口）、概览页（最近会话/队列）**四处都在讲 RCA 会话**；RCA 还有三条发起路径（告警触发、RCA 页新建、对话 rca 模式带时间窗），语义各不相同。
8. **交付形态是"能跑"，不是"可验收"**：无测试、无统一错误体（117 处 `HTTPException` 直出，前端把 JSON 文本塞进 toast）、无 request-id、无权限位（只有 `require_admin` 硬编码）、无性能基线。重构必须先把"可验收"补齐，否则无法证明"不丢功能"。

### Top 5 优先动作（建议本周启动）

| # | 动作 | 产出 | 对应任务 |
|---|---|---|---|
| 1 | 把 `routes/hermes.py` 下沉为 `integrations/hermes/` 服务层网关，消灭 6 处临时 `httpx` 与 5 套 URL 拼装 | 1 个客户端 + 1 份契约 + respx 单测 | G1 |
| 2 | 统一错误信封 + `X-Request-ID` + 权限位（12 个 bit），替换 `require_admin` 散点 | 错误可诊断、权限可声明 | G2 |
| 3 | 设计 token 收口（组件级 token）+ 路由表驱动导航/⌘K/懒加载 | 前端可"极简" | G3/G4 |
| 4 | 会话落库映射（`hermes_session_id`/`active_run_id`）+ 切页不杀 run + 刷新自动 reattach | 对话可恢复、可续聊 | E1 |
| 5 | 事件中心合并（告警+进行中+报告库）+ RCA 终止（网关 `stop_run`）+ 历史页并入 | 少三次点击、可止损 | E3 |

### 目标架构一图

```
┌──────────────────────────── Browser (React 19) ────────────────────────────┐
│ routes.tsx（唯一路由表）  features/*（对话/事件/知识/任务）  components/*     │
│ lib/api-client（统一错误/取消/重试）   lib/sse（统一事件流）   lib/status     │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │ /api/*（同源，Nginx 反代，SSE 不缓冲）
┌───────────────────────────────────▼────────────────────────────────────────┐
│ FastAPI  api/routers（鉴权 + 校验 + DTO，≤300 行/文件）                      │
│          domain/services（告警策略 / RCA 编排 / 知识生命周期 / 巡检）        │
│          core（errors / permissions / request-id / pagination / metrics）    │
│          integrations/hermes（唯一出口：transport + capabilities + events）  │
└───────┬───────────────────────────────┬────────────────────────────────────┘
        │ SQLAlchemy(async)             │ HTTP（1 个共享 AsyncClient）
┌───────▼────────┐              ┌───────▼─────────────────────────────────────┐
│ PostgreSQL 16  │              │ Hermes Gateway :8642                         │
│ 业务事实层      │              │ /v1/runs · /api/sessions · /api/jobs         │
│ + 会话映射      │              │ /v1/capabilities · /v1/artifacts · /health   │
└────────────────┘              └──────────────────────────────────────────────┘
```

**职责一句话**：Hermes 是"Agent 运行时与工具执行面"；六脉是"运维事实层 + 治理层（权限/审计/通知/知识生命周期）+ 呈现层"。任何"重试/队列/工具调用/长任务"尽量下沉 Hermes，任何"业务语义（告警级别、触发策略、报告结构、知识归属）"留在平台。

---

## 1. 现状盘点

### 1.1 规模总览

| 维度 | 数值 | 说明 |
|---|---|---|
| 前端 | 53 文件 / 14,357 行 | 页面 6,451 行；`api.ts` 1,714 行；对话组件 2,357 行（ChatPanel 1,083 + ChatMessage 589 + useChat 685） |
| 后端 | 31 文件 / ≈17,400 行（含进行中的 `routes/hermes.py` 651） | 路由 8,410 行 / 14 个 router / **148 端点**；服务 7,657 行；模型 691 行 |
| UI 基础件 | 18 个（`components/ui/*`，1,541 行） | shadcn/base-ui 混用，封装良好但**缺业务级组件** |
| 测试 | **0** | 全仓无 `test_*.py` / `*.test.tsx` / e2e |
| 最大文件 | 前端 `api.ts` 1,714；后端 `rca_runner.py` 2,084 · `alert_pipeline.py` 1,586 · `routes/chat.py` 1,525 · `routes/alerts.py` 1,342 · `routes/knowledge.py` 1,299 | 后端前 5 合计 7,836 行（≈45%） |

### 1.2 前端路由与页面清单（`src/App.tsx:89-115`）

| 路由 | 文件 | 行数 | 页面职责 | 主要 API | 现状问题 |
|---|---|---|---|---|---|
| `/` | `pages/dashboard.tsx` | 253 | 队列/最近会话/规则数/入口卡片 | `rca.queue`、`history.list`、`ruleApi.list`、`hermesDiscovery` | 与 `/rca`、`/history` 内容重叠；卡片文案写死数据源种类 |
| `/alerts` | `pages/alerts.tsx` | 1,259 | 收件箱 / 垃圾箱 / 触发策略+Webhook+通知渠道 | `alertsApi.*`（17 端点） | **25 个 useState**，3 个模块挤在一个文件；策略表单与告警列表同页 |
| `/chat` | `pages/chat/chat-page.tsx` → `ChatPanel` | 9 + 1,083 | 会话侧栏 + 流式对话 + 模式/模型/文件 | `chatHistory`、`chatRuns`、`chatRunEvents`、`chatModes` | 会话侧栏用平台表，不读 Hermes；切页杀 run；无搜索/重命名/fork |
| `/rca` | `pages/rca/rca-page.tsx` | 688 | 分析会话 / 报告库 / 根因知识库 | `rca.*`、`reportApi.*`、`rootCauseApi.*` | 与 `/history` 重复；无终止；状态标签/颜色自建 |
| `/rules` | `pages/rules/rules-page.tsx` | 448 | 规则条件行编辑器 + 启停 | `ruleApi.*` | 表单校验偏弱；无命中预览/试算 |
| `/history` | `pages/history/history-page.tsx` | 128 | 所有 RCA 会话（客户端分页） | `historyApi.rca` | 拉最多 10×100 行到前端分页，规模上去必卡 |
| `/settings` | `pages/settings.tsx` | 559 | Hermes/LLM/LDAP/模式配置 + 测试 | `authApi.*`、`hermesDiscovery`、`chatModes` | 4 类配置同页；测试结果与保存状态耦合 |
| `/users` | `pages/users.tsx` | 306 | 用户 CRUD/角色 | `userApi.*` | 无批量、无审计入口 |
| `/skills` | `pages/skills.tsx` | 298 | Hermes 技能/工具集浏览 | `hermesDiscovery.*` | 只读；无法启停（Hermes 侧才可） |
| `/datasources` | `pages/datasources.tsx` | 468 | 数据源 CRUD/测试/查询/模板 | `dataSourceApi.*` | 查询结果无图表；测试与模板同页 |
| `/profile` | `pages/profile.tsx` | 312 | 资料/改密/会话/主题/统计 6 tab | `profileApi.*` | 主题切换页面级，暗色因硬编码不全生效 |
| `/knowledge` | `pages/knowledge.tsx` | 566 | 知识库/Webhook/命中测试/蒸馏 4 tab | `knowledgeApi.*`（22 端点） | 入库无进度；命中无分数/来源；27 处硬编码样式 |
| `/systems` | `pages/systems.tsx` | 284 | 应用系统 + 资源关联（L0/L1/L2） | `systemApi.*` | 与知识/数据源无交叉入口 |
| `/jobs` | `pages/jobs.tsx` | 386 | Hermes 计划任务 CRUD/暂停/立即跑 | `jobsApi.*` | 只用 name/schedule/prompt；无最近结果/失败原因；仅 ADMIN |
| `/help` | `pages/help.tsx` | 223 | 静态帮助 4 tab | — | 内容与真实功能漂移风险 |
| `/login` | `pages/login.tsx` | 264 | 登录 + 首启向导 + 密码强度 | `authApi.*` | 自己 fetch，绕过 `api.ts` |

**导航**：`App.tsx:45-66` 硬编码 13 项（11 + 2 管理员），**无分组、无面包屑、无命令面板、无 badge**（`SidebarItem.badge` 支持但从未使用）。`/profile`、`/help` 不在侧栏，属"隐性路由"。

**布局**：`components/layout/dashboard-shell.tsx` 350 行，`h-dvh` 网格 = header 56/64px + 左栏 240/56px + 主区；右抽屉固定 400px。问题：
- 移动端菜单按钮只做"折叠"（`dashboard-shell.tsx:119-126`），侧栏仍是网格列（`:178-184`），**小屏被 56px 永久占用**，未用 Sheet 覆盖；
- `activeIncidentCount` 从未被 `App.tsx` 传入（`App.tsx:68-80` 只传 4 个 prop），头部告警铃**永远不会出现**；
- 选中态/弹层用 `bg-white` 与 `#6b6b80`（`:214-215`、`:287`），暗色下变白块。

### 1.3 设计 token 现状（`src/styles/globals.css`，243 行）

| 层 | 已有 | 缺口 |
|---|---|---|
| 语义色 | surface 3 级、text 4 级、interactive 3 态、status 4 态、border 2 级、overlay | 缺图表色板、风险/置信度专用色、图谱分类色 |
| 排版 | `--font-sans/mono`、`--font-size-data`、weight 4 档、line-height 3 档 | 未定义页面标题/正文/元信息三级字号 token，页面各写 `text-[11px]/[13px]` |
| 圆角/阴影 | 5 档 radius、3 档 shadow | 阴影无"层级"语义（卡片/弹层/抽屉同 `shadow-lg`） |
| 动效 | duration 5 档 + 3 条 easing | 无 `prefers-reduced-motion` 之外的使用约定；页面多数无过渡 |
| 兼容层 | `@theme inline` 映射 24 个 shadcn 变量 | **两套 token 并存**（语义 `--color-*` 与 shadcn `--*`），值手工重复，已开始漂移 |
| 暗色 | `.dark` 覆盖语义色与 shadcn 变量 | 组件硬编码 `bg-white` 导致半失效；无暗色回归校验 |

> 结论：token 不是"没有"，是"没有唯一出口"。阶段一只做两件事——**补组件级 token** + **禁止页面写死颜色**，不做大改版。

### 1.4 `api.ts` 规模与分层（1,714 行）

- 结构：`request()`（`api.ts:13-50`，48 行）→ 18 个域对象（`rca`、`reportApi`、`ruleApi`、`historyApi`、`chatRuns`、`authApi`、`dataSourceApi`、`systemApi`、`hermesDiscovery`、`knowledgeApi`、`userApi`、`chatModes`、`chatHistory`、`profileApi`、`jobsApi`、`alertsApi`、`rootCauseApi`、`auditApi`）+ 40 余个 interface。
- 优点：类型齐全、路径集中、401 统一清理登录态。
- 缺口（重构必须补）：
  1. **无错误结构**：非 2xx 直接 `throw new Error(await res.text())`（`:43-46`），页面 `toast.error(err.message)` → 用户看到 `{"detail":"..."}`；
  2. **无取消/超时**：`request()` 不接受 `AbortSignal`，除 SSE 外无法取消；
  3. **无重试/去重**：切 tab 重复请求；
  4. **无上传**：`FormData` 走各页面自己 `fetch`（`knowledge.tsx`、`profile.tsx` 头像）；
  5. **无分页/查询串规范**：各域自己拼 `URLSearchParams`；
  6. **`auth-context.tsx` 与 `login.tsx` 绕过 `api.ts`**（各写 4 处 fetch）。

### 1.5 后端路由清单（14 个 router / 148 端点）

| Router（前缀） | 文件 | 行数 | 端点数 | 越界/重叠点 |
|---|---|---|---|---|
| `alerts` `/api/alerts` | `routes/alerts.py` | 1,342 | 17 | 接入解析 + 去重 + 触发 + 策略 + 通知配置 + 统计全在一个文件；**路由内直接写 SQL 与业务策略** |
| `chat` `/api/chat` | `routes/chat.py` | 1,525 | 27 | SSE 转发 + Runs 代理 + 会话 CRUD + 模式 CRUD + 技能缓存 + 文件转换 + LLM 直连 + 健康/信息；**7 个职责** |
| `knowledge` `/api/knowledge` | `routes/knowledge.py` | 1,299 | 22 | 文档入库（含 MarkItDown 转换、Hermes 提示、分块）+ Webhook + 命中测试 + 蒸馏 + 盲区 + 过期；`root_cause` 也挂同一前缀 |
| `rca` `/api/rca` | `routes/rca.py` | 1,157 | 10 | 会话/报告/导出/重跑；渲染 Markdown/HTML 也在其中；**无终止端点** |
| `auth` `/api/auth` | `routes/auth.py` | 633 | 14 | 登录/setup/LDAP/Hermes 配置/LLM 配置/欢迎语生成；**2 处手搓 Hermes/LLM HTTP** |
| `rules` `/api/rules` | `routes/rules.py` | 358 | 6 | CRUD 正常；引擎在 `services/rule_engine.py`（已解耦） |
| `users` `/api/users` | `routes/users.py` | 329 | 10 | 用户 + 个人中心 + 会话吊销 + 统计 |
| `datasources` `/api/datasources` | `routes/datasources.py` | 240 | 11 | CRUD + 模板 + 测试 + 查询 |
| `systems` `/api/systems` | `routes/systems.py` | 238 | 8 | 系统 + 资源关联 |
| `root_cause` `/api/knowledge` | `routes/root_cause.py` | 217 | 5 | **与 knowledge 同前缀不同 router**，OpenAPI tag 分裂 |
| `history` `/api/history` | `routes/history.py` | 205 | 2 | 读模型 + 协作事件；与 `rca` 会话列表重叠 |
| `jobs` `/api/jobs` | `routes/jobs.py` | 141 | 8 | 纯代理；**每次请求新建 `httpx.AsyncClient`**、URL 用正则去 `/v1` |
| `audit` `/api/audit` | `routes/audit.py` | 75 | 1 | 只读列表，无日期筛选 |
| `hermes` `/api/hermes` | `routes/hermes.py`（**进行中**） | 651 | 7 | 只读代理；鉴权只在 `get_current_user`，**任意 VIEWER 可读全部 Hermes 会话** |

### 1.6 服务层清单与依赖

| 服务 | 行数 | 职责 | 问题 |
|---|---|---|---|
| `rca_runner.py` | 2,084 | RCA 执行（Runs/回退 Chat）、并发闸门、心跳、僵尸回收、重入队、报告解析、通知、后续会话 | 一个文件承担 8 件事；`run_id` 只写进 `evidence` JSONB（`rca_runner.py:2016-2021`），**不可查询**；心跳寄生在 `CollaborationEvent.metadata.kind`（`:367-403`），时间线被心跳污染 |
| `alert_pipeline.py` | 1,586 | 归一化/去重/合并/触发策略/建会话/人工批量 | 与 `rca_runner` 共同推进会话状态，边界靠约定 |
| `hermes.py` | 1,144 | Hermes 客户端（Chat/Runs/Skills/Capabilities/ModelOptions/Sessions 状态） | 已是"事实上的网关"，但仍被 4 个路由绕过；`chat_stream` 单方法 324 行；内置 2 处临时 `AsyncClient` |
| `rule_engine.py` | 918 | 规则条件求值 | 与 `alerts` 策略重复概念（规则 vs 全局策略） |
| `datasource_adapters.py` | 517 | Prometheus/Zabbix/ClickHouse/API 适配 | Path C 已接入（`docs/path-c-notes.md`） |
| `notify.py` / `wecom.py` | 512 / 206 | 多渠道通知 / 企微客户端 | `wecom` 自建 4 个 `AsyncClient`（`wecom.py:72/118/162/198`） |
| `distiller.py` | 461 | 对话蒸馏知识 | 又一套 Hermes URL 拼接（`:253-254`） |
| `ldap.py` | 194 | LDAP/AD | 正常 |
| `audit.py` | 35 | 审计写入 | 只有写入，无保留期 |

**模型层** `models/__init__.py`（691 行，24 个类）：`Team/User/DataSource/AlertRule/RcaSession/CollaborationEvent/ChatSession/ChatMessage/SystemConfig/KnowledgeDocument/UserChatMode/DistilledKnowledge/ChatMode/AppSystem/AppSystemResource/Alert/RcaReport/RootCauseKnowledge/AuditLog`。
关键缺口：`ChatSession` **无 `hermes_session_id` / `active_run_id` / `model` / `pinned` / `archived`**（`:331-359`）；`ChatMessage` 无 `reasoning/run_id/seq/usage/status`（`:362-388`）；`RcaSession` 无 `run_id/heartbeat_at/stop_requested_at`（`:235-292`）。

### 1.7 `main.py` 装配（254 行）

- lifespan（`:23-184`）：4 个后台任务——技能缓存刷新、自动蒸馏、RCA 僵尸巡检、启动接管/重入队。**编排逻辑写在入口文件里**（约 160 行），应下沉 `services/runtime.py`。
- 路由装配（`:230-244`）：14 个 `include_router`，前缀与 tag 不一致（`root_cause` 跟 `knowledge` 共前缀）。
- 无 `exception_handler`、无 request-id 中间件、无慢请求日志、无 metrics。
- 头像目录硬编码 `/app/data/avatars`（`:252-254`），本地开发会尝试在 `C:\app\data` 建目录。

### 1.8 职责越界 / 重复 Top 8

| # | 现象 | 证据 | 影响 | 阶段 |
|---|---|---|---|---|
| 1 | Hermes HTTP 调用分散 6 处 | `auth.py:444-470`、`chat.py:741-760`/`:1402`/`:1445`、`jobs.py:14-62`、`knowledge.py:89-166`、`distiller.py:245-270`、`wecom.py` | 超时/重试/错误/凭据策略各写一遍，故障难定位 | P1-G1 |
| 2 | URL 形态归一 5 套实现 | `jobs.py:31-35`（正则）、`auth.py:605-619`（分支）、`chat.py:741-743`（包含判断）、`hermes.py:907-912`（切片）、`routes/hermes.py:74-87` | `http://h:8642` 与 `http://h:8642/v1` 行为不一致 | P1-G1 |
| 3 | 路由内写业务+SQL | `alerts.py`、`rca.py`、`knowledge.py`、`chat.py` 合计 5,323 行 | 无法单测；改一处牵动全局 | P1-G2 |
| 4 | RCA 会话四处呈现 | `/rca`（3 tab）、`/history`、`/alerts`、`/`（概览） | 用户不知道"该去哪看"，维护 4 套过滤/分页 | P2-E3 |
| 5 | 状态/级别映射 4 套 | `alerts.tsx:77/93`、`rca-page.tsx:37`、`history-page.tsx:11`、`dashboard.tsx:15` | 同一状态不同颜色/文案 | P1-G3 |
| 6 | 4 个 Logo 组件 | `liumai-brand/logo/logo-full/login-logo`（245 行） | 品牌微调要改 4 处 | P1-G3 |
| 7 | 会话真相双份 | 平台 `chat_sessions` vs Hermes `state.db`，无映射列 | 刷新丢上下文、无法 fork/搜索 | P2-E1 |
| 8 | 双层 `<Routes>` + 全量 import | `App.tsx:89-115`；无 `lazy` | 首次加载全量页面代码；嵌套路由语义混乱 | P1-G4 |

> 并发说明：分析期间检测到 `routes/hermes.py`、`docs/hermes-gateway-layer.md`、`main.py` 于 21:08 被写入（另一个会话正在补只读网关）。本文档把它视为**已完成 40% 的 G1**，路线图给的是"如何收口"，不重复造。

---

## 2. Hermes 能力对照与网关边界

### 2.1 事实校正（文档 vs 本机源码）

| 结论来源 | 说法 | 本机源码事实 | 处理 |
|---|---|---|---|
| `hermes-api-report.md` B.7 / 附录 | API Server 上**没有**会话列表/历史端点 | `api_server.py:1663-1672` 有完整 `/api/sessions*`；capabilities `session_resources/session_chat_streaming/session_fork/session_model_lock=true`（`:67-99`） | **以源码为准**；`/api/sessions` 可直接用 |
| `hermes-api-report.md` B.6 | `/v1/skills`、`/v1/toolsets` **不存在** | `api_server.py:1661-1662` 存在；平台已在用（`hermes.py:857-903`） | 报告过期，需修订 |
| `docs/hermes-gateway-layer.md` §7 | 会话端点"不在 API Server 契约内，纯 API Server 部署可能 404" | 本机构建在路由表内，且被 capabilities 声明 | 改为**能力位门控**，不写死"可能 404" |
| `docs/rca-webhook-gap.md` P0-1/P0-2/P1-3/P1-4/P1-5 | 规则未接引擎、无生命周期接管、无批量、无下载 | `rule_engine.py` 已接入（`alert_pipeline.py:1417`）、`main.py` 已有启动接管与 60s 巡检、`/batch-trigger` 已存在、`/report/download` 与 ZIP 导出已存在 | 文档需标注**已完成**，避免重复排期 |
| capabilities 静态位 | `jobs_admin=false`、`admin_config_rw=false` | `/api/jobs` 路由真实存在 | **不要**用静态位判断 jobs 可用性，用实际探测/404 降级 |
| 本机源码新增 | `/v1/artifacts/*`、`/v1/browser-control/*`、`/api/platforms/{p}/events`、`/api/cron/fire` | 均存在（`:1657-1692`） | 列入观察项，P3 起评估 |

> 注：`hermes-api-report.md` 实际位于**仓库根目录**（不在 `docs/`），`docs/` 下只有 `rca-webhook-gap.md`。两份文档均早于当前 Hermes 构建，引用前需按上表校正。

### 2.2 能力利用矩阵

| # | Hermes 能力 | 端点 | 平台现状 | 缺口/风险 | 价值 | 阶段 |
|---|---|---|---|---|---|---|
| 1 | Chat Completions 流式 | `POST /v1/chat/completions` | 已用（`hermes.py:362-686`） | 事件名/字段解析与前端耦合；`ping` 手工转发 | 中 | P1 |
| 2 | Runs 提交/轮询/事件/停止/steer/审批 | `/v1/runs*` | 已用（对话 + RCA） | **无 `Idempotency-Key`**；RCA **无终止端点**；无 `resolve-unknown` | 高 | P1/P2 |
| 3 | 会话资源 CRUD | `/api/sessions` | **0 引用** | 无映射列，刷新丢上下文；无法搜索/pin/归档 | 高 | P2-E1 |
| 4 | 会话内对话/流式 | `POST /api/sessions/{id}/chat[/stream]` | **0 引用** | 与 Runs 形成第三条路径，需明确"只用 Runs" | 低 | 明确不用 |
| 5 | 会话 fork | `POST /api/sessions/{id}/fork` | **0 引用** | 无法"从这条消息重开" | 中 | P2-E1 |
| 6 | 会话模型锁 | `POST /api/sessions/{id}/model` | **0 引用** | 模型选择仅请求级；切换会话不记忆 | 中 | P2-E1 |
| 7 | 模型目录 | `GET /api/model/options` | **0 引用**（前端读 provider `/v1/models`，`chat.py:1366-1419`） | 选择器与 Hermes 路由/别名/价格脱节 | 中 | P2-E1 |
| 8 | 能力探测 | `GET /v1/capabilities` | 间接使用（`hermes-info`） | 无统一"按位降级"门控；UI 靠猜 | 中 | P1-G1 |
| 9 | 技能/工具集 | `/v1/skills`、`/v1/toolsets` | 已用，5 分钟缓存（`main.py:36-54`） | 只读、无启用状态（Hermes 侧才有） | 低 | P2 |
| 10 | 任务 CRUD/暂停/立即执行 | `/api/jobs*` | 已用（纯代理，仅 ADMIN） | 无本地模型/审计/字段校验；每次新建 client；无"最近运行结果" | 中 | P2-E3 |
| 11 | 就绪检查 | `GET /health/detailed` | 新增只读代理 | 未纳入平台健康页/监控 | 中 | P1-G1 |
| 12 | Artifacts 上传/下载 | `/v1/artifacts/*` | **0 引用** | 报告/截图/附件无统一存储与鉴权 | 中 | P3 |
| 13 | 浏览器控制 | `/v1/browser-control/*` | **0 引用** | 巡检截图/前端排障潜力 | 低 | 观察 |
| 14 | 平台事件回调 | `/api/platforms/{p}/events` | **0 引用** | 通知回流/多渠道 last-mile | 低 | 观察 |
| 15 | 幂等键 | `Idempotency-Key` 请求头 | **0 引用** | 网络重试可能重复起 run（计费+重复动作） | 高 | P1-G1 |
| 16 | 未知准入恢复 | `/v1/runs/{id}/resolve-unknown` | **0 引用** | 网关重启后审批挂起无法收敛 | 中 | P2-E1 |
| 17 | Responses API | `/v1/responses` | **0 引用** | 与 Runs 重叠、语义不同 | — | **明确不引入** |

### 2.3 统一 Hermes 网关客户端：边界定义

**放在哪**：`backend/app/integrations/hermes/`（不是 `routes/`，不是 `services/hermes.py`）。`services/hermes.py` 保留为**兼容门面**，内部委托新包，6 个月后删除。

```
integrations/hermes/
├── __init__.py        get_gateway() / close_gateway() / reload()
├── transport.py       AsyncClient 生命周期、超时、重试、幂等、日志、URL 归一
├── capabilities.py    /v1/capabilities 快照 + TTL + requires() 门控
├── contracts.py       GatewayEvent / RunHandle / RunStatus / Capabilities / 数据类
├── errors.py          GatewayError 族（kind/retryable/hermes_code/request_id）
├── events.py          三种上游流 → 统一 GatewayEvent
├── runs.py            create/get/events/stop/steer/approve/resolve_unknown
├── sessions.py        list/get/patch/delete/messages/fork/model_lock
├── chat.py            complete/stream（OpenAI 兼容，供知识/蒸馏/兼容路径）
├── jobs.py            list/get/create/update/delete/pause/resume/run
└── meta.py            health_detailed/model_options/skills/toolsets/artifacts
```

| 边界项 | 规则 |
|---|---|
| **唯一出口** | 只有 `integrations/hermes/*` 允许 `import httpx` 访问 Hermes；路由/服务只调用 `get_gateway()`。巡检脚本用 `rg "httpx.AsyncClient" backend/app/routes` = 0 验收 |
| **URL 归一** | `transport.base_root`/`base_v1` 一处计算（接受带/不带 `/v1`、带尾斜杠、`/p/<profile>` 前缀），路由不得再出现 `re.sub(r"/v1$")` |
| **连接** | 进程级单例，配置变更时原子替换并 `aclose()` 旧 client；`main.py` lifespan 关闭 |
| **超时** | 元数据 10s / 任务 30s / 对话与 run 600s / SSE 读无上限（依赖 10-30s 心跳）/ artifacts 120s；全部可配置 |
| **重试** | 仅幂等 GET，2 次，200/800ms 抖动；POST 不自动重试，run/任务创建带 `Idempotency-Key: {request_id}` |
| **能力门控** | `await gw.requires("run_steer")` → 缺失时端点返回 **501**（`capability_unavailable`）而不是 500；前端按 `/api/platform/capabilities` 隐藏按钮 |
| **事件统一** | `GatewayEvent{type, run_id, seq, data}`；`type ∈ {run.started, text.delta, reasoning.delta, tool.started, tool.finished, approval.request, usage, run.completed, run.failed, run.cancelled, keepalive, unknown}`；`: keepalive` → `keepalive`，未知事件 → `unknown`（**永不抛错**） |
| **错误统一** | `GatewayUnavailable→502`、`GatewayTimeout→504`、`GatewayAuth→502(auth)`、`GatewayNotFound→404`、`GatewayConflict→409`、`AgentFailed→422`、`ProtocolError→502`；上游 `request_id` 透传到错误体 |
| **会话映射** | 平台 `chat_sessions.hermes_session_id` 唯一索引；创建/首轮后回写；`active_run_id` 支持刷新恢复；不同步 Hermes 全量消息（按需拉 `/messages` 做校验/导入） |
| **可观测** | 每请求日志 `endpoint/status/duration_ms/run_id/request_id`；计数器 `hermes_requests_total{endpoint,status}`、`hermes_errors_total{kind}`、`hermes_capability_missing_total` |
| **不做** | 不做缓存穿透层（除 capabilities 60s）、不做 Hermes 侧限流、不代理 dashboard 9119、不实现模型路由（交给 Hermes `model_routes`） |

**路由层收敛示意**（写操作也进网关）：

```python
# routes/chat.py（目标形态）
@router.post("/runs")
async def create_run(body: ChatRunRequest, user=Depends(require("chat:write"))):
    gw = get_gateway()
    handle = await gw.runs.create(
        input=body.input, session_id=body.session_id,
        instructions=body.instructions, model=body.model,
        idempotency_key=request_id.get(),
    )
    return {"run_id": handle.run_id, "session_id": handle.session_id, "status": "started"}

@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, last_event_id: str | None = None):
    return StreamingResponse(sse(gw.runs.events(run_id, last_event_id=last_event_id)),
                             media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
```

### 2.4 反模式清单（重构禁止项）

| 反模式 | 现状 | 规则 |
|---|---|---|
| 路由内建 HTTP 客户端 | `jobs.py:41`、`knowledge.py:131`、`auth.py:460/619`、`distiller.py:262` | 禁止；必须经 `gateway` |
| 手拼 URL | 5 套实现 | 禁止；`transport.build(path)` |
| 用 `finish_reason`/HTTP 码判成功 | 部分路径已改用 runs `status` | 统一 `RunStatus.terminal ∈ {completed, failed, cancelled, interrupted}` |
| 会话键手工拼 `agent:main:...` | 未出现（仅用 `X-Hermes-Session-Id`） | 保持禁止 |
| 把长任务塞 `BackgroundTasks` | RCA 已改成可恢复 runner | 新任务必须可恢复（DB 状态 + 巡检） |
| 把心跳写进业务时间线 | `CollaborationEvent.metadata.kind=heartbeat` | 新字段 `heartbeat_at`，时间线只放业务事件 |

---

## 3. 目标架构

### 3.1 分层

| 层 | 前端（`src/`） | 后端（`backend/app/`） |
|---|---|---|
| 入口/编排 | `routes.tsx`（路由表）、`App.tsx`（Provider + 布局） | `api/routers/*`（≤300 行/文件） |
| 领域 | `features/{chat,alerts,knowledge,ops,admin}/`（hook + 组件 + 视图） | `domain/{chat,alerts,rca,knowledge,ops,iam}/`（用例） |
| 通用能力 | `lib/{api-client,sse,status,format,permissions}`、`components/{ui,common,layout}` | `core/{errors,permissions,request_id,pagination,observability}`、`integrations/hermes/*` |
| 数据 | — | `models/`（SQLAlchemy）+ `domain/*/repository.py` |

**迁移策略**：不搞"一次性重写"。先**加壳**（gateway/errors/permissions），再**搬逻辑**（routes → domain），最后**换前端**（features）。每个 PR 可独立回滚。

### 3.2 目标信息架构（URL 不破坏）

```
⌘K 任何页面/动作
┌ 工作台        /            今日：待处理告警 · 进行中 RCA · 待审批 · 昨日巡检
├ 对话          /chat        会话（搜索/pin/归档/fork）· 模式 · 模型
├ 事件          /alerts      收件箱 · 进行中 · 报告库（原 /rca、/history 并入）
├ 知识          /knowledge   文档 · 检索 · Webhook · 蒸馏 · 图谱(P3)
├ 任务与巡检    /jobs /patrol 任务 CRUD · 立即执行 · 每日建议(P2/P3)
└ 更多 ▾        技能 / 应用系统 / 数据源 / 规则 / 帮助
   管理 ▾        用户 / 系统设置                          （ADMIN）
```

| 旧路由 | 新形态 | 兼容方式 |
|---|---|---|
| `/`、`/chat`、`/knowledge`、`/datasources`、`/systems`、`/skills`、`/rules`、`/settings`、`/users`、`/profile`、`/help`、`/jobs` | 保留 | URL 不变，仅导航分组 |
| `/rca` | 事件中心详情深链 `/alerts?tab=reports&s={id}`；`/rca` 保留渲染同一组件 | 双向可跳，旧链接 200 |
| `/history` | `/alerts?tab=reports&scope=all`；`/history` 保留重定向 | 保留搜索/分页/下载能力 |

### 3.3 数据模型增补（仅新增，不重命名）

| 表 | 新增 | 用途 |
|---|---|---|
| `chat_sessions` | `hermes_session_id`(unique, nullable)、`active_run_id`、`model`、`provider`、`pinned`、`archived`、`last_active_at`、`message_count` | 会话映射与刷新恢复 |
| `chat_messages` | `run_id`、`seq`、`reasoning`、`usage` JSONB、`status`、`tool_name` | 忠实回放/审计/成本 |
| `rca_sessions` | `run_id`、`heartbeat_at`、`stop_requested_at` | 可终止/可判活/可查询 |
| `knowledge_documents` | `stage`、`progress`、`error`、`chunk_count`、`content_hash`、`tags` JSONB | 入库可观测/去重 |
| `knowledge_chunks`（新） | `doc_id`、`seq`、`content`、`tokens`、trigram 索引 | 检索与引用 |
| `knowledge_entities` / `knowledge_edges`（新，P3） | 实体/关系/权重/证据 | 图谱检索 |
| `patrol_plans` / `patrol_runs` / `patrol_findings`（新，P2） | 剧本/执行/建议 | 主动巡检 |

### 3.4 非功能目标（验收基线）

| 指标 | 现状（估） | 目标 | 测量点 |
|---|---|---|---|
| 对话首字延迟 p95 | 未测 | ≤ 2.5s（同网络） | 前端 `performance` + 后端日志 |
| run 成功率 | 未测 | ≥ 97%（不含用户 stop） | `rca_sessions`/run 状态聚合 |
| 审批出现→响应 p95 | 未测 | ≤ 2s 出现，≤ 30s 响应 | `approval.request` → `/approval` |
| 切页/刷新恢复 | **失败**（run 被杀/上下文丢失） | 3s 内 reattach | E2E 场景 |
| 入库成功率（≤20MB） | 未测 | ≥ 98%，失败可重试 | `knowledge_documents.stage` |
| 检索 p95（不含 LLM） | 未测 | ≤ 300ms | 服务端计时 |
| 路由文件行数 | max 1,525 | ≤ 300 | CI 检查 |
| 前端首屏 JS | 全量同步 | ≤ 现网 70% | `vite build` 报告 |
| 测试覆盖 | 0 | 核心域 ≥ 60%，网关契约 100% 错误分支 | CI |

---

## 4. 路线图

> 工作量口径：**S** ≤ 1 人日；**M** 2–4 人日；**L** 5–10 人日。
> 阶段周期按 **2 后端 + 1.5 前端** 并行估算。单人执行时按每阶段表格中的 `Must` 标记裁剪（见 §4.4）。

### 4.1 阶段一「地基」（第 1–2 周，目标：可替换、可诊断、可扩展）

| ID | 目标 | 涉及文件 | 工作量 | 风险 | 验收标准 |
|---|---|---|---|---|---|
| **G1** | 统一 Hermes 网关：transport + capabilities + events + errors + runs/sessions/chat/jobs/meta；吃掉 6 个模块内的临时 client 与 5 套 URL 拼装；把 `routes/hermes.py` 降为薄路由 | 新增 `backend/app/integrations/hermes/*`（11 文件）、`backend/tests/test_hermes_*.py`；改 `services/hermes.py`（门面）、`routes/{hermes,chat,jobs,knowledge,auth}.py`、`services/distiller.py`、`config.py`、`main.py` | **L** | Hermes 版本差异（404/401/422）；SSE 重连回归；配置热更新竞态 | ① `rg "httpx.AsyncClient" backend/app/routes` = 0；② `/chat/completions` 字符串只出现在 `integrations/hermes/chat.py`；③ 3 种 base_url 形态 + 6 类错误映射单测全绿；④ capabilities 探测失败时对话/知识/RCA 均降级不 5xx；⑤ 四条主链路回归通过且首字延迟不退化 |
| **G2** | 路由/权限/错误规范：`{error:{code,message,details,request_id}}`、`X-Request-ID`、`permissions` 位、路由≤300 行、OpenAPI 声明权限 | 新增 `core/{errors,request_id,permissions,pagination,observability}.py`；改 `main.py`、`auth.py`、全部 `routes/*.py`；`src/lib/api.ts`、`src/components/auth/auth-context.tsx` | **L** | 401/403 行为变化引起回归；旧前端依赖 `detail` 文本 | ① 148 端点全部声明权限；② `/api/auth/me` 返回 `permissions[]`；③ 7 类错误统一信封且有 `request_id`；④ `routes/*.py` 最大行数 ≤300；⑤ 三角色冒烟脚本全绿；⑥ 前端不再展示 JSON 原文 |
| **G3** | 设计系统收口：组件级 token、8 个业务组件、状态语义层、暗色修复、4 logo 合一 | 改 `styles/globals.css`、`components/ui/{button,badge,card,tabs,sheet}.tsx`；新增 `components/common/{page-header,toolbar,empty-state,data-table,timeline,stat-card,status-badge,confirm-action}.tsx`、`lib/status.ts`、`components/brand.tsx`；改 15 个页面 | **M** | 视觉回归面大；页面改造与功能开发冲突 | ① `rg "bg-white|text-\[#|#6b6b80"` ≤3；② 5 个主页面暗色截图无白块；③ 状态/级别/置信度由 `lib/status.ts` 单点定义；④ 空态/错误态/加载态在 100% 页面统一 |
| **G4** | 信息架构与路由重构：路由表单一来源、分组导航、⌘K、懒加载、路由级错误/骨架、移动端抽屉 | 新增 `src/routes.tsx`、`components/layout/{sidebar,nav-group,command-palette,breadcrumbs}.tsx`、`pages/not-found.tsx`；改 `App.tsx`、`dashboard-shell.tsx`、`main.tsx`、`vite.config.ts` | **M** | 旧 URL 失效；键盘可达性回归 | ① 15 个旧 URL 全部 200（表驱动清单）；② 首屏 JS ≤ 现网 70%；③ ⌘K 覆盖页面+动作，键盘全操作；④ 侧栏 ≤5 组、一级项 ≤9；⑤ 移动端侧栏以 Sheet 覆盖且主区不被挤压；⑥ 无嵌套 `<Routes>` |

**阶段一出口门禁**：`ruff check` 0 error、`pytest backend/tests` 全绿、`npx tsc --noEmit` 0 error（当前受 TS7/`baseUrl` 历史配置阻塞，需先修）、错误信封与权限矩阵评审通过。

### 4.2 阶段二「体验」（第 3–5 周，三条主线并行）

#### E1 对话主线（会话 / 流式 / 中断审批 / 上下文恢复）

| ID | 目标 | 涉及文件 | 工作量 | 风险 | 验收标准 |
|---|---|---|---|---|---|
| E1-1 | 会话映射与恢复：`chat_sessions.hermes_session_id/active_run_id`；列表聚合 Hermes `/api/sessions`（搜索/pin/归档/fork）；刷新按 `active_run_id` 自动 reattach | `models/__init__.py`、`routes/chat.py`、`integrations/hermes/sessions.py`、`src/hooks/useChat.ts`、`ChatPanel.tsx`、`alembic/versions/*` | **M** | 双写不一致；Hermes 会话被清理 | 刷新后 3s 内恢复流；从历史打开可**直接续聊（不全量重放）**；fork 生成新会话；pin/归档生效 |
| E1-2 | 流式统一：后端只产 `GatewayEvent`，前端只消费一套；断线按 `seq` 续传；终态以 run `status` 为准 | `integrations/hermes/events.py`、`routes/chat.py`、`src/lib/sse.ts`、`useChat.ts`、`api.ts` | **M** | 事件字段回归；重复渲染 | 断网 5s 恢复不重复、不丢字；`completed/failed/cancelled/interrupted` 四态 UI 正确；`unknown` 事件不崩 |
| E1-3 | 中断/审批/steer：停止真实中断；审批卡支持 once/session/always/deny + 记住；steer 队列可视化；`resolve-unknown` 兜底 | `routes/chat.py`、`ChatPanel.tsx`、`ChatMessage.tsx`、`api.ts` | **M** | 审批漏弹导致长任务卡死 | stop→`cancelled` ≤5s；审批 2s 内出现且选择持久；steer 显示"已入队/已送达/未送达"；网关重启后无悬挂审批 |
| E1-4 | 切页不杀 run + 后台运行指示 + 恢复提示 | `useChat.ts`（移除 unmount abort）、`ChatPanel.tsx`、`dashboard-shell.tsx` | **S** | 用户误以为已停止 | 切到告警页再回来，run 仍在跑并可接续；全局指示器显示"1 个任务后台运行" |

#### E2 知识库主线（入库 / 检索 / 文档管理）

| ID | 目标 | 涉及文件 | 工作量 | 风险 | 验收标准 |
|---|---|---|---|---|---|
| E2-1 | 入库状态机 + 进度 + 重试/取消：`stage/progress/error/content_hash`；SSE 或 1s 轮询进度；失败可重试、重复入库幂等 | `routes/knowledge.py`（拆分）、`services/knowledge_ingest.py`（新）、`models`、`src/pages/knowledge.tsx` | **L** | MarkItDown/LLM 超时；并发入库压垮 Hermes | 20MB 文档进度可见；失败给原因+重试；同文件二次入库不产生重复 chunk |
| E2-2 | 检索命中可解释：混合召回（trigram+关键词）→ 返回 `hits[{doc,title,snippet,score}]`；测试面板显示分数/来源；回答引用 doc id | `services/knowledge_retrieval.py`（新）、`routes/knowledge.py`、`api.ts`、`knowledge.tsx` | **M** | 中文分词/trigram 效果不稳定 | 每次回答 ≥1 条引用；测试页展示 Top-K 与分数；删除文档后不再命中并提示 |
| E2-3 | 文档管理：批量上传/删除/重入库、标签、过期、引用计数、版本 | `knowledge.tsx`、`routes/knowledge.py`、`models` | **M** | 批量删除误操作 | 批量操作有确认与结果回执；标签可筛选；过期文档自动归档（策略可配） |

#### E3 日常运维主线（告警-RCA / 任务 / 巡检）

| ID | 目标 | 涉及文件 | 工作量 | 风险 | 验收标准 |
|---|---|---|---|---|---|
| E3-1 | 事件中心合并：收件箱 / 进行中 / 报告库 三 tab；`/rca`、`/history` 并入并保留旧 URL；统一详情抽屉与筛选 | `pages/alerts.tsx`（拆分）、`pages/rca/*`、`pages/history/*`、`App.tsx`、`routes.tsx` | **M** | 功能遗漏（搜索/分页/导出） | 旧页 3 项能力逐条对齐；告警→报告 ≤3 击；跨 tab 筛选状态保留 |
| E3-2 | RCA 可控：`POST /api/rca/sessions/{id}/stop`（网关 `stop_run`）、批量终止、终止审计、`run_id` 落库可查 | `routes/rca.py`、`services/rca_runner.py`、`integrations/hermes/runs.py`、`rca-page.tsx` | **M** | 终止与完成竞态；槽位泄漏 | 终止 5s 生效且 `cancelled`；审计有"谁在何时终止"；槽位正常归还（Redis 计数校验） |
| E3-3 | 任务中心：全字段（name/schedule/repeat/skills/deliver/model）、立即执行、最近一次结果与失败原因、任务模板 | `routes/jobs.py`（改走 gateway + 本地审计）、`jobs.tsx`、`api.ts` | **M** | cron 表达式校验不足 | 创建/编辑/暂停/恢复/立即执行全通；失败展示上游原因；模板一键创建 |
| E3-4 | 巡检 MVP：`patrol_plans/runs/findings`；采集（数据源健康+未闭环告警+知识盲区）→ Hermes 归纳 → 今日 3 条建议 → 一键转 RCA/任务 | 新增 `services/patrol.py`、`routes/patrol.py`、`pages/patrol.tsx`、`models`、`integrations/hermes/jobs.py` | **L** | 采集超时/噪声过多；成本失控 | 每日 09:00 产出；单次 <3 分钟、token <30k；建议含证据链接；采纳/忽略可统计 |

**阶段二出口门禁**：E2E 覆盖"告警→RCA→报告→知识沉淀"与"对话中断→恢复"两条黄金链路；错误率、首字延迟达到 §3.4；用户可用性走查（5 人）无阻断问题。

### 4.3 阶段三「创新」（第 6–7 周，3 个差异化能力）

#### I1 运维 Copilot 工作台（Incident Workspace）

| 维度 | 内容 |
|---|---|
| **价值** | 把"事件事实 + AI 分析 + 人机协同动作"收进一个页面，减少 60% 上下文切换；MTTR 目标 −20% |
| **差异化** | 不是"聊天窗 + 页面"的拼装：**run 生命周期绑定业务事件 ID**，上下文自动装配（事件+相似历史+知识盲区+数据源健康），审批/终止/接管全部落同一时间轴，AI 结论可回溯到具体工具调用 |
| **实现路径** | ① `GET /api/incidents/{kind}/{id}/workspace` 一次聚合（事件+时间线+相关知识+健康）；② `POST /api/incidents/{id}/copilot/run` → 以事件为 `session_id` 起 run；③ `IncidentContextBuilder`（服务层，token 预算 6k，可单测）；④ 前端 `/incidents/{id}` 三栏，移动端 tab；⑤ `CommandBus` 统一动作（终止/重跑/通知/转任务/误报），每动作写 `CollaborationEvent + AuditLog` |
| **工作量 / 风险** | **L**（8–10 人日，分两迭代） / 上下文超预算、跨团队越权 |
| **验收** | 从告警到"有结论"≤3 击；每条 AI 输出带事件引用与工具链；移动端可用；MTTR 对比基线下降 ≥15% |

#### I2 知识图谱检索增强（Service–Alert–Cause–Action）

| 维度 | 内容 |
|---|---|
| **价值** | 回答"这个服务历史上因为什么挂过、当时怎么修的、这次像不像"；把 RCA 结构化字段自动变成关系，**越用越准** |
| **差异化** | 相比纯 RAG：文本召回 + 1–2 跳图扩展 + 可解释"证据路径"；结构化报告不是附件，而是图的边 |
| **实现路径** | ① 表 `knowledge_entities/knowledge_edges`（`caused_by/resolved_by/affects/similar_to/documented_in`）；② 抽取器从 `RcaReport`+`AppSystem`+`RootCauseKnowledge` 幂等建边（规则优先，LLM 可选）；③ `hybrid_search(q,{k,hops})`：trigram 召回 → 图扩展 → 打分（0.6 文本+0.25 图距+0.15 确认度/时效）；④ API `/api/knowledge/search`、`/api/knowledge/graph/{entity}`；⑤ 知识页"图谱"视图（SVG 力导向，默认 1 跳）+ RCA 详情"证据路径" |
| **工作量 / 风险** | **L**（7–9 人日） / 图数据质量、关系爆炸、渲染性能 |
| **验收** | 30 条标注 query 命中率 ≥ 基线 +15%；每条结果给来源与路径；1 跳查询 p95 <300ms；RCA 报告引用率 ≥60% |

#### I3 主动巡检建议（Patrol Advisor）

| 维度 | 内容 |
|---|---|
| **价值** | 从"告警驱动"转为"风险驱动"：每天 3 条可执行建议，把隐患在变成故障前处理 |
| **差异化** | 建议**可执行、可追踪、可反馈**（采纳率/命中率闭环），不是又一张报表；巡检剧本由运维配置，证据可点开 |
| **实现路径** | ① `patrol_plans`（检查项/阈值/时间/范围）、`patrol_runs`、`patrol_findings`；② `PatrolCollector` 复用 `datasource_adapters` + 告警统计 + 知识盲区，单项超时独立降级；③ 阈值脚本（`no_agent`，0 token）先筛，再让 Hermes run 归纳成建议；④ 调度复用 Hermes `/api/jobs` cron 回调平台 webhook，避免第二套调度；⑤ 前端 `/patrol` 今日建议 + 历史 + 采纳率 |
| **工作量 / 风险** | **L**（7–10 人日） / 采集权限、建议噪声、LLM 成本 |
| **验收** | 每日 09:00 稳定产出；单次 <3 分钟、<30k token；建议一键转 RCA/任务并保留证据；采纳率、误报率可查 |

> **备选 I4（本期不做，吸收进 I1）**：事件时间轴协同（多人围观同一 run + 复盘回放）。技术前提是 SSE 扇出（Redis pub/sub），建议在 I1 时间轴稳定后再评估。

### 4.4 排期与裁剪

| 周 | 后端泳道 A | 后端泳道 B | 前端泳道 |
|---|---|---|---|
| W1 | G1 网关 transport/runs/sessions | G2 errors/permissions/request-id | G3 token + 组件 + 暗色 |
| W2 | G1 迁移 6 处调用 + 契约测试 | G2 路由瘦身（chat/alerts/knowledge 开头） | G4 路由表 + ⌘K + 懒加载 |
| W3 | E1 会话映射 + 事件统一 | E3 事件中心后端 + RCA stop | E3 事件中心 UI |
| W4 | E2 入库状态机 + 检索 | E3 任务中心 + 巡检采集 | E1 对话 UI（恢复/审批/后台运行） |
| W5 | E2 文档管理 + 检索可解释 | E3 巡检 MVP | E2 知识 UI + E3 巡检 UI |
| W6 | I2 图模型 + 抽取器 | I1 workspace 聚合 + CommandBus | I1 工作台三栏 |
| W7 | I2 检索 + 图谱 API | I3 巡检建议 + 调度 | I2 图谱视图 + I3 建议卡 |

**单人执行裁剪顺序**：G1 → G2（仅错误信封+权限位）→ G4（路由表）→ E1-1/E1-4 → E3-1/E3-2 → G3 → E2-2 → E3-4 → I1。G3 可延后（视觉债不阻塞功能），E2-1 可降级为"轮询进度 + 手动重试"。

### 4.5 完成定义（DoD）与度量

每个任务合并前必须满足：

1. 有验收脚本或 E2E 用例（不接受"手点过"）；
2. 错误路径有测试（超时/404/409/能力缺失）；
3. 新增端点声明权限与错误码；
4. 前端有加载/空/错/无权限四态；
5. 指标上报（至少日志字段）到位；
6. 文档同步（`docs/architecture.md` + 对应 ADR，改一处同步一处）。

**基线采集（阶段一第 1 周内完成）**：首字延迟、run 成功率、审批时延、入库成功率、检索 p95、路由行数、bundle 体积。没有基线就无法证明重构"更好"。

---

## 5. 不丢失功能迁移策略

### 5.1 迁移原则

| 原则 | 做法 |
|---|---|
| **Strangler（绞杀者）** | 新层先包住旧实现，流量逐步切换；旧代码在"零调用 + 一个发布周期"后才删 |
| **URL 永不破坏** | 旧路由至少保留 2 个发布周期；重定向用 308 保留方法与查询串 |
| **双写过渡** | `chat_sessions`/`chat_messages` 与 Hermes 会话映射并行写；`rca_sessions.evidence` 与新 `run_id` 列并行 |
| **能力门控** | 所有新能力按 `capabilities` 或平台开关降级，**不允许"Hermes 版本低就 500"** |
| **功能清单驱动** | 每个页面/端点有"能力清单 + 验收项"，逐条打勾才允许下线路由 |
| **迁移可回滚** | 每个阶段一个总开关；每个 PR 可独立 revert；DB 只做 expand-contract |

### 5.2 页面迁移与替换关系

| 现路由 | 页面 | 核心能力（不可丢） | 新归属 | 替换方式 | 验收项 | 阶段 |
|---|---|---|---|---|---|---|
| `/` | 概览 | 队列、最近会话、规则数、快捷入口 | 工作台 | 重写（保留卡片信息） | 队列/最近会话/入口等价 | P2 |
| `/alerts` | 告警中心 | 收件箱（分页/搜索/详情/原始报文）、垃圾箱、策略、Webhook、令牌、通知渠道、统计、批量触发、忽略 | 事件中心 | **拆分**：列表/详情/策略/接入 4 个模块 | 上述 11 项逐条回归 | P2 |
| `/rca` | RCA | 会话列表、报告库（搜索/分页/批量 ZIP/MD/HTML 下载）、根因知识库、重跑、时间线 | 事件中心 | 并入 tab，保留独立路由渲染 | 下载/导出/重跑/时间线全通 | P2 |
| `/history` | 历史 | 会话列表、搜索、分页、详情跳转 | 事件中心 | 并入"报告库"tab + 308 | 与报告库结果一致 | P2 |
| `/chat` | 对话 | 4 模式、模型切换（LLM 模式）、文件上传、Markdown/推理/工具卡、停止/steer/审批、会话侧栏、自动保存 | 对话 | 演进（不重写） | 上述 8 项 + 恢复能力 | P2 |
| `/knowledge` | 知识 | 文档上传/转换/入库/删除、Webhook 注册与监控、命中测试（流式+反馈）、蒸馏审核/统计/配置、盲区、过期 | 知识 | 拆分 5 个视图 | 22 个端点对应能力全通 | P2 |
| `/rules` | 规则 | 条件行编辑、启停、删除、兼容旧表达式 | 规则 | 保留 | 保存→命中链路可验证 | P1/P2 |
| `/jobs` | 任务 | CRUD、暂停/恢复、立即执行 | 任务 | 保留 + 增字段 | 8 端点全通 + 结果展示 | P2 |
| `/systems` | 应用系统 | CRUD、L0/L1/L2、资源关联 | 应用系统 | 保留 | 资源增删一致 | P1 |
| `/datasources` | 数据源 | CRUD、测试、查询、模板 | 数据源 | 保留 | 5 类型测试通过 | P1 |
| `/skills` | 技能 | 技能/工具集浏览、缓存状态/刷新/周期 | 技能 | 保留 | 缓存与刷新可用 | P1 |
| `/settings` | 设置 | Hermes/LLM/LDAP/模式/欢迎语 配置与测试 | 设置 | 拆分 4 个 section | 配置保存→生效（热加载） | P1 |
| `/users` | 用户 | CRUD、角色、状态 | 管理 | 保留 | 三角色权限生效 | P1 |
| `/profile` | 个人中心 | 资料/改密/会话吊销/偏好/主题/统计 | 个人中心 | 保留 | 6 tab 全通 | P1 |
| `/help` | 帮助 | 4 tab 静态内容 | 帮助 | 保留 + 与实际功能对齐 | 无死链 | P1 |
| `/login` | 登录 | 登录、首启向导、密码强度/生成 | 公共 | **改走 `api.ts`** | 首启/登录/LDAP 全通 | P1 |

### 5.3 接口迁移与替换关系

| 现有端点组 | 现状 | 迁移动作 | 兼容策略 | 下线条件 |
|---|---|---|---|---|
| `POST /api/chat/stream` | 兼容路径（LLM 直连 + 回退） | 保留；内部改走 gateway | 事件名不变 | 新事件流稳定 2 个版本后标记 deprecated |
| `POST /api/chat/runs`、`GET /runs/{id}`、`/events`、`/stop`、`/steer`、`/approval` | 已实现 | 内部改走 gateway；新增 `Idempotency-Key`、`resolve-unknown` | 请求/响应字段不变 | — |
| `GET/POST/DELETE /api/chat/sessions*` | 平台表 | 增加 `hermes_session_id` 映射与 Hermes 列表聚合 | 字段只增不改 | 旧字段保留 |
| `GET /api/chat/hermes/*`（skills、toolsets、cache-status、cache-interval、refresh、info、health） | 7 个发现端点 | 收敛到 `/api/hermes/*` | 旧路径 308 | 前端全部切换后 |
| `/api/chat/llm-models` | 读 provider | 保留；新增 `/api/chat/models`（Hermes `model/options`） | 并存 | 选择器切换后 |
| `/api/rca/*` | 10 端点 | 新增 `POST /sessions/{id}/stop`；`run_id` 落列 | 原字段不变 | — |
| `/api/alerts/*` | 17 端点 | 拆服务；`batch-trigger` 保留 | 不变 | — |
| `/api/knowledge/*` | 22 端点 | 拆服务；新增 `/search`、`/documents/{id}/ingest/status` | 新增为主 | — |
| `/api/knowledge/root-causes*` | 与 knowledge 同前缀 | 保持路径，OpenAPI tag 统一 | 不变 | — |
| `/api/jobs/*` | 纯代理 | 改走 gateway + 本地审计/校验 | 请求/响应透传 | — |
| `/api/hermes/*` | 只读代理（进行中） | 下沉服务层；加 `hermes:read` 权限（ADMIN/OPERATOR） | 路径不变 | — |
| `/api/auth/hermes-config`、`/hermes-test`、`/llm-config` | 配置与测试 | 测试改走 gateway；配置保持 | 不变 | — |
| `/api/audit` | 只读 | 加 `date_from/date_to`、分页上限 | 参数只增 | — |

**接口不丢功能的机器化验收**：`backend/tests/test_contract_parity.py` 对每个旧端点做"旧实现 vs 新实现"快照对比（同输入 → 同结构，允许新增字段），CI 阻断结构断裂。

### 5.4 权限迁移映射（角色 → 权限位）

| 权限位 | ADMIN | OPERATOR | VIEWER | 覆盖端点（示例） |
|---|---|---|---|---|
| `chat:read` / `chat:write` | ✓ | ✓ | ✓ / ✓ | 会话、run、审批（审批需 `chat:write`） |
| `alert:read` / `alert:write` | ✓ | ✓ / ✓ | ✓ / — | 收件箱、策略、批量触发 |
| `rca:trigger` / `rca:terminate` | ✓ | ✓ / ✓ | — | 触发、重跑、终止 |
| `report:read` / `report:export` | ✓ | ✓ / ✓ | ✓ / — | 报告、下载、ZIP |
| `kb:read` / `kb:write` | ✓ | ✓ / ✓ | ✓ / — | 文档、蒸馏审核、Webhook |
| `job:read` / `job:admin` | ✓ | ✓ / — | — | 任务列表 / CRUD+执行 |
| `datasource:read` / `datasource:admin` | ✓ | ✓ / —（可配） | — | 数据源 |
| `system:admin` | ✓ | — | — | 设置、LDAP、Hermes 配置、欢迎语 |
| `user:admin` | ✓ | — | — | 用户管理 |
| `audit:read` | ✓ | ✓ | — | 审计 |
| `hermes:read` | ✓ | ✓ | — | `/api/hermes/*`（**修当前"任意登录用户可读全部会话"**） |
| `patrol:read` / `patrol:admin` | ✓ | ✓ / ✓ | — | 巡检建议 / 剧本 |

**迁移方式**：`require_admin` → `require("user:admin")` 逐端点替换；旧角色依赖保留 1 个版本（`require_admin` 内部映射到 `system:admin|user:admin`），保证灰度期不 403。

### 5.5 数据迁移（expand-contract）

| 步骤 | 内容 | 回滚 |
|---|---|---|
| 1. Expand | 只加列/表（全部 nullable 或有默认值）+ 索引；不删不改类型 | down 脚本删列/表 |
| 2. Dual-write | 新列写入与旧 JSONB `evidence` 并行；`chat_sessions.hermes_session_id` 在首轮后回写 | 关开关停写新列 |
| 3. Backfill | 批处理回填 `hermes_session_id`（从 `evidence.run_id`/历史消息）、`rca_sessions.run_id`、`heartbeat_at` | 幂等，可重跑 |
| 4. Read-switch | 读路径切新列（flag 控制），旧字段仅保留 | flag 关闭回旧读 |
| 5. Contract | 一个发布周期后清理旧字段/旧路由 | 需备份快照 |

**约束**：不使用 `DROP COLUMN`/`RENAME` 直到阶段三结束；迁移脚本必须幂等（`IF NOT EXISTS`）；每个阶段发布前 `pg_dump` 快照（运维执行，本文档不代跑）。

### 5.6 回滚方案

| 层级 | 机制 | 触发条件 | 动作 | RTO |
|---|---|---|---|---|
| L1 功能开关 | `system_config` 键 `platform.flags`，`/api/platform/flags` 下发 | 单功能异常 | 关 `chat_v2` / `events_v2` / `knowledge_v2` / `patrol` / `incident_workspace`，前端自动回旧组件 | < 1 min |
| L2 路由别名 | 旧路由保留 + 308；新路由独立前缀 | 新路由 5xx 升高 | Nginx/路由层把前缀切回旧实现 | < 5 min |
| L3 版本回退 | 镜像 tag 回滚（后端/前端各自独立） | 错误率 > 基线 2 倍持续 15 min；首字 p95 > 5s；401/403 激增 | 回退上一稳定 tag | < 10 min |
| L4 数据修复 | 只加列 → 回滚后旧代码忽略新列；双写保证旧字段可用 | 数据不一致 | 关双写、停回填、按快照修复 | < 60 min |

**回滚检查单（发布前必填）**：① 本次涉及哪些 flag；② 旧路由是否仍可用；③ 新列是否可被旧代码忽略；④ 回滚后审批/终止/会话是否仍工作；⑤ 一次演练记录（预发环境）。

**回滚演练（阶段一、二各一次）**：在预发把 `chat_v2` 关闭 + 后端回退一版，验证：旧前端可用、进行中的 run 不被杀、审批不悬挂、历史会话可打开。

---

## 6. 风险登记册

| # | 风险 | 概率/影响 | 缓解 | 触发信号 |
|---|---|---|---|---|
| R1 | Hermes 版本差异导致网关行为不一致 | 高/高 | 能力探测 + 契约测试 + 多版本 fixture | 契约测试失败、`capability_missing` 激增 |
| R2 | 双写期会话数据不一致 | 中/高 | 映射唯一索引 + 对账任务（每日）+ 回填幂等 | 对账差异 > 0.5% |
| R3 | 事件模型改造引入"丢字/重复" | 中/高 | `seq` 去重 + 回放测试 + 灰度用户 | 重复率/缺失率 > 0.1% |
| R4 | 权限收紧导致运维无法操作 | 中/中 | 旧角色兼容映射 + 灰度 + 一键回退角色 | 403 激增 |
| R5 | 前端改造与并行功能开发冲突 | 高/中 | 先路由表/token 后页面；小 PR；feature branch | 合并冲突频次 |
| R6 | 知识入库/巡检压垮 Hermes（并发/成本） | 中/高 | 并发上限 + 队列 + token 预算 + 熔断 | 上游 429/超时率 |
| R7 | 无测试基线，重构"看起来好了" | 高/高 | 阶段一强制补契约/E2E；指标看板 | 无基线/无 CI 阻断 |
| R8 | 迁移期文档继续失真 | 高/中 | 文档即代码：PR 模板勾选；每阶段文档评审 | 文档与代码不一致被 QA 发现 |
| R9 | 图谱/巡检数据质量差，创新变噪声 | 中/中 | 先规则后 LLM；人工抽检；明确置信度 | 建议采纳率 < 10% |
| R10 | 移动端/暗色等体验债被无限延后 | 中/低 | G3/G4 设硬门禁；每阶段末做体验走查 | 走查阻断项 > 0 |
| R11 | `routes/hermes.py` 并发开发与 G1 冲突 | 高/中 | 先对齐接口契约，后合并；以本文档 §2.3 为准 | 双份实现/字段分叉 |
| R12 | TS7/`baseUrl` 历史配置阻塞类型检查 | 高/低 | 阶段一先修 `tsconfig` 或固定 TS 版本 | `tsc --noEmit` 报 TS5102 |

---

## 7. 附录

### 7.1 文件清单（A：前端）

| 文件 | 行数 | 角色 | 备注 |
|---|---|---|---|
| `src/App.tsx` | 122 | 路由 + 导航 + 鉴权壳 | 双层 Routes、内联导航 |
| `src/main.tsx` | 13 | 入口 + ThemeProvider | 正常 |
| `src/lib/api.ts` | 1,714 | 18 域 API + 类型 | 需拆 client/域 |
| `src/lib/utils.ts` | 36 | cn 等 | 正常 |
| `src/hooks/useChat.ts` | 685 | 对话状态机（Runs/回退/重连） | 切页杀 run、丢会话映射 |
| `src/components/chat/ChatPanel.tsx` | 1,083 | 对话 UI（侧栏/输入/审批/模式） | 拆分为 3–4 组件 |
| `src/components/chat/ChatMessage.tsx` | 589 | 消息渲染（Markdown/推理/工具） | 缺代码高亮 |
| `src/components/layout/dashboard-shell.tsx` | 350 | 外壳（header/sidebar/drawer） | 移动端/暗色问题 |
| `src/components/rca/rca-results-view.tsx` | 319 | 报告结果视图 | 可复用为事件详情 |
| `src/components/rca/incident-timeline.tsx` | 283 | 时间线 | 心跳污染展示 |
| `src/components/rca/rule-wizard.tsx` | 256 | 规则向导 | 与 rules 页表单重复 |
| `src/components/ui/*`（18 文件） | 1,541 | 基础组件 | 缺业务组件 |
| `src/components/{liumai-brand,liumai-logo,liumai-logo-full,login-logo}.tsx` | 245 | 4 个 Logo | 合并为 1 |
| `src/components/auth/auth-context.tsx` | 115 | 鉴权上下文 | 仅 isAdmin；自写 fetch |
| `src/components/ErrorBoundary.tsx` | 67 | 全局错误边界 | 需路由级 |
| `src/pages/*`（16 文件） | 6,451 | 页面 | 见 §1.2 |
| `src/styles/globals.css` | 243 | token + 主题 | 见 §1.3 |

### 7.2 文件清单（B：后端）

| 文件 | 行数 | 角色 | 备注 |
|---|---|---|---|
| `main.py` | 254 | 装配 + lifespan + 4 后台任务 | 编排外溢 |
| `config.py` | 147 | 配置 | — |
| `auth.py` | 88 | JWT/RBAC | 仅角色 |
| `models/__init__.py` | 691 | 24 张表 | 会话映射缺失 |
| `models/database.py` | 78 | 引擎/会话 | — |
| `routes/alerts.py` | 1,342 | 接入/策略/触发/统计 | 拆 3 服务 |
| `routes/chat.py` | 1,525 | 7 职责 | 拆 4 模块 |
| `routes/knowledge.py` | 1,299 | 入库/检索/蒸馏/Webhook | 拆 4 服务 |
| `routes/rca.py` | 1,157 | 会话/报告/导出 | 缺 stop |
| `routes/auth.py` | 633 | 认证/配置/测试 | 2 处手搓 HTTP |
| `routes/rules.py` | 358 | 规则 CRUD | — |
| `routes/users.py` | 329 | 用户/个人中心 | — |
| `routes/datasources.py` | 240 | 数据源 | — |
| `routes/systems.py` | 238 | 应用系统 | — |
| `routes/root_cause.py` | 217 | 根因知识 | 前缀重叠 |
| `routes/history.py` | 205 | 历史/协作 | 与 rca 重叠 |
| `routes/jobs.py` | 141 | Jobs 代理 | 改走 gateway |
| `routes/audit.py` | 75 | 审计查询 | 缺日期筛选 |
| `routes/hermes.py` | 651 | 只读网关代理（进行中） | 下沉服务层 |
| `services/rca_runner.py` | 2,084 | RCA 编排 | 8 职责 |
| `services/alert_pipeline.py` | 1,586 | 告警流水线 | 边界靠约定 |
| `services/hermes.py` | 1,144 | Hermes 客户端 | 保留门面 |
| `services/rule_engine.py` | 918 | 规则求值 | 正常 |
| `services/datasource_adapters.py` | 517 | 数据源适配 | 正常 |
| `services/notify.py` | 512 | 通知 | 正常 |
| `services/distiller.py` | 461 | 蒸馏 | URL 拼接 |
| `services/wecom.py` | 206 | 企微 | 4 处 client |
| `services/ldap.py` | 194 | LDAP | 正常 |
| `services/audit.py` | 35 | 审计写入 | 正常 |

### 7.3 验收清单（可直接勾选）

| 类别 | 检查项 | 命令/方法 |
|---|---|---|
| 架构 | 路由无直连 Hermes | `rg "httpx.AsyncClient" backend/app/routes` = 0 |
| 架构 | URL 归一仅一处 | `rg "re.sub\(r\"/v1\$\"" backend/app` = 0 |
| 架构 | 路由行数 | `Get-ChildItem backend/app/routes/*.py` 最大 ≤300 |
| 契约 | 旧端点结构不变 | `pytest backend/tests/test_contract_parity.py` |
| 权限 | 端点到权限位覆盖 | OpenAPI 扫描脚本（新增） |
| 错误 | 统一信封 | 手工打 401/403/404/409/422/502/504 |
| 前端 | 类型 | `npx tsc -p tsconfig.app.json --noEmit`（先修 TS5102） |
| 前端 | 构建 | `npm run build`（当前 `rolldown` 原生依赖缺失，需修复本地依赖） |
| 后端 | 静态检查 | `ruff check backend/app` |
| 回归 | 三角色冒烟 | 新增 `scripts/smoke_roles.py`（ADMIN/OPERATOR/VIEWER 各 1 轮） |
| 体验 | 刷新恢复/切页不杀 run | E2E：发起长任务 → 切页 → 返回 → 任务仍在 → 刷新 → 3s 内恢复 |
| 迁移 | 旧 URL 全通 | 表驱动清单 15 条，逐条断言 200 |

### 7.4 术语

| 术语 | 含义 |
|---|---|
| Gateway（网关客户端） | 平台侧唯一 Hermes 出口：`integrations/hermes/` |
| GatewayEvent | 平台统一事件模型，屏蔽 Chat/Runs/Session 三种上游流差异 |
| 能力位 | `/v1/capabilities.features` 的布尔开关，用于门控与降级 |
| 会话映射 | 平台会话 ↔ Hermes session id 的持久化关系 |
| expand-contract | 先加列后删列的数据库迁移法，保证可回滚 |
| 事件中心 | 告警、进行中 RCA、报告库的统一入口 |

---

*本文档为只读分析产出，唯一写入文件；未改动任何代码，未执行 docker 命令。*
