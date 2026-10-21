# 六脉 RCA 平台能力融合说明

> 源项目：`C:\Users\11490\Desktop\六脉RCA平台_源码导出_20261015`
> 目标项目：`E:\dev\Liumai`（FastAPI + PostgreSQL + React 19）
> 融合日期：2026-10-17

---

## 一、源服务分析（webhook_rca_new.py）

源服务是一个**零依赖单文件 Python HTTP 服务**（`http.server`，13,983 行，监听 8642），
所有后端逻辑、7 个页面的 HTML/CSS/JS 都内嵌在同一个文件里；配套两个 shell watchdog。

### 1. 核心链路

```
监控平台 ──POST /webhook/alert──▶ normalize_alert
                                  │  Tarsier / eventInfo / Java Map.toString()
                                  │  字段兼容（SERIAL/CINAME/CIAPPLICATION/SEVERITY…）
                                  ▼
                        dedup_key + 去重窗口（默认 300s）
                                  ▼
                        classify_alert（性能/错误/挂起/连接/未知）
                        severity_level（1 严重 … 5 提示）
                                  ▼
                  ┌──────────── 触发策略（alert_policy.json 热加载）────────────┐
                  │ A 关键组件 + 高严重度                                     │
                  │ B 高危故障签名（与严重度解耦）                             │
                  │ C ClickHouse 交易量波动（辅助信号）                        │
                  └───────────────────────────────────────────────────────────┘
                                  ▼
             人工模式 ──▶ 收件箱待勾选         自动模式
                                              ├─ 未命中 ──▶ 垃圾箱（filtered）
                                              ├─ 同应用运行中/合并窗口内 ──▶ 附着（coalesced）
                                              └─ 新应用 ──▶ 新建 RCA（triggered）
                                  ▼
                 任务 JSON 写入 /opt/data/rca-jobs/<id>.json
                 nohup hermes -s new-rca chat -m <model> -q <prompt>
                                  ▼
                 stdout 实时解析 ──▶ /progress/push 进度
                 /opt/data/rca-reports/*.html + *.json 报告
                 SQLite 指标库 / 根因知识库（Jaccard）/ 处置建议库 / 审计
```

### 2. 主要功能模块

| 模块 | 源实现 | 说明 |
|---|---|---|
| Webhook 接入 | `_handle_alert` / `_process_single_alert_inner` | 支持单条、数组、`eventInfo` 嵌套、Java `Map.toString()`、form 兜底 |
| 字段归一化 | `normalize_alert` | Tarsier 原生字段 + 通用字段（`alertId/alertLevel/alertContent/host_ip…`） |
| 告警分类 | `classify_alert` | `performance_degradation / error_spike / service_hang / connectivity_loss / unknown` |
| 严重级别 | `get_severity_level` | 1 严重、2 重要、3 一般、4 告警、5 提示；未知兜底 4 |
| 触发策略 | `should_trigger_multi` + `alert_policy.json` | A 关键组件 / B 高危签名 / C 交易量波动；阈值与前溯窗口热加载 |
| 去重 | `dedup_key` / `is_duplicate` | alertId 优先；无 alertId 用 IP+应用+指标指纹 |
| 应用级合并 | `_register_app_rca` / `_attach_alert_to_rca` | 同应用合并窗口（默认 600s）内不再新起会话，扩展分析窗并追加原始告警 |
| 人工/自动模式 | `TRIGGER_MODE` | 人工模式所有告警先入收件箱，仪表板勾选触发 |
| RCA 执行 | `launch_hermes_rca` / `build_rca_prompt` | 后台子进程驱动 Hermes `new-rca`，并发信号量排队 |
| 进度与报告 | `rca_progress` / `reports` | 实时步骤、思考过程 transcript、HTML+JSON 报告 |
| 根因知识库 | `_kb_*` | Jaccard 相似检索、确认/误报标注、L1 历史案例注入 |
| 处置建议库 | `_advice_*` | docx/xlsx/csv/md/txt 上传解析，注入分析提示词 |
| RBAC / 审计 | LDAP + `rca-roles.json` / `rca-audit.jsonl` | 12 项细粒度权限、审计留痕、一次性预览令牌 |
| 通知 | `send_wechat_*` / `edong_notify_*` | 企业微信单聊/群聊双通道 |
| 页面 | 7 个内嵌页面 | 进度仪表板、告警中心、报告库、统计、知识库、系统管理、任务详情 |

---

## 二、融合原则

不把 13k 行单文件整体搬进 Liumai，而是**保留源服务的行为语义，用 Liumai 的技术栈重新实现**：

| 源实现 | Liumai 融合后 |
|---|---|
| `http.server` 单文件 | FastAPI 路由 + SQLAlchemy async 模型 |
| 文件 / SQLite 存告警、报告、知识、审计 | PostgreSQL 表：`alerts` / `rca_reports` / `root_cause_knowledge` / `audit_logs` |
| `alert_policy.json` 热加载 | `system_config.rca_alert_policy`（管理员 UI/API 即时保存） |
| Hermes CLI 子进程（`new-rca` skill） | `HermesClient.run_rca()`（OpenAI 兼容 `/v1/chat/completions`），后台 asyncio 任务 + 信号量 |
| HTML 报告文件 | 结构化 JSON 报告入库（根因/置信度/证据/影响面/处置建议）+ 报告库页面 |
| LDAP 搜索 + 自研 12 权限 | 复用 Liumai 现有 JWT + ADMIN/OPERATOR/VIEWER RBAC |
| 内嵌前端页面 | React 页面：告警中心（新）、RCA 报告库/根因知识库（扩展） |
| 企微双通道 | 复用 `WeComClient`，可选推送（`alert_notify_enabled` + `wecom_alert_chat_id`） |

---

## 三、数据模型（新增）

| 表 | 用途 |
|---|---|
| `alerts` | 归一化后的告警收件箱/垃圾箱；`status = pending/triggered/coalesced/filtered/dismissed`；保留 `raw_payload` |
| `rca_reports` | 每次成功 RCA 的结构化报告（与 `rca_sessions` 1:1） |
| `root_cause_knowledge` | 根因候选/确认/误报；`digest` 用于 Jaccard 相似检索与 L1 注入 |
| `audit_logs` | 告警接入、人工触发、策略变更、根因标注、RCA 完成/失败等审计 |

`rca_sessions` 增加：`service_name`、`alert_count`、`trigger_reason`。

迁移脚本：

- 新库：`backend/migrations/init.sql`（已追加建表语句）
- 已有库：`backend/migrations/20261017_alert_pipeline.sql`

```powershell
Get-Content backend/migrations/20261017_alert_pipeline.sql -Raw |
  docker exec -i liumai-postgres psql -U liumai -d liumai -v ON_ERROR_STOP=1
```

---

## 四、触发管线（backend/app/services/alert_pipeline.py）

1. **归一化**：`normalize_alert()` 兼容 Tarsier、`eventInfo`、Java Map 字符串、通用字段。

### 4.1 `eventInfo` 为 Java Map 字符串（集中监控 Tarsier 实际报文）

集中监控推送的 `eventInfo` 是**字符串化的 Java Map**（`Map.toString()`），不是嵌套对象：

```json
{"eventInfo": "{SERIAL=HW3224009787-2269, SEVERITY=2, CINAME=5308353857500138, SUMMARY=错误信息:TCCM记账失败|告警信息(简要): 告警名称: 批次查证记账告警, 告警联系人: 毕玉朋 , CIAPPLICATION=, CICATEGORYNAME=应用监控默认丰富, CIID=1000000000454628, CITYPE=801, KPINAME=XCP3532B, LASTOCCURRENCE=2026-09-14T15:43:12, DURATION=null}"}
```

解析规则（`_parse_java_map_string` / `_split_java_map_parts`）：

- 去掉外层 `{}`；`KEY=VALUE` 只按**第一个** `=` 切分（值内可含 `=`）；
- 顶层 ASCII 逗号仅在其后紧跟 `KEY=`（`^\s*[A-Za-z_$][\w.$-]*\s*=`）时才切分，
  否则视为值的一部分 —— 值内的英文逗号、`|`、`:`、中文标点都不会截断字段；
- `null` / 空值视为缺失并走回退；嵌套 `{…}`、双引号、转义会被识别，花括号不平衡时
  退回「仅按 KEY= 前瞻」再解析一次；
- `eventInfo` 也可以是 JSON 对象、JSON 字符串或已解析的 dict（旧格式兼容）。

字段映射（缺失时回退）：

| 目标 | 来源 |
|---|---|
| `alertId` | `SERIAL` → `ID` → `DUPLICATESERIAL` → `SOURCEEVENTID`（空则 `auto-…`） |
| `content` | `SUMMARY` → `SOURCESUMMARY` |
| `severity` | `SEVERITY`（数字 1-5）→ `SOURCESEVERITY`（如 `2_2` → 2） |
| `alertTime` | `LASTOCCURRENCE`（ISO-8601，默认 +08:00） |
| `source` | `SOURCENAME` |
| `ci_name` | `CINAME` → `SERVERNAME` → `source` |
| `ci_application` | `CIAPPLICATION` → `CICATEGORYNAME` |
| `ci_id` | `CIID` |
| `ci_type` | `CITYPE`（如 `801`） |
| `metric` | `KPINAME` |
| `service_name` | `ci_application` → `ci_name` → `source` |
| `raw` | 解析后映射 + 原始 `eventInfo` 字符串（`_eventInfo`，截断） |

去重：`dedup_key = rid:<alertId>`，同一 `SERIAL` 在去重窗口（默认 300s）内重复推送返回
`duplicate`；JSON 数组批量推送逐条处理、逐条返回 `status`。

2. **去重**：`dedup_key()` → `alerts` 表按 `created_at` 窗口查重（默认 300 秒）。
3. **分类/定级**：`classify_alert()`、`severity_level()`。
4. **策略判定**：`decide_trigger()`
   - 严重级别触发：`level <= trigger.severity_max`（默认 2，可在 UI 关闭）
   - A 路：关键组件命中且级别达标
   - B 路：高危故障签名命中（不受级别限制）
   - C 路：交易量波动（保留开关；需要单独接入 ClickHouse 数据源后启用）
5. **模式**：
   - `manual`：告警入收件箱（`pending`）
   - `auto`：未命中 → `filtered`（垃圾箱）；命中 → 查同应用活动会话
6. **应用级合并**：同 `service_name` 的 `QUEUED/RUNNING` 会话且在合并窗口内 → 附着为 `coalesced`，
   累加 `alert_count`、扩展 `time_window_end`、写时间线；不新建会话。
7. **触发 RCA**：新建 `RcaSession`（`PASSIVE`/`QUEUED`，窗口 = 告警时间 − 前溯分钟 ~ 告警时间），
   事务提交后 `BackgroundTasks` 调度 `run_rca_session()`。
8. **后台执行**（backend/app/services/rca_runner.py）：
   - 全局 `asyncio.Semaphore(settings.RCA_MAX_CONCURRENCY)` 限流，超限保持 `QUEUED`
   - 汇总该会话关联的全部告警 → 检索相似历史根因（L1）→ 调用 Hermes
   - 解析 JSON 输出 → 写 `rca_reports` → 更新会话状态/根因/证据/完成时间
   - 自动沉淀 `root_cause_knowledge`（`pending`）→ 写审计 → 可选企微通知
   - 超时/不可达 → `FAILED`，失败原因写入时间线与审计，不影响 API

---

## 五、API

### 公开接入

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/alerts/webhook` | 告警接入；支持对象/数组；配置 `webhook_token` 后需 `X-Webhook-Token` |
| GET | `/api/alerts/webhook-info` | 回调地址、令牌、curl 示例、支持格式（登录） |
| POST | `/api/alerts/webhook/rotate-token` | 重新生成令牌（管理员） |

### 收件箱 / 策略 / 统计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/alerts/inbox` | 支持 `status/search/page/page_size` |
| GET | `/api/alerts/trash` | 过滤/忽略的告警 |
| POST | `/api/alerts/trash/clear` | 清空垃圾箱（管理员） |
| POST | `/api/alerts/{id}/trigger` | 人工触发 RCA（后台执行） |
| POST | `/api/alerts/{id}/dismiss` | 忽略告警 |
| GET/PUT | `/api/alerts/policy` | 读取/保存触发策略（PUT 管理员） |
| GET | `/api/alerts/stats?days=7` | 状态/级别/应用/类型/RCA 统计 |

### RCA 报告与知识库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rca/reports` | 报告库搜索（服务/根因） |
| GET | `/api/rca/sessions/{id}/report` | 报告 + 关联告警 |
| GET | `/api/rca/sessions/{id}/alerts` | 会话关联告警 |
| POST | `/api/rca/sessions/{id}/rerun` | 重新分析 |
| GET | `/api/knowledge/root-causes` | 根因列表（label/service/search） |
| GET | `/api/knowledge/root-causes/similar` | Jaccard 相似案例 |
| POST | `/api/knowledge/root-causes` | 手工新增根因 |
| PUT | `/api/knowledge/root-causes/{id}/label` | 确认/误报/待确认 |
| DELETE | `/api/knowledge/root-causes/{id}` | 删除（管理员） |
| GET | `/api/audit` | 审计日志（管理员） |

### 示例：模拟一条 Tarsier 告警

```powershell
$body = @{
  SOURCENAME='Goldendb'; SOURCECINAME='10.20.0.11'
  CINAME='pay-node-01'; CIAPPLICATION='支付核心'
  SEVERITY=1
  SUMMARY='支付服务线程池耗尽，交易失败率上升'
  KPINAME='pay.threadpool.active'
  LASTOCCURRENCE=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  SERIAL='alert-20261017-0001'
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:3000/api/alerts/webhook' -Method Post `
  -ContentType 'application/json' -Body $body
```

返回示例：

```json
{"status":"accepted","alert_id":"alert-20261017-0001","rca_session_id":7,
 "severity_level":1,"severity_label":"严重","alert_type":"performance_degradation",
 "trigger_reason":"multi:严重级别1(严重)+关键组件:支付核心+高危签名:线程池耗尽",
 "message":"RCA 已触发（…）","run_session_id":7}
```

其它状态：`inboxed`（人工模式）、`filtered`（未命中策略）、`coalesced`（并入已有会话）、
`duplicate`（去重窗口内重复）。

---

## 六、前端

| 页面 | 路由 | 内容 |
|---|---|---|
| 告警中心（新） | `/alerts` | 统计卡片、收件箱（勾选/批量触发/忽略）、垃圾箱、触发策略编辑、Webhook 接入说明与 curl、告警详情抽屉（含原始报文） |
| RCA 分析（扩展） | `/rca` | 分析会话、报告库（搜索/详情）、根因知识库（确认/误报）；详情抽屉展示根因、置信度、证据链、处置建议、关联告警、时间线、重新分析 |
| 概览 / 历史记录 | `/` / `/history` | 兼容后端大写状态枚举（COMPLETED/FAILED/RUNNING），统计与状态标签正确显示 |

导航新增「告警中心」（侧边栏第二项）。

---

## 七、配置

- 触发策略与 Webhook 令牌：告警中心 → **触发策略 / 接入**（管理员）
- Hermes 地址/密钥：系统设置 → 智能引擎（复用 `/api/auth/hermes-config`）
- 企业微信通知：策略表单里勾选并填写群 `chat_id`；需环境变量 `WECOM_CORP_ID/WECOM_CORP_SECRET`
- 并发上限：`RCA_MAX_CONCURRENCY`（compose 默认 5）；策略里的 `rca.concurrency` 作为配置项保留，
  运行时以服务端信号量为准（避免热改导致槽位泄漏）
- 授权令牌：未设置时开放接入；建议在接入监控前点击「重新生成」并配置到推送端

---

## 八、验证记录（本机）

| 场景 | 结果 |
|---|---|
| 严重告警自动触发 | `accepted` → 创建 RCA #7 → `COMPLETED`（mock Hermes），报告入库、根因候选生成 |
| 同应用第二条告警 | `coalesced`，RCA #5 `alert_count=2`，未新建会话 |
| 重复 alertId | `duplicate`，300s 内不重复触发 |
| 未命中策略 | `filtered` 进垃圾箱，统计与审计正确 |
| 人工模式 | `inboxed` → 勾选 → `POST /{id}/trigger` → RCA #4 |
| Webhook 令牌 | 无令牌 `401`，带 `X-Webhook-Token` 通过 |
| 根因标注 | `pending → confirmed`，相似检索命中（similarity 0.19） |
| 失败降级 | Hermes 不可达时状态 `FAILED`，时间线/审计记录原因，不影响其他接口 |
| 前端渲染 | Headless Chrome 验证 `/alerts`、`/alerts` 策略页签、`/rca?s=7` 无控制台异常 |

> 说明：验证时临时启动了一个 mock Hermes（9876 端口）用于打通成功链路，验证后已恢复
> `hermes_url` 为空（回退环境变量默认 `http://hermes-gateway:8080`）。

---

## 九、未移植 / 后续可选项

以下能力属于源服务的部署环境特化，本次未纳入（不影响主链路）：

1. **LDAP 用户搜索 + 12 项细粒度权限配置**：Liumai 已用 JWT + ADMIN/OPERATOR/VIEWER 覆盖。
2. **Hermes CLI 子进程 + transcript 实时回放**：改为 OpenAI 兼容 API，进度以时间线事件呈现；
   如需完整思考过程，可后续接入 Hermes 流式事件落库。
3. **HTML 报告文件与一次性预览令牌**：当前以结构化 JSON + 页面渲染替代；报告导出可后续补充。
4. **处置建议库 docx/xlsx/复盘会纪要解析**：当前知识中心支持文档入库，未实现专用表格解析。
5. **ClickHouse 交易量波动（C 路）**：策略开关保留，但未启用；接入 ClickHouse 数据源后可补齐。
6. **Tarsier 分析窗预取、批量 CLI**：源环境专有工具链，Liumai 通过 Hermes 技能自行取数。
7. **企微单聊中继（wecom_bot_new.py, 9301）**：Liumai 仅保留可选群通知。
8. **SQLite 指标库 / 146+ 技能中心**：Liumai 已有技能中心页面，指标统计改由 `alerts`/`rca_reports` 聚合。

---

## 十、变更文件

**后端**

- `backend/app/models/__init__.py`：新增 `Alert`/`RcaReport`/`RootCauseKnowledge`/`AuditLog`，扩展 `RcaSession`
- `backend/app/services/alert_pipeline.py`（新）：归一化、策略、去重、合并、入库
- `backend/app/services/rca_runner.py`（新）：后台 RCA、报告解析、知识沉淀、通知
- `backend/app/services/audit.py`（新）
- `backend/app/routes/alerts.py`：Webhook、收件箱、策略、统计、人工触发
- `backend/app/routes/rca.py`：报告库/报告详情/会话告警/重新分析；触发改为后台执行
- `backend/app/routes/root_cause.py`（新）、`backend/app/routes/audit.py`（新）
- `backend/app/services/hermes.py`：支持自定义超时
- `backend/app/main.py`：注册新路由
- `backend/migrations/init.sql`、`backend/migrations/20261017_alert_pipeline.sql`

**前端**

- `src/pages/alerts.tsx`（新）：告警中心
- `src/pages/rca/rca-page.tsx`：报告库、根因知识库、报告详情抽屉
- `src/pages/dashboard.tsx`、`src/pages/history/history-page.tsx`：状态枚举大小写兼容
- `src/lib/api.ts`：告警/报告/根因/审计 API 客户端
- `src/App.tsx`：路由与导航
- `docker/nginx/default.conf`：`Host $http_host`（Webhook 示例地址保留端口）
