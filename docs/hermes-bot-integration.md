# Hermes Bot 能力调研与六脉集成方案

> **调研对象**：本机 Hermes Agent **0.22.2**（`C:\Users\11490\AppData\Local\hermes`）+ 本地文档快照 `hermes-docs/` + 源码 `hermes-agent/`。
> **调研方式**：只读分析。未修改业务代码、未重启服务、未发送任何测试消息；仅做了 `GET /health`、`GET /api/sessions`、`hermes gateway status`、`hermes send --list` 等只读查询。
> **实测时间**：2026-10-18 11:00–11:20（Asia/Shanghai）。
> **脱敏约定**：本文只记录环境变量**名称**与“是否占位/是否为空”，不记录任何密钥、Token、HMAC secret 的值；群/微信 ID 做了截断。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| Hermes bot 支持面 | 20+ 平台：Telegram、Discord、Slack、Google Chat、WhatsApp、Signal、SMS、Email、Home Assistant、Mattermost、Matrix、DingTalk、Feishu/Lark、**WeCom**、**WeCom Callback**、**Weixin**、BlueBubbles、**QQ**、Yuanbao、Teams、LINE、**Webhook**、**API Server**。统一由一个 gateway 进程承载多适配器、会话、cron、媒体与语音。 |
| 本机哪些通道在线 | **WeCom（WebSocket 已连）、API Server（8642）、Webhook（8644）** 在线；**Weixin 账面 `connected` 但实际已 `Session expired` 并每 10 分钟重试**；**QQBot 重试中**（appid/secret 无效）；WeCom Callback 未启用（8645 未监听）。 |
| 能否把六脉事件变成 bot 消息 | **能**。`POST http://127.0.0.1:8644/webhooks/{route}` + `deliver_only: true`，零 LLM、亚秒级，可直达企微单聊/微信单聊；**企微群不能冷启动主动推**（需被动 `req_id` / 24h 会话窗）。 |
| 能否让 IM 用户走六脉 agent 能力 | **部分能**。IM 入站天然走 Hermes agent（与六脉 Web 聊天同一引擎）；但要查六脉告警、触发/确认 RCA，需要 **MCP/技能桥接六脉 API**。IM 会话不在 `/api/sessions` 暴露，无法直接与六脉会话一一映射。 |
| 是否存在 `/notify` 或消息发送 API | **Hermes 没有 `/notify`、`/v1/messages`、独立 send API**；`send_message` 也**没有**注册为 agent 工具。出站只有 webhook 投递、cron 投递、`hermes send` CLI 三条路。 |
| 推荐首选 | **方案 A：六脉 → Hermes webhook → 企微单聊**。工作量 **S（2–3 人日）**，不重启网关，先打通 RCA/告警通知。 |
| 关键风险 | 企微群主动推送不可靠；微信通道当前掉线；bot 默认带 `terminal` 全权限；企微 30 条/分限流；`hermes send --to wecom` 会**踢掉**网关 WebSocket；六脉企微自建应用凭据目前是占位值，现有 `notify.py` 的 wecom 通道实际是 no-op。 |

---

## 1. Hermes 消息网关总览

### 1.1 架构

Hermes 的 bot/消息能力不是一个独立“机器人服务”，而是 **gateway 进程里的一个 platform adapter**：

```text
                    ┌──────────────────────────── Hermes Gateway（单进程）────────────────────────────┐
  Telegram  ──────► │ Telegram Adapter ─┐                                                          │
  Discord   ──────► │ Discord Adapter  ─┤                                                          │
  Slack     ──────► │ Slack Adapter    ─┤      per-chat session store                            │
  WeCom     ──────► │ WeCom Adapter    ─┼────► (chat_id → session) ──► AIAgent（工具/技能/MCP）      │
  Weixin    ──────► │ Weixin Adapter   ─┤                                                          │
  Webhook   ──────► │ Webhook Adapter  ─┤                                                          │
  API Server ◄────► │ API Server       ─┘                                                          │
                    │ Cron Scheduler（60s tick）──► 同一套 delivery 路由 ──► 各平台 adapter.send()   │
                    └──────────────────────────────────────────────────────────────────────────────┘
```

- 所有平台共用同一套 **session、权限、工具集、媒体、cron、delivery** 机制。
- 每个平台适配器独立维护连接（WebSocket / 长轮询 / HTTP 回调），入站消息统一转成 `MessageEvent` 交给 agent。
- 出站统一走 `adapter.send()/send_image()/send_document()`，因此 webhook 的 `deliver: wecom|weixin|...` 本质上就是调用对应适配器。

依据：`hermes-docs/user-guide/messaging/index.md:41-102`、`hermes-agent/gateway/platforms/base.py:2691`、`hermes-agent/gateway/platforms/webhook.py:976-1000`。

### 1.2 平台能力矩阵（按文档 + 源码整理）

图例：✅ 支持；— 不支持/未实现；⚠️ 有条件支持；`本机` 列为实测状态。

| 平台 | 传输 / 接入方式 | 入站 | 出站 | 单聊 | 群聊 / @bot | 图片 | 文件 | 语音 | 线程 | 流式 | 本机状态 |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| **WeCom（企微 AI Bot）** | WebSocket 长连接（`openws.work.weixin.qq.com`） | ✅ | ✅ | ✅ | ✅（群内需 @，被动回复） | ✅ | ✅ | ✅ | — | ✅ | ✅ **connected** |
| **WeCom Callback（企微自建应用）** | 公网 HTTP 回调 + AES 加密 XML | ✅ | ✅（主动 API） | ✅ | —（仅 `touser` 单聊） | — | — | — | — | — | ⚪ 未启用，8645 未监听 |
| **Weixin（个人微信 iLink Bot）** | HTTP 长轮询（`getupdates`） | ✅ | ✅ | ✅ | ⚠️ 群事件通常不下发 | ✅ | ✅ | ✅ | — | ✅ | ⚠️ 账面 connected，实际 session expired |
| **QQ Bot** | WebSocket Gateway + REST | ✅ | ✅ | ✅（C2C） | ✅（群 @） | ✅ | ✅ | ✅ | — | — | ❌ 重试，appid/secret 无效 |
| **Webhook** | HTTP server（默认 8644） | ✅ | ✅（deliver 到其他平台） | — | — | — | — | — | — | — | ✅ **connected** |
| **API Server** | HTTP（默认 8642，OpenAI 兼容） | ✅ | —（不是消息发送 API） | — | — | ✅（图片输入） | — | — | — | ✅ | ✅ **connected** |
| Telegram | 长轮询（默认）或 Webhook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Discord | Gateway WebSocket | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Slack | Socket Mode（WebSocket） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Google Chat | HTTP 事件回调 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ⚪ 未配置 |
| DingTalk | Stream Mode（WebSocket） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ⚪ 未配置 |
| Feishu/Lark | WebSocket（推荐）或 Webhook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Matrix | `/sync` 长轮询 | ✅ | ✅ | ✅ | ✅（房间） | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Email | IMAP 收 + SMTP 发 | ✅ | ✅ | ✅（邮件线程） | — | ✅ | ✅ | — | ✅ | — | ⚪ 未配置 |
| Microsoft Teams | 公网 HTTPS Webhook（Bot Framework） | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ⚪ 未配置 |
| WhatsApp | Baileys 桥 / Cloud API | ✅ | ✅ | ✅ | ⚠️（群） | ✅ | ✅ | — | — | ✅ | ⚪ 未配置 |
| Signal | signal-cli | ✅ | ✅ | ✅ | ⚠️（群） | ✅ | ✅ | — | — | ✅ | ⚪ 未配置 |
| SMS | Twilio Webhook | ✅ | ✅ | — | — | — | — | — | — | — | ⚪ 未配置 |
| LINE | 公网 HTTPS Webhook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | ⚪ 未配置 |
| Yuanbao | WebSocket Gateway | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | ⚪ 未配置 |
| BlueBubbles | Webhook | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ⚪ 未配置 |
| Mattermost | WebSocket | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ 未配置 |
| Home Assistant | WebSocket 事件 | ✅ | ✅ | — | — | — | — | — | — | — | ⚪ 未配置 |

依据：`hermes-docs/user-guide/messaging/index.md:15-39`、`wecom.md:86-94`、`weixin.md:9`、`qqbot.md:3-12`、`wecom-callback.md:14-22`、`matrix.md:589-616`、`whatsapp.md`、`dingtalk.md:9`、`feishu.md:13`、`teams.md:9`。

> **注意**：表中“群聊 ✅”指适配器支持群会话；**能否主动往群推消息是另一回事**，见 §2.5 与 §7。

### 1.3 传输方式与“回调可达性”

| 类别 | 平台 | 是否需要公网回调 | 说明 |
|---|---|---|---|
| 长连接（推荐、无公网） | WeCom、Discord、Slack Socket、DingTalk Stream、Feishu WS、Matrix sync、Weixin 长轮询、Telegram 长轮询 | 否 | 内网/本机即可，适合六脉当前部署 |
| 公网回调 | WeCom Callback、Teams、LINE、SMS/Twilio、Webhook（若跨机） | 是 | 需要反代/端口映射/TLS |
| 混合 | Telegram Webhook、WhatsApp Cloud、BlueBubbles | 取决于模式 | 可选 |

**六脉当前场景（本机/内网）应优先选长连接类通道，避免公网回调。**

### 1.4 通用 bot 能力

| 能力 | 说明 | 依据 |
|---|---|---|
| 每聊一会话 | 每个 chat_id 独立 session，可配置 daily/idle reset | `index.md:156-181` |
| 聊天内命令 | `/new`、`/model`、`/status`、`/stop`、`/approve`、`/deny`、`/resume`、`/usage`、`/background`、`/reload-mcp`、`/<skill>` | `index.md:127-154` |
| 权限 | 默认拒绝未授权用户；allowlist / pairing / `GATEWAY_ALLOW_ALL_USERS` | `index.md:183-223` |
| 分组权限 | 每平台 DM/群策略、群级 sender allowlist、admin/user 命令分级 | `index.md:225-250`、`wecom.md:111-178` |
| 工具集 | 每平台独立 toolset，WeCom/Weixin/QQ 默认 `Full tools including terminal` | `index.md:407-435` |
| 富媒体 | 图片/文件/语音/视频，各平台有大小上限与自动降级 | `wecom.md:180-225`、`weixin.md:166-207` |
| 流式 | 部分平台支持编辑式流式输出 | `index.md:15-39` |
| 打断/排队/steer | 忙时消息可 interrupt/queue/steer | `index.md:252-276` |
| 后台任务 | `/background` 独立 session，结果回到原 chat | `index.md:297-352` |
| 语音 | TTS/转写；WeCom/Weixin/QQ 支持语音消息 | `index.md:15-39`、`voice-mode` 文档 |

> **安全提醒**：`index.md:427` 明确 WeCom/Weixin/QQ 的 toolset 是“Full tools including terminal”。这意味着**被 allowlist 放行的用户可以通过 bot 在 gateway 主机上执行命令**。集成时必须限制 profile/toolset，见 §7。

---

## 2. 本机实测状态

### 2.1 进程与端口

| 项 | 实测值 | 证据 |
|---|---|---|
| gateway 进程 | PID **23404**，`hermes gateway run --quiet` | `hermes gateway status`；`gateway_state.json` |
| 开机自启 | Windows 启动项 `Hermes_Gateway.vbs` 已安装 | `hermes gateway status` |
| 版本 | **0.22.2** | `/health/detailed`、`gateway_state.json` |
| 进程状态 | `gateway_state: running`，`active_agents: 0`，`gateway_busy: false` | `/health/detailed` |
| 监听端口 | **8642**（API Server）、**8644**（Webhook），均 `0.0.0.0` | `Get-NetTCPConnection` |
| 未监听端口 | 8645（WeCom Callback）、8646（LINE/msgraph 类）、9301（旧 relay） | `Get-NetTCPConnection` |
| 平台计数 | `connected_platforms: 4` / `platforms: 5` | `/health/detailed` |

### 2.2 平台状态（`/health/detailed`）

| 平台 | state | needs_attention | 实测判断 |
|---|---|---|---|
| `wecom` | `connected` | false | ✅ WebSocket 心跳正常（日志每 30s ping） |
| `api_server` | `connected` | false | ✅ 8642 可访问；今日 14 请求 / 497k tokens |
| `webhook` | `connected` | false | ✅ 8644 `/health` 返回 200 |
| `weixin` | `connected` | false | ⚠️ **账面 connected，实际已掉线**：日志 `Session expired; pausing for 10 minutes`，且 09:05 出现 `getaddrinfo failed` |
| `qqbot` | `retrying` | **true** | ❌ `invalid appid or secret`（error_code `qq_connect_error`） |

> **重要差异**：`/health/detailed` 的 `weixin.state` 只看适配器进程状态，不反映 iLink 登录是否过期；判断微信通道必须看日志/实际发送。

### 2.3 配置与凭据（只列名称/状态）

#### Hermes `config.yaml` 的 `gateway.platforms`

| 平台 | enabled | 关键配置 |
|---|:--:|---|
| `api_server` | true | `port: 8642`，`max_concurrent_runs: 10` |
| `webhook` | true | `host: 0.0.0.0`，`port: 8644`，`secret: <已设置，脱敏>` |
| `wecom` | true | 凭据来自 `.env`（`WECOM_BOT_ID` / `WECOM_SECRET`，均已设置、非占位） |
| `weixin` | true | 凭据来自 `.env`（`WEIXIN_ACCOUNT_ID` / `WEIXIN_TOKEN`，均已设置、非占位） |
| `qqbot` | 由 env 启用 | `QQ_APP_ID` / `QQ_CLIENT_SECRET` 已设置，但**服务端返回 appid/secret 无效** |
| `wecom_callback` | 未配置 | 8645 未监听，`WECOM_CALLBACK_*` 不存在 |

#### `.env` 变量名（仅名称）

- Hermes：`WECOM_BOT_ID`、`WECOM_SECRET`、`WECOM_HOME_CHANNEL`（长度 1，**疑似占位/无效**）、`WEIXIN_ACCOUNT_ID`、`WEIXIN_TOKEN`、`WEIXIN_HOME_CHANNEL`（已设置）、`QQ_APP_ID`、`QQ_CLIENT_SECRET`、`API_SERVER_ENABLED/HOST/PORT/KEY`、`QQ_ALLOWED_USERS`、`WEIXIN_ALLOWED_USERS`、`WEIXIN_DM_POLICY`、`WEIXIN_GROUP_POLICY` 等。
- 未出现：`GATEWAY_PROXY_URL`、`WECOM_CALLBACK_*`、`TELEGRAM_*`、`DISCORD_*`、`SLACK_*`、`DINGTALK_*`、`FEISHU_*`。
- **`WECOM_HOME_CHANNEL` 不可用** → 任何 `deliver: wecom` 的 webhook/route 必须显式传 `deliver_extra.chat_id`，不要依赖 home channel。

#### 六脉容器

| 变量 | 状态 | 影响 |
|---|---|---|
| `WECOM_CORP_ID` | **占位值**（`your_corp_id`） | 六脉 `WeComClient` 无法获取 token |
| `WECOM_CORP_SECRET` | **占位值** | 同上 |
| `WECOM_AGENT_ID` | **占位值** | 自建应用不可用 |
| `HERMES_API_KEY` | 环境变量为空（可能来自 DB 运行时配置） | 不影响本次 bot 调研 |
| `SMTP_*` | 未设置 | 六脉邮件通道静默跳过 |

> **结论**：六脉现有 `services/notify.py` 的 `wecom` 通道在当前环境是 **silent no-op**（`_wecom_configured()` 对 `your_*` 返回 False）。真正能发企微的，目前只有 **Hermes WeCom bot**（DM）。这条事实直接决定了方案 A 的价值。

### 2.4 其他实测结果

| 查询 | 结果 |
|---|---|
| `GET http://127.0.0.1:8644/health` | `200 {"status":"ok","platform":"webhook"}` |
| `GET http://127.0.0.1:8644/notify` | **404**（不存在） |
| `GET http://127.0.0.1:8644/webhooks/alerts` | **405**（路由存在，仅 POST） |
| `GET http://127.0.0.1:8642/health` | `200 {"status":"ok","platform":"hermes-agent","version":"0.22.2"}` |
| `GET http://127.0.0.1:8642/health/detailed`（无 key） | `401` |
| `GET /api/sessions?limit=10`（带 key） | 仅返回 `api_server` 会话；`source=wecom/weixin/webhook` 均为 **0** |
| `hermes send --list` | `wecom:LiLong (dm)`、`wecom:LiLong (group)`、`weixin:o9cq…@im.wechat (dm)`、`qqbot`（无可用 channel） |
| `hermes webhook list` | **报 “Webhook platform is not enabled”**，但 8644 实际在跑（CLI 读的是旧 schema，见 §3.6） |
| `webhook_subscriptions.json` | 1 条动态路由 `alerts`：`deliver: "origin"`、`skills: ["ops-fault-diagnosis"]`、创建于 2026-06-12 |
| 六脉后端 | `http://127.0.0.1:8000/health` → `200 {"status":"ok","service":"liumai-backend","version":"0.3.0"}` |
| 六脉容器 | `liumai-backend`、`liumai-frontend`、`liumai-postgres`、`liumai-redis` 均 healthy |

### 2.5 本机异常与“坑”

| # | 现象 | 影响 | 证据 |
|---|---|---|---|
| 1 | **Weixin 掉线**：`Session expired; pausing for 10 minutes`，每 10 分钟循环；09:05 还有 DNS `getaddrinfo failed` | 微信消息发不出/收不到；健康接口仍显示 connected | `logs/gateway.log` 2026-10-18 09:06–11:06 |
| 2 | **QQBot 凭据无效**：`invalid appid or secret` | QQ 通道不可用，且会持续重试 | `/health/detailed` `qqbot.error_message` |
| 3 | **动态路由 `alerts` 的 `deliver: "origin"` 无效** | webhook 适配器只认 `log`/`github_comment`/已知平台；`origin` → `Unknown deliver type`，agent 回复投递失败（仍会跑一次 agent、消耗 token） | `gateway/platforms/webhook.py:327-337`、`:976-1000` |
| 4 | **`hermes webhook` CLI 读顶层 `platforms.webhook`，而本机配置在 `gateway.platforms.webhook`** | CLI 认为未启用，`hermes webhook subscribe/list` 不可用；但网关运行时配置正常 | `hermes_cli/webhook.py:109-120` vs `config.yaml:585-600` |
| 5 | **`hermes send --to wecom` 会踢掉网关 WebSocket** | WeCom 同一 bot 只允许一个长连接；CLI 进程拿不到 live adapter，会新建临时连接，把网关连接踢下线，网关再重连 | `plugins/platforms/wecom/adapter.py:721-744`、`:563-570` |
| 6 | 六脉自建应用凭据是占位值 | 现有企微群通知实际不工作；群告警推送无可用通道 | 容器 env `WECOM_CORP_*` |
| 7 | 本地文档快照可能落后于 0.22.2 | 例如文档称 `/api/sessions` 不存在，但本机实际暴露；以 `/v1/capabilities` 运行时探测为准 | `/v1/capabilities` 实测 |

---

## 3. 集成面清单（Hermes 能给六脉用什么）

### 3.1 出站：六脉 → bot 消息

| 方式 | 入口 | 是否可用 | 成本 | 限制 | 建议 |
|---|---|:--:|---|---|---|
| **Webhook 直投** | `POST /webhooks/{route}`，route 配 `deliver_only: true` + `deliver: wecom/weixin` | ✅ | **零 LLM**，亚秒级 | 需 HMAC；单 route 单目标；群推送受限 | **首选** |
| Webhook 转 agent | 同上，不配 `deliver_only` | ✅ | LLM token | prompt injection 风险；慢 | 仅用于“告警→自动分析” |
| Cron 投递 | `POST /api/jobs` 或 `hermes cron`，job 配 `deliver=wecom:chat_id` | ✅ | agent/脚本 | 需要调度，不适合即时告警 | 日报/巡检摘要 |
| CLI 直发 | `hermes send --to wecom:...` / `weixin:...` | ⚠️ | 无 LLM | **WeCom 会踢网关 WS**；Weixin 走直连 API 相对安全 | 仅限 Weixin 或停机维护时 |
| 媒体发送 | `hermes send "... MEDIA:/path"` | ⚠️ | 无 LLM | 同上；WeCom 图片 10MB、文件 20MB | 报告图片/附件 |
| Agent 内部 `send_message` | 工具层 | ❌ 对模型不可见 | — | 源码明确“不注册为 agent 可调用工具” | 不要依赖 |
| `/v1/artifacts/upload` | API Server | ✅ 但**不是发消息** | — | 仅 browser-control 产物，TTL 300s、10MB、一次性下载 | 不能当文件推送 API |
| 独立 `/notify` | — | ❌ | — | Hermes 无此端点；旧的 9301 relay 已不存在 | 用 webhook 替代 |

依据：`webhooks.md:256-326`、`gateway/platforms/webhook.py:558-580`、`:976-1000`、`tools/send_message_tool.py:25-27`、`hermes_cli/send_cmd.py:194-239`、`plugins/platforms/wecom/adapter.py:721-744`、`/v1/capabilities` 实测。

#### Webhook 直投的请求格式

```http
POST /webhooks/liumai-alert HTTP/1.1
Host: 127.0.0.1:8644
Content-Type: application/json
X-Webhook-Timestamp: 1760000000
X-Webhook-Signature-V2: <hex hmac-sha256(secret, timestamp + "." + raw_body)>
X-Request-ID: <六脉幂等 ID>

{"title":"六脉 RCA 分析完成","markdown":"**六脉 RCA ✅ 分析完成**\n> 会话：#123 ...","session_id":123}
```

- 签名算法（源码 `webhook.py:846-860`）：
  ```python
  ts = str(int(time.time()))
  raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
  sig = hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
  ```
- 必须对**实际发送的原始字节**签名；`separators`/`ensure_ascii` 不一致会 401。
- V1（仅 body HMAC）仍可用但已弃用，有重放风险；建议直接上 V2。
- 成功：`200 {"status":"delivered","route":"...","target":"wecom","delivery_id":"..."}`；目标拒绝：`502`；重放：`200 {"status":"duplicate"}`；签名错：`401`；限流：`429`。

### 3.2 入站：bot 消息 → 六脉/Hermes

| 方式 | 入口 | 说明 | 限制 |
|---|---|---|---|
| 平台适配器入站 | WeCom WS / Weixin 长轮询 / QQ WS 等 | 用户消息 → per-chat session → Hermes agent | 走的是 Hermes agent，不是六脉后端 |
| Webhook 入站 | `POST /webhooks/{route}` | 外部事件 → prompt → agent | HMAC；agent 成本；注入风险 |
| `/api/platforms/{platform}/events` | API Server | 仅 **Google Chat** 实现了 `verify_http_event_request`/`dispatch_http_event` | WeCom/Weixin 不支持 |
| WeCom Callback | 8645 公网回调 + AES XML | 自建应用回调，当前未启用 | 需公网；仅文本入站 |
| `/api/sessions/{id}/chat` | API Server | 可对 Bot Chat 提交一轮（`hermes peer dm` 的底层） | **不是**向企微/微信会话注入消息 |
| `GATEWAY_PROXY_URL` | 网关代理模式 | 适配器在 A 机、agent 在 B 机；会话用 `X-Hermes-Session-Id` 延续 | 不改变入站协议 |

**关键结论**：Hermes **没有**“向指定 WeCom/Weixin 会话注入一条入站消息”的公开 API。要让 IM 用户“走六脉能力”，正确姿势是 **让 bot 的 agent 调用六脉 API（MCP/技能）**，而不是把 IM 消息转发进六脉。

### 3.3 会话与映射

| 项 | 实测/说明 |
|---|---|
| `/api/sessions` | 只列出 `api_server` 来源的会话；`source=wecom/weixin/webhook` 过滤结果为 0 |
| 平台会话存储 | 在 gateway 自己的 session store 中，按 chat_id 隔离；**不通过 API Server 暴露** |
| Bot Chat | `POST /api/sessions` + title `Bot Chat`，`POST /api/sessions/{id}/chat` = `hermes peer dm` 的 bot-to-bot 通道 |
| 会话延续头 | `X-Hermes-Session-Id`、`X-Hermes-Session-Key`（`/v1/capabilities`） |
| 消息镜像 | webhook route 可配 `mirror_to_session: true`，把投递内容写进目标 chat 的 transcript，后续在该 chat 追问时 agent 有上下文 |

依据：`hermes-agent/gateway/platforms/api_server.py:80-103`、`:3013-3065`、`api_server_bot_chat.py:1-9`、`webhook.py:1009-1034`；实测 `/api/sessions?source=wecom`。

### 3.4 代理 / 多 profile / 扩展

| 能力 | 说明 | 适用 |
|---|---|---|
| `GATEWAY_PROXY_URL` + `GATEWAY_PROXY_KEY` | 平台适配器网关把消息转发到远端 API Server，不本地跑 agent；会话用 `X-Hermes-Session-Id` 延续 | DMZ 放适配器、内网放 agent |
| `/p/{profile}/...` | 多 profile 复用同一监听端口 | 多租户/多 bot |
| 自定义 platform plugin | 在 `~/.hermes/plugins/` 注册 `plugin.yaml + adapter.py`，零核心改动 | 把六脉做成一个“平台” |
| relay connector | 实验性通用适配器，握手传 `CapabilityDescriptor` | 高级/不稳定，不建议生产 |
| `hermes send` | 无 LLM 的 shell 发送入口 | 脚本/运维应急 |

依据：`api-server.md:433-437`、`matrix.md:589-616`、`ADDING_A_PLATFORM.md:1-11`、`gateway/relay/descriptor.py`。

### 3.5 Hermes **没有**的能力（避免走错路）

| 期望 | 实际 |
|---|---|
| `POST /notify` 通用通知 | ❌ 无。旧六脉 `wecom_bot_new.py` 的 9301 `/notify` 是历史实现，当前 9301 未监听、脚本不在本仓库 |
| `POST /v1/messages` / 独立发消息 API | ❌ 无 |
| agent 可调用 `send_message` | ❌ 源码明确不注册（防止 agent 自行跨平台发消息） |
| `/v1/artifacts` 当文件推送 | ❌ 仅 browser-control 产物上传/下载，TTL 300s、一次性 |
| WeCom/Weixin 会话注入 API | ❌ 无 |
| WeCom 群主动推送 | ❌ 适配器要求群 `req_id`（被动回复），冷群发送会失败 |
| 平台事件回调通用入口 | ❌ 仅 Google Chat 实现 |

### 3.6 一个容易踩的配置坑

`hermes webhook` CLI 读取的是**顶层** `platforms.webhook`（`hermes_cli/webhook.py:109-120`），而本机网关配置在 **`gateway.platforms.webhook`**（`config.yaml:585-600`）。因此：

- `hermes webhook list/subscribe` 会误报 “not enabled”；
- 但网关运行时确实加载了 `gateway.platforms.webhook`，8644 正常工作；
- **不要用 CLI 管理动态路由**。可选做法：
  1. 直接编辑 `~/.hermes/webhook_subscriptions.json`（适配器按 mtime/inode **热加载**，无需重启，源码 `webhook.py:430-472`）；
  2. 或写 `gateway.platforms.webhook.extra.routes`（静态路由，需重启网关）；
  3. 或用 Dashboard 的 webhook 管理（若版本支持）。

> 本报告推荐 1：只改配置文件，不重启服务。

---

## 4. 与六脉现状对照

### 4.1 六脉已有的消息/通知能力

| 模块 | 能力 | 现状 |
|---|---|---|
| `backend/app/services/wecom.py` | 企微自建应用：`gettoken`、`appchat/create`、`appchat/send`（text/markdown）、`appchat/update` 加 bot | 代码完整，但**凭据是占位值 → 实际不可用** |
| `backend/app/services/notify.py` | 统一通知：`wecom` / `webhook` / `email`，通道隔离、best-effort | webhook 无 HMAC；wecom 因凭据占位被跳过；email 无 SMTP |
| `backend/app/routes/alerts.py` | 告警接入 `/api/alerts/webhook`（`X-Webhook-Token`） | 正常 |
| `backend/app/routes/rca.py` | RCA 触发/会话/报告 | 正常 |
| `backend/app/services/rca_runner.py` | RCA 开始/结束调用 `send_notification` | 逻辑正常，通道不可用 |
| `backend/app/routes/hermes.py` | 只读 Hermes 适配层（health/sessions/runs/jobs/capabilities） | 正常 |

### 4.2 重复 / 互补 / 可替代矩阵

| 能力 | 六脉 | Hermes | 关系 | 建议 |
|---|---|---|---|---|
| 企微群主动通知 | `appchat/send`（需真实 corp 凭据；当前占位） | WeCom bot **不能冷启动推群**（仅被动 `req_id`） | **互补，不可替代** | 保留六脉 appchat 做群主动推送；补真实凭据 |
| 企微单聊主动通知 | 未实现（`appchat` 是群接口） | WeCom bot DM 主动 `aibot_send_msg`（需用户先发起） | **Hermes 补位** | 方案 A 用它 |
| 个人微信 | 无 | Weixin iLink DM（当前掉线） | **唯一通道** | 修 token 后再启用 |
| 邮件通知 | SMTP 出站（当前未配） | Email 适配器 IMAP/SMTP 双向 | **不同用途** | 六脉保留告警邮件；Hermes 做交互邮箱 |
| Webhook 出站 | `notify.webhook` 通用 JSON，无签名 | 8644 入站 webhook（HMAC，可直投/转 agent） | **互补** | 六脉加 HMAC，指向 8644 |
| Bot 对话 | 无 | Hermes agent | **同一引擎** | 六脉 Web 聊天已经调 Hermes，不需要再造 |
| 告警/RCA/权限/审计 | 六脉 | 无 | **六脉保留** | bot 通过 MCP/技能调用六脉 |
| 会话历史 | 六脉 chat DB | Hermes 平台 session（不暴露） | **不互通** | 先 `mirror_to_session`，完整统一为 L |
| 消息发送 API | `WeComClient` | 无独立 API | 六脉保留 | 不要期待 Hermes 提供 |
| 卡片/富媒体 | appchat 仅 text/markdown | bot 支持图片/文件/语音/视频 | 互补 | 需要富媒体时走 bot |

### 4.3 关键判断

1. **Hermes bot 不是六脉 `wecom.py` 的替代品**：两者身份不同（AI Bot vs 自建应用）、协议不同（WS vs appchat HTTP）、能力互补（bot 能收能回，appchat 能主动推群）。
2. **Hermes 的即时价值是“补上单聊推送”**：六脉当前企微群/单聊都不通，而 Hermes WeCom bot 是唯一凭据真实、连接在线的企微出口。
3. **“用户在企微里对话走六脉 agent”目前不成立**：bot 走的是 Hermes agent，不是六脉业务后端。要访问六脉数据，必须加 MCP/技能；六脉的 JWT/RBAC 也不会自动作用于 IM 用户。
4. **“把外部事件变成 bot 消息”完全成立**：8644 webhook + `deliver_only` 是标准做法，且零 LLM。

---

## 5. 三个可落地方案（按价值排序）

### 方案 A（P0）：六脉告警/RCA → Hermes webhook → 企微/微信单聊

#### 场景

- RCA 开始/完成时推送摘要到值班人企微 DM（可选微信 DM）。
- 高危告警触发时推送“告警 + 一键进 RCA”链接。
- 每日巡检/日报摘要（可改用 cron）。

#### 架构

```text
┌──────────────┐   POST /webhooks/liumai-alert
│ 六脉 backend │   HMAC-SHA256 V2 + X-Request-ID
│ notify.py    │────────────────────────────────────┐
└──────────────┘                                    ▼
                                      ┌─────────────────────────────┐
                                      │ Hermes Gateway :8644        │
                                      │ Webhook Adapter             │
                                      │ route: deliver_only=true    │
                                      │        deliver=wecom        │
                                      │        chat_id=LiLong       │
                                      └──────────────┬──────────────┘
                                                     │ adapter.send()（进程内，不开新连接）
                                                     ▼
                                      ┌─────────────────────────────┐
                                      │ WeCom Adapter (WS 已连接)    │
                                      │ aibot_send_msg → 企微单聊    │
                                      └─────────────────────────────┘
                                                     │
                                      （可选第二条 route）
                                                     ▼
                                      ┌─────────────────────────────┐
                                      │ Weixin Adapter → 微信 DM     │
                                      │ 当前掉线，修好后再启用        │
                                      └─────────────────────────────┘
```

> **群聊**：不要把告警群推到 `deliver: wecom` 的群 chat_id 上——冷群没有 `req_id`，通常会被平台拒绝（webhook 返回 502）。群告警继续走六脉 `appchat/send`（需补真实 `WECOM_CORP_*`）。

#### 所需接口/配置

1. 在 `~/.hermes/webhook_subscriptions.json` 增加动态 route（热加载，无需重启）：
   ```json
   {
     "liumai-alert": {
       "description": "六脉 RCA/告警通知 → 企微单聊",
       "events": [],
       "secret": "<新生成 32+ 字节随机串>",
       "prompt": "{title}\n\n{markdown}",
       "deliver": "wecom",
       "deliver_only": true,
       "deliver_extra": { "chat_id": "LiLong" }
     }
   }
   ```
   - `deliver_only` 表示渲染后的 prompt 就是消息体，**不跑 agent**。
   - `chat_id` 必须显式给：`WECOM_HOME_CHANNEL` 长度仅 1，**疑似占位/不可用**。
   - 群聊 route 不要建；群推送走六脉 appchat。
2. 六脉 `notify.py`：
   - 新增 `hermes_bot` 通道（或扩展现有 `webhook` 通道支持 `signature_secret`）；
   - 发送前计算 `X-Webhook-Timestamp` / `X-Webhook-Signature-V2`；
   - 带 `X-Request-ID`（用 RCA session / alert id + 事件类型），利用 Hermes 1 小时幂等；
   - 超时从 5s 调到 10–15s（WeCom WS 往返可能 >5s）；
   - 失败重试 1 次，仍失败只 warning，不影响 RCA。
3. 配置项：`notify.channels` 增加 `hermes_bot`；`hermes_webhook_url`（默认 `http://host.docker.internal:8644/webhooks/liumai-alert`，容器内不能用 `127.0.0.1`）；`hermes_webhook_secret`。

#### 工作量：**S（2–3 人日）**

| 工作 | 人日 |
|---|---|
| route 配置 + 联调（含 HMAC 校验） | 0.5 |
| `notify.py` 新通道 + 签名 + 幂等 + 超时 | 1 |
| RCA/告警两处内容模板 + 链接 | 0.5 |
| 测试（成功/401/429/502/重复） | 0.5–1 |

#### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 企微 DM 冷启动失败 | WeCom 主动推送要求用户先与 bot 有会话；`LiLong` 已有 DM 记录，可用 | 首次让值班人给 bot 发一条消息；文档写明 |
| 群推送失败 | 适配器要求群 `req_id`；冷群 502 | 群告警继续用六脉 appchat；不要建群 route |
| 微信掉线 / 冷启动 | iLink session 过期；微信 DM 还需要先有入站消息产生 `context_token` | 修 token 前只启用企微；微信 route 先不建；先让值班人给 bot 发一条消息 |
| 消息风暴 | 企微 30 条/分；webhook 默认 30 请求/分 | 六脉侧按 RCA/告警去重；批量合并；route `rate_limit` 可调 |
| 8644 暴露 | 绑定 `0.0.0.0`，仅 HMAC 保护 | 防火墙限制来源；HMAC secret 定期轮换；不要把 8644 暴露公网 |
| 5s 超时误判 | 六脉超时但消息可能已送达 | 超时调大；用 `X-Request-ID` 幂等重试 |
| 无送达回执 | 只有 HTTP 200/502 | 以 200 为准；关键消息让值班人确认 |

#### 验收

- 签名正确 → `200 delivered`，企微 DM 收到 markdown。
- 错误签名 → `401`，六脉只 warning。
- 同一 `X-Request-ID` 重放 → `200 duplicate`，不重复发。
- 目标不可用（微信掉线）→ `502`，六脉不阻塞 RCA。

---

### 方案 B（P1）：企微群内 @bot 查询告警 / 触发 RCA / 确认处置

#### 场景

- 运维群 `@Hermes 查一下支付系统最近 30 分钟告警`。
- `@Hermes 对 #123 触发 RCA`。
- `@Hermes 确认 #123 根因为数据库连接池耗尽`。
- `@Hermes 把 #123 报告发我`。

#### 架构

```text
┌──────────────────────── 企微群 ────────────────────────┐
│  @Hermes 查告警 / 触发 RCA / 确认处置                    │
└───────────────────────────┬────────────────────────────┘
                            │ WeCom AI Bot WebSocket（被动回调）
                            ▼
              ┌──────────────────────────────┐
              │ Hermes WeCom Adapter          │
              │ 群策略 + 发送者 allowlist      │
              └──────────────┬───────────────┘
                             │ MessageEvent（@ 前缀已剥离）
                             ▼
              ┌──────────────────────────────┐
              │ Hermes Agent                 │
              │ skill: liumai-ops            │
              │ MCP: liumai (工具 7 个)       │
              └──────────────┬───────────────┘
                             │ HTTPS + Service Token (API Key/JWT)
                             ▼
              ┌──────────────────────────────┐
              │ 六脉 API                     │
              │ /api/alerts/* /api/rca/*     │
              │ RBAC + 审计                   │
              └──────────────┬───────────────┘
                             │
                             ▼
              被动回复（aibot_respond_msg，req_id）
              回到原群；超时则降级主动 DM
```

#### 所需接口/配置

1. **六脉 MCP Server**（建议独立进程，`backend/mcp/liumai_mcp.py` 或 `tools/liumai_mcp/`）：
   - 只读工具：`list_alerts(status, service, limit)`、`get_alert(id)`、`get_rca(session_id)`、`get_rca_report(session_id)`。
   - 写工具（需二次确认）：`trigger_rca(alert_ids)`、`ack_alert(id, note)`、`dismiss_alert(id)`。
   - 内部调用六脉 REST；不要直连 DB，避免绕过 RBAC/审计。
2. **服务账号/令牌**：六脉目前只有 JWT（`backend/app/auth.py:135-170`），建议二选一：
   - 新增 `X-API-Key`/service token 认证（推荐，代码改动小）；
   - 或创建 `OPERATOR` 服务账号，签发长有效期 JWT（需要刷新机制，运维复杂）。
3. **Hermes 配置**：
   ```yaml
   mcp_servers:
     liumai:
       command: <python>
       args: [".../liumai_mcp.py"]
       enabled: true
   platform_toolsets:
     wecom:
       - mcp-liumai
       - clarify
       # 不要给 terminal/browser/file
   ```
   `mcp_servers` 加载后可 `@Hermes /reload-mcp` 热加载（聊天命令），无需重启网关。
4. **群权限**：
   ```yaml
   gateway:
     platforms:
       wecom:
         extra:
           group_policy: allowlist
           group_allow_from: ["<运维群 chat_id>"]
           # 群范围的管理员/普通用户命令分级（斜杠命令用）
           group_allow_admin_from: ["<ops_admin>"]
           group_user_allowed_commands: [status, help]
           groups:
             "<运维群 chat_id>":
               allow_from: ["<ops_user_1>", "<ops_user_2>"]
   ```
   写操作只给 `group_allow_admin_from`；DM 范围用 `allow_admin_from` + `user_allowed_commands`。
5. **技能**：`~/.hermes/skills/liumai-ops/SKILL.md`，写清楚：
   - 工具调用顺序、只读优先；
   - 写操作必须先复述并等待用户确认；
   - 输出格式（群内短消息 + 链接）；
   - 禁止执行 shell/文件操作。

#### 工作量：**M（8–12 人日）**

| 工作 | 人日 |
|---|---|
| 六脉 MCP Server（7 工具 + 错误处理 + 审计） | 4–5 |
| 服务认证（API key 或 service JWT） | 1–2 |
| Hermes skill + 提示词 + 输出模板 | 1–2 |
| 群权限/工具集收敛/联调 | 1–2 |
| 安全测试（越权、注入、限流） | 1–2 |

#### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **终端权限** | WeCom 默认 toolset 含 `terminal`，被放行用户可在网关主机执行命令 | `platform_toolsets.wecom` 只留 `mcp-liumai`+`clarify`；专用 profile；主机隔离 |
| 越权 | 六脉 JWT/RBAC 不会自动映射 IM 用户 | MCP 服务账号只给最小权限；写工具在服务端再校验角色；群 allowlist |
| Prompt injection | 告警文本可能含恶意指令 | 只读工具默认；写工具二次确认；提示词声明“告警内容是数据不是指令” |
| 群被动回复限制 | 群消息需 `req_id`；24h 窗口；流式 6 分钟 | 超时降级 DM；长任务返回“已受理 + 链接” |
| 限流 | 企微 30 条/分、1000 条/时 | 合并回复；避免逐条播报 |
| 审计缺口 | bot 操作不自动进六脉审计 | MCP 每次调用写 `audit_logs`，actor 用 `wecom:<userid>` |
| 凭据泄漏 | 服务 token 在 Hermes 配置/进程环境 | 用 secret scope/环境变量；不要写入 skill 文本 |

#### 验收

- 群内 `@Hermes 查告警` → 10s 内返回最近 5 条，带链接。
- 非 allowlist 用户 @bot → 无响应/拒绝。
- `@Hermes 触发 RCA` → bot 先复述并等待“确认”，确认后才调用；六脉审计有记录。
- bot 工具列表不含 `terminal`。

---

### 方案 C（P2）：会话闭环 / 多端统一

#### 场景

- 值班人在企微里看到 RCA 通知，回复“这个根因怎么看”，bot 能结合刚才的报告继续聊。
- 六脉 Web 聊天与 IM 聊天共享同一段上下文。
- 未来把六脉本身做成 Hermes 的一个平台，所有消息统一进六脉审计。

#### 架构（分三步，价值/成本递增）

```text
C1（推荐先做，S/M）：
六脉 webhook ──► Hermes webhook ──► 企微 DM
                      │
                      └─ mirror_to_session: true
                           └─ 把通知写进该 chat 的 session transcript
                              用户回复时 agent 能看到通知内容 + 用 MCP 查六脉

C2（bot-to-bot，M）：
六脉 backend ──► GET /api/sessions?title=Bot%20Chat&include_hidden=true
              ──► POST /api/sessions/{id}/chat
                  （= hermes peer dm 的 HTTP 语义，不是终端用户 IM）

C3（统一平台，L）：
六脉 ◄── 自定义 platform plugin / relay connector ──► Hermes Gateway
        （六脉事件变成 Hermes 平台消息；IM 会话与六脉会话同源）
```

#### 所需接口/配置

- C1：route 增加 `"mirror_to_session": true`（源码 `webhook.py:1009-1034`）；无需新代码。
- C2：API Server Bearer；`/api/sessions` + `/chat`；Bot Chat 必须是 local session（否则 `bot_chat_unbound`）。
- C3：`~/.hermes/plugins/<name>/plugin.yaml + adapter.py`，实现 `connect/send/get_chat_info`；或 relay connector（实验性）。

#### 工作量

| 子方案 | 工作量 | 说明 |
|---|---|---|
| C1 消息镜像 | **S/M（3–5 人日）** | 主要是提示词/上下文验证 |
| C2 Bot Chat 桥 | **M（5–8 人日）** | 会话发现、权限、错误处理 |
| C3 自定义平台 | **L（3–5 周）** | 适配器、协议、身份映射、升级维护 |

#### 风险

- `/api/sessions` 不暴露 IM 会话，C3 之前无法真正“统一历史”。
- 两个写入方（六脉/IM）可能造成会话分叉、重复消息。
- 自定义插件跟随 Hermes 升级有维护成本。
- 身份/权限双轨（六脉 RBAC vs Hermes allowlist）容易错配。

#### 建议

- **先做 C1**，成本最低、立刻改善“收到告警后追问”的体验。
- **C2 仅用于 bot-to-bot**，不要让终端用户直接依赖。
- **C3 暂缓**，等 A/B 稳定、明确“统一会话”是刚需再做。

---

### 5.4 方案对比

| 维度 | 方案 A（P0） | 方案 B（P1） | 方案 C（P2） |
|---|---|---|---|
| 价值 | 立即补上企微/微信通知 | 群内自助查询/处置，减少切系统 | 会话连续、多端统一 |
| 工作量 | **S（2–3 人日）** | **M（8–12 人日）** | C1 S/M；C3 L |
| 依赖 | 8644 + HMAC + 企微 DM 已通 | 六脉 MCP/服务令牌 + 群权限 | 会话映射/自定义适配器 |
| 风险 | 低（无 LLM、无写操作） | 中高（终端权限、越权、注入） | 高（架构复杂、升级维护） |
| 建议 | **先做** | 再做 | C1 可穿插；C3 暂缓 |

---

## 6. API / 端点清单

### 6.1 Hermes 侧

| 端点 | 方法 | 鉴权 | 用途 | 限制/备注 | 来源 |
|---|---|---|---|---|---|
| `/health`、`/v1/health` | GET | 无 | 存活探针 | — | `api-server.md:220-222` |
| `/health/detailed` | GET | Bearer | 就绪/平台状态 | 无 key 返回 401 | 实测 |
| `/v1/models` | GET | Bearer | 模型发现 | 只返回 agent 自身 | `api-server.md:193-195` |
| `/v1/capabilities` | GET | Bearer | 能力位/端点发现 | 集成前必查 | `api-server.md:197-218` |
| `/v1/chat/completions` | POST | Bearer | OpenAI 兼容对话 | 无状态；不支持文件上传 | `api-server.md:54-109` |
| `/v1/responses` | POST | Bearer | Responses API | 支持 `previous_response_id` | `api-server.md:111-191` |
| `/v1/runs` | POST | Bearer | 创建 run | 返回 `run_id` | `api-server.md:228-305` |
| `/v1/runs/{id}` | GET | Bearer | 轮询状态 | — | 同上 |
| `/v1/runs/{id}/events` | GET | Bearer | SSE 事件流 | 断线重连 | 同上 |
| `/v1/runs/{id}/stop` | POST | Bearer | 中断 | — | 同上 |
| `/v1/runs/{id}/approval` | POST | Bearer | 危险命令审批 | 本机 capabilities 支持 | `/v1/capabilities` |
| `/v1/runs/{id}/steer` | POST | Bearer | 中途注入指令 | 本机支持 | `/v1/capabilities` |
| `/api/sessions` | GET/POST | Bearer | 会话列表/创建 | **不含 IM 会话** | `api_server.py:3013-3136` |
| `/api/sessions/{id}` | GET/PATCH/DELETE | Bearer | 会话元数据 | — | `api_server.py:3139-3223` |
| `/api/sessions/{id}/messages` | GET | Bearer | 消息历史 | 仅 API 会话 | `api_server.py:3224-3259` |
| `/api/sessions/{id}/chat` | POST | Bearer | 同步一轮 | Bot Chat 走 peer 通道 | `api_server.py:3534-3579` |
| `/api/sessions/{id}/chat/stream` | POST | Bearer | SSE 一轮 | — | `api_server.py:3580-...` |
| `/api/sessions/{id}/model` | POST | Bearer | 模型锁 | — | `api_server.py:3740` |
| `/api/jobs` 及子路径 | CRUD | Bearer | 计划任务 | 可配 delivery | `api-server.md:271-305` |
| `/v1/artifacts/upload` | POST | Bearer | 浏览器产物上传 | 10MB、TTL 300s、一次性 | `/v1/capabilities` |
| `/v1/artifacts/download/{id}` | GET | Bearer | 下载 | 一次性 | 同上 |
| `/webhooks/{route}` | POST | HMAC | 外部事件→直投/agent | 30/min、1MB、幂等 1h | `webhooks.md:31-87`、`:380-426` |
| `/webhooks/{route}`（GET） | — | — | 不存在 | 405 | 实测 |
| `/notify` | — | — | **不存在** | 404 | 实测 |
| `/api/platforms/{platform}/events` | POST | 平台自定义 | 平台 HTTP 事件 | 仅 Google Chat | `api_server.py:1535-1570` |

### 6.2 六脉侧（bot/MCP 可调用）

| 端点 | 方法 | 鉴权 | 用途 |
|---|---|---|---|
| `/api/alerts/inbox` | GET | JWT | 告警收件箱 |
| `/api/alerts/stats` | GET | JWT | 告警统计 |
| `/api/alerts/{id}/trigger` | POST | JWT | 人工触发 RCA |
| `/api/alerts/{id}/dismiss` | POST | JWT | 忽略告警 |
| `/api/alerts/batch-trigger` | POST | JWT | 批量触发 |
| `/api/rca/trigger` | POST | JWT | 直接触发 RCA |
| `/api/rca/sessions` | GET | JWT | RCA 会话列表 |
| `/api/rca/sessions/{id}` | GET | JWT | 会话详情 |
| `/api/rca/sessions/{id}/report` | GET | JWT | 结构化报告 |
| `/api/rca/sessions/{id}/report/download` | GET | JWT | HTML/Markdown 报告 |
| `/api/rca/sessions/{id}/cancel` | POST | JWT | 取消 |
| `/api/alerts/webhook` | POST | `X-Webhook-Token` | 监控告警入站（不是 bot） |
| `/api/chat/stream` | POST | JWT | 六脉 Web 聊天（Hermes SSE） |

### 6.3 CLI / 运维命令

| 命令 | 用途 | 备注 |
|---|---|---|
| `hermes gateway status` | 网关状态 | 实测 PID 23404 |
| `hermes send --list` | 可用发送目标 | 只读 |
| `hermes send --to wecom:LiLong "..."` | 无 LLM 直发 | **会踢网关 WS** |
| `hermes send --to weixin:<id> "..."` | 微信直发 | 走 iLink API |
| `hermes webhook subscribe ...` | 动态路由 | **本机 CLI 因 schema 不识别，勿用** |
| `hermes peer dm` | bot-to-bot DM | 底层是 `/api/sessions` + `/chat` |

---

## 7. 风险清单与缓解

| 类别 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 安全 | bot 默认 `terminal` 全权限 | 被放行用户可在网关主机执行命令 | 专用 profile；`platform_toolsets` 只留 MCP；主机隔离/沙箱；严格 allowlist |
| 安全 | 8644 绑定 `0.0.0.0` | 同网段可访问 | 防火墙限制来源；HMAC；反代 TLS；不要把 8644 暴露公网 |
| 安全 | HMAC secret 泄漏 | 伪造告警/钓鱼消息 | secret 只存服务端；定期轮换；最小权限 |
| 安全 | Prompt injection（告警文本） | agent 执行恶意指令 | 方案 A 用 `deliver_only`（不跑 agent）；方案 B 只读工具 + 二次确认 |
| 权限 | 六脉 JWT/RBAC ≠ IM allowlist | IM 用户越权查/改 | MCP 服务账号最小权限；服务端二次鉴权；群 allowlist + admin 分级 |
| 权限 | 服务 token 长期有效 | 泄漏后长期可用 | 短 TTL + 刷新；或 API key 可撤销 |
| 消息风暴 | 企微 30 条/分、1000 条/时 | 限流/漏发 | 六脉侧去重/合并；webhook `rate_limit`；`coalesce`（仅 agent 模式） |
| 消息风暴 | 告警突发大量推送 | 值班人被打爆 | 分级/聚合；只推 P1/P2；静默窗口 |
| 回调可达性 | 8644 在容器/跨机不可达 | 六脉 POST 失败 | 用 `host.docker.internal` 或宿主 IP；防火墙放行；健康检查 |
| 回调可达性 | 微信 iLink 掉线 | 微信通道不可用 | 修 token；先只启用企微 |
| 平台限制 | 企微群只能被动回复 | 冷群推送失败 | 群告警走六脉 appchat；bot 只做交互 |
| 平台限制 | 企微 24h 会话窗 | 超过窗口主动推送失败 | 值班人定期互动；关键告警走 appchat |
| 平台限制 | QQ 凭据错误 | QQ 不可用 | 暂不纳入 |
| 运维 | `hermes send` 踢 WS | 网关短暂离线 | 禁止在 WeCom 上用 CLI；改用 webhook |
| 运维 | 配置 schema 分裂 | CLI/文档与运行时不一致 | 以运行时 `/v1/capabilities` + 实测为准；直接改 `webhook_subscriptions.json` |
| 运维 | 版本升级 | 行为变化 | 升级前跑 `/v1/capabilities` 对比；保留回滚 |
| 审计 | bot 操作不入六脉审计 | 无法追责 | MCP 每次调用写 `audit_logs`；记录 `wecom:<userid>` |
| 体验 | 群内回复慢/被截断 | 用户困惑 | 先回“已受理”，长结果给链接；控制消息长度 |

---

## 8. 工作量与排期建议

| 阶段 | 内容 | 人日 | 依赖 | 产出 |
|---|---|---:|---|---|
| **P0（方案 A）** | 动态 route + 六脉 HMAC 通道 + 模板 + 测试 | **2–3** | 8644 在线；企微 DM 可用 | RCA/告警推送企微 DM |
| **P1（方案 B）** | 六脉 MCP Server + 服务认证 + skill + 群权限 + 测试 | **8–12** | P0 稳定；六脉 API 可访问 | 群内 @bot 查/触发/确认 |
| **P2-C1** | `mirror_to_session` + 上下文验证 | **3–5** | P0/P1 | 收到通知后可追问 |
| **P2-C3** | 自定义平台/统一会话 | **15–25** | 明确刚需 | 多端统一（可选） |

**推荐节奏**：

1. 第 1 周：完成 P0，值班人企微 DM 能收到 RCA 开始/完成通知。
2. 第 2–3 周：完成 P1 的只读部分（查告警/查报告），写操作（触发/确认）后置。
3. 第 4 周：评估 C1 是否需要；C3 暂不启动。

---

## 9. 建议与下一步

### 9.1 推荐首选

**方案 A（P0）**：六脉 → Hermes 8644 webhook（`deliver_only`）→ 企微单聊。理由：

- 零 LLM 成本、亚秒级、不重启网关；
- 直接补上六脉当前最大的洞（企微通知实际不可用）；
- 不引入写操作/终端权限，风险最低；
- 后续可平滑叠加 P1 的 MCP 与 C1 的会话镜像。

### 9.2 立即可做（不改代码）

1. 在 `webhook_subscriptions.json` 增加 `liumai-alert` route（`deliver_only: true`，`deliver: wecom`，`chat_id: LiLong`），生成独立 HMAC secret。
2. 用 `curl` + 正确 HMAC 做一次**人工**联调（建议在值班群知会后再发）。
3. 确认 `LiLong` 已与 bot 有过 DM（企微主动推送前提）。
4. 把 8644 的访问限制在本机/内网，不要暴露公网。

### 9.3 需要决策的事项

| 决策 | 选项 | 建议 |
|---|---|---|
| 六脉用哪种认证访问 MCP | 新增 API key / 长 JWT | 新增可撤销的 API key |
| 群内写操作是否开放 | 只读 / 只读+触发 / 全量 | 先只读，写操作二次确认 |
| 是否把六脉做成 Hermes 平台 | 是/否 | 暂缓，先 A+B |
| 微信通道是否纳入 | 是/否 | 修好 token 后再纳入 |
| 群告警走哪条 | 六脉 appchat / bot | appchat（主动推群唯一可靠路径） |

### 9.4 不建议做的事

- ❌ 不要用 `hermes send --to wecom` 做生产推送：会踢网关 WS。
- ❌ 不要用 webhook 的 `deliver: wecom` 往冷群推：通常会 502/平台拒绝。
- ❌ 不要给 WeCom bot 开 `terminal` 后把群放开给所有人。
- ❌ 不要把 8644 直接暴露公网、不要用 `INSECURE_NO_AUTH`（0.0.0.0 下会被拒绝）。
- ❌ 不要依赖 `hermes webhook` CLI 管理本机动态路由（schema 不匹配）。
- ❌ 不要把 `/v1/artifacts` 当消息/文件推送 API。

---

## 附录 A：证据索引

| 主题 | 来源 |
|---|---|
| 平台清单/能力矩阵 | `hermes-docs/user-guide/messaging/index.md:15-39` |
| 网关架构 | `hermes-docs/user-guide/messaging/index.md:41-102` |
| 聊天命令 | `hermes-docs/user-guide/messaging/index.md:127-154` |
| 权限/allowlist/pairing | `hermes-docs/user-guide/messaging/index.md:183-250` |
| 平台 toolset（含 terminal） | `hermes-docs/user-guide/messaging/index.md:407-435` |
| WeCom WS/媒体/回复模式 | `hermes-docs/user-guide/messaging/wecom.md:9-94`、`:180-233`、`:263-273` |
| Weixin 长轮询/群限制 | `hermes-docs/user-guide/messaging/weixin.md:9`、`:15-24`、`:250-294` |
| QQ Bot | `hermes-docs/user-guide/messaging/qqbot.md:3-12` |
| WeCom Callback / 8645 | `hermes-docs/user-guide/messaging/wecom-callback.md:14-22`、`:39-41`、`:125-148` |
| Webhook 路由/直投/安全 | `hermes-docs/user-guide/messaging/webhooks.md:31-87`、`:256-326`、`:380-426` |
| API Server 端点/安全 | `hermes-docs/user-guide/features/api-server.md:52-305`、`:315-328` |
| Proxy 模式 | `hermes-docs/user-guide/features/api-server.md:433-437`、`matrix.md:589-616` |
| 自定义平台 | `hermes-agent/gateway/platforms/ADDING_A_PLATFORM.md:1-11` |
| HMAC V2 校验 | `hermes-agent/gateway/platforms/webhook.py:846-860` |
| 动态路由热加载 | `hermes-agent/gateway/platforms/webhook.py:430-472` |
| deliver_only | `hermes-agent/gateway/platforms/webhook.py:558-580` |
| 跨平台投递 | `hermes-agent/gateway/platforms/webhook.py:976-1000` |
| 消息镜像 | `hermes-agent/gateway/platforms/webhook.py:1009-1034` |
| WeCom 群被动回复 | `hermes-agent/plugins/platforms/wecom/adapter.py:594-630` |
| `hermes send` 独立发送（会踢 WS） | `hermes-agent/plugins/platforms/wecom/adapter.py:721-744` |
| `send_message` 不对模型开放 | `hermes-agent/tools/send_message_tool.py:25-27` |
| Webhook CLI schema 不匹配 | `hermes-agent/hermes_cli/webhook.py:109-120` |
| API Server 路由表 | `hermes-agent/gateway/platforms/api_server.py:80-103`、`:1649-1687` |
| Bot Chat peer | `hermes-agent/gateway/platforms/api_server_bot_chat.py:1-9` |
| 六脉企微客户端 | `backend/app/services/wecom.py:1-208` |
| 六脉通知分发 | `backend/app/services/notify.py:1-525` |
| 六脉 RCA 通知钩子 | `backend/app/services/rca_runner.py:1373-1512` |

## 附录 B：本机实测原始结果（脱敏）

### B.1 `hermes gateway status`

```text
✓ Windows login item installed: ...\Startup\Hermes_Gateway.vbs
✓ Gateway process running (PID: 23404)
```

### B.2 `/health/detailed` 摘要

```json
{
  "status": "ok",
  "platform": "hermes-agent",
  "version": "0.22.2",
  "gateway_state": "running",
  "platforms": {
    "wecom":     {"state": "connected", "needs_attention": false},
    "api_server":{"state": "connected", "needs_attention": false, "listener_base": "http://127.0.0.1:8642"},
    "webhook":   {"state": "connected", "needs_attention": false, "listener_base": "http://127.0.0.1:8644"},
    "weixin":    {"state": "connected", "needs_attention": false},
    "qqbot":     {"state": "retrying", "needs_attention": true, "error_code": "qq_connect_error",
                  "error_message": "QQ startup failed: ... invalid appid or secret"}
  },
  "api_server": {"host": "0.0.0.0", "port": 8642, "active_runs": 0, "stored_runs": 14}
}
```

### B.3 通道目录（截断）

```json
{
  "platforms": {
    "wecom": [
      {"id": "LiLong", "type": "dm"},
      {"id": "wrgV…（截断）", "type": "group"}
    ],
    "weixin": [
      {"id": "o9cq…@im.wechat", "type": "dm"}
    ]
  }
}
```

### B.4 动态路由（脱敏）

```json
{
  "alerts": {
    "description": "通用监控告警自动分析（带故障诊断技能）",
    "events": [],
    "secret": "<脱敏>",
    "prompt": "收到监控告警：...",
    "skills": ["ops-fault-diagnosis"],
    "deliver": "origin",
    "created_at": "2026-06-12T07:53:56Z"
  }
}
```

> `deliver: "origin"` 不被 webhook 适配器识别；该路由的 agent 回复无法投递。

### B.5 Weixin 日志（截断）

```text
2026-10-18 09:05:25 ERROR [Weixin] poll error (3/3): Cannot connect to host ilinkai.weixin.qq.com:443 ... getaddrinfo failed
2026-10-18 09:06:13 ERROR [Weixin] Session expired; pausing for 10 minutes
2026-10-18 10:56:14 ERROR [Weixin] Session expired; pausing for 10 minutes
2026-10-18 11:06:15 ERROR [Weixin] Session expired; pausing for 10 minutes
```

### B.6 六脉容器凭据状态（不打印值）

```text
WECOM_CORP_ID      : placeholder
WECOM_CORP_SECRET  : placeholder
WECOM_AGENT_ID     : placeholder
HERMES_API_KEY     : empty（可能由 DB 运行时配置覆盖）
```

---

## 附录 C：一句话版本

> Hermes 有 20+ 平台的完整 bot 网关，本机 **WeCom 在线、API/Webhook 在线、Weixin 掉线、QQ 凭据错误**；集成六脉最稳的是 **8644 webhook `deliver_only` 直推企微单聊（S，2–3 人日）**，其次是 **群内 @bot + 六脉 MCP（M，8–12 人日）**；不要用 `/notify`（不存在）、不要用 `hermes send` 发 WeCom（会踢网关）、不要指望 bot 主动推冷群。
