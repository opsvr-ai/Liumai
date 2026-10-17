# E1 对话主线：审批 / Steer / 运行状态接线

> 范围：仅 `src/components/chat/ChatPanel.tsx`、`src/hooks/useChat.ts`、
> `src/lib/api.ts`。未改 `App.tsx` / `routes.tsx` / `layout/**` / `pages/**`，
> 未执行任何 docker 命令。

## 1. 工具审批接线

### 事件链路

```
Hermes approval.request
  → GET /api/chat/runs/{id}/events            (SSE)
  → api.ts _normalizeRunEvent()               { approvalId, tool, description, command, choices }
  → useChat.applyEvent("approval")            setPendingApproval(...)
  → ChatPanel 审批条（输入卡上方）
  → respondApproval({ decision })
  → POST /api/chat/runs/{id}/approval         { approval_id, decision }
```

### UI

- 出现 `pendingApproval` 时，在输入卡上方渲染黄色审批条：
  - 标题：`工具调用需要审批 · <tool>`（`tool` 来自 `approval.request` 的
    `tool` / `tool_name` / `name`，缺省则只显示标题）；
  - 描述 `description`、命令预览 `command`（`<pre>`，长内容可滚动）；
  - 四个固定动作，顺序与文案：**允许一次 / 本会话 / 始终 / 拒绝**，
    decision 分别为 `once / session / always / deny`。即使服务端
    `choices` 只给出子集也完整展示（不支持的 decision 会以可重试错误暴露，
    而不是静默隐藏）。
- `runCapabilities.approval === false` 时整条审批 UI 不渲染（见 §4）。

### 提交语义

`useChat.respondApproval({ decision })`：

1. 取 `runIdRef` 与当前 `pendingApproval`；
2. 同一 `request_id` 若已提交过，直接返回 `true`（不重复 POST）；
3. 先把 `pendingApproval` 置空（审批条立即消失，不可再点），再发请求；
4. 成功 → 返回 `true`，ChatPanel 显示 `已响应 · 允许一次`（4 秒后自动消失）；
5. 失败 → 清除去重标记、把**同一个** `pendingApproval` 放回（若期间没有
   新的 prompt 顶替），返回 `false`，ChatPanel `toast.error("审批响应失败，请重试")`
   并可立即重试。

防重复点击有三层：

- ChatPanel `approvalRequestRef`：请求在途时忽略再次点击（无 id 的 prompt 也覆盖）；
- `useChat.answeredApprovalIdsRef`：按 `request_id` 去重，跨组件重渲染仍有效；
- SSE 断线重连重放 `approval.request` 时，`applyEvent` 直接忽略已答过的
  `request_id`，不会把已关闭的审批条重新弹出来。

每次新 turn / 停止 / 清空 / 切换会话都会清空 `answeredApprovalIdsRef`。

## 2. Steer 接线

- 运行中且 `activeRunId` 存在、`runCapabilities.steer === true` 时
  `canSteer = true`：textarea 保持可输入，placeholder 提示“可输入补充指令”，
  发送按钮变成补充指令按钮。
- `handleSend` 在 `isStreaming` 时一律走 `handleSteer()` → `steerMessage(input)`，
  不会创建新 turn；`steerInFlightRef` 防止 Enter 连发。
- 成功：清空输入 + `toast.success("已发送补充指令")`。
- 失败：
  - HTTP **409**（后端 `run_not_accepting_steer`，`ApiError.status` 判定，
    兼容 detail 文本匹配）→ `toast.error("本轮已结束，指令未发送")`，
    同时：
    1. 仅当被 steer 的 run 仍是**当前活跃 run** 时调用 `settleEndedRun()` 收尾：
       `stoppedRef=true`、递增 `turnTokenRef`（旧 SSE 事件全部作废，旧
       `sendMessage` 不再结算状态）、abort 当前事件流、清空
       `activeRunId/pendingApproval`、`isStreaming=false`、`finishAssistant()`、
       持久化 `active_run_id=null`。若期间用户已按停止/切换会话/发了新 turn
       （runId 已变化），**不触碰**新状态，按普通错误处理，避免误杀新 turn；
    2. ChatPanel 把原文放进 `pendingResend`，等 `isStreaming` 变 false 后由
       effect 调用共享的 `submitTurn(text)`，**转为普通发送**——文字不丢失。
  - 其他错误：`toast.error("补充指令发送失败，请重试")`，输入保留可重试。
  - `reason: "unavailable"`（组件认为在运行但 runId 已被收尾）与 409 同样处理。
- `steerMessage` 返回值从 `boolean` 改为判别联合
  `ChatSteerResult = { ok: true } | { ok: false; reason: "ended" | "unavailable" | "error"; message? }`，
  调用方据 `reason` 区分“转普通发送”和“重试”。

## 3. 运行状态可见性

- 输入卡底部左侧（文件/模型控件之前）显示小标：
  `执行中 · <activeRunId>`；无 run id（旧 `/chat/stream` 回退）时显示 `执行中`。
  文本 `truncate`，`title` 给出完整 run id；`role="status"` + spinner。
- 停止按钮沿用现有实现：右侧 ■ → `stopStreaming()`，内部优先
  `POST /api/chat/runs/{id}/stop`，再 abort 本地 SSE。
- 审批等待、reattach 轮询期间 `isStreaming=true`，小标同样可见。

## 4. 能力降级

| 能力 | 为 false 时的行为 |
| --- | --- |
| `approval` | 审批条与“已响应”提示都隐藏；不报错 |
| `steer` | `canSteer=false`：运行中输入框禁用、补充指令按钮隐藏 |
| `stop` | 仅断开本地流（`stopStreaming` 原有逻辑） |
| `runs` | 走 `/chat/stream` 回退（原有逻辑） |

探测（`GET /api/chat/hermes-info`）：

- 成功：`run_submission !== false` / `run_stop === true` /
  `run_steer === true` / `run_approval_response === true` → 对应能力位；
  旧 Hermes 缺字段即 false → 相关 UI 隐藏。
- 失败（网络/403/老后端）：不再沿用乐观默认值显示审批与 steer，而是
  `configureRunCapabilities({ approval: false, steer: false })`，使两处 UI
  保持隐藏；`runs/stop` 保持乐观默认（避免整体退回非 Runs 路径）。
  整个失败路径不抛错、不 toast。

## 5. api.ts 变更

- 新增 `ApiError extends Error { status, detail }`；`request()` 对非 2xx
  抛 `ApiError`，并从 FastAPI `{detail}` / `{detail:{code,message}}` 中提取
  可读 message。这样 steer 的 409 判定基于状态码而非字符串。
- `ChatApprovalRequest` 增加可选 `tool`；`_normalizeRunEvent("approval.request")`
  解析 `tool` / `tool_name` / `name`。
- `chatRuns.steer` 返回类型补 `status?: string`。

## 6. 验证

类型检查（仓库基线本身有错误，仅比较目标文件）：

```powershell
npx tsc --noEmit -p .tsconfig.e1check.json
```

> `tsconfig.app.json` 含 `baseUrl`，本仓库 TypeScript 7 会直接报 TS5102；
> 校验时临时用去掉 `baseUrl` 的等价配置（`.tsconfig.e1check.json`，验证后已删除）。

- 改动前 baseline：`incident-timeline.tsx`、`datasources.tsx`、`knowledge.tsx`、
  `users.tsx` 共 16 条错误。
- 改动后：错误集合**完全一致**（16 条）；`ChatPanel.tsx` / `useChat.ts` /
  `api.ts` 无新增 tsc 错误。

未执行的验证（环境限制）：未启动后端/Hermes，未做浏览器 E2E；也未运行
`docker build/up/restart`。建议联调时按下列顺序手测：

1. 运行中触发需要审批的工具 → 审批条出现，四按钮各发一次，检查
   `POST /runs/{id}/approval` 的 `decision` 与 `approval_id`；快速双击只发一次。
2. 审批接口返回 500/断网 → toast + 审批条重新出现，可重试。
3. 运行中点发送 → `POST /runs/{id}/steer`；成功后输入清空、toast。
4. 运行结束瞬间再 steer → 后端 409，toast「本轮已结束，指令未发送」，
   随后原文作为新 turn 自动发出。
5. 运行中小标显示 `执行中 · run_xxx`，■ 触发 `POST /runs/{id}/stop`。
6. 模拟 `features.run_steer/run_approval_response=false`（或探测失败）:
   两处 UI 隐藏、无报错；消息渲染、附件、模式条、⌘K 不受影响。

## 7. 已知限制 / 后续

- `GET /api/chat/hermes-info` 目前是 **admin-only**。普通用户探测会 403，
  按 §4 的降级策略审批/steer 会保持隐藏。若需要普通用户可用，后续应增加
  一个非管理员可读的能力探测端点（或在后端按用户角色下发能力位）。
- 审批条固定展示四个 decision；服务端 `choices` 暂只用于归一化，不用于裁剪按钮。
- 409 转普通发送依赖 `settleEndedRun` 先作废旧 turn 的 token；若后端将
  “run 已结束”表达为其他状态码（当前非 409），仍会按普通错误重试，不会自动重发。
