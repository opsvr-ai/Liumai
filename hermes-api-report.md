# Hermes Agent HTTP API 调研报告（供六脉 Liumai 对接）

> 检索范围：`E:\dev\Liumai\hermes-docs\`（317 篇 md/mdx，Docusaurus 源码快照）+ 官方站点交叉验证。
> 引用约定：每条结论后附来源。`hermes-docs/xxx.md` = 本地镜像；`官网: docs/xxx` = 仅线上存在、本地镜像缺失的内容。

---

## 0. 先读这一段：本地镜像比线上旧，存在关键事实冲突

| 事实 | 本地镜像 | 线上官网 | 影响 |
|---|---|---|---|
| 配置方式 | 仅环境变量，`config.yaml` 明确"Not yet supported" | 支持 `gateway.api_server.{enabled,port,host,key,cors_origins,model_name}`，环境变量优先 | 部署方式可选，但建议统一用 env |
| 请求级 `model` | "Model field is cosmetic"（被忽略，实际模型由服务端 config 决定） | 支持 `model` + `provider` + `model_options` 按请求覆盖；OpenAI 兼容端点上"裸 model"需 `direct_model_requests: true` 才生效 | **平台做模型切换必须按新行为设计，并做能力探测** |
| `/health/detailed` | "扩展健康检查，报告活跃会话/资源" | 已改为**需认证的就绪检查**，返回 `status` + `readiness.checks`，降级仍 HTTP 200 | 监控逻辑不同 |
| Runs events | 仅"工具进度/token 增量/生命周期事件"这一句 | 给出 `run.completed/failed/cancelled/interrupted`、断线缓冲 5 分钟、steer/approval 端点 | 事件消费代码要按新协议写 |
| 推理内容 | 完全未提 | `reasoning_content` delta、`reasoning` output item、`reasoning_streaming` 能力位 | 前端可直接渲染思考块 |

依据：`hermes-docs/user-guide/features/api-server.md`（L347-349、L431）、`官网: docs/user-guide/features/api-server`、`官网: docs/developer-guide/programmatic-integration`

**结论：以本地镜像为基线，但凡涉及"模型切换 / 推理 / Runs 事件 / 健康检查 / 会话头"的行为，按线上文档实现，并用 `/v1/capabilities` 运行时探测兜底。** 依据：`官网: docs/user-guide/features/api-server`（capabilities 章节）

---

## A. 认证与连接

### A.1 启用与端口

| 项 | 值 | 来源 |
|---|---|---|
| 启用开关 | `API_SERVER_ENABLED=true` | `hermes-docs/user-guide/features/api-server.md` |
| 配置位置 | `~/.hermes/.env`（多实例时为 `~/.hermes/profiles/<name>/.env`） | `hermes-docs/user-guide/features/api-server.md` |
| 进程 | API server 是 **gateway 的一个 adapter**，由 `hermes gateway` 拉起，不是独立服务 | `hermes-docs/developer-guide/gateway-internals.md`（L170）、`hermes-docs/user-guide/features/api-server.md` |
| 默认端口 | `8642` | `hermes-docs/user-guide/features/api-server.md` |
| 默认 bind | `127.0.0.1`（仅回环） | `hermes-docs/user-guide/features/api-server.md` |
| 启动成功标志 | 日志 `[API Server] API server listening on http://127.0.0.1:8642` | `hermes-docs/user-guide/features/api-server.md` |
| 改配置后 | 必须重启 gateway 才生效 | `hermes-docs/user-guide/messaging/open-webui.md`（L106） |
| base URL | `http://<host>:8642/v1` —— **必须带 `/v1`** | `hermes-docs/user-guide/features/api-server.md`（L40）、`hermes-docs/user-guide/messaging/open-webui.md`（L250） |

### A.2 认证

- 所有业务端点（含 `/v1/models`、`/api/jobs`）走 `Authorization: Bearer <API_SERVER_KEY>`。依据：`hermes-docs/user-guide/features/api-server.md`
- `API_SERVER_KEY` **最少 8 字符**（官方建议 `openssl rand -hex 32`）。依据：`hermes-docs/user-guide/docker.md`（L44）
- 绑定非回环地址（如 `0.0.0.0`）时 `API_SERVER_KEY` 为**强制要求**。依据：`hermes-docs/user-guide/features/api-server.md`（L326）、`hermes-docs/reference/environment-variables.md`（L403）
- `GET /health`、`GET /v1/health` 在文档示例中**不带 Authorization 头**即可返回 `{"status":"ok"}`，即健康探针不强制鉴权（文档未显式声明鉴权策略）。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L99）、`hermes-docs/user-guide/features/api-server.md`（L220-222）
- 网关 proxy 模式复用同一 key：`GATEWAY_PROXY_KEY` 必须等于目标机 `API_SERVER_KEY`。依据：`hermes-docs/user-guide/messaging/matrix.md`（L594）

### A.3 CORS（对六脉最关键的一条）

- **默认不开启浏览器 CORS**。依据：`hermes-docs/user-guide/features/api-server.md`（L359）
- 需要浏览器直连时才设 `API_SERVER_CORS_ORIGINS`（逗号分隔精确 origin，不支持在本地文档中声明的通配写法）。依据：`hermes-docs/user-guide/features/api-server.md`（L361-365）
- 开启后：预检带 `Access-Control-Max-Age: 600`；**SSE 响应也带 CORS 头**（EventSource 可用）；`Idempotency-Key` 被列入允许的请求头。依据：`hermes-docs/user-guide/features/api-server.md`（L367-370）
- 官方立场：多数前端（Open WebUI 等）是 server-to-server，**根本不需要 CORS**。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L29）
- 安全响应头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。依据：`hermes-docs/user-guide/features/api-server.md`（L353-355）

### A.4 bind 地址注意事项

- `127.0.0.1`（默认）只能同机访问；Docker 内的前端必须走 `host.docker.internal` 或 `--network=host`，因为容器内 `localhost` 指向容器自己。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L253）
- 跨机/容器访问需 `API_SERVER_HOST=0.0.0.0`，同时**必须**配 `API_SERVER_KEY`。依据：`hermes-docs/user-guide/messaging/matrix.md`（L518-519）
- **端口不要乱选**：`8644` = webhook adapter、`8645` = wecom-callback、`8646` = msgraph-webhook；多 profile 时 API server 建议用 `8650+`。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L278）
- **API server 给出的是 agent 运行时，不是 LLM 代理**：每次请求在 **API server 所在主机**上创建 `AIAgent`，工具（terminal/文件/浏览器/本地 MCP）都在那台机器执行。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L23-27）

### A.5 官方 Web Dashboard 是另一套服务（易混淆）

| 项 | API Server | Web Dashboard |
|---|---|---|
| 启动 | `hermes gateway` | `hermes dashboard` |
| 默认端口 | 8642 | 9119 |
| 鉴权 | Bearer `API_SERVER_KEY` | **文档明确"没有自己的认证"** |
| 用途 | OpenAI 兼容推理入口 | 配置/会话/日志/分析管理台 |
| CORS | 默认关闭，需显式 allowlist | 仅允许 localhost 系 origin（9119/3000/5173） |

依据：`hermes-docs/user-guide/features/web-dashboard.md`（L17、L180、L296-302）

---

## B. 端点清单

### B.1 总表

| 端点 | 方法 | 用途 | 本地镜像 | 官网 |
|---|---|---|---|---|
| `/v1/chat/completions` | POST | OpenAI Chat Completions，无状态 | ✅ | ✅ |
| `/v1/responses` | POST | OpenAI Responses，服务端保存上下文 | ✅ | ✅ |
| `/v1/responses/{id}` | GET / DELETE | 取回 / 删除已存响应 | ✅ | ✅ |
| `/v1/models` | GET | 模型发现（只返回 agent 自身一个） | ✅ | ✅ |
| `/api/model/options` | GET | 完整 provider/模型/价格目录 | ❌ | ✅ |
| `/v1/capabilities` | GET | 能力位探测 | ✅ | ✅ |
| `/v1/runs` | POST | 创建 run（返回 run_id） | ✅ | ✅（202） |
| `/v1/runs/{id}` | GET | 轮询 run 状态 | ✅ | ✅ |
| `/v1/runs/{id}/events` | GET | SSE 事件流 | ✅ | ✅ |
| `/v1/runs/{id}/stop` | POST | 中断 | ✅ | ✅ |
| `/v1/runs/{id}/approval` | POST | **答复待审批的危险命令** | ❌ | ✅ |
| `/v1/runs/{id}/steer` | POST | 工具边界注入中途指令 | ❌ | ✅ |
| `/v1/runs/{id}/resolve-unknown` | POST | 重启后未知准入的恢复 | ❌ | ✅ |
| `/api/jobs` 及子路径 | CRUD | 计划任务管理 | ✅ | ✅ |
| `/health`、`/v1/health` | GET | 存活探针 | ✅ | ✅ |
| `/health/detailed` | GET | 就绪检查 | ✅ | ✅（需认证） |
| `/v1/skills`、`/v1/toolsets` | — | **文档未提及，不存在** | ❌ | ❌ |
| 会话列表/历史（API server 上） | — | **文档未提及** | ❌ | ❌ |

依据：`hermes-docs/user-guide/features/api-server.md`（L52-305）、`官网: docs/developer-guide/programmatic-integration`（端点清单）、`官网: docs/user-guide/features/api-server`

### B.2 POST /v1/chat/completions

- 无状态：每轮把完整对话放进 `messages`。依据：`hermes-docs/user-guide/features/api-server.md`（L56）
- 请求：`model`、`messages[]`（role/content）、`stream`。依据：同上（L59-68）
- 响应：`id`、`object: chat.completion`、`created`、`model`、`choices[0].message{role,content}`、`choices[0].finish_reason`、`usage{prompt_tokens,completion_tokens,total_tokens}`。依据：同上（L71-84）
- 图片输入：`content` 可为数组，含 `text` 与 `image_url`（`{url, detail}`），支持远程 http(s) 与 `data:image/...`。依据：同上（L86-101）
- 不支持：`file` / `input_file` / `file_id` 与非图片 `data:` URL → `400 unsupported_content_type`。依据：同上（L103）
- `system` message 会**叠加**在 Hermes 核心系统提示之上（不会替换工具/记忆/技能）。依据：同上（L307-313）
- 推理（官网）：`choices[0].delta.reasoning_content` 承载思维链，答案仍在 `delta.content`；非流式则在 `choices[0].message.reasoning_content`。依据：`官网: docs/user-guide/features/api-server`
- 终止原因（官网）：正常 `stop`；被中断 `finish_reason: "cancelled"`；失败 `"error"`。依据：`官网: docs/user-guide/features/api-server`（Conversation and terminal-result semantics）
- 客户端自备 `tools`/`tool_choice`：**文档未提及支持**。文档描述的方向是 agent 使用服务端自身工具集（`hermes-api-server`）。依据：`hermes-docs/reference/toolsets-reference.md`（L96）
- 请求级 `temperature`/`max_tokens` 是否透传：**文档未提及**。
- 模型字段：本地镜像称其无效（cosmetic，实际模型由服务端 config 决定）；官网称支持 `model`+`provider`+`model_options`，且裸 `model` 需 `direct_model_requests: true`。依据：`hermes-docs/user-guide/features/api-server.md`（L431）、`官网: docs/user-guide/features/api-server`（Per-request model selection）

### B.3 POST /v1/responses

- 请求：`model`、`input`（字符串或 input 数组）、`instructions`、`store: true`。依据：`hermes-docs/user-guide/features/api-server.md`（L115-123）
- 响应：`id`（`resp_...`）、`object: response`、`status: completed`、`output[]`（`function_call` / `function_call_output` / `message`）、`usage{input_tokens,output_tokens,total_tokens}`。依据：同上（L126-139）
- 关键语义（官网）：`output` 中的 `function_call` 是**已在服务端执行完毕**的回放（`status: completed`），不是待客户端执行的调用。依据：`官网: docs/user-guide/features/api-server`
- 多轮：`previous_response_id` 重建完整链路（含工具调用与结果），并共享同一 session（在仪表板显示为单条会话）。依据：`hermes-docs/user-guide/features/api-server.md`（L160-171）
- 命名会话：`{"input": "...", "conversation": "my-project"}` 自动链到该对话最新响应，无需自己存 response_id。依据：同上（L173-183）
- 图片输入：`input[].content` 支持 `input_text` / `input_image`（远程 URL 或 data URL）；`input_file`/`file_id` → 400。依据：同上（L141-158）
- 存储上限：SQLite 持久化、**最多 100 条，LRU 淘汰**、重启存活。依据：同上（L429）
- `GET /v1/responses/{id}` 可取回（含 reasoning item 回放），`DELETE` 删除。依据：`hermes-docs/user-guide/features/api-server.md`（L185-191）、`官网: docs/user-guide/features/api-server`

### B.4 Runs API

| 端点 | 请求要点 | 响应要点 |
|---|---|---|
| `POST /v1/runs` | `input`（字符串，必填）；可选 `session_id`、`instructions`、`conversation_history`、`previous_response_id` | `{"run_id": "run_abc123", "status": "started"}`；官网标 **202** |
| `GET /v1/runs/{id}` | — | `{"object":"hermes.run","run_id","status","session_id","model","output","usage":{input_tokens,output_tokens,total_tokens}}` |
| `GET /v1/runs/{id}/events` | — | SSE：工具调用进度 + token 增量 + 生命周期事件 |
| `POST /v1/runs/{id}/stop` | — | 立即返回 `{"status":"stopping"}`，在下一个安全中断点停止 |

依据：`hermes-docs/user-guide/features/api-server.md`（L232-269）

补充要点：
- 传 `session_id` 时 Hermes 会在 run 状态中回显，便于平台把自己的会话 ID 与 run 关联。依据：同上（L243）
- 终态 `completed` / `failed` / `cancelled` 的状态会**短暂保留**供轮询与对账。依据：同上（L261）
- `stop` 后 run 会停在 `stopping`，executor 真正退出后才转 `cancelled`；停止请求不会隐藏仍在运行的 worker。依据：`官网: docs/user-guide/features/api-server`
- 事件缓冲：未消费事件 **5 分钟**后过期（仅过期传输状态，run 本身继续存在于轮询/停止/审批中）。依据：`官网: docs/user-guide/features/api-server`
- 终态判定表（官网）：

| 轮次结局 | status | 终止事件 | 标志位 |
|---|---|---|---|
| 产出最终答案 | `completed` | `run.completed` | `completed: true` |
| 被中断（/stop 或内部中断） | `cancelled` | `run.cancelled` | `completed:false, interrupted:true, turn_exit_reason` |
| 模型/agent 失败 | `failed` | `run.failed` | `completed:false, error` |
| 运行中 gateway 关闭 | `interrupted` | `run.interrupted` | `error: "Gateway shutdown interrupted the run."` |
| 迭代预算耗尽/截断 | `failed` | `run.failed` | `completed:false, partial, turn_exit_reason`（如 `max_iterations_reached(60/60)`） |

依据：`官网: docs/developer-guide/programmatic-integration`（Terminal run status）

- `/v1/runs/{id}/steer`：仅在 status=`running` 时接受，否则 `409 run_not_accepting_steer`；200 只代表"已入队"，若最终没送达会以 `pending_steer` 挂在终止事件上。依据：`官网: docs/developer-guide/programmatic-integration`
- `/v1/runs/{id}/approval`：答复 run 中挂起的危险命令审批。依据：`官网: docs/developer-guide/programmatic-integration`
- `conversation_history` 非空时**优先于** `session_id`。依据：`官网: docs/user-guide/features/api-server`（Conversation semantics）

### B.5 Jobs API（`/api/jobs`，与 bearer 同一鉴权）

| 端点 | 说明 |
|---|---|
| `GET /api/jobs` | 列出所有计划任务 |
| `POST /api/jobs` | 创建；body 与 `hermes cron` 同构：prompt、schedule、skills、provider 覆盖、delivery target |
| `GET /api/jobs/{id}` | 单任务定义 + 最近一次运行状态 |
| `PATCH /api/jobs/{id}` | 部分更新（prompt、schedule 等），字段合并 |
| `DELETE /api/jobs/{id}` | 删除，**同时取消在途 run** |
| `POST /api/jobs/{id}/pause` | 暂停，挂起下次运行时间戳 |
| `POST /api/jobs/{id}/resume` | 恢复 |
| `POST /api/jobs/{id}/run` | 立即触发（脱计划运行） |

依据：`hermes-docs/user-guide/features/api-server.md`（L271-305）

可用字段（来自 cron 文档，`/api/jobs` 复用同构 body）：`name`、`prompt`、`schedule`（`every 1h` / cron 表达式 / ISO 时间戳）、`skills[]`、`deliver`（`local` / `telegram:<id>` / `origin` / `all`）、`enabled_toolsets[]`、`repeat`、`no_agent`、`workdir`、`context_from`、`model`/`provider`。依据：`hermes-docs/user-guide/features/cron.md`（L62-121、L225-255、L490-499、L536-542）

注意：Job 运行在**完全新鲜的 agent session**里，prompt 必须自带全部上下文；创建/更新时会做 prompt 注入与凭据外泄扫描。依据：`hermes-docs/user-guide/features/cron.md`（L546-558）

Dashboard 另有**另一套** `/api/cron/jobs`（无鉴权、路径不同、trigger 而非 run），不要混用。依据：`hermes-docs/user-guide/features/web-dashboard.md`（L258-280）

### B.6 元数据端点

**GET /v1/models**
- 只把 agent 自己列为可用模型；默认名为 profile 名（默认 profile 为 `hermes-agent`），可用 `API_SERVER_MODEL_NAME` 覆盖。依据：`hermes-docs/user-guide/features/api-server.md`（L193-195、L342）
- 官网明确：这是**刻意最简**的 OpenAI 兼容面，不枚举所有可路由 provider/模型，不做价格与能力富化。依据：`官网: docs/user-guide/features/api-server`

**GET /api/model/options**（官网新增，需 bearer）
- 返回 provider 行、模型能力提示、价格元数据（dashboard Models 页与 TUI 用的同一套数据）；`?refresh=1` 强制刷新并探测所有已保存自定义端点。依据：`官网: docs/user-guide/features/api-server`、`官网: docs/developer-guide/programmatic-integration`

**GET /v1/capabilities**
```json
{"object":"hermes.api_server.capabilities","platform":"hermes-agent","model":"hermes-agent",
 "auth":{"type":"bearer","required":true},
 "features":{"chat_completions":true,"responses_api":true,"run_submission":true,
             "run_status":true,"run_events_sse":true,"run_stop":true,"reasoning_streaming":true}}
```
- 本地镜像列 6 个 feature；官网新增 `reasoning_streaming`，并在其他地方出现 `tool_progress_events`、`run_unknown_resolution`、`browser_extension_control`。依据：`hermes-docs/user-guide/features/api-server.md`（L201-216）、`官网: docs/user-guide/features/api-server`

**GET /v1/skills、GET /v1/toolsets**
- **API server 上不存在，文档未提及。** 本地检索 `v1/(skills|toolsets|sessions)` 零命中。
- 真正可用的等价能力在 dashboard REST（端口 9119，无鉴权）：
  - `GET /api/skills` — 技能名/描述/分类/启用状态
  - `PUT /api/skills/toggle` — body `{"name","enabled"}`，**下次 session 生效**
  - `GET /api/tools/toolsets` — toolset 标签/描述/工具清单/启用状态
  依据：`hermes-docs/user-guide/features/web-dashboard.md`（L282-292、L176）

**健康检查**
- `GET /health` → `{"status":"ok"}`；`GET /v1/health` 为同一探针的 `/v1` 别名。依据：`hermes-docs/user-guide/features/api-server.md`（L220-222）
- `GET /health/detailed`：本地镜像描述为"额外报告活跃会话、运行中 agent 与资源占用"（`hermes-docs/user-guide/features/api-server.md` L224-226）；**官网已改为需认证的就绪检查**，返回当前 profile 配置、状态库、模型、磁盘、gateway/platform 状态、活跃 run、待处理完成通知、活跃 delegation 的有限状态；只暴露状态与计数，不含配置值/凭据/路径/命令；**降级时仍返回 HTTP 200**，需看 `status` 与 `readiness.checks`。依据：`官网: docs/user-guide/features/api-server`

### B.7 会话（session）相关

| 需求 | 文档结论 | 来源 |
|---|---|---|
| 在 API server 上列会话/读历史 | **文档未提及，无公开端点** | 本地 grep `v1/sessions` 零命中 |
| 让 API server 记住上一轮 | 三种方式：① `previous_response_id`；② `conversation` 命名会话；③ 请求头 `X-Hermes-Session-Id` / `X-Hermes-Session-Key` | `hermes-docs/user-guide/features/api-server.md`、`hermes-docs/user-guide/messaging/matrix.md`（L611）、`官网: docs/user-guide/features/api-server` |
| Runs 侧会话 | `POST /v1/runs` 传 `session_id`，状态中回显 | `hermes-docs/user-guide/features/api-server.md`（L243） |
| 会话如何存储 | SQLite `~/.hermes/state.db`（含标题、模型、token、全文索引 FTS5）+ gateway JSONL `~/.hermes/sessions/` | `hermes-docs/user-guide/sessions.md`（L13-26、L440-448） |
| API 请求在会话里的 source | 标记为 `api-server` | `hermes-docs/user-guide/sessions.md`（L89） |
| 会话列表/历史/dashboard 检索 | `GET /api/sessions`（近 20 条）、`GET /api/sessions/{id}`、`GET /api/sessions/{id}/messages`、`GET /api/sessions/search?q=`、`DELETE /api/sessions/{id}` | `hermes-docs/user-guide/features/web-dashboard.md`（L202-248） |
| 在指定会话里继续对话 | `POST /api/sessions/{session_id}/chat`、`POST /api/sessions/{session_id}/chat/stream`（支持 `model`/`provider`/`model_options`；流式的 `assistant.completed` 带真实 `completed`/`partial`/`interrupted`，终止事件为 `run.completed`/`run.failed`/`run.cancelled`） | `官网: docs/developer-guide/programmatic-integration`、`官网: docs/user-guide/features/api-server` |
| session key 格式 | `agent:main:{platform}:{chat_type}:{chat_id}`，**文档明确禁止手工拼接**，必须用 `build_session_key()` | `hermes-docs/developer-guide/gateway-internals.md`（L68-78） |

**对平台的现实建议：会话列表/历史走 dashboard REST 或直读 SQLite，不要指望 API server 提供。** 依据：`hermes-docs/user-guide/features/web-dashboard.md`、`hermes-docs/user-guide/sessions.md`

---

## C. SSE 事件格式

### C.1 Chat Completions 流

- 标准 `chat.completion.chunk` 事件 + Hermes 自定义具名事件 `hermes.tool.progress`。依据：`hermes-docs/user-guide/features/api-server.md`（L105-109）
- `hermes.tool.progress` 的用途：工具启动可见性，**不污染持久化的 assistant 文本**。依据：同上（L108）
- **字段级 JSON 结构：文档未给出**（本地与官网都只到"事件名 + 用途"这一层）。文档可确认的呈现形式是"工具 emoji + 该工具的关键参数"的内联提示。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L216、L224-226）
- 保活（官网）：所有 SSE 流（Chat Completions / Responses / `/api/sessions/{id}/chat/stream` / `/v1/runs/{id}/events`）在 **10 秒无事件**时发 `: keepalive` 注释行；自定义解析器必须跳过以 `:` 开头的行。依据：`官网: docs/user-guide/features/api-server`
- 关闭工具进度帧（官网）：`gateway.platforms.api_server.tool_progress_events: false`（默认 true），仅作用于 Chat Completions；`/v1/runs/{id}/events` 永远发工具事件。依据：同上
- 推理帧（官网）：`choices[0].delta.reasoning_content`，与 `delta.content` 分离。依据：同上
- 严格 OpenAI 客户端：若解析器不认识具名事件，必须显式忽略 `event:` 非 `chat.completion.chunk` 的帧，否则会报错。依据：`hermes-docs/user-guide/features/api-server.md`（L105-109）+ `官网`（提供了关闭开关这一事实，反证严格客户端会踩坑）

### C.2 Responses 流

- 事件类型：`response.created`、`response.output_text.delta`、`response.output_item.added`、`response.output_item.done`、`response.completed`。依据：`hermes-docs/user-guide/features/api-server.md`（L105）
- 工具：发出 spec 原生的 `function_call` 与 `function_call_output` output item，客户端可渲染结构化工具 UI。依据：同上（L109）
- 推理（官网）：`response.output_item.added`（`item.type: "reasoning"`）→ `response.reasoning_summary_part.added` → `response.reasoning_summary_text.delta` → `...text.done` → `response.reasoning_summary_part.done` → `response.output_item.done`；`sequence_number` 在推理/文本/工具之间单调递增。依据：`官网: docs/user-guide/features/api-server`
- 终止事件：官网提到 `response.cancelled` / `response.failed`（与 runs 的终态一致）。依据：`官网: docs/user-guide/features/api-server`（Conversation semantics）

### C.3 Runs `/v1/runs/{id}/events`

- 本地镜像只有一句话：工具调用进度、token 增量的**生命周期事件**流，面向"可 attach/detach 而不丢状态"的仪表板。依据：`hermes-docs/user-guide/features/api-server.md`（L263-265）
- **完整事件类型清单：本地文档未提及。** 官网可确认的终止/通知事件：`run.completed`、`run.failed`、`run.cancelled`、`run.interrupted`、`run.steered`。依据：`官网: docs/developer-guide/programmatic-integration`
- 事件载荷字段（官网可确认）：`completed`、`interrupted`、`partial`、`error`、`turn_exit_reason`、`pending_steer`。依据：同上
- 断线重连策略：5 分钟内可续上未消费事件；超时后改用 `GET /v1/runs/{id}` 轮询对账。依据：`官网: docs/user-guide/features/api-server`

### C.4 SSE 消费要点（工程向）

| 要点 | 说明 | 来源 |
|---|---|---|
| 关闭缓冲 | 逐帧 flush，禁用响应缓冲/压缩中间件 | 文档未提及（按 SSE 常规要求，非文档结论） |
| 心跳 | 每 10s `: keepalive`，客户端需跳过注释行 | `官网: docs/user-guide/features/api-server` |
| 代理超时 | 长工具调用可能数十秒无 token，需调大 idle timeout | 由 keepalive 机制存在的理由反推，文档在 keepalive 段落明示"避免客户端 idle timeout" |
| CORS | 浏览器 EventSource 需服务端开 allowlist（SSE 响应会带 CORS 头） | `hermes-docs/user-guide/features/api-server.md`（L369） |

---

## D. 错误码与失败模式

### D.1 文档可确认的错误

| 状态码 | 语义 | 来源 |
|---|---|---|
| `400 unsupported_content_type` | 上传了文件（`file`/`input_file`/`file_id`）或非图片 `data:` URL | `hermes-docs/user-guide/features/api-server.md`（L103、L158） |
| `400`（provider 冲突） | 请求里的 `provider` 与 `model_routes` 别名冲突，服务端拒绝而非"混合物"凭据 | `官网: docs/user-guide/features/api-server` |
| `401` | `Authorization` 与 `API_SERVER_KEY` 不匹配；官方故障排查明确"`/v1/models` 返回 401 = 头没对上 `API_SERVER_KEY`" | `hermes-docs/user-guide/messaging/open-webui.md`（L106、L264-266） |
| `409 run_not_accepting_steer` | 对非 `running` 状态的 run 发 steer | `官网: docs/developer-guide/programmatic-integration` |

### D.2 文档未定义的错误

| 状态码 | 结论 |
|---|---|
| `404` | **API server 的语义文档未提及**（未知 run/response id 的行为未写明） |
| `429` | **API server 自身未文档化限流**。文档中的 429 均指上游 LLM provider 限流（`hermes-docs/reference/faq.md` L297、`hermes-docs/user-guide/features/fallback-providers.md` L104）或 webhook adapter 的路由限流 30 req/min（`hermes-docs/user-guide/messaging/webhooks.md` L318） |
| `5xx` | **文档未提及 API server 的 5xx 语义**（agent 内部失败在 Runs 中体现为 `status: failed` + `error`，而非靠 HTTP 码） |
| 错误响应体 JSON 形状 | **文档未提及**（本地镜像只给 `400 unsupported_content_type` 这类错误标识，未给 body 结构） |

> 对上结论的工程含义：**不要靠 HTTP 状态码判断 agent 是否成功**。Runs 用 `status`，Chat Completions 用 `finish_reason`（`stop` / `cancelled` / `error`）。依据：`官网: docs/developer-guide/programmatic-integration`（Terminal run status）、`官网: docs/user-guide/features/api-server`

### D.3 常见集成错误（高频踩坑）

| 症状 | 原因 | 依据 |
|---|---|---|
| 连接测试通过但模型列表为空 | base_url 少了 `/v1`（官方称"几乎总是"这个原因） | `hermes-docs/user-guide/messaging/open-webui.md`（L250、L256-258） |
| Docker 里连不上 | 容器内 `localhost` 是容器自己；用 `host.docker.internal` / `--network=host` / 桥接 IP | `hermes-docs/user-guide/messaging/open-webui.md`（L253、L321-333） |
| `/health` 通但 `/v1/models` 401 | key 不匹配，或 key < 8 字符 | `hermes-docs/user-guide/messaging/open-webui.md`（L106）、`hermes-docs/user-guide/docker.md`（L44） |
| `/health` 本身失败 | gateway 没加载到 `API_SERVER_ENABLED=true`，需重启 | `hermes-docs/user-guide/messaging/open-webui.md`（L106） |
| 非回环绑定拒绝启动 | 未设 `API_SERVER_KEY` | `hermes-docs/user-guide/features/api-server.md`（L326） |
| 端口冲突 | 撞上 8644/8645/8646 等其它 adapter 端口 | `hermes-docs/user-guide/messaging/open-webui.md`（L278） |
| 响应很慢/像卡死 | agent 正在连续调用工具，非流式会等到全部结束才返回 | `hermes-docs/user-guide/messaging/open-webui.md`（L260-262） |
| 浏览器直连被 CORS 拦 | 未设 `API_SERVER_CORS_ORIGINS`（默认关闭） | `hermes-docs/user-guide/features/api-server.md`（L359-365） |
| 改了 `.env` 不生效 | API server 只在 gateway 启动时读取；且改了 Open WebUI 侧 env 也只首次生效 | `hermes-docs/user-guide/messaging/open-webui.md`（L78-82、L177-179） |

### D.4 超时基线

- LLM 调用超时默认 `HERMES_API_TIMEOUT=1800s`，流式 socket 读超时 `HERMES_STREAM_READ_TIMEOUT=120s`（本地 provider 会自动抬到 API_TIMEOUT）。依据：`hermes-docs/reference/environment-variables.md`（L522-524）
- 含义：一次 API 请求可能合法地跑十几分钟（多轮工具调用）。平台自己的 HTTP client / 反代 read timeout 必须显著放宽。依据：`hermes-docs/user-guide/messaging/open-webui.md`（L260-262）+ 上述超时配置

---

## E. 对六脉平台最有价值的集成建议（每条附依据）

| # | 建议 | 依据 |
|---|---|---|
| E1 | **走 server-to-server，不开 CORS**：六脉 FastAPI 作为唯一出口调用 Hermes，浏览器只打自己的 API。这样 `API_SERVER_CORS_ORIGINS` 保持默认关闭，暴露面最小。 | `hermes-docs/user-guide/features/api-server.md`（L359-372）、`hermes-docs/user-guide/messaging/open-webui.md`（L29） |
| E2 | **启动时调 `/v1/capabilities` 做能力探测**，按 feature 位决定用 Runs 还是 Responses、渲染不渲染推理块、是否发 steer/approval。避免 Hermes 版本升级后静默错配。 | `hermes-docs/user-guide/features/api-server.md`（L197-218） |
| E3 | **主链路用 Runs API，而不是自己管 Chat Completions 的 SSE**：run 状态可轮询、可重连（事件缓冲 5 分钟）、可 stop、可 steer、可审批；页面刷新不丢进度。聊天式低延迟场景再用 `/v1/chat/completions` 流式。 | `hermes-docs/user-guide/features/api-server.md`（L228-269）、`官网: docs/user-guide/features/api-server`（5 分钟缓冲） |
| E4 | **会话连续性用平台自造 session_id + `X-Hermes-Session-Id` 头**（或 Runs 的 `session_id` 字段），不要自己拼 `agent:main:...` 键 —— 文档明确禁止手工构造 session key。 | `hermes-docs/user-guide/messaging/matrix.md`（L611）、`hermes-docs/developer-guide/gateway-internals.md`（L68-78）、`hermes-docs/user-guide/features/api-server.md`（L243） |
| E5 | **多轮上下文优先用 `previous_response_id` 或 `conversation`**，避免每轮回传全量历史（含工具调用结果会迅速膨胀 token）。注意 100 条 LRU 上限，重要会话要能容忍被淘汰后回退到全量 messages。 | `hermes-docs/user-guide/features/api-server.md`（L113、L160-183、L429） |
| E6 | **工具进度要能"忽略未知事件"**：前端 SSE 解析器遇到 `hermes.tool.progress` / `: keepalive` 必须跳过而非报错；若第三方 SDK 严格，让 Hermes 侧设 `tool_progress_events: false`。 | `hermes-docs/user-guide/features/api-server.md`（L105-109）、`官网: docs/user-guide/features/api-server` |
| E7 | **危险命令审批必须提前决策**：`hermes-api-server` toolset 已去掉 `clarify`、`send_message`、`text_to_speech`，即 agent 无法在 HTTP 上反问用户。要么设 `approvals.mode: smart`，要么用 `/v1/runs/{id}/approval` 把它做成 UI 弹窗，否则长任务会卡在审批上。 | `hermes-docs/reference/toolsets-reference.md`（L96）、`hermes-docs/user-guide/security.md`（L29-44）、`官网: docs/developer-guide/programmatic-integration`（`/v1/runs/{id}/approval`） |
| E8 | **多租户用 profiles 一实例一端口一 key**（8650+），模型名自动等 profile 名，天然隔离配置/记忆/技能。 | `hermes-docs/user-guide/features/api-server.md`（L392-425）、`hermes-docs/user-guide/messaging/open-webui.md`（L272-319） |
| E9 | **超时按分钟级设计**：反向代理、httpx/axios、FastAPI 中间件都要显式放宽（文档给出的上游 LLM 超时是 1800s，一次请求可合法跑很久）。非流式请求尤其危险。 | `hermes-docs/reference/environment-variables.md`（L522-524）、`hermes-docs/user-guide/messaging/open-webui.md`（L260-262） |
| E10 | **模型选择器别读 `/v1/models`**（它只返回一个 agent 名）。要么用 `/api/model/options` 做 Hermes 感知的 picker，要么按请求传 `model`+`provider`；若必须走 OpenAI 兼容端点传裸 `model`，先确认服务端开了 `direct_model_requests: true`。 | `官网: docs/user-guide/features/api-server`、`官网: docs/developer-guide/programmatic-integration`（Model catalog surfaces）、本地旧约束见 `hermes-docs/user-guide/features/api-server.md`（L431） |
| E11 | **失败判定不要看 HTTP 码**，看 Runs 的 `status` 与 Chat 的 `finish_reason`（`cancelled` / `error` 不是成功）。 | `官网: docs/developer-guide/programmatic-integration`（Terminal run status） |
| E12 | **dashboard（9119）绝不对外**：文档明确它没有自己的认证，可读写 `.env`。会话列表/历史若要用它的 `/api/sessions*`，只能由后端同机访问。 | `hermes-docs/user-guide/features/web-dashboard.md`（L180、L202-248） |

---

## F. 文档提到但容易漏掉的能力

| 能力 | 说明 | 依据 |
|---|---|---|
| **推理/reasoning** | Chat：`delta.reasoning_content` / `message.reasoning_content`；Responses：`reasoning` output item + `reasoning_summary_*` 事件；能力位 `reasoning_streaming`；关闭方式 `model_options.reasoning.enabled: false`；`reasoning_effort` 支持 `none/minimal/low/medium/high/xhigh`，默认 medium | `官网: docs/user-guide/features/api-server`、`hermes-docs/user-guide/configuration.md`（L1091-1103） |
| **工具审批（HTTP 化）** | `/v1/runs/{id}/approval` 答复挂起审批；`approvals.mode` = `manual`/`smart`/`off`；`off` 等价 `--yolo`；另有 `UNRECOVERABLE_BLOCKLIST` 连 yolo 也拦 | `官网: docs/developer-guide/programmatic-integration`、`hermes-docs/user-guide/security.md`（L29-89） |
| **中途 steer** | `/v1/runs/{id}/steer` 在下一个工具边界注入指令，不打断当前工具循环；非 running 返回 409；未送达会以 `pending_steer` 回传 | `官网: docs/developer-guide/programmatic-integration` |
| **skills 动态性** | 技能是 progressive disclosure 的按需文档，由 profile 决定；**HTTP 请求无法指定 skills**（文档未提及该参数）；cron job 可绑定 `skills[]`；dashboard 开关技能"下次 session 生效" | `hermes-docs/user-guide/features/skills.md`（L9）、`hermes-docs/user-guide/features/cron.md`（L62-90）、`hermes-docs/user-guide/features/web-dashboard.md`（L176） |
| **模型热切换** | 按请求 `model`+`provider`；`model_options` 里带 `reasoning_effort`/`service_tier`；优先级：session `/model` 覆盖 > `model_routes` 别名 > 请求直传 > 全局默认 | `官网: docs/user-guide/features/api-server`（Per-request model selection）、`官网: docs/developer-guide/programmatic-integration`（Model hot-swapping） |
| **token / usage** | Chat `usage{prompt/completion/total_tokens}`；Responses `usage{input/output/total_tokens}`；Runs 状态里 `usage`；dashboard `/api/analytics/usage?days=` 给出按天/按模型成本 | `hermes-docs/user-guide/features/api-server.md`（L82、L137、L257）、`hermes-docs/user-guide/features/web-dashboard.md`（L254-256） |
| **幂等 Idempotency-Key** | 属允许的请求头，按 key 缓存响应 **5 分钟**；文档未说明失败请求是否也算幂等 | `hermes-docs/user-guide/features/api-server.md`（L370） |
| **取消** | `/v1/runs/{id}/stop` → `stopping` → `cancelled`；Chat 侧体现为 `finish_reason: "cancelled"` | `hermes-docs/user-guide/features/api-server.md`（L267-269）、`官网: docs/user-guide/features/api-server` |
| **多轮上下文四选一** | ①全量 `messages`（无状态）②`previous_response_id` ③`conversation` 命名会话 ④`X-Hermes-Session-Id`/`X-Hermes-Session-Key` 头 | `hermes-docs/user-guide/features/api-server.md`、`官网: docs/user-guide/features/api-server` |
| **图片输入** | `image_url` 支持远程 URL 与 `data:image/...`（base64）；**不支持文件上传** | `hermes-docs/user-guide/features/api-server.md`（L86-103） |
| **profile 多实例 / proxy 模式** | 每 profile 独立端口+key；`GATEWAY_PROXY_URL`+`GATEWAY_PROXY_KEY` 可做"薄网关转发到远端 agent"的分体部署（注意：代理模式下工具进度与审批**不会**回传给用户） | `hermes-docs/user-guide/features/api-server.md`（L392-435）、`hermes-docs/user-guide/messaging/matrix.md`（L606-616） |
| **响应存储行为** | 100 条 LRU，SQLite，重启存活；删除走 `DELETE /v1/responses/{id}` | `hermes-docs/user-guide/features/api-server.md`（L429） |
| **cron 无 LLM 模式** | `no_agent=True` + script：按点跑脚本、stdout 原样投递，零 token；空 stdout 则静默（watchdog 模式） | `hermes-docs/user-guide/features/cron.md`（L305-321） |
| **cron 任务链** | `context_from` 把上游 job 最近一次输出前置到下游 prompt | `hermes-docs/user-guide/features/cron.md`（L347-396） |
| **client.capabilities 握手（TUI gateway）** | 若不走 HTTP 而走 TUI gateway JSON-RPC，未声明 `server_requests: true` 的客户端会被立即拒绝 approval/clarify/sudo 请求（无宽限） | `官网: docs/developer-guide/programmatic-integration`（Server→client requests） |
| **`hermes-api-server` toolset 差异** | 相比 CLI 去掉了 `clarify`、`send_message`、`text_to_speech`，其余保留 | `hermes-docs/reference/toolsets-reference.md`（L96）、`hermes-docs/user-guide/messaging/index.md`（L434） |
| **健康探针语义** | `/health` 是低开销存活探针、不跑就绪检查；就绪状态看 `/health/detailed` 的 `readiness.checks`（降级仍 200） | `官网: docs/user-guide/features/api-server` |

---

## 附：明确"文档未提及"的清单（避免平台按想象开发）

1. `/v1/skills`、`/v1/toolsets` 端点 —— API server 上不存在（等价能力在 dashboard `/api/skills`、`/api/tools/toolsets`）。
2. API server 上的会话列表 / 会话历史端点 —— 未提及（走 dashboard `/api/sessions*` 或直读 `state.db`）。
3. `hermes.tool.progress` 与 `chat.completion.chunk` 的字段级 JSON schema —— 未给出。
4. `/v1/runs/{id}/events` 的完整事件类型枚举（除终态事件外）—— 未给出。
5. API server 的 404 / 429 / 5xx 语义与错误响应体结构 —— 未提及。
6. 客户端自备 `tools` / `tool_choice` / `parallel_tool_calls` —— 未提及支持。
7. 请求级 `temperature` / `max_tokens` / `top_p` 是否透传 —— 未提及。
8. API server 自身的并发限制 / 速率限制 —— 未提及。
9. `Idempotency-Key` 在失败请求上的幂等语义 —— 未说明。
10. 流式响应中断后的精确重发语义（Chat Completions 侧）—— 未提及（Runs 侧有 5 分钟缓冲与轮询对账）。

---

### 参考文件清单（本地镜像）

- `hermes-docs/user-guide/features/api-server.md`（主文档，437 行）
- `hermes-docs/user-guide/messaging/open-webui.md`（最佳实践 + 故障排查，334 行）
- `hermes-docs/user-guide/features/web-dashboard.md`（dashboard REST：会话/技能/toolset/analytics，350 行）
- `hermes-docs/user-guide/features/cron.md`（jobs body 字段，558 行）
- `hermes-docs/user-guide/sessions.md`（会话存储与 source，496 行）
- `hermes-docs/user-guide/messaging/matrix.md`（`X-Hermes-Session-Id`、proxy 模式）
- `hermes-docs/developer-guide/gateway-internals.md`（adapter 架构、session key 规则）
- `hermes-docs/developer-guide/programmatic-integration.md` → **本地缺失**（仅官网）
- `hermes-docs/reference/environment-variables.md`、`hermes-docs/reference/toolsets-reference.md`、`hermes-docs/user-guide/docker.md`、`hermes-docs/user-guide/security.md`、`hermes-docs/user-guide/configuration.md`
