# Hermes「机器人（BOTS）」功能调研与六脉集成评估

> 结论先行：用户看到的 BOTS 不是消息渠道 bot、不是子代理、也不是"网关群组聚合"，而是
> **Hermes 桌面端内置插件 Bot Mode（`hermes-bots`）的 agent profile 花名册**——每个 bot 就是一个
> Hermes profile（独立配置/技能/记忆/凭据/会话）。它的**管理面**（列出/新建/编辑/定时任务/群组）
> 走网关 JSON-RPC（`/api/ws` + 本机 control pipe 签发的一次性 ticket），**运行面**（对话、跑任务、
> 读会话）走 8642 的 OpenAI 兼容 API（`API_SERVER_KEY`）。两边都能在没有桌面 App 的情况下调用，
> 但 RPC 面被限制在 **同一台 Windows 主机、同一个用户**，六脉后端跑在 Docker 里，需要在宿主机加一个
> 薄桥接（类似现有 `hermes-proxy.py`）。state.db 里**没有 bots 表**，直接读库覆盖不到这套功能。

- 调研时间：2026-10-18（Asia/Shanghai）
- Hermes 版本：`0.22.2` / `0.22.2+1104.g0ab43d4`，commit `0ab43d4f67e41be75f4f6c0fa14a86dbcfd3e5b3`
- 桌面端：`%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe`（内置插件，默认开启）
- Hermes home：`C:\Users\11490\AppData\Local\hermes`
- 六脉：`E:\dev\Liumai`（FastAPI 后端跑在 Docker，Hermes 网关跑在 Windows 宿主）

---

## 0. 结论摘要

| 问题 | 结论 | 关键证据 |
|---|---|---|
| BOTS 是什么 | 桌面插件 **Bot Mode**（`hermes-bots`）的机器人花名册；**bot == Hermes profile**（一个独立 agent 实例） | `apps/desktop/src/plugins/hermes-bots/plugin.tsx:1-16`、`types.ts:131`、`website/docs/user-guide/bot-mode.md:8-13` |
| 「Hermes」那一行是什么 | 名为 `default` 的 profile，Bot Mode 把它显示成 "Hermes"（用户可改 Title 覆盖） | `labels.ts:62-72`；实测 `profiles.list` 只有 `name:"default"` |
| 「刷新网关群组」按钮是什么 | 不是刷新 bot 列表，而是刷新**网关侧群组房间**（canonical groups，`groups.list`）；按钮文案 = `refreshGroups` | `roster-pane.tsx:474`、`canonical-group-registry.tsx:17-40`、`canonical-group-locales.ts:97` |
| 右侧「定时任务」是什么 | Routines 面板：Hermes cron job，命名约定 `[bot:<profile>] <routine>`，按当前 bot 的 profile 作用域 | `plugin.tsx:10-11,486-522`、`cron.tsx:71-75,1015` |
| 数据在哪 | `profiles/<name>/`（profile.yaml + 技能/记忆/SOUL/凭据）+ `state.db`（会话/消息）+ `cron/jobs.json` + 桌面 localStorage（分区/房间完整日志） | 见 §2.3/§2.4 |
| 能否 API 集成 | **能**。管理面走网关 RPC，运行面走 8642 API；群组走 `groups.*` RPC。桌面 IPC 不是外部接口 | §3.3、§4 |
| 推荐方案 | 方案①：宿主机"Bots Bridge"（RPC + 8642 API 聚合）→ 六脉后端调用。P0 只读+对话 **S**，P1 管理 **M**，P2 群组/多机 **M~L** | §5、§6 |
| 最大风险 | ①RPC 是内部协议，无公开兼容承诺；②ticket 只能同机同用户（Docker 隔断）；③bot 元数据/房间日志是"服务端 ui_meta + 桌面 localStorage"双源，部分能力只在 UI | §7 |

---

## 1. BOTS 是什么

### 1.1 定位

Hermes 桌面 App 左侧是 `SESSIONS | BOTS` 两个 tab（中文「会话 / 机器人」）。BOTS 是内置桌面插件
**Bot Mode** 注册的 pane：

- 插件随 App 打包、默认开启：`apps/desktop/src/contrib/plugins.ts:2-6`
  > `hermes-bots` (Bot Mode) ships in-tree and is ON by default
- pane 注册与停靠：`apps/desktop/src/plugins/hermes-bots/plugin.tsx:442-484`（placement `left`，宽 260px，
  停靠到 sessions 区，tab 标题 `t.common.bots`；中文值 `机器人`，`i18n/zh.ts:77`）
- 右侧 Routines pane：`plugin.tsx:486-522`（`placement: 'main'`, `pos: 'right'`，默认折叠，宽 250px；
  中文标题 `定时任务`，`i18n/zh.ts:2923`）

### 1.2 三个组成部分（用户看到的一块）

| 区域 | 内容 | 实现 | 数据归属 |
|---|---|---|---|
| 顶部「网关群组」列表 | gateway 上的群聊房间（canonical rooms），带「刷新网关群组」按钮 | `roster-pane.tsx:474` → `CanonicalGroupList`（`canonical-group-registry.tsx`）→ `groups.capabilities` + `groups.list` | 网关服务端（`shared-state.db` / `state.db` 的 hosted_room* 表） |
| 主体 BOTS 花名册 | 一行一个 profile（头像、最近消息、时间、未读） | `roster-pane.tsx` + `data.ts`（每 5s 轮询 `profiles.list`） | 每个 profile 目录 + `profile.yaml` 的 `ui_meta['hermes-bots']` |
| 右侧「定时任务」 | 当前 bot 的 cron 作业，可建/改/暂停/删 | `cron.tsx`（`cron.manage`）| `cron/jobs.json` + `cron/executions.db` |

### 1.3 核心数据模型

**bot = profile**（这是理解整套功能的关键，`plugin.tsx:4-5` 原注释）：

> Left pane "Bots": one row per Hermes profile (**a bot = an agent profile**) …
> Right tile "Routines": scheduled tasks (Hermes cron jobs) scoped to the bot you're currently chatting with

每个 bot 的"配置""技能""记忆""凭据""SOUL"都在 `C:\Users\11490\AppData\Local\hermes\profiles\<name>\`
（默认 profile 则是 home 根目录）。Bot Mode 额外加的东西都写在 profile 的 `ui_meta` 里：

| 元数据 | 含义 | 存储 |
|---|---|---|
| `ui_meta['hermes-bots'].title` | Bot 显示名（友好名） | `profile.yaml`（经 `profiles.configure` 写入，带 CAS revision） |
| `...description` | Bot 描述 | 同上 |
| `...color/shape/image/imageKind` | 头像 | 颜色/形状在 ui_meta；图片走 `profiles.set_asset('avatar')` 存 `profiles/<n>/assets/avatar.<ext>` |
| `...hidden/pinned/custom` | 隐藏/置顶/自定义头像标记 | ui_meta |
| `...sectionId/sectionName` | 用户分区（文件夹）归属 | ui_meta（分区**列表**只在本机 localStorage） |
| `...groups[]` | 群聊成员关系（旧版 `group` 单值仍兼容） | ui_meta |
| `...chat` | 旧版 canonical chat 指针（已废弃，代码忽略） | ui_meta（仅向后兼容） |

证据：`types.ts:52-94`（`BotMeta`）、`types.ts:131`（`RosterRow.ui_meta`）、
`data.ts:357-415`（写 ui_meta + CAS）、`methods_profiles.py:257-262`（读 ui_meta/revisions/has_avatar）。

**canonical Bot Chat**：每个 bot 有一个"永久会话"，身份是**标题恰好等于 `"Bot Chat"`** 的会话，
不是存了 session id 的指针：

- `methods_profiles.py:162-174`：`get_session_by_title("Bot Chat")`，注释明确 "identity is the NAME"
- `tools/bot_mode_probe.py:31`：`BOT_CHAT_TITLE = "Bot Chat"`
- 实测：`20260823_222433_67eeb7`，`profile_name=default`，`title=Bot Chat`，`hidden=1`，`message_count=2`
- Bot Mode 里 `/new` 会被改写成 `/compact`，保证这个会话"永不重置"（`plugin.tsx:765-800`）

**群组（Groups）** 有两层，必须区分：

| 类型 | 是什么 | 服务端可见？ | 存储 |
|---|---|---|---|
| 网关群组（canonical groups） | 网关托管的群聊房间，有 `room_id`、成员、单调日志、driver（关掉桌面也能跑） | ✅ `groups.*` RPC | `shared-state.db`（新）/ `state.db` `hosted_room*` 表（老）；本机两处均为空 |
| 桌面本地群聊（Group Chat） | Bot Mode 的花名册房间行，房主是当前 Desktop | ⚠️ 仅 `ui_meta` 有界投影（最近历史），完整日志在桌面 localStorage | 插件 storage key `group-chats` + `ui_meta` 镜像 |

证据：`canonical-groups.ts:74-98`（`groups.capabilities` + `groups.list` 分页）、
`contracts/groups_bot_relay.py:159-487`（18 个 `groups.*` 方法）、
`group-chat.ts:3-4,276-281,1278-1280`（ui_meta 有界镜像、本地日志权威）、
`bot-mode.md:145,170`（房间跟随网关、网关 driver）。

### 1.4 和"消息渠道 bot / 子代理"的区别

| 概念 | 本报告对象 BOTS | 消息渠道 bot | 子代理（subagent） |
|---|---|---|---|
| 载体 | Hermes profile | Telegram/企微/微信等平台账号 | 父 agent 派生的临时会话 |
| 标识 | profile 名 + ui_meta title | 平台 bot token / appid | session id |
| 独立技能/工作区 | ✅（profile 自己的 config/skills/memory/凭据） | ❌ 共用网关 profile 配置 | ❌ 继承父会话 |
| 独立定时任务 | ✅（cron `[bot:<name>]`） | ❌（cron 属于 profile） | ❌ |
| 独立"永久会话" | ✅ canonical `Bot Chat` | ❌ | ❌ |
| 群聊 | ✅（网关房间 / 本地房间） | 平台群 | ❌ |

`website/docs/user-guide/bot-mode.md:12-13` 原文：*"a Bot **is** a Hermes profile — isolated config,
memory, skills, credentials, and chat history under `~/.hermes/profiles/<name>/`. Bot Mode is a UI over
that primitive…"*

---

## 2. 实现定位（源码 / 数据库证据）

### 2.1 关键源码文件

| 文件 | 作用 | 关键行 |
|---|---|---|
| `apps/desktop/src/plugins/hermes-bots/plugin.tsx` | Bot Mode 插件入口：花名册 pane、Routines pane、@ 提及中间件 | 1-16（定位）、442-484（pane）、486-522（Routines）、751-890（@ 提及） |
| `.../hermes-bots/types.ts` | 领域模型 `RosterRow` / `BotMeta` / `GroupChat` / `RoutineJob` | 52-94（BotMeta）、96-135（RosterRow）、198-246（GroupChat）、318-337（RoutineJob） |
| `.../hermes-bots/data.ts` | 花名册查询（`profiles.list` 5s 轮询）、ui_meta 写回、本地镜像 | 44-46（storage key）、357-415（configure+CAS）、435-449（本地回退） |
| `.../hermes-bots/cron.tsx` | Routines：`cron.manage` + `[bot:]` 命名 | 71-75（正则）、1015（`name: \`[bot:${profile}] ${title}\``） |
| `.../hermes-bots/canonical-groups.ts` | 网关群组发现/创建/审批 | 74-98（list 分页）、100-145（create）、147-177（retry/discard/approve） |
| `.../hermes-bots/canonical-group-registry.tsx` | 顶部群组列表 + 「刷新网关群组」 | 17-40（按钮在 39） |
| `.../hermes-bots/canonical-group-locales.ts` | 多语言：`refreshGroups` | 41（en）、97（zh=`刷新网关群组`） |
| `.../hermes-bots/pane` 相关 | `roster-pane.tsx` / `roster-pane-toolbar.tsx` / `roster-sections.tsx` | `roster-pane.tsx:474`、`roster-pane-toolbar.tsx:70-124` |
| `.../hermes-bots/group-chat.ts` | 本地群聊编排 + ui_meta 有界镜像 | 3-4、276-281、1278-1280 |
| `.../hermes-bots/profile-ops.ts` | 头像读写、新建 bot、CLI 兜底 | 77/107（set_asset）、183（get_asset）、377（profiles.create）、449（cli.exec） |
| `hermes-agent/apps/desktop/src/contrib/plugins.ts` | 插件内置 + 默认开启 | 2-6 |
| `hermes-agent/apps/desktop/src/lib/storage.ts` | 插件持久化 = `window.localStorage` | 41-52 |
| `hermes-agent/apps/desktop/src/contrib/plugin.ts` | `createPluginStorage` → `hermes.plugin.<id>.<key>` | 372、storage 工厂 |
| `hermes-agent/apps/desktop/src/app/chat/sidebar/gateway-groups.tsx` | Sessions 侧栏的**网关/ profile 分组**（易与 BOTS 混淆） | 59-136、149-309 |
| `hermes-agent/tui_gateway/methods_profiles.py` | `profiles.list/create/describe/configure/set_asset/get_asset` | 162-174、257-262、282-303、306-346、386-409、412-447 |
| `hermes-agent/tui_gateway/methods_groups.py` | `groups.*` 处理器 | 216-507 |
| `hermes-agent/tui_gateway/methods_bot_relay.py` | `bot_relay.*`（跨机中继） | 31-132 |
| `hermes-agent/tui_gateway/contracts/groups_bot_relay.py` | 方法契约（含参数/结果） | 159-487、516-570 |
| `hermes-agent/tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py` | `profiles.*` 契约 | 184-360 |
| `hermes-agent/hermes_cli/gateway_client.py` | **官方 Python RPC 客户端**（ticket + WS + JSON-RPC） | 25-31、152-185、188-240 |
| `hermes-agent/gateway/control_socket.py` | 本机 control pipe：`identify`/`status`/`session-ticket` 等 | 289-361、420-436、506-511 |
| `hermes-agent/hermes_cli/web_routers/profiles.py` | dashboard REST `/api/profiles*` | 800-810、953-990 |
| `hermes-agent/hermes_cli/web_routers/cron.py` | dashboard REST `/api/cron/jobs*` | 701-772 |
| `hermes-agent/hermes_cli/web_server.py` | dashboard 会话令牌（每进程随机） | 233-238、304-349 |
| `hermes-agent/hermes_cli/dashboard_auth/native_http.py` | native-http ticket 的 profile 作用域 | 42-104 |
| `hermes-agent/gateway/platforms/api_server.py` | OpenAI 兼容 API + `/p/<profile>/` 前缀 | 5-6、45-51、63-99、1680-1687 |
| `hermes-agent/tui_gateway/ws.py` / `hermes_cli/web_routers/chat_ws.py` | `/api/ws` WebSocket = JSON-RPC 传输 | `ws.py:1-4`、`chat_ws.py:702` |
| `hermes-agent/website/docs/user-guide/bot-mode.md` | 官方能力说明（Bots/Routines/Groups/跨机） | 8-13、32-45、104-108、110-176、191-218、372-374 |

### 2.2 调用链

```
桌面渲染进程 (Bot Mode 插件)
  ├─ host.request('profiles.list' | 'profiles.configure' | 'cron.manage' | 'groups.*' | 'session.*')
  │     └─ WS  ws://127.0.0.1:5152/api/ws
  │          subprotocol: hermes-gateway-v1 + hermes-gateway-ticket.<一次性ticket>
  │          ticket 由 Electron 主进程通过 control pipe (\\.\pipe\hermes-gw-*) 的
  │          "session-ticket" verb 现签发（30s、一次性）
  │
  ├─ host.requestProfile({connectionId, profile}) → 远端网关同一套 RPC
  │
  ├─ REST（Electron 拦截后带 X-Hermes-Gateway-Ticket）
  │     GET    /api/profiles
  │     DELETE /api/profiles/<name>   ← 删除 bot 走这条（无 RPC 删除）
  │     PATCH  /api/profiles/<name>
  │     GET    /api/cron/jobs?profile=<name>
  │
  └─ 运行面（对话/跑任务）：不是 RPC，是 8642 的 OpenAI 兼容 API
        GET/POST /api/sessions[/{id}/chat]   （会话、Bot Chat 续聊）
        POST     /v1/chat/completions        （一次性对话）
        GET/POST /api/jobs                   （cron CRUD，AI 面）
```

### 2.3 数据落盘位置

| 数据 | 位置 | 备注 |
|---|---|---|
| bot 列表 / 身份 | `profiles/<name>/`、`profile.yaml`（`ui_meta`） | 默认 profile 即 home 根 |
| bot 显示名/描述/头像色/分组/隐藏/置顶/分区归属 | `profile.yaml` → `ui_meta['hermes-bots']` | 经 `profiles.configure`，带 `_ui_meta_revisions` CAS |
| bot 头像图片 | `profiles/<name>/assets/avatar.{png,jpg,webp}` | `profiles.set_asset`，≤2MB |
| Bot Chat / 普通会话 / 消息 | `state.db`（`sessions` 307 行、`messages` 9919 行） | `title='Bot Chat'`，`hidden=1` |
| cron 作业 | `cron/jobs.json`（当前 1 个）+ `cron/executions.db` | 命名 `[bot:<name>]` 只是约定，没有独立 bot 字段 |
| 网关群组房间 | `shared-state.db`（当前只有 `hosted_room_events` 0 行）+ `state.db` 的 `hosted_room*`（全 0） | 本机未使用群组 |
| 桌面分区列表/顺序、房间完整日志、tombstone、UI 偏好 | Electron localStorage（`%APPDATA%\Hermes\Local Storage\leveldb`），key `hermes.plugin.hermes-bots.*` | **API 不可见**；分区成员关系有 ui_meta 副本 |

### 2.4 数据库证据（只读 sqlite，未做任何写操作）

`state.db` 共 **51** 张表，**没有任何 bots / bot_ / gateway_group / 机器人相关表**；会话类表才是核心：

| 表 | 行数 | 与 BOTS 的关系 |
|---|---|---|
| `sessions` | 307 | Bot Chat 就是其中 `title='Bot Chat'` 的一行（`id=20260823_222433_67eeb7`，`profile_name=default`，`hidden=1`，`message_count=2`） |
| `messages` / `messages_fts` | 9919 | Bot 对话内容 |
| `hosted_rooms` 及 `hosted_room_*` | 0 | 网关群组（本机未创建） |
| `gateway_routing` | 102 | profile/agent 路由键（`agent:<profile>:...`） |
| `runtime_epoch` | 1 | 运行时纪元 |

**关键结论**：想"通过读库拿到机器人列表"是拿不到的——bot 的定义在文件系统（profile 目录 + profile.yaml），
不在 SQLite。库只能回答"某个 bot 有哪些会话/消息"。

`shared-state.db` 只有 `hosted_room_events`（0 行），与 `bot-mode.md:170`（房间状态在 root `shared-state.db`）
一致，但本机没有群组数据。

`cron/jobs.json` 当前 1 个作业（`2df8bfaf6046`，"Hermes对话自动同步到llm-wiki-v2知识库"，每 10 分钟），
没有 `[bot:]` 前缀（说明该作业是普通 cron，不是 Bot Mode 建的 routine）。

### 2.5 桌面端本地存储证据

- 插件 storage 实现 = 渲染进程 `localStorage`：`apps/desktop/src/lib/storage.ts:41-52`
- key 前缀：`hermes.plugin.${pluginId}.${key}`（`contrib/plugin.ts` 的 `createPluginStorage`）
- Bot Mode 使用的 key（`data.ts:44-46`、`group-chat.ts:937`、`canonical-group-send.ts:65`）：
  `bot-meta-v2`、`bot-meta-v2-migrated`、`group-chats`、`group-chat-tombstones`、`selected-roster-bot-v1`、
  `activity-toasts`
- 这些只存在于该桌面实例，换一台电脑看不到（分区列表/房间完整日志/本地顺序），**只能靠 ui_meta 的有界镜像跨端同步一部分**

---

## 3. 数据与接口现状（本机实测）

### 3.1 进程与端口

| 端口 | 绑定 | 进程 | 是什么 | 实测 |
|---|---|---|---|---|
| 8642 | `0.0.0.0` | 23404（gateway python） | **API Server**（OpenAI 兼容 + `/api/sessions`、`/api/jobs`） | `GET /v1/models` 无 key→401，带 key→200 |
| 8644 | `0.0.0.0` | 23404 | Webhook 平台（外部事件入口） | `GET /health`→`{"status":"ok","platform":"webhook"}` |
| 5152 | `127.0.0.1` | 23404 | **Dashboard + `/api/ws` JSON-RPC + `/api/profiles*`** | `GET /`→SPA；`GET /api/status`→200；`GET /api/profiles` 无 token→401、带 ticket→200；`ws /api/ws` 无 ticket→403 |
| 1585 | `127.0.0.1` | 23404 | 未识别私有通道（非 HTTP；HTTP/WS 握手均被拒，返回非标准响应） | 不作为集成面 |
| 8644/5152 之间 | — | — | — | `gateway_state.json`：`api_server` listener_base `http://127.0.0.1:8642`（与 netstat 的 0.0.0.0 不一致，按 netstat 为准） |

其他相关：`gateway.pid`、`gateway.lock`、`gateway_state.json`（`served_profiles: []`，
`multiplex_standalone_reason: "only one profile exists (nothing to multiplex)"`）。

### 3.2 三种鉴权模型

| 鉴权 | 用于 | 获取方式 | 有效期/范围 | 能做什么 |
|---|---|---|---|---|
| `API_SERVER_KEY`（Bearer） | 8642 API Server | `~/.hermes/.env` 中 `API_SERVER_KEY`（本机已配置） | 长期；**全 profile**（用 `/p/<profile>/` 选 profile） | 对话、Runs、会话读写、cron `/api/jobs` CRUD、模型目录 |
| Gateway session ticket | 5152 `/api/ws` RPC；5152 REST 的 `X-Hermes-Gateway-Ticket` | 本机 control pipe（Windows 命名管道 / POSIX unix socket）的 `session-ticket` verb，需要 `instance_id` + `profile_id` + `purpose` | **30 秒、一次性**；绑定 profile home | 全部 RPC（profiles/cron/groups/session/prompt/bot_relay）；REST 只到 profile 作用域内的只读/会话面 |
| Dashboard session token | 5152 dashboard REST（`/api/profiles` POST/PATCH/DELETE、`/api/cron/jobs`、`/api/status` 等） | 进程启动时随机生成（`HERMES_DASHBOARD_SESSION_TOKEN` 环境变量可覆盖），只注入 SPA HTML | 随进程；本地 loopback 免密码 | 全量 REST（含创建/改/删 profile）——但**六脉拿不到**（令牌只在 App 内） |

证据：`web_server.py:233-238`（`_resolve_session_token`）、`web_server.py:304-349`（`_require_token`，
header `X-Hermes-Session-Token` 或 `Bearer`）、`native_http.py:107-121`（ticket 兑换）、
`control_socket.py:305-361`（`session-ticket`）、`gateway_client.py:25-31`（WS 子协议）。

### 3.3 可用接口清单（按"六脉能不能用"排序）

#### A. 8642 API Server（推荐：六脉现在就能用）

鉴权：`Authorization: Bearer <API_SERVER_KEY>`。多 profile 时用 `/p/<profile>/...` 前缀
（`api_server.py:5-6`；当前只有一个 profile，`/p/default/...` 也已实测可用）。

| 方法 | 路径 | 说明 | 实测 |
|---|---|---|---|
| GET | `/v1/models` | 模型列表 | ✅ 200 |
| GET | `/v1/capabilities` | 能力位（含 `session_continuity_header` 等） | ✅ 200 |
| POST | `/v1/chat/completions` | OpenAI 兼容一次性对话（SSE 可选） | 未测（写操作） |
| POST | `/v1/responses` / `/v1/runs` | Responses / 异步 Run（可轮询/停止/审批/steer） | 未测 |
| GET | `/api/sessions?limit=N` | 会话列表（**隐藏会话不返回**，Bot Chat 因此不可见） | ✅ 200（97 条，无 Bot Chat） |
| GET | `/api/sessions/{id}` | 单个会话元数据（含 `title=Bot Chat`） | ✅ 200 |
| GET | `/api/sessions/{id}/messages` | 消息历史（隐藏会话也可读） | ✅ 200 |
| POST | `/api/sessions/{id}/chat`、`/chat/stream` | **对指定会话续聊**（可用于 Bot Chat 续聊，前提是已知 id） | 未测（写） |
| POST | `/api/sessions` | 新建会话 | 未测 |
| GET/POST/PATCH/DELETE | `/api/jobs`、`/api/jobs/{id}`、`pause/resume/run` | **cron 全量 CRUD** | GET ✅ 200（返回 `2df8bfaf6046`） |
| GET | `/health`、`/health/detailed` | 健康 | 文档/能力表声明 |

> 注意：8642 **没有** `/api/profiles`（404），也**没有** `groups.*`。bot 花名册与群组必须走 5152 的 RPC。

#### B. 5152 JSON-RPC（`/api/ws`）——Bot 管理/群组/定时任务的正门

传输：`ws://127.0.0.1:5152/api/ws`，子协议 `hermes-gateway-v1` + `hermes-gateway-ticket.<ticket>`；
消息为 JSON-RPC 2.0（`{"jsonrpc":"2.0","id":N,"method":...,"params":{...}}`）。
现成客户端：`hermes_cli/gateway_client.py`（`connect_gateway()` + `client.rpc()`）。

本机**实测成功**（只读方法）：

| 方法 | 结果（脱敏） | 意义 |
|---|---|---|
| `profiles.list {include_sessions:true}` | 1 个 profile `default`；`bot_mode_protocol:true`；`canonical_session.id=20260823_222433_67eeb7`（title `Bot Chat`） | 花名册 + 每个 bot 的永久会话 |
| `profiles.describe {name:'default'}` | `soul`、`model{provider,default}`、`skills[]`、`toolsets`、`mcp_servers` | 单 bot 的完整配置面 |
| `cron.manage {action:'list'}` | `success:true, count:1, jobs:[…]` | Routines 数据 |
| `groups.capabilities {profile:'default'}` | `protocol_version:2, driver:true, persistent_process:true, authority_gateway_id:install:…, methods:[14 个]` | 群组能力（本机可用） |
| `groups.list {limit:10}` | `{"rooms":[],"next_offset":null}` | 本机暂无房间 |

完整方法面（契约文件为准）：

- `profiles.*`：`list` / `create` / `describe` / `configure` / `set_asset` / `get_asset`
  （`profiles_vault_complete_foreign_subagents.py:184,224,265,313,333,351`）
- `cron.manage`（`contracts/tools_commands.py:525`）、`session.*`（45 个，含 `session.create` / `session.list` /
  `session.history` / `session.resume` / `session.mutate` / `session.set_hidden`）、`prompt.*`
  （`prompt.submit` / `cancel` / `receipt` / `steer`）、
- `groups.*`（18 个）：`capabilities/list/state/create/rename/send/log/stop/disband/retry/discard/approve/
  replicate/replica_state/promote/demote/peer.invite/peer.revoke/peer.register` + `attachment.upload/download`
  （`groups_bot_relay.py:159-487`）
- `bot_relay.*`：`roster.sync` / `outbox.drain` / `deliver` / `reply`（`groups_bot_relay.py:516-570`）

> 这些是 **Hermes 内部协议**：有生成的契约（`apps/shared/src/gateway-contract.generated.ts`）和能力位，
> 但没有"公共 API 稳定承诺"。升级 Hermes 后必须回归。

#### C. 5152 REST（dashboard 面）

| 路径 | 鉴权 | 说明 | 实测 |
|---|---|---|---|
| `GET /api/status` | 公开（PUBLIC_API_PATHS） | 版本/网关状态 | ✅ 200 |
| `GET /api/profiles` | session token **或** native ticket | 基础字段（name/model/skill_count/bot_title…），**无 ui_meta** | 无 token 401；带 ticket 200 |
| `GET /api/profiles/{name}/desktop-overlay` | ticket | 桌面 overlay | ✅ 200 `{"exists":false}` |
| `GET /api/cron/jobs?profile=<name>` | ticket | 必须显式 `profile`（否则 403） | ✅ 200 |
| `PATCH/DELETE /api/profiles/{name}` | **仅 session token** | 改名/删除 profile | 带 ticket → **403 profile_scope_mismatch** |
| `POST /api/profiles` | session token 或专用 `native-profile-create` 授权 | 新建 profile | 带普通 ticket → 403 |

证据：`native_http.py:79-104`（`/api/profiles` 只允许 GET；`PATCH/DELETE` 直接拒）、
`native_http.py:107-121`（native-profile-create 专用 scope）。

#### D. CLI（可作为兜底，不是"API"）

| 能力 | 命令 |
|---|---|
| 列出 bot | `hermes profile list` |
| 新建 | `hermes profile create <name> [--clone-from default]` |
| 改名/删除 | `hermes profile rename` / `hermes profile delete <name>` |
| 和 bot 的 Bot Chat 对话 | `hermes -p <bot> chat -c "Bot Chat" --create-if-missing` |
| 定时任务 | `hermes cron list` / `hermes cron add ...` |
| 跨机交付 | `hermes peer add/list/dm/run/status/stop`（走对端 API Server + `API_SERVER_KEY`） |

`bot-mode.md:384-393` 明确 CLI 对等性。

### 3.4 实测命令（可复现）

```powershell
# 1) 端口/进程
Get-NetTCPConnection -State Listen | ? LocalPort -in 8642,8644,5152,1585

# 2) API Server 鉴权（不打印 key）
$key = (Select-String "$env:LOCALAPPDATA\hermes\.env" '^API_SERVER_KEY=(.*)$').Matches[0].Groups[1].Value
Invoke-WebRequest http://127.0.0.1:8642/v1/models -Headers @{Authorization="Bearer $key"}
Invoke-WebRequest "http://127.0.0.1:8642/api/jobs" -Headers @{Authorization="Bearer $key"}
Invoke-WebRequest "http://127.0.0.1:8642/api/sessions/20260823_222433_67eeb7/messages?limit=3" -Headers @{Authorization="Bearer $key"}

# 3) RPC（用 Hermes 自带 Python + 官方客户端）
& "$env:LOCALAPPDATA\hermes\tools\python-3.14.7+20260901-win32-x64\python.exe" probe.py
# probe.py:
#   import hermes_bootstrap
#   from hermes_cli.gateway_runtime import discover_gateway_endpoint
#   from hermes_cli.gateway_client import connect_gateway
#   d = discover_gateway_endpoint(r"C:\Users\11490\AppData\Local\hermes")
#   async with connect_gateway(endpoint=d.endpoint) as c:
#       print(await c.rpc("profiles.list", include_sessions=True))
#       print(await c.rpc("cron.manage", action="list"))
#       print(await c.rpc("groups.capabilities", profile="default"))
```

### 3.5 明确拿不到的

| 目标 | 现状 |
|---|---|
| 无 ticket/token 直接 `GET /api/profiles`（5152） | 401 |
| 无 ticket `ws /api/ws` | 403 |
| 8642 上 `/api/profiles`、`/api/status` | 404 |
| 带普通 ticket 改名/删除 profile | 403 `profile_scope_mismatch` |
| 从 `state.db` 读 bot 列表/标题/头像 | 不存在这些表/列（只有 `sessions.title` 可间接看到 `Bot Chat`） |
| 读桌面分区列表/房间完整日志 | 仅 Electron localStorage（LevelDB），无 API |
| 远程机器上的 bot 管理 | 需要该机器的 ticket（pipe）或 dashboard token；跨机只有 `bot_relay` / `hermes peer` |

---

## 4. 能力清单：BOTS 能做什么 × API 可复刻性

图例：✅ 有公开接口可复刻；🟡 需桥接/组合接口；❌ 仅桌面 UI（IPC/localStorage）。

| # | 能力 | UI 行为 | 后端实现 | 可复刻 | 说明 |
|---|---|---|---|---|---|
| 1 | 列出机器人 | BOTS 花名册（5s 轮询） | `profiles.list` | ✅ | 含 `ui_meta`、`canonical_session`、`last_session` |
| 2 | 查看单 bot 配置 | Edit Profile → 模型/技能/工具集/MCP/SOUL | `profiles.describe` | ✅ | |
| 3 | 新建机器人 | New Agent（Name/Title/Description + Advanced） | `profiles.create`（RPC） | ✅ | 可 clone、可 `no_skills`、可指定 model/provider、可写 SOUL |
| 4 | 编辑标题/描述/颜色/隐藏/置顶/分区归属 | 右键/编辑框 | `profiles.configure {ui_meta}`（CAS） | ✅ | 需自己维护 revision |
| 5 | 改模型 | Advanced / 会话内 composer | `profiles.configure {model,provider}` | ✅ | 有 `confirm_required` 分支（贵模型） |
| 6 | 开关技能 / 工具集 / MCP | Advanced 勾选 | `profiles.configure {disabled_skills, enabled_toolsets, enabled_mcp_servers}` | ✅ | |
| 7 | 改 SOUL.md | 编辑器 | `profiles.configure {soul}` | ✅ | |
| 8 | 上传/清除头像 | 头像选择器 | `profiles.set_asset` / `get_asset` | ✅ | PNG/JPEG/WebP ≤2MB |
| 9 | 删除机器人 | 右键 Delete（二次确认） | REST `DELETE /api/profiles/<n>`（Electron 拦截做 teardown） | 🟡 | 无 RPC；native ticket 403，需 dashboard token 或 CLI |
| 10 | 重命名机器人 | 右键重命名 | REST `PATCH /api/profiles/<n>` 或 CLI | 🟡 | 同上 |
| 11 | 打开 Bot 的永久会话 | 点行 → Bot Chat | `session.create`/`resume` + 标题 `Bot Chat`；RPC `canonical_session` 给出 id | ✅ | 也可直接用 8642 `/api/sessions/{id}/chat` 续聊 |
| 12 | 给 bot 下发任务 | 在 Bot Chat 里发消息 | `prompt.submit` / `session.*`；或 8642 `/v1/chat/completions`、`/api/sessions/{id}/chat` | ✅ | 要落在 Bot Chat 需指定会话 id 或标题 |
| 13 | 查看会话/历史 | 行内预览 + 打开会话 | `session.list`/`session.history`；8642 `/api/sessions*` | ✅ | 8642 列表过滤隐藏会话；按 id 读仍可 |
| 14 | 每个 bot 独立技能/工作区/模型/凭据 | Advanced | profile 目录 + `profiles.configure` | ✅ | 工作区=该 profile 的 cwd/config |
| 15 | 定时任务（Routines） | 右侧面板建/改/暂停/删 | `cron.manage`（RPC）或 8642 `/api/jobs`（CRUD）或 5152 `/api/cron/jobs?profile=` | ✅ | Bot 作用域 = `[bot:<name>]` 命名 + `profile` 参数 |
| 16 | 群组（网关房间） | 顶部列表、刷新、创建、审批、收发 | `groups.*`（18 方法，含 send/log/approve/stop） | ✅ | 本机 `driver:true`，会话内可无人值守 |
| 17 | 群组成员关系 | Manage groups | `profiles.configure {ui_meta.groups}` | ✅ | 本地房间成员还在 localStorage + ui_meta 镜像 |
| 18 | 桌面本地群聊（房间行/完整日志） | 花名册房间行 | 插件 localStorage + ui_meta 有界镜像 | ❌ | 只能在桌面端产生/查看完整日志 |
| 19 | 分区（文件夹）顺序/空分区 | 拖拽、右键 | 分区**列表**在 localStorage；成员在 ui_meta | 🟡 | 成员可写，列表顺序不可 |
| 20 | @ 提及 / bot 互发消息 | composer @ 补全 + `message_agent` | RPC `bot_relay.deliver`（跨机）；本地 DM 由 agent 工具完成 | 🟡 | `message_agent` 是 agent 工具，不是外部 API；跨机可走 `hermes peer dm` |
| 21 | 跨机 bot 花名册/消息 | Connections 多网关 | Desktop relay（`bot_relay.*`）+ `hermes peer` | 🟡 | relay 需要桌面在线；peer 是网关对网关（需 API key） |
| 22 | Screen/宠物/语音/TTS | 插件附加 UI | 桌面 IPC / profile 配置 | ❌ | 纯桌面表现层 |

**结论**：BOTS 的"业务价值面"（花名册、创建/配置、Bot Chat、任务下发、Routines、网关群组）**全部有服务端接口**；
只有"桌面表现层与其本地布局/日志"不可复刻，且这部分对六脉价值低。

---

## 5. 三种集成方案对比

### 5.1 方案①：直接调 Hermes 网关 API（推荐）

拆成两半，因为它们在两台"身份域"里：

| 子面 | 接口 | 鉴权 | 六脉可达性 | 覆盖 |
|---|---|---|---|---|
| ①-A 运行面 | 8642 `/v1/*`、`/api/sessions*`、`/api/jobs*`、`/p/<profile>/...` | `API_SERVER_KEY` | ✅ 后端容器可直接 `host.docker.internal:8642` | 对话、Run、会话读写、cron |
| ①-B 管理面 | 5152 `/api/ws`（JSON-RPC）+ 5152 REST（ticket） | control pipe 签发的 30s ticket | ❌ Docker 内不可达（pipe 是 Windows 本机 IPC）→ **需宿主机桥接** | profiles、groups、cron.manage、session/prompt |

**架构建议**（贴合六脉现状：后端在 Docker，Hermes 在宿主，已有 `hermes-proxy.py` 模式）：

```
[六脉后端容器 FastAPI]
      │  HTTP + 平台 JWT（复用 backend/app/services/hermes.py 的 URL/Key 管理）
      ▼
[Windows 宿主：hermes-bots-bridge.py  (新，~300-500 行)]
      ├─ 8642 /v1/*、/api/sessions*、/api/jobs*   (Bearer API_SERVER_KEY)
      └─ 5152 /api/ws JSON-RPC
            ├─ 启动时：hermes gateway ensure --json → api_origin + instance_id
            ├─ 每次调用：control pipe "session-ticket"（purpose=interactive/native-http）
            └─ 复用 hermes_cli.gateway_client（或用同样 20 行自实现）
```

桥接暴露给六脉的最小 REST（示例）：

| 桥接端点 | 下游 | 说明 |
|---|---|---|
| `GET /bots` | `profiles.list` | 花名册（title/description/头像/最近会话/canonical_session id） |
| `GET /bots/{name}` | `profiles.describe` | 配置快照 |
| `POST /bots` | `profiles.create` | 新建 |
| `PATCH /bots/{name}` | `profiles.configure` | 标题/描述/模型/技能/SOUL/ui_meta |
| `POST /bots/{name}/avatar` | `profiles.set_asset` | 头像 |
| `POST /bots/{name}/chat` | 8642 `POST /api/sessions/{canonical_id}/chat` | 向 Bot Chat 下发任务（保留永久会话） |
| `GET /bots/{name}/sessions` | `session.list`（profile 作用域） | 历史 |
| `GET/POST/PATCH/DELETE /routines` | `cron.manage` 或 8642 `/api/jobs` | 定时任务，名称加 `[bot:<name>]` |
| `GET/POST /groups`、`POST /groups/{id}/send` | `groups.list/create/send` | 群组 |
| `DELETE /bots/{name}` | CLI `hermes profile delete` 或 dashboard token REST | 兜底 |

工作量：

| 阶段 | 范围 | 工作量 |
|---|---|---|
| P0 | 桥接骨架 + `GET /bots` + `POST /bots/{n}/chat` + 只读 routines | **S**（3–5 人日，含联调） |
| P1 | 新建/编辑/头像/模型/技能 + routines CRUD + 六脉前端「机器人」页 | **M**（2–3 周） |
| P2 | 群组（`groups.*`）、多网关/跨机（peer/relay）、审批流、SSE 进度 | **M~L**（3–6 周） |

风险：

- RPC 是内部协议：方法名/参数可能随 Hermes 升级变化（本机 0.22.2，更新频率高）；
- ticket 30s 一次性 → 桥接必须每次调用现签，不能缓存；
- pipe 只允许**同机同用户**：桥接必须以启动 Hermes 的那个 Windows 用户运行；服务化/计划任务要以该用户身份；
- 8642 监听 `0.0.0.0`，务必保证 `API_SERVER_KEY` 强随机、网络层限制（否则等于把 agent 暴露到 LAN）；
- gateway 可能 idle-exit（`ensure_gateway_runtime(idle_exit=True)`），桥接需带"未就绪 → ensure → 重试一次"；
- 多 profile 后网关会自动 multiplex（`multiplex_profiles`），`/p/<profile>/` 前缀才生效，桥接要按 profile 路由。

### 5.2 方案②：只读 state.db（不推荐作为主方案）

| 项 | 结论 |
|---|---|
| 可行性 | SQLite WAL + `mode=ro` 可读，会话/消息/路由可查 |
| 能覆盖 bots 吗 | **不能**。51 张表里没有 bots/bot_/group 相关表；bot 定义在 `profiles/` 文件系统与 `profile.yaml` |
| 能覆盖什么 | 会话/消息统计、`Bot Chat` 行（`title` + `hidden`）、token/成本、`gateway_routing` |
| 改造 | 只读连接 + 轮询/增量（`sessions.last_activity_at`） |
| 工作量 | **S**（2–4 人日） |
| 风险 | ①schema 随版本变（有 `schema_version`，无兼容承诺）；②WAL 下读到的是快照，可能与运行中状态不一致；③**绝不能写**（网关持有 WAL，外部写会破坏一致性）；④拿不到 ui_meta/头像/群组/定时任务（cron 在 JSON+另一个 DB） |
| 适用 | 只做"会话/成本看板"或对账，不做机器人管理 |

### 5.3 方案③：桌面 App IPC / 本地接口（不建议）

| 路径 | 可行性 | 说明 |
|---|---|---|
| Electron IPC（`window.hermesDesktop.*`，preload 暴露） | ❌ | 只在 App 渲染进程内可用；外部进程无法调用（需要 Electron 上下文/IPC 通道） |
| 本地 REST/WS（5152） | 🟡 | 需要 ticket 或 dashboard token；ticket 仍要 pipe，token 随进程随机 |
| 读 localStorage（LevelDB） | 🟡/❌ | 能读到分区/房间日志，但格式是 Chromium 内部编码、随版本变、App 运行时可能锁库，**且没有写回路径** |
| 结论 | — | 把它当"集成方案"会把六脉绑死在某个桌面版本 + 某个用户会话上；仅可作为排障时的人工取证 |

### 5.4 对比总表

| 维度 | ① 网关 API | ② state.db 只读 | ③ 桌面 IPC/本地 |
|---|---|---|---|
| 覆盖 bot 管理 | ✅（create/configure/asset；删改需 CLI/token） | ❌ | ❌（IPC 不可外部调用） |
| 覆盖对话/任务 | ✅ | ⚠️ 只能读 | 🟡 |
| 覆盖定时任务 | ✅（RPC / `/api/jobs`） | ❌（cron 不在 state.db） | 🟡 |
| 覆盖群组 | ✅（`groups.*`） | ❌（本机为空） | 🟡 |
| 鉴权可自动化 | ✅（API key + pipe） | ✅（文件读） | ❌（token 随机/App 内） |
| 跨机扩展 | ✅（`/p/`、peer、relay） | ❌ | ❌ |
| 改造量 | 桥接 + 前端 | 小 | 大且脆 |
| 工作量 | S→M→L（分阶段） | S | L，不建议 |
| 版本敏感度 | 中（RPC 契约） | 中（schema） | 高（Electron/localStorage） |
| 上线风险 | 中（鉴权/网络/版本） | 低（只读） | 高 |
| 建议 | **主方案** | 辅助（分析/对账） | 放弃 |

---

## 6. 推荐路线（结合六脉现状）

六脉已有 `backend/app/services/hermes.py` + `backend/app/routes/hermes.py` 只读适配层（见
`docs/hermes-gateway-layer.md`），`_hermes_url` / `_hermes_api_key` 可热加载，鉴权在 router 级
`get_current_user`。建议在此基础上增量，不新建体系。

**P0（1 周内，S）**
1. 宿主机新增 `hermes-bots-bridge.py`（沿用 `hermes-proxy.py` 的部署方式，Windows 任务/手动启动）。
2. 桥接实现：`GET /bots`（profiles.list）、`GET /bots/{n}/routines`（cron.manage）、
   `POST /bots/{n}/chat`（8642 `/api/sessions/{canonical_id}/chat`）。
3. 六脉后端新增 `/api/hermes/bots*` 只读代理（沿用现有超时/错误映射/Key 脱敏）。
4. 前端「机器人」页：花名册（头像/标题/最近消息）+ 最近会话 + 一键"下发任务"。

**P1（2–3 周，M）**
5. 新建/编辑 bot（`profiles.create` / `profiles.configure` / `profiles.set_asset`），
   标题/描述/模型/技能开关/SOUL。
6. Routines CRUD（优先 8642 `/api/jobs`，按 `[bot:<name>]` 命名 + `profile` 路由）。
7. 会话历史（`session.list`/`history` 或 8642 `/api/sessions*`）。

**P2（3–6 周，M~L）**
8. 群组（`groups.*`：列表/创建/发送/日志/审批），对应六脉"事件中心/协作"场景。
9. 多网关/跨机：`/p/<profile>/` + `hermes peer`（对端需开 `api_server` + 强 key）。
10. 删除/改名兜底（CLI 或 dashboard token），以及审计/幂等/重试。

---

## 7. 风险与缓解

| 风险 | 表现 | 缓解 |
|---|---|---|
| RPC 协议漂移 | Hermes 升级后方法名/参数变化（如 `profiles.*`、`groups.*`） | 启动时探测 `profiles.list` 的 `bot_mode_protocol` 与 `groups.capabilities.protocol_version`；桥接做能力门禁；锁版本并回归 |
| ticket 短命/一次性 | 30s、redeem 一次；缓存必失败 | 每次调用现签；失败重签一次；不要在 URL/日志落 ticket |
| pipe 同机同用户限制 | 六脉后端在 Docker，无法打开 `\\.\pipe\...` | 宿主机桥接（P0 核心工作）；桥接以 Hermes 运行用户启动 |
| 8642 暴露面 | `0.0.0.0:8642`，key 泄露=agent 被控 | 强随机 `API_SERVER_KEY`、防火墙仅放行宿主/容器网段、定期轮换；不要把 key 写进前端 |
| 并发写 | 桌面/网关/六脉同时改 cron、profile.yaml、会话 | 只走官方接口；ui_meta 用 CAS revision；cron 变更走单一写入口；不要写 state.db |
| Bot Chat 标题耦合 | 身份=标题恰好 `Bot Chat`；改名/改标题会丢"永久会话"语义 | 不改标题；用 `profiles.list.canonical_session.id` 固定 id；`/new` 在 Bot Chat 内被改写为 `/compact` |
| 可见性差异 | 8642 `/api/sessions` 过滤隐藏会话（Bot Chat 不在列表） | 用 RPC 拿 canonical_session id；或按 id 直接读 |
| 桌面专属数据 | 分区列表、房间完整日志、tombstone 只在 localStorage | 六脉只展示"服务端真相"；UI 文案注明"桌面端专属布局不同步" |
| cron 命名约定 | `[bot:<name>]` 只是约定，不是硬约束 | 六脉创建时统一加前缀；读取时用 `profile` 参数 + 前缀双过滤 |
| 网关生命周期 | idle exit / 重启 / 更新中 | 桥接做 ensure→重试；前端展示"网关不可用"而不是空列表 |
| 多 profile multiplex | 第二个 profile 出现后网关行为切换 | 桥接始终用 `/p/<profile>/` 与 `profile` 参数，不依赖"默认单 profile" |
| 桌面插件可被禁用 | Capabilities → Plugins → Bots 关掉后 UI 消失，但数据/接口仍在 | 六脉不依赖 UI 存在；文档说明"关闭桌面 Bots 不影响六脉" |

---

## 8. 附录 A：证据索引（源码 / DB / 实测）

### A.1 源码行号

| 主题 | 证据 |
|---|---|
| Bot Mode 定位（bot=profile） | `apps/desktop/src/plugins/hermes-bots/plugin.tsx:1-16` |
| BOTS pane 注册 | `plugin.tsx:442-484`；`i18n/zh.ts:77`（`bots: '机器人'`） |
| Routines pane | `plugin.tsx:486-522`；`i18n/zh.ts:2923`（`定时任务`） |
| 「Hermes」显示名 | `labels.ts:62-72` |
| BotMeta / ui_meta | `types.ts:52-94,131` |
| 花名册轮询与写回 | `data.ts:44-46,357-415,435-449` |
| `[bot:]` 命名 | `cron.tsx:71-75,1015` |
| 网关群组列表 + 刷新按钮 | `roster-pane.tsx:474`；`canonical-group-registry.tsx:17-40`；`canonical-group-locales.ts:41,97` |
| 群组 RPC 调用 | `canonical-groups.ts:74-98,100-145,147-177` |
| 本地群聊 + ui_meta 镜像 | `group-chat.ts:3-4,276-281,1278-1280` |
| 插件 localStorage | `lib/storage.ts:41-52`；`contrib/plugin.ts:372`（`hermes.plugin.<id>.<key>`） |
| 内置且默认开启 | `contrib/plugins.ts:2-6` |
| `profiles.list` 返回 | `tui_gateway/methods_profiles.py:282-303` |
| canonical Bot Chat（按标题） | `methods_profiles.py:162-174`；`tools/bot_mode_probe.py:31` |
| ui_meta / revisions | `methods_profiles.py:257-262` |
| `profiles.create/configure/set_asset` | `methods_profiles.py:306-346,386-409,412-447` |
| RPC 契约 | `tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py:184-360`；`contracts/groups_bot_relay.py:159-570`；`contracts/tools_commands.py:525` |
| 官方 RPC 客户端 | `hermes_cli/gateway_client.py:25-31,152-185,188-240` |
| control pipe / ticket | `gateway/control_socket.py:289-361,420-436` |
| `/api/ws` | `tui_gateway/ws.py:1-4`；`hermes_cli/web_routers/chat_ws.py:702` |
| dashboard token | `hermes_cli/web_server.py:233-238,304-349` |
| native-http 作用域 | `hermes_cli/dashboard_auth/native_http.py:42-104,107-121` |
| REST profiles | `hermes_cli/web_routers/profiles.py:800-810,953-990` |
| REST cron | `hermes_cli/web_routers/cron.py:701-772` |
| API Server + `/p/` | `gateway/platforms/api_server.py:5-6,45-51,63-99,1680-1687` |
| 官方能力文档 | `website/docs/user-guide/bot-mode.md:8-13,32-45,104-108,110-176,191-218,372-393` |

### A.2 实测结果（脱敏）

```
端口：8642(0.0.0.0) 8644(0.0.0.0) 5152(127.0.0.1) 1585(127.0.0.1, 非HTTP)   [PID 23404]
gateway_state.code_version = 0.22.2
profiles.list → {"profiles":[{"name":"default","is_default":true,"skill_count":139,
                  "canonical_session":{"id":"20260823_222433_67eeb7","title":"Bot Chat",
                  "message_count":2},"has_avatar":true}],"bot_mode_protocol":true,
                  "install_id":"…"}
cron.manage{action:list} → {"success":true,"count":1,"jobs":[{"job_id":"2df8bfaf6046", …}]}
groups.capabilities{profile:default} → {"protocol_version":2,"driver":true,"persistent_process":true,
                  "methods":[14 项]}
groups.list → {"rooms":[],"next_offset":null}
GET /v1/models (Bearer) → 200 {"data":[{"id":"hermes-agent"}]}
GET /v1/capabilities (Bearer) → 200
GET /api/sessions?limit=500 (Bearer) → 200，97 条，无 "Bot Chat"（隐藏会话被过滤）
GET /api/sessions/20260823_222433_67eeb7/messages (Bearer) → 200（隐藏会话按 id 可读）
GET /api/jobs (Bearer) → 200，含 2df8bfaf6046
GET /p/default/api/sessions (Bearer) → 200
GET /api/profiles (ticket) → 200，1 个 profile（无 ui_meta 字段）
GET /api/profiles/default/desktop-overlay (ticket) → 200 {"exists":false}
GET /api/cron/jobs?profile=default (ticket) → 200
GET /api/profiles (无 ticket) → 401
PATCH/DELETE /api/profiles/__probe__ (ticket) → 403 profile_scope_mismatch
ws /api/ws (无 ticket) → 403
state.db：51 张表，sessions=307、messages=9919、hosted_rooms=0
shared-state.db：hosted_room_events=0
cron/jobs.json：1 个作业（每 10 分钟，无 [bot:] 前缀）
```

### A.3 被证伪的假设

| 假设 | 实测结论 |
|---|---|
| BOTS 是消息渠道 bot 的聚合 | ❌ 是 profile 花名册；消息渠道状态在 `gateway_state.platforms`，与 BOTS 无关 |
| BOTS 是 gateway channel/群组聚合 | ❌ 群组只是 BOTS pane 顶部的一小块（canonical groups） |
| 数据在 state.db，读库即可 | ❌ 无 bots 表；bot 在 profile 目录 + profile.yaml |
| 有 `/api/bots` 之类的 REST | ❌ 没有；只有 `profiles.*` RPC 与 `/api/profiles` REST |
| 桌面端 IPC 可以外部调用 | ❌ Electron preload 只在 App 内；外部只能走 5152/8642 |
| 用普通 gateway ticket 能完成 bot 的增删改 | ⚠️ 新建/编辑走 RPC 可以（`profiles.create/configure`）；改名/删除走 REST 被 `403 profile_scope_mismatch`，需 dashboard token 或 CLI |

---

## 9. 附录 B：一句话版本

**BOTS = Hermes 桌面插件 Bot Mode = 一个 profile 一行 bot + 每个 bot 一个 `Bot Chat` 永久会话 +
`[bot:]` 定时任务 + 网关群组；管理面在 5152 的 JSON-RPC（同机 pipe ticket），运行面在 8642 的
OpenAI API（API_SERVER_KEY）。六脉走"宿主机桥接 + 现有 hermes 适配层"即可集成：P0 只读+对话 S，
P1 管理 M，P2 群组/多机 M~L；不要读 state.db 当数据源，也不要依赖桌面 IPC。**
