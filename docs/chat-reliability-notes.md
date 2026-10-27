# 对话上下文可靠性修复说明（架构报告 Top-1）

> 日期：2026-10-17 · 范围：`chat_sessions` 表、`/api/chat/sessions/*`、`useChat`、`api.ts`
>
> 目标：让「刷新 / 切换页面 / 重新进入」不再丢失 Hermes 会话与运行中的 run，
> 避免对话上下文被硬清零。

## 1. 根因

修复前：

1. `chat_sessions` 只存消息文本，没有记录 Hermes `session_id`。`loadSession()`
   一律 `setHermesSessionId(null)`，恢复历史后下一轮只能**全量重放历史**；
   Hermes 侧已有上下文被丢弃，长对话很容易触发上下文溢出 / 答非所问。
2. run 的 `run_id` 只存在 React 内存里。组件卸载时
   `useEffect(() => () => abortRef.current?.abort(), [])` 会主动中止本地流（对
   `/chat/stream` 等于中止生成），Hermes run 与前端彻底失联。
3. 运行中的 run 没有落库，重新进入页面无法知道「还有一轮在跑」。

## 2. 改动清单

### 数据库

| 文件 | 内容 |
| --- | --- |
| `backend/migrations/20261017_chat_session_hermes.sql` | 新增幂等迁移：`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS hermes_session_id VARCHAR(128)`、`active_run_id VARCHAR(128)` + 两个查询索引 |
| `backend/migrations/init.sql` | `chat_sessions` 建表语句同步两列（并保留升级用 `ADD COLUMN IF NOT EXISTS`） |
| `backend/app/models/__init__.py` | `ChatSession` ORM 增加 `hermes_session_id` / `active_run_id` |

### 后端（`backend/app/routes/chat.py`）

- `ChatSessionDetail` 增加 `hermes_session_id`、`active_run_id`；无值返回 `null`。
- `GET /api/chat/sessions/{id}` 原样返回两列。
- `SaveMessagesRequest` 接受 `hermes_session_id` / `active_run_id`：
  - 用 `model_fields_set` 判断「调用方是否真的带了该字段」；
  - 显式传 `null` 才清空，老客户端不带字段时保留原值（向后兼容）；
  - `messages` 可省略：只更新关联字段时不会清空已存消息；显式传列表
    （含 `[]`）才替换消息；
  - 与消息 upsert、标题更新在同一次请求内持久化。

### 前端

**`src/lib/api.ts`**

- `ChatSessionSummary`（`ChatSessionDetail` 继承）补：
  `hermes_session_id?: string | null; active_run_id?: string | null;`
- `chatHistory.saveMessages(sessionId, messages, title?, links?)` 新增可选
  `links` 参数，用于同一次写入携带 Hermes 关联字段。

**`src/hooks/useChat.ts`**

1. `sendMessage` 收到 `session` 事件 → 异步把 `hermes_session_id` 写回当前
   chat session；成功创建 run 后立即把 `active_run_id` 写回。
   - 已有 `sessionId`：调用 `saveMessages(..., links)`；
   - 新对话尚无 session：等该轮结束后的自动保存统一写入。
   - 所有 session 写入经 `enqueueSessionWrite` 串行化，避免
     “删除+重插”式保存并发交错产生重复消息。
2. `loadSession(id)`：
   - 从后端记录恢复 `hermesSessionId`（不再置空）；
   - `hermesSessionMode` 置 `null`（表示“模式未知/来自持久化”），
     匹配逻辑把 `null` 视为可续用 → 下一轮只发送最新消息，继续同一 Hermes 会话；
   - 记录无 `hermes_session_id` 时仍回退全量历史重放；
   - 记录有 `active_run_id` 时通过 Runs 状态接口 reattach（见下）。
3. 卸载不再中止 run：删除
   `useEffect(() => () => abortRef.current?.abort(), [])`；卸载只清理 reattach
   轮询定时器。Hermes run 在后端继续执行，`active_run_id` 已落库。
4. 重新进入：`loadSession` 发现 `active_run_id` → 轮询
   `GET /api/chat/runs/{run_id}`（`chatRuns.status`）：
   - 运行中：`activeRunId` 恢复、`isStreaming=true`（仍可 steer / stop）；
   - 完成：把最终 `output` 合并进恢复出的消息（若是已保存的流式前缀则原地补全，
     不重复追加），并清空 `active_run_id`；
   - 运行已过期 / 404：只清空 `active_run_id`，已恢复的聊天记录不受影响。
5. 运行结束 / 停止 / 自动保存时带上当前 link 字段（`null` 会清空
   `active_run_id`），避免留下指向已结束 run 的“僵尸”记录。

## 3. 迁移执行

禁止 docker build/up/restart 的前提下，对**已存在**的数据库执行：

```powershell
Get-Content backend/migrations/20261017_chat_session_hermes.sql -Raw |
  docker exec -i liumai-postgres psql -U liumai -d liumai -v ON_ERROR_STOP=1
```

若 psql 不在 docker 里，也可把文件挂载/复制进容器后执行：

```bash
psql -U liumai -d liumai -v ON_ERROR_STOP=1 -f /path/to/20261017_chat_session_hermes.sql
```

验证列已存在（应返回 2 行，长度均为 128）：

```sql
SELECT column_name, data_type, character_maximum_length
  FROM information_schema.columns
 WHERE table_name = 'chat_sessions'
   AND column_name IN ('hermes_session_id', 'active_run_id');
```

> 全新数据卷无需手动执行：`init.sql` 已包含这两列。迁移文件本身幂等，重复执行安全。

## 4. 验收步骤（建议按顺序）

1. **静态检查**
   - `python -m py_compile backend/app/models/__init__.py backend/app/routes/chat.py`
   - 前端 `tsc`（本次改动文件无新增类型错误）。
2. **迁移**：执行上面的 SQL，跑验证查询确认两列存在。
3. **接口**
   - `POST /api/chat/sessions` 建会话；
   - 发一轮 agent 消息后 `GET /api/chat/sessions/{id}`：
     `hermes_session_id` 已非空（Hermes 可用时）、`active_run_id` 在运行中非空；
   - 手动 `POST /api/chat/sessions/{id}/messages` 携带
     `{"hermes_session_id": null}`，再 GET 应返回 `null`（显式 null 清空）；
   - 老格式请求（不带两个字段）不应改变已有值。
4. **上下文连续性**
   - 在同一会话连发两轮，第二轮的请求体应只包含最新一条 user message
     （Hermes 会话被复用，`conversation_history` 为 null）；
   - 刷新页面 → 从侧栏点回该会话 → 再发一条：仍继续同一个 Hermes 会话，
     Hermes 能引用第一轮内容。
5. **运行中离开页面**
   - 发一条耗时较长的 agent 消息，流式期间切换到其它页面（或刷新）；
   - 确认不会向 Hermes 发送 stop（后端 run 继续）；
   - 回到该会话：run 仍在跑时输入框保持“运行中/可补充指令”状态；
     run 完成后最终回答出现在消息末尾，`active_run_id` 被清空。
6. **不破坏既有页面**：会话列表、新对话、删除会话、LLM 直连模式
   （`provider: "llm"`，走 `/api/chat/stream`）行为不变。

## 5. 已知边界

- 新对话在**首轮结束**后才创建 `chat_sessions` 行：若首轮运行中直接关闭页面且
  从未自动保存，则没有可 reattach 的会话记录（与现状一致，属后续可优化项）。
- reattach 采用 Runs 状态轮询（约 2.5s）而非重新订阅 SSE：好处是不会重放
  已保存的流式片段、不会重复消息；代价是 reattach 后不是逐字实时，run 完成后
  一次性补全最终输出。
- 旧路径 `/api/chat/stream`（LLM 直连模式）没有 run 概念，离开页面即结束本地
  流，无法 reattach；该路径不属于本次 Top-1 修复范围。
- `hermes_session_id` 在 Hermes 侧过期时，下一轮创建 run 会失败并回退
  `/chat/stream`；此时会改为**全量历史重放**（不会只发最新一条），保证上下文不丢。
- 直连 LLM 模式（`provider: "llm"`）没有服务端 agent 上下文，即使会话记录了
  Hermes session 也仍走全量历史重放，避免模式切换后上下文缺失。

## 6. 二次修复：正文重复两遍 / 切页返回不再输出（2026-10-27）

### 6.1 根因

| 现象 | 根因 |
| --- | --- |
| 每条助手正文出现两遍 | Hermes Runs API 对**同一条**中途说明会投递两种事件：`message.delta`（逐 token 增量）与 `message.interim`（整条消息的**完整文本**）。`normalizeRunEvent` 把两者都归一成 `{type:"delta"}`，`appendToAssistant` 无条件 `current + chunk` 追加 → 整句渲染两次。思考过程早前有 `ReasoningDeduper` 去重，正文这一路一直没有对应保护。 |
| 重复内容无法被终态纠正 | `_mergeAuthoritativeRunOutput` 只在「服务端 output **更长**」时替换；本地因重复而更长的文本反而被保留。`_withRunOutput` 在内容不一致时**追加**一条新消息。 |
| 刷新 / 切页返回后不再继续输出 | 返回时若 localStorage 里没有该 run 的 `seq` 游标（刷新会中断写请求），`reattachRun` 直接走 `run-state` 轮询；而 Hermes 在 RUNNING 阶段 `output` 通常为空，轮询要等 `COMPLETED` 才一次性补全 → 界面上表现为「卡住、不继续输出」。 |

### 6.2 改动

- `src/lib/api.ts`：`ChatStreamEvent` 的 `delta` 增加 `snapshot?: boolean`；`message.interim` 归一为 `{type:"delta", snapshot:true}`（整块快照语义）。
- `src/hooks/useChat.ts`
  - 新增 `_mergeAssistantChunk`：快照延长正文则替换、已包含则丢弃、否则只追加未见面后缀；普通增量照常追加，仅「≥10 字符且与尾部完全重复」的重放帧被丢弃。
  - 新增 `replayRef` + `beginReplayFromStart`：无游标重订阅 SSE 时，先用恢复出的气泡文本作 baseline 吸收重放，追上后再恢复正常追加（15s 未追上则放弃，交给终态对账）。
  - `reattachRun`：**只要在 Hermes 5 分钟重放窗口内就优先 SSE 续订**（无游标时从头发起并吸收），SSE 失败仍回落轮询。
  - `pollRunState`：RUNNING/QUEUED 阶段把 `run-state.output` 以「替换」方式刷进气泡，轮询间隔 3s → 1.5s。
  - `_mergeAuthoritativeRunOutput(…, authoritative)`：`COMPLETED` 的 run 无条件采用服务端 `output`（即使更短），据此清掉重复正文。
  - `collapseDoubledTail`：回合终态前，仅裁剪**完全重复的整块尾部**（≥20 字符），正常重复措辞不受影响。
  - `_withRunOutput`：恢复的正文已包含服务端 output 时原地替换，不再追加第二条。

### 6.3 验收

1. 发一条会触发工具调用的 agent 消息：中途说明只出现一次，最终回答只出现一次。
2. 流式期间切到其它导航页再返回：气泡原地继续增长（SSE 续订），或每 1.5s 刷新一次（轮询兜底）；结束后内容与 Hermes `output` 完全一致。
3. 流式期间刷新页面：恢复历史后继续补全，且**不重复**已显示的文本。
