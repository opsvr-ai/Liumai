# Webhook 告警 → 自动触发 RCA：老平台能力对照与差距分析

> 评估对象：老平台「六脉RCA平台」（`六脉RCA平台/`，单文件 14,420 行 + 2 个 watchdog 脚本）
> vs 新平台 Liumai（FastAPI + PostgreSQL + React，当前工作区文件为准）
> 场景：启动 webhook 服务 → 告警平台推送告警 → 平台**按配置的 RCA 触发规则**自动触发 RCA
> 分析方式：**只读**（grep + read），未修改任何代码、未重启任何容器。所有结论均附 `文件:行` 证据；找不到的写"未找到"。

## 0. 结论摘要（TL;DR）

1. **主链路 happy path 已打通**：接收 → 归一化 → 去重 → 全局策略判定 → 建 `RcaSession` → 后台调 Hermes → 结构化报告入库 → 知识库沉淀 → 可选企微通知。字段归一化、级别映射、A/B 多信号、去重、应用级合并、收件箱/垃圾箱这些"骨架"基本做到与老平台等价，个别处更好。
2. **但"按配置的 RCA 触发规则"名不副实**：`AlertRule` 只有模型 + CRUD，**完全没有接入 `ingest_alert`**；`RcaSession.rule_id` 全仓从未被写入；规则页前端字段（`source/severity/condition_expr`）与后端 schema（`conditions/actions`）**互不匹配**。这一条直接命中用户场景的核心承诺，判 **P0**。
3. **任务生命周期无人接管**：会话只在被 `BackgroundTasks` 调度时才推进状态；进程重启/崩溃后 `QUEUED/RUNNING` 永久僵尸，且无终止、无超时回收、无 watchdog。webhook 会返回 `accepted`，但可能永远没有报告 —— **静默失效**，判 **P0**。
4. 运维感知与交付物缺口明显：**无实时进度、无思考过程回放、无 HTML 报告/下载/导出、通知无报告链接且无"分析开始"通知**；人工批量触发**不做聚合**（N 条告警 → N 个会话）。
5. 统计口径：54 项能力中 **完全覆盖 17（31%）、部分覆盖 17（31%）、缺失 16（30%）、更差 4（7%）**。缺失集中在"执行期可观测性 / 交付物 / 规则引擎 / 生命周期 / 清空保留"。

---

## 1. 方法与证据约定

### 1.1 覆盖判定口径

| 判定 | 含义 |
|---|---|
| **完全覆盖** | 语义与效果等价，或实现形态不同但运维可感知行为一致 |
| **部分覆盖** | 有对应实现，但触发条件、边界、产物或默认值存在可观察差异 |
| **缺失** | 新平台未找到对应实现 |
| **更差** | 同类能力有实现，但健壮性/语义**弱于**老平台（含"配置存在但不生效"） |

"未找到"= 在 `backend/`、`src/`、`docker*` 全量 grep 后无对应实现，不做推测。

### 1.2 证据别名（下文表格沿用）

| 别名 | 实际路径 |
|---|---|
| **老** | `六脉RCA平台/webhook_rca_new.py`（14,420 行；另 `webhook_watchdog.sh`、`rca-stack-watchdog.sh`） |
| **PIPE** | `backend/app/services/alert_pipeline.py` |
| **AR** | `backend/app/routes/alerts.py` |
| **RUN** | `backend/app/services/rca_runner.py` |
| **RCR** | `backend/app/routes/rca.py` |
| **RUL** | `backend/app/routes/rules.py` |
| **M** | `backend/app/models/__init__.py` |
| **H** | `backend/app/services/hermes.py` |
| **UI-A** | `src/pages/alerts.tsx` |
| **UI-R** | `src/pages/rca/rca-page.tsx` |
| **API** | `src/lib/api.ts` |

### 1.3 扫描主题（grep 关键词）

`normalize_alert` / `eventInfo` / `_parse_java_map_string` / `dedup_key` / `is_duplicate` / `APP_COALESCE_WINDOW` / `SEVERITY_TRIGGER_MAX` / `UNRECOGNIZED_SEVERITY` / `CRITICAL_COMPONENTS` / `HIGH_RISK_KEYWORDS` / `trigger_paths` / `alert_policy` / `TRIGGER_MODE` / `alert_inbox` / `alert_trash` / `AUTOCLEAR` / `MAX_CONCURRENT_RCA` / `_rca_slots` / `PROGRESS_KEY` / `transcript` / `_rescue_report` / `notify_rca_started` / `notify_rca_completed` / `edong_notify` / `_audit` / `PERMISSION_KEYS` / `_kb_history_for` / `_inject_remediation` / `_stats_query`；新平台侧：`AlertRule` / `ingest_alert` / `decide_trigger` / `run_rca_session` / `_rca_slot` / `create_manual_session` / `notify` / `terminate` / `download`。

---

## 2. 覆盖度总览（54 项）

| # | 能力点 | 老平台 | Liumai | 判定 |
|---|---|---|---|---|
| **A. 接入与解析** | | | | |
| 1 | Webhook 接收（单对象 / JSON 数组） | 老:14028-14079 | AR:135-190 | 完全覆盖 |
| 2 | 接入鉴权（可选令牌） | 老:13230（公开白名单，无令牌） | AR:146-155, 238-251 | 完全覆盖（更优） |
| 3 | Tarsier / 通用字段归一化 | 老:2100-2176 | PIPE:288-329 | 完全覆盖 |
| 4 | `eventInfo` 嵌套 + Java `Map.toString()` | 老:2012-2098, 2073-2098 | PIPE:184-219, 274-286 | 完全覆盖 |
| 5 | Zabbix 专有字段（host/trigger/item key/eventid） | 老:未找到（仅通用别名） | PIPE:294-314（仅通用别名） | 部分覆盖（两侧同缺） |
| 6 | 展示字段（CI 负责人/服务器名/首次发生/来源类型/级别码） | 老:2136-2196 | PIPE:316-329（未落库，M:584-615 无对应列） | 部分覆盖 |
| 7 | 非 JSON 与 `form-urlencoded` 兜底 | 老:14046-14067 | AR:157-163（直接 400） | **更差** |
| 8 | 处理异常兜底（永不 500、报文诊断日志） | 老:14046-14050, 14081-14092 | AR:170, 181（异常直接冒泡） | **更差** |
| **B. 去重与应用级合并** | | | | |
| 9 | 去重键（alertId 优先 / IP+应用+指标指纹） | 老:2738-2745 | PIPE:400-405 | 完全覆盖 |
| 10 | 去重窗口（默认 300s） | 老:788, 2748-2767（内存态） | PIPE:538-554（DB 窗口，重启不丢） | 完全覆盖（更稳） |
| 11 | 人工模式下重复告警仍入列 | 老:14103（manual 跳过去重） | PIPE:538-554（统一先去重） | **更差** |
| 12 | 应用级合并判定（运行中无条件附着 / 结束后窗口内附着） | 老:2651-2661 | PIPE:612-625（仅"创建时间在窗口内"） | 部分覆盖（更差） |
| 13 | 合并后扩展分析窗 / 累加计数 / 时间线 | 老:2666-2721 | PIPE:626-657 | 部分覆盖 |
| **C. 触发策略** | | | | |
| 14 | 严重级别映射（1 严重 … 5 提示，未知→4） | 老:2251-2285 | PIPE:365-390 | 完全覆盖 |
| 15 | 级别阈值触发（`<= severity_max`） | 老:2508-2522（函数已定义但**主链路未调用**） | PIPE:451, 461（独立触发路径，可开关） | 部分覆盖（语义不同） |
| 16 | A 路：关键组件 + 高严重度 | 老:2336-2346, 2385 | PIPE:413-423, 455 | 完全覆盖 |
| 17 | B 路：高危故障签名（与级别解耦） | 老:2349-2363, 2388 | PIPE:426-435, 456 | 完全覆盖 |
| 18 | C 路：ClickHouse 交易量波动 | 老:2296-2505, 2391 | PIPE:459（硬编码 `path_c = False`） | **缺失** |
| 19 | 未识别级别策略（trigger / ignore） | 老:796, 1571-1573, 2521（消费函数未调用） | PIPE:52（配置存在但 `decide_trigger` 未读） | 部分覆盖（两侧均未生效） |
| 20 | 关键组件 / 高危签名 / 阈值热更新 | 老:1516-1648（5s mtime 轮询） | PIPE:100-138, 141-167（每次请求读 DB） | 完全覆盖（更优） |
| 21 | **AlertRule 规则引擎（conditions/actions 参与判定）** | 老:未找到（策略即规则） | M:193-232 + RUL:109-320 存在，**PIPE:517-700 从不查询** | **缺失** |
| 22 | 规则前后端契约一致性 | 老:13456-13608（策略表单闭环） | API:186-198 vs RUL:30-50（字段不符） | **更差** |
| **D. 模式 / 收件箱 / 垃圾箱** | | | | |
| 23 | 自动 / 人工模式切换与持久化 | 老:989-1023, 13610-13646 | PIPE:46-78, 116-118, 582-593；AR:445-458 | 完全覆盖 |
| 24 | 收件箱（分页/搜索/详情/原始报文） | 老:13648-13653, 1124-1161 | AR:259-294（`raw_payload` 上限 32KB，PIPE:493-509） | 完全覆盖 |
| 25 | 垃圾箱（filtered / dismissed、分页、详情） | 老:13803-13845, 1243-1307 | AR:297-324 | 完全覆盖 |
| 26 | **人工勾选 N 条 → 聚合为 1 个 RCA** | 老:13655-13683, 1363-1484 | UI-A:188-205（逐条循环）；后端无批量端点 | **缺失** |
| 27 | 定时清空 / 按时间清理 / 保留期 | 老:1074-1122, 1321-1360, 13710-13800, 14220-14268 | 仅 AR:327-343（手动清空垃圾箱） | **缺失** |
| 28 | 忽略告警 / 删除收件箱条目 | 老:13685-13708（按 key 批量删） | AR:498-512（仅 dismiss） | 部分覆盖 |
| **E. RCA 执行与产物** | | | | |
| 29 | 并发闸门 + 超限排队 | 老:824-849, 3064-3083 | RUN:94-218（Redis 计数 + TTL 租约） | 完全覆盖（更优） |
| 30 | 并发数运行时热改（策略文件） | 老:838-849, 1633-1637 | RUN:85, 131（只读 `settings`；PIPE:137 仅 clamp） | **缺失** |
| 31 | 排队可见（时间线/进度提示） | 老:3075-3079 | RUN:156-172 | 完全覆盖 |
| 32 | 超时（策略可配） | 老:3144-3163（子进程轮询） | RUN:455-463, 565-569（`wait_for`） | 完全覆盖 |
| 33 | **终止 / 取消（含批量）** | 老:13886-13942 | 全仓未找到（`terminate` 无端点；`H:770-773` 已具备 `stop_run`） | **缺失** |
| 34 | **重启 / 崩溃恢复 + watchdog** | 老:965-986, 13405-13444 + 2 个 watchdog 脚本 | main.py:23-131（无任何恢复）；compose:75 仅重启进程 | **缺失** |
| 35 | **实时进度推送（`PROGRESS\|` / `/progress/push`）** | 老:807, 3188-3191, 13950-14021 | RUN:237-360（非流式，仅首尾事件） | **缺失** |
| 36 | **思考过程落盘 / 回放（transcript）** | 老:859-948, 9257-9290 | 未找到（`raw_output` 入库 RUN:495，但 RCR:112-125 未暴露） | **缺失** |
| 37 | **HTML/JSON 报告文件生成** | 老:2797-2860, 3315-3494, 9160-9217 | 仅结构化 JSON 入库（M:621-646） | **缺失** |
| 38 | **报告下载 / 批量 zip / CSV 导出** | 老:8455-8504, 8517-8529, 9155 | 未找到（无 `FileResponse`/下载端点） | **缺失** |
| 39 | 报告库检索 | 老:8409-8426（q/app/from/to/sort） | RCR:359-402（service/search） | 部分覆盖 |
| 40 | 重跑（单条 / 批量） | 老:13405-13444（`rca_ids` 数组） | RCR:474-500（仅单条） | 部分覆盖 |
| 41 | Top3 根因结论呈现 | 老:1932-1962, 3286-3301 | RUN:279（解析后未落库、未展示） | 部分覆盖 |
| 42 | Tarsier 分析窗告警预取 | 老:2983-3057 | 未找到（依赖 agent 自查） | **缺失** |
| **F. 通知** | | | | |
| 43 | **分析开始通知** | 老:1768-1804, 14193 | 未找到（仅完成/失败） | **缺失** |
| 44 | 完成/失败通知（含报告链接、Top3、耗时） | 老:1807-1853, 3286-3311 | RUN:556-562, 594-595（无链接、无 Top3） | 部分覆盖 |
| 45 | 通道（企微单聊 + 群 + Markdown） | 老:1711-1747（方案 A 双通道） | RUN:369-379 + wecom.py:134-173（仅群、`text`） | 部分覆盖 |
| 46 | 通知开关 / 目标群配置 | 老:810-812, 1655-1657（群 chatid 热改） | PIPE:76, 120-121（默认关闭） | 部分覆盖 |
| **G. 知识 / 统计 / 审计 / 权限 / 清理** | | | | |
| 47 | 历史案例注入（含误报负样本、同应用先验） | 老:5248-5298, 2814-2829 | RUN:305-338, 428-434, 446-447（仅相似 + 同服务加权） | 部分覆盖 |
| 48 | 处置建议知识库（docx/xlsx 解析 + 注入） | 老:5302-5883, 5821 | 未找到 | **缺失** |
| 49 | 知识沉淀与"确认/误报"闭环 | 老:4912-5230, 8654-8668 | RUN:533-546 + `backend/app/routes/root_cause.py` | 完全覆盖 |
| 50 | 统计维度（按天趋势 / 成功率 / p50-p90 / Top 根因 / 最慢） | 老:4477-4545 | AR:346-426（状态/级别/应用/类型 + RCA 均值） | 部分覆盖 |
| 51 | 统计明细 CSV 导出 | 老:8517-8529 | 未找到 | **缺失** |
| 52 | 审计（谁在何时做了什么） | 老:4566-4615, 4588-4615（日期/用户/动作筛选） | audit.py:17-35 + routes/audit.py:37-63（动作/用户筛选，无日期） | 部分覆盖 |
| 53 | 细粒度权限（12 项） | 老:347-363（policy/terminate/export/kb_*…） | ADMIN/OPERATOR/VIEWER 三角色 | 部分覆盖 |
| 54 | 数据保留 / 日志与任务文件清理 | 老:1487-1501, 4850-4911, 14220-14268 | 未找到（`alerts`/`audit_logs` 无保留期策略） | **缺失** |

**统计**：完全覆盖 17（31%）、部分覆盖 17（31%）、缺失 16（30%）、更差 4（7%）。

---

## 3. 分域关键差异说明（带证据的补充）

### 3.1 接入与解析：骨架等价，兜底更差

- 归一化的字段优先级、`eventInfo` 解包、Java Map 字符串（含括号/引号内逗号）解析，两侧几乎逐字对应：
  老:2012-2098 / 2100-2176 ↔ PIPE:184-219 / 288-329。
- 老平台在 `JSONDecodeError` 时会尝试 `form-urlencoded` 还原（老:14051-14062），并对任何处理异常兜底成 JSON 响应 + 记录 body 预览（老:14046-14050, 14081-14092）。Liumai 对非 JSON 直接 `400`（AR:157-163），`ingest_alert` 抛异常会冒泡成 500 —— 真实推送方的格式问题会变成"接入失败且无线索"。
- Zabbix：两侧都**没有**专有字段映射（`host` / `trigger` / `item key` / `eventid` / `status`），只有通用别名（`host_ip`、`alertLevel`、`alertContent`…）。若监控源是 Zabbix 原生 webhook，两侧都需要补映射。

### 3.2 应用级合并：语义被收窄 + 并入告警"看不见"

老平台（老:2651-2661）：同一应用只要有**运行中的** RCA 就一律附着，只有会话**已结束**时才看合并窗口 —— 目的是"绝不重复起会话"。

Liumai（PIPE:612-625）：只认 `status in (QUEUED, RUNNING)` **且** `created_at >= now - app_coalesce_window`。默认窗口 600s、单次 RCA 超时上限 1800s（RUN:455）：

- 一个跑了 11 分钟的 RCA 仍在 RUNNING，但 `created_at` 已超出窗口 → 同应用新告警**会另起第二个会话**，与"合并"目标相反；
- 分析参数在启动时一次性读取关联告警（RUN:413-419），之后并入的告警只更新 `alert_count / time_window_end / 时间线`（PIPE:630-643），**不会进入提示词**。结果：报告实际覆盖 1~2 条告警，而 UI 显示 `alert_count=5`，口径不一致。老平台虽也无法中途改提示词，但会回写任务文件（老:2682-2715）并推送进度（老:2716-2718），agent 重读任务文件时能看到并入告警。

### 3.3 触发策略：A/B 等价，C 与"规则"是真空

- 老平台当前实际生效的是 `should_trigger_multi`（老:14144）；纯级别函数 `should_trigger_rca`（老:2508-2522）已定义但**没有调用点**，因此 `UNRECOGNIZED_SEVERITY` 在老平台也是"看起来有、实际不参与"的配置。
- Liumai `decide_trigger`（PIPE:438-485）**从未读取** `trigger.unrecognized_severity`（仅 PIPE:52 的默认值 + PIPE:116-137 的 clamp），同样不生效。
  → 结论：这一项两侧"名义覆盖、实际等价缺失"，需要显式设计（见 P2-6）。
- **C 路（交易量波动）**：老平台真实实现（CK 查询 + 30min 窗口 + 前 1h/昨日同时段基线 + 降/升阈值 + CK 不可达兜底，老:2288-2505）。Liumai 把 `path_c` 硬编码为 `False`（PIPE:459），而前端仍暴露"C 交易量波动"开关（UI-A:611-621）—— 开关无效。仓库里其实已有 `ClickHouseAdapter`（`backend/app/services/datasource_adapters.py:199-240`），只是没接到触发链路。
- **规则引擎**：`AlertRule` 模型（M:193-232）、CRUD（RUL:109-320）、规则页（`src/pages/rules/rules-page.tsx`）都在，但：
  - `ingest_alert` 全程只读 `system_config.rca_alert_policy`（PIPE:534, 595），**不查询 `AlertRule`**；
  - `RcaSession.rule_id` 只在 RCR:325 被**读取**，全仓 grep `rule_id=` 无任何**写入**；
  - 前端 `AlertRule` 类型是 `source / severity / condition_expr`（API:186-198），页面按此提交（rules-page.tsx:17, 28, 123-125）；后端 schema 只有 `name/description/conditions/actions`（RUL:30-50, 63-75）。→ 页面保存的"条件表达式/来源/级别"对后端**不存在**，规则配置语义丢失。

### 3.4 人工模式与批量：聚合能力缺失

老平台人工模式的价值点就是"勾选多条 → 合并成一次分析"：`POST /alert-inbox/trigger {keys:[…]}`（老:13655-13683，1~50 条）→ `trigger_aggregated_rca`（老:1363-1484）生成 **1 个** RCA，窗口 = 最早告警 − 前溯 N 分钟 ~ 最晚告警，多应用时服务名汇总（老:1395-1396），最差级别取 `min`（老:1398）。

Liumai：前端 `triggerSelected` 直接 `for … await alertsApi.trigger(id)`（UI-A:188-205）→ N 个独立 `RcaSession`、N 份报告、N 个互不相同的时间窗，并立即打满并发（默认 5，compose:84）。后端也没有批量端点（AR 只有 `/{alert_id}/trigger`，AR:466-495）。

### 3.5 执行期可观测性与交付物

| 能力 | 老平台做法 | Liumai 现状 |
|---|---|---|
| 进度 | agent 输出 `PROGRESS\|…` 行 → `push_progress_http`（老:3188-3191）；外部执行器可 `POST /progress/push`（`PROGRESS_KEY` 令牌，老:807, 13950-14021）；仪表板轮询（老:9036） | `HermesClient.run_rca` 是**非流式** `POST /v1/chat/completions`（H:237-360），中途不产生任何事件；只有"RCA 开始分析"与"完成/失败"两条时间线（RUN:399-407, 526-531） |
| 思考过程 | 子进程 stdout 逐行落盘 + 从 Hermes `state.db` 重建（老:859-948）；`GET /progress/<id>/transcript`（老:9257-9290） | 未找到；`rca_reports.raw_output`（RUN:495，≤50k 字符）已入库但 `RcaReportOut`（RCR:112-125）不返回、前端不展示 |
| 报告 | agent 生成静态 HTML + 同名 JSON（老:2847, 2877）；`GET /reports/<name>` 静态服务（老:9155）；zip 批量导出（老:8455-8504） | 只有结构化 JSON（根因/置信度/证据/影响面/处置建议）；无 HTML、无文件、无下载端点（全仓无 `FileResponse`/`download`） |
| Top3 | 解析报告 JSON 取 Top3 进通知（老:1932-1962, 3296-3298） | `_normalise_report` 收集 `top3`（RUN:279）但 `RcaReport` 无该列（M:621-646），解析后丢弃 |
| 终止 | `POST /rca/control {rca_id, action:"terminate"}`：SIGTERM → 5s 后 SIGKILL（老:13886-13942） | 未找到端点；不过 `HermesClient.stop_run / steer_run`（H:770-780）与 `stream_run_events`（H:808-870）已实现，可直接用 |
| 恢复 | 启动恢复进度文件（老:965-986）+ 批量重跑（老:13405-13444）+ 两个 watchdog（`webhook_watchdog.sh` 46 行、`rca-stack-watchdog.sh` 52 行：端口探活 → 重启 → 等端口确认） | `main.py:23-131` 启动只建连接池、刷技能缓存、跑蒸馏循环，**不扫描** `rca_sessions`；`run_rca_session` 只在被调度时推进（RUN:391-398）；`docker-compose.yml:75` 的 `restart: unless-stopped` 只能重启进程，救不回丢失的 `BackgroundTasks` |

### 3.6 通知

老平台：`send_wechat_notification` 双通道（9301 中继单聊 + `appchat/send` 群，Markdown + emoji，老:1711-1747）；开始通知含系统/开始时间/级别/IP/CI/RCA ID/触发原因/告警内容/**实时进度链接**（老:1793-1804）；完成通知含 Top3 + **报告链接**（老:3286-3302）。易动中继函数（老:1857-1998）虽然存在，但 `edong_notify_start/end` 在当前代码中**没有调用点**（grep 仅命中定义），属于"老平台也尚未接线"。

Liumai：只有群通知、`msg_type="text"`、内容截断 2000 字符、无链接、无 Top3、**无开始通知**，且默认关闭（`notify.enabled=False`，PIPE:76；`get_policy` 默认 `"false"`，PIPE:120）。触发完成/失败在 RUN:556-562、594-595。

### 3.7 知识、统计、审计、权限、清理

- 历史案例注入：Liumai 用 Jaccard + 同服务 +0.1 加权（RUN:305-338），把 `confirmed/false_positive/pending` 混合成 `knowledge_history`（RUN:428-434）；老平台分四类（相似/误报负样本/同应用 Top 根因/已确认），并在提示词里写"先独立取证再对照历史"的防锚定纪律（老:2814-2829）。
- 处置建议库（老:5302-5883）：新平台未找到。
- 统计：老平台有按天趋势、成功率、p50/p90、Top 根因、最慢任务、CSV 导出（老:4477-4545, 8517-8529）；Liumai 只有"近 N 天计数 + 平均耗时"（AR:346-426）。
- 审计：Liumai 覆盖了 webhook 接入、人工触发、策略变更、清空垃圾箱、RCA 完成/失败、知识标注（RUN:547-552, 589-591；AR:173-189, 247-250, 338-342, 452-457, 483-487, 508-511），力度不小；但无"终止/删除告警/定时清空/导出"这类动作（因为功能本身缺失），且列表不支持按日期筛选（routes/audit.py:37-50）。
- 权限：老平台 12 项细粒度（老:347-363），Liumai 三角色（M:37-43 + `app/auth.py`），对**现有**功能足够；风险在于未来补"终止/导出/删除"时必须新增权限位，否则 VIEWER 也能终止任务。
- 清理：老平台每 10 分钟清理告警状态、过期 transcript（7 天）、过期任务文件（30 天）、超大日志截断（老:14220-14268, 1487-1501）。Liumai 无任何保留期策略 —— `alerts`（含 32KB raw_payload）、`audit_logs`、`rca_reports.raw_output(50KB)` 会无限增长。

---

## 4. 差距清单（按对"webhook 告警自动触发 RCA"主链路影响排序）

> 工作量刻度：**S** ≤ 1 人日；**M** 2–4 人日；**L** ≥ 5 人日。
> 每条给出：现象 → Liumai 现状（证据）→ 建议实现（后端/前端）→ 工作量。

### P0-1 规则化触发断链：`AlertRule` 未接入引擎，且前后端契约不符

- **现象**：管理员在「告警规则」页配好"高 CPU 告警 → 触发 RCA"，webhook 推来的告警完全不受影响；页面保存的字段后端也不认。用户场景里"按配置的 RCA 触发规则"这一句，当前**没有任何实现**。
- **Liumai 现状**：
  - 模型有：M:193-232（`conditions` / `actions` JSONB / `enabled`）；
  - CRUD 有：RUL:109-320；
  - 但 `ingest_alert` 只读全局策略（PIPE:534, 595）；`RcaSession.rule_id` 从未写入（仅 RCR:325 读取）；
  - 前端类型 `source/severity/condition_expr`（API:186-198）与后端 `conditions/actions`（RUL:30-50）不一致，页面按错误字段提交（rules-page.tsx:17, 28, 123-125）。
- **建议实现**：
  - **后端**：新增 `backend/app/services/rule_engine.py`
    - `async def match_rule(db, team_id, alert, level) -> AlertRule | None`：取 `enabled=True` 的规则（30s 进程内缓存，保存时失效），条件数组按 **AND** 求值；
    - 字段白名单：`source / ci_application / ci_name / ip / content / metric / alert_type / severity_level`；操作符：`eq / ne / contains / in / gte / lte / regex`；
    - 在 `PIPE.ingest_alert` 的 `decide_trigger` 之前插入规则判定：命中 → `triggered`、`trigger_reason=f"rule:{id}:{name}"`、`session.rule_id=rule.id`；未命中 → **回落**现有 policy（保证向后兼容）；
    - `actions` 最小语义：`{"rca": true}`、`{"notify_chat_id": "..."}`、`{"coalesce_window": 900}`、`{"analysis_offset_minutes": 10}`（覆盖全局策略对应项）。
  - **前端**：`rules-page.tsx` 改成"条件行编辑器（字段/操作符/值）+ 动作勾选 + 审核确认"（`RuleWizard` 已具备 4 步骨架，可直接复用，`src/components/rca/rule-wizard.tsx`）；同步修正 API:186-198 的类型。
  - **验证**：一条命中规则 → `accepted` + `rule_id` 落库；一条不命中 → 仍按全局策略判定（回归）。
- **工作量**：后端 **S**（含单测与迁移校验）、前端 **M**。

### P0-2 任务生命周期无接管：重启/崩溃后会话永久僵尸，且无超时回收

- **现象**：webhook 返回 `accepted`、会话进 `QUEUED`，随后进程重启（升级/`docker restart`/OOM）→ `BackgroundTasks` 丢失，会话永远停在 `QUEUED`；已在跑的变成永远 `RUNNING`。此后：并发槽不会被主动归还（Redis 计数只有 4h 租约兜底，且每次新占用都会整体续期，RUN:68-70, 134-138）；同应用新告警要么排队、要么被并入这个"假运行中"会话（PIPE:614-625），**永远没有报告**，而且没有任何告警。
- **Liumai 现状**：RUN:391-398（状态只由调度推进）；M:235-292 无 `heartbeat_at/run_id/attempt` 列；main.py:23-131 启动无恢复逻辑；全仓无 watchdog；`docker-compose.yml:75` 只重启进程。
- **建议实现**：
  - **迁移**：`rca_sessions` 增 `run_id VARCHAR(255)`、`heartbeat_at TIMESTAMPTZ`、`attempt SMALLINT DEFAULT 0`；`alerts` 增 `initial_alert_count`（见 P1-3）。
  - **启动补偿**（main.py lifespan，`init_db` 之后）：
    1. `UPDATE rca_sessions SET status='QUEUED' WHERE status='RUNNING' AND (heartbeat_at IS NULL OR heartbeat_at < now()-interval '120 seconds') AND completed_at IS NULL`；
    2. 取最近 N（如 50）条 `QUEUED` 会话，`asyncio.create_task(run_rca_session(id))`；
    3. 写审计 + 时间线"服务重启，已重新入队"。
  - **周期巡检**（60s 后台任务）：`RUNNING` 且 `now - heartbeat_at > run_timeout_seconds + 120` → `FAILED` + 时间线 + 审计 + 显式 `DECR` Redis 槽一次（幂等键 `rca:released:{id}`）。
  - **心跳**：`run_rca_session` 内起一个 30s 定时写 `heartbeat_at` 的协程，Hermes 返回时取消。
- **工作量**：**S–M**（1–2 人日，含迁移与两个后台任务）。

### P1-3 应用级合并语义被收窄 + 并入告警不进入分析

- **现象**：① 跑了 10 分钟以上的 RCA 不再吸收同应用告警 → 重复会话（老平台对"运行中"无条件吸收，老:2657-2661）；② 已并入的告警只改计数，不进入提示词，报告口径与 UI 不符（RUN:413-419 一次性读取；PIPE:630-643 只改 end/count）。
- **建议实现**：
  - 合并判定改为：`status == RUNNING`（或 `heartbeat_at` 新鲜）→ **无条件**附着；`COMPLETED/FAILED` 才用 `app_coalesce_window`；`QUEUED` 也附着（排队中不需要第二个会话）。
  - 分析前刷新：`run_rca_session` 在调用 Hermes 前重新查一次关联告警（同一 session 内 `db.expire_all()` + 重新 select），把最新告警写入 `alerts` 参数；
  - 会话运行中若继续并入：调用 `H:775-780 steer_run` 注入"新增告警文本"（可选、失败降级），或至少在时间线与报告里标注"分析开始后并入 N 条（未纳入本次推理）"；
  - 报告与列表展示 `initial_alert_count` 与 `coalesced_count` 两个数。
- **工作量**：**S–M**。

### P1-4 人工批量触发不做聚合：N 条告警 → N 个会话

- **现象**：人工模式下勾选 5 条告警点"触发 RCA"，得到 5 个会话、5 份报告、5 个时间窗，并瞬间打满并发（默认 5）；老平台是 **1 个**会话（窗口 = 最早−前溯 ~ 最晚，服务名汇总）。
- **Liumai 现状**：UI-A:188-205 循环单条；AR 无批量端点；`create_manual_session`（PIPE:703-741）仅接受单条 `Alert`。
- **建议实现**：
  - **后端**：新增 `POST /api/alerts/batch-trigger`，body `{ids: [1..50]}`：
    - 校验全部属于本 team 且未被活动会话占用；
    - `service_name = 单应用 ? app : "A、B等N系统"`；`time_window_start = min(alert_time) - offset`；`time_window_end = max(alert_time)`；`trigger_reason = f"manual_batch:{n}:{actor}"`；
    - 一次事务内建 1 个 `RcaSession`，批量更新 `alerts.status='triggered'` / `rca_session_id`，写 1 条时间线 + 1 条审计；
    - 返回 `{rca_session_id, alerts: n}`；`BackgroundTasks` 调度。
  - **前端**：`triggerSelected` 改为一次调用（UI-A:188-205），toast 里给单个会话链接。
- **工作量**：**S**。

### P1-5 闭环交付缺失：进度 / 思考过程 / 报告文件与下载 / 通知链接（含"分析开始"通知）

- **现象**：RCA 跑 10–30 分钟期间，界面只有一条"RCA 开始分析"；完成后只有一段 JSON，没有可下载/可转发的报告；群通知既没有"开始"也没有"报告链接"。老平台这一整条链路（进度 → 思考过程回放 → HTML 报告 → 报告链接/zip 导出）恰恰是它被日常使用的主要原因。
- **Liumai 现状**：RUN:399-407（仅开始）、H:237-360（非流式）、RCR:112-125（DTO 无 `raw_output`）、全仓无下载端点、RUN:556-562/594-595（仅结束通知、无链接）、无开始通知、`msg_type="text"`（RUN:377）。
- **建议实现**（三步可独立上线）：
  1. **进度**：`run_rca_session` 改用 `H.create_run`（H:727-764）+ `H.stream_run_events`（H:808-870），把 `tool.start/tool.complete/assistant.delta` 归一为 `CollaborationEvent(AGENT_PROGRESS)`（同类型 2s 内合并、单会话总条数上限 200），`session.run_id` 落库；前端详情抽屉对 `RUNNING` 会话 5s 轮询 timeline（UI-R:439-453 已有渲染，只需加轮询）。终止即调 `H.stop_run`（H:770-773）。
  2. **报告**：`rca_reports` 增 `top3 JSONB`（把 RUN:279 的解析结果落库）；新增 `GET /api/rca/sessions/{id}/report/download?format=md|html`（服务端用现有字段渲染，不依赖文件系统），`GET …/report/raw` 返回 `raw_output`；前端详情加"下载报告"。若要"附件化"，再加 `report_path` 列与 `FileResponse`。
  3. **通知**：新增"开始"通知（在 PIPE 返回 `run_session_id` 后发送，含服务/级别/窗口/会话链接）；完成通知加 `{PUBLIC_BASE_URL}/rca?s={id}` 与 Top3；`msg_type="markdown"`；默认值从"关闭"改为"开启但需配置 chat_id"（或首启引导）。
- **工作量**：进度 **M**、报告 **S**、通知 **S**。

### P2-6 三处"死配置"：`unrecognized_severity` / `paths.C` / `rca.concurrency`

- `trigger.unrecognized_severity`（PIPE:52, 116-137）在 `decide_trigger`（PIPE:438-485）从未读取；老平台的同名配置（老:796, 1571-1573）也只被未调用的 `should_trigger_rca` 使用 —— **两侧同病**。
- `multi.trigger_paths.C` 前端可勾（UI-A:611-621），后端 `path_c = False` 硬编码（PIPE:459）。
- `rca.concurrency` 前端可改（UI-A:649-656）、后端只 clamp（PIPE:137），运行时读 `settings.RCA_MAX_CONCURRENCY`（RUN:85, 131）。
- **建议**：短期二选一 —— 要么把三项接到实现（C 用 `ClickHouseAdapter`；concurrency 热改需重建闸门，可参考老:838-849 的"重建信号量 + 旧槽跳过 release"）；要么在 UI 上明确标注"未启用/需重启生效"并禁止编辑。**S**。

### P2-7 接入兜底退化

非 JSON 请求直接 400（AR:157-163）、`ingest_alert` 异常冒泡成 500（AR:181）、无原始报文诊断日志。建议：加 `form-urlencoded` 兜底、`try/except` 包住单条处理返回结构化错误、400/500 时记录 body 前 500 字符（对齐老:14046-14067, 14081-14092）。**S**。

### P2-8 无定时清空 / 无保留期

老平台有收件箱/垃圾箱两套 autoclear（老:1074-1122, 1321-1360, 13747-13800）+ 按时间清理（老:13710-13745）；Liumai 只有管理员"清空垃圾箱"（AR:327-343）。建议：新增 `GET/PUT /api/alerts/autoclear`（interval + statuses + enabled）与 60s 巡检任务；再为 `alerts`（如 90 天）、`audit_logs`（180 天）、`rca_reports.raw_output`（30 天后置空）加保留期任务。**M**。

### P2-9 展示字段与 Zabbix 映射

缺 `ci_owner / server_name / first_time / source_type / severity_code`（老:2136-2196 有，PIPE:316-329 丢弃，M:584-615 无列）；Zabbix 原生字段无映射。建议：`alerts` 增列或统一存进 `raw_payload` + 详情抽屉展示；`normalize_alert` 增 `host/trigger/subject/item_key/eventid` 别名。**S**。

### P2-10 统计维度与导出

缺按天趋势、成功率、p50/p90、Top 根因、最慢任务、CSV 导出（老:4477-4545, 8517-8529）。建议：在 `AR /stats` 扩 `by_day / success_rate / p50 / p90 / top_root_causes / slowest`（都能从 `rca_sessions`+`rca_reports` 聚合），加 `GET /api/alerts/stats/export.csv`（需 `report_export` 权限位）。**M**。

### P2-11 审计覆盖与筛选

补"终止/重跑/删除告警/定时清空/报告导出"动作审计；列表加 `date_from/date_to` 与分页大小上限（routes/audit.py:37-63）。**S**。

### P2-12 人工模式重复告警被直接丢弃

老平台 manual 模式绕过去重（老:14103），Liumai 统一在 PIPE:538-554 丢弃 → 人工模式下"同一告警第二次推送"完全不可见。建议：`policy.mode == "manual"` 时跳过去重（或去重命中时仍入列但标记 `duplicate_of`）。**S**。

### P2-13 多团队归属

webhook 固定 `team_id=1`（AR:170, 181 未传 → PIPE:521 默认 1）。建议：按 `webhook_token` 绑定 team（`system_config` 增 `webhook_team_id`），或每个团队独立接入端点。**S**。

### P2-14 报告库检索与预览

仅 `service/search`（RCR:359-402），缺时间范围、应用、排序、HTML 预览（老:8409-8426）。建议：加 `from/to/sort` 参数与"报告详情页"（前端已有抽屉，可扩展为独立路由）。**S–M**。

### P2-15 历史知识注入维度

缺"同应用 Top 根因""已确认案例单独分组""防锚定纪律提示"。建议：在 `RUN._find_similar_cases` 之外补 `same_app_top_causes`（按 service 聚合 `confirmed` 出现频次）与提示词段落（可直接借鉴老:2814-2829 的 a~e 条纪律）。**S**。

### P2-16 处置建议知识库

老平台四期能力（docx/xlsx 解析 + 按系统/类型/关键词检索 + 注入报告"建议措施"，老:5302-5883）。若确需对齐，建议简化为：`remediation_advices` 表（system/category/keywords/content）+ 管理页 CRUD + 分析前按 service/alert_type 检索注入。**L**。

### P2-17 Tarsier 窗口告警预取

老平台在触发时预取 `[最早告警−N分钟, 最晚告警]` 全窗告警写入任务上下文（老:2983-3057，上限 500 条、120s 超时降级）。Liumai 依赖 agent 自行查询。若数据源在平台侧可读（`DataSource` + `datasource_adapters.py` 已支持 zabbix/prometheus/clickhouse/api），可在 `run_rca_session` 里预取并写入 `params.window_alerts`。**M**（依赖接入配置）。

---

## 5. Liumai 比老平台做得更好的 3 点

### 5.1 持久化 + 多租户 + 接入鉴权 + 审计（老平台是进程内存 + JSON 文件）

- 告警、报告、知识、审计全部落 PostgreSQL（M:571-699；迁移 `backend/migrations/20261017_alert_pipeline.sql`），重启不丢；老平台的 `alert_status` / `alert_inbox` / `alert_trash` / `rca_progress` 都是模块级 dict（老:814-818, 994, 1180），靠定时写 JSON 文件兜底。
- 数据按 `team_id` 隔离：列表按团队过滤（AR:269, 306；RCR:252-256），对象级越权一律 404 防探测（AR:475-476；RCR:508-521），跨团队 `team_id` 参数直接 403（RCR:246-250）。
- Webhook 可选令牌校验（AR:146-155，`secrets.compare_digest`）+ 一键轮换（AR:238-251）；老平台 `/webhook/alert` 在公开白名单里（老:13230），任何能连到 8642 的人都能推送。
- 审计入库并可查询（audit.py:17-35 / routes/audit.py），老平台是 JSONL 追加文件 + 20MB 轮转（老:4566-4585）。

### 5.2 并发闸门与稳定性工程更扎实

- 跨进程闸门：Redis 原子 `INCR` + 超限立即 `DECR` + 4h 租约 TTL 自动回收僵尸计数（RUN:94-153, 175-218），Redis 不可用自动降级进程内信号量；老平台是进程内 `threading.BoundedSemaphore`（老:834），多进程部署直接失效，热改并发还要重建信号量并防旧槽泄漏（老:838-849）—— 两者复杂度相当，但新方案在多副本下语义正确。
- 策略**每次请求从 DB 读取**（PIPE:100-138），改完立即生效；老平台靠 5s `mtime` 轮询（老:1516-1648），并且自己承认"同进程连续 POST 时 mtime 精度不够会跳过重载"（老:13560-13562），需额外手工失效缓存。
- 细节防御：`hermes_session_id` UNIQUE 冲突探测（RUN:506-522）、`finish_reason=length` 截断显式告警（RUN:471-478 / H:344-352）、`raw_payload` 32KB/60 字段截断（PIPE:493-509）、审计与通知失败不影响主流程（RUN:378-379, 547-552）。

### 5.3 结构化报告 + 知识闭环 + 契约化 API/前端

- 报告从"一份 HTML 文件"升级为结构化字段：`root_cause / confidence / evidence / impacted_services / recommended_actions / category`（M:621-646），可检索、可聚合、可二次消费；前端一处渲染根因、置信度、证据链、处置建议、关联告警、时间线（UI-R:367-453）。
- 每次完成自动沉淀 `pending` 根因候选（RUN:533-546），运维标"确认/误报"（root_cause.py + UI-R:331-333, 422-431），下次分析作为参考注入（RUN:428-434）—— 闭环比老平台的"指标库 + JSON 文件"更干净。
- 工程形态：FastAPI + Pydantic 契约（RUL/AR/RCR 全部 schema 化）、React 响应式页面、策略/令牌/收件箱/垃圾箱/统计/审计一站式 UI；老平台是 14,420 行单文件内嵌 7 个页面，改一处要动整文件。

---

## 6. 建议落地顺序（最小改动、最大收益）

| 顺序 | 内容 | 影响 | 工作量 |
|---|---|---|---|
| 1 | P0-2 生命周期补偿（启动重入队 + 心跳 + 超时回收） | 消除"受理了但永远没报告"的静默失效 | S–M |
| 2 | P0-1 规则引擎 + 前后端契约修正 | 兑现"按配置规则触发"的产品承诺 | S + M |
| 3 | P1-4 批量聚合触发端点 | 人工模式立刻可用，且不再打满并发 | S |
| 4 | P1-5(3) 通知补开始/链接/Top3；P1-5(2) 报告下载 | 交付闭环，改动小、感知强 | S + S |
| 5 | P1-3 合并语义与"并入可见性" | 告警风暴下不重复起会话、报告口径一致 | S–M |
| 6 | P1-5(1) 进度流（`/v1/runs` + SSE）与终止 | 可观测性 + 可止损 | M |
| 7 | P2-6 死配置、P2-7 接入兜底、P2-8 清空/保留期 | 减少运维踩坑与数据膨胀 | S/M |

---

## 7. 附录

### 7.1 "未找到"清单（明确声明）

| 能力 | 检索范围 | 结论 |
|---|---|---|
| RCA 终止/取消端点 | `backend/` 全量 grep `terminate` / `cancel` / `stop_run` 调用点 | 未找到（仅 `H.stop_run` 定义与 chat 的 run 取消） |
| 报告下载 / zip / CSV 导出 | `backend/` grep `FileResponse` / `download` / `export` | 未找到 |
| 实时进度推送端点 / `PROGRESS_KEY` | `backend/` grep `progress` / `PROGRESS` | 未找到（仅 chat SSE 与 `hermes.py` 内部解析） |
| 思考过程 transcript 存储 | `backend/`、`src/` grep `transcript` / `raw_output` | 未找到（`raw_output` 入库但无读取路径） |
| 收件箱/垃圾箱定时清空 | `backend/` grep `autoclear` / `retention` / `cleanup` | 未找到 |
| 处置建议知识库 | `backend/`、`src/` grep `advice` / `remediation` | 未找到 |
| AlertRule 求值 | `PIPE` 全文、`RUN`、`AR` grep `AlertRule` | 未找到（仅 CRUD 与模型） |
| Zabbix 专有字段映射 | 老:2000-2198、PIPE:184-329 | 两侧均未找到 |
| 老平台易动通知接线 | 老:1857-1998 + 调用点 grep | 函数存在但 `edong_notify_start/end` 无调用点（未接线） |
| 老平台纯级别触发接线 | 老:2508-2522 + 调用点 grep | `should_trigger_rca` 无调用点（已被 multi 取代） |

### 7.2 口径提醒（避免误判）

1. 老平台的"严重级别即触发"是**历史语义**：2026-09-16 改为 A+B+C 多信号后，纯级别路径已被 `should_trigger_multi` 取代（老:2304-2310, 14139-14144）。Liumai 的 `severity_trigger`（PIPE:451）默认开启，因此**默认比老平台更激进**（非关键组件、无高危签名的 1/2 级告警也会触发）。若要与老平台行为对齐，把 `trigger.severity_trigger` 置 false 即可 —— 这是配置差异，不是缺陷。
2. `unrecognized_severity` 在两侧都"未真正生效"，不要按已覆盖评估。
3. 老平台 14,420 行中约 1,100 行是内嵌前端、约 900 行是 LDAP/RBAC、约 1,800 行是知识库/处置建议/统计，本次只对"webhook → 自动触发 RCA"主链路及其直接周边（收件箱/垃圾箱/通知/报告/审计）做对照；对话、知识中心等平台级能力不在对比范围。
4. 本次为**只读静态分析**：未启动服务、未调用接口，结论均来自代码路径；运行时行为（如 Hermes 返回格式）以现有代码的解析逻辑为判断依据。

---

*报告生成：2026-10-17 · 只读分析，未修改任何代码/容器 · 证据行号以当前工作区文件为准*
