# 多通道通知 + 非 Runs 回退路径的 steer 等价能力

> 范围：`backend/app/services/notify.py`（新增）、`backend/app/services/rca_runner.py`、
> `src/pages/alerts.tsx`。`backend/app/services/alert_pipeline.py` 只读，未改动。

## 1. 多通道通知（Task A）

### 1.1 统一入口

`backend/app/services/notify.py::send_notification(policy, title, markdown, links, *, session_id=None)`

- 读取 `policy.notify.channels`（数组，默认 `["wecom"]`），逐通道顺序发送；
- 每个通道独立 `try/except`，失败只记一条 `warning`，不影响其它通道，也不抛给 RCA；
- `policy.notify.enabled` 显式为假时整体静默跳过（保持原有静默跳过语义）；
  `enabled` 缺失时视为启用（显式配置了通道即有意发送）；
- 返回 `[{channel, status, detail}]`，便于日志/调试；未配置的通道返回 `skipped`。

### 1.2 通道实现

| 通道 | 行为 |
| --- | --- |
| `wecom` | 复用 `app.services.wecom.WeComClient().send_message(chat_id, content, msg_type="markdown")`；chat_id 缺失、`WECOM_CORP_ID/SECRET` 未配置或仍是 `your_*` 模板值时静默跳过；15s 超时 |
| `webhook` | `POST policy.notify.webhook_url`，body `{title, markdown, links, session_id, ts}`，5s 超时；非 2xx / 连接失败记 warning；URL 非 http(s) 跳过 |
| `email` | 标准库 `smtplib`，纯文本 + HTML（简单 markdown→HTML）；SMTP 或收件人未配置时静默跳过（仅 debug 日志） |

Webhook 的 `links` 统一成 `[{"label","url"}]`；`ts` 为 UTC ISO8601。
`PUBLIC_BASE_URL` / `RCA_PUBLIC_BASE_URL` 的链接生成逻辑原样保留，开始/完成/失败
三处通知的 Markdown 文案与链接未变（额外把同样的链接以结构化 `links` 传给
Webhook/邮件）。

### 1.3 邮件 SMTP 配置（环境变量，敏感项不入库）

```
SMTP_HOST=10.0.0.25          # 必填
SMTP_PORT=465                # 可选，默认 465(SSL) / 587(STARTTLS)
SMTP_USER=alert@example.com  # 必填
SMTP_PASS=******             # 必填（也接受 SMTP_PASSWORD）
SMTP_FROM=alert@example.com  # 可选，默认 = SMTP_USER
SMTP_TO=oncall@example.com   # 收件人兜底（策略里 notify.email_to 优先）
SMTP_SSL=true / SMTP_TLS=true  # 可选；端口 465 自动走 SSL
```

策略里的 `notify.email_to` 支持数组或逗号/分号/换行分隔字符串，最多 50 个。
SMTP 主机/账号/密码/收件人任一缺失 → 邮件通道静默跳过。

### 1.4 策略持久化的兼容处理（未改 alert_pipeline.py）

`save_policy` 会在写库前剥离 `notify` 对象，只把 `notify.enabled` /
`notify.wecom_chat_id` 落到 `system_config`。为了让 Webhook URL / 收件人 /
通道数组也能保存，前端 **额外写一个根级 `notify_ext`**（会被策略 JSON 的通用
深合并保留）；`notify.py` 解析顺序为 `policy.notify.*` → `policy.notify_ext.*`。
因此 `{"notify": {"channels": [...]}}` 这种直接调用/测试写法依然有效。

### 1.5 前端（alerts.tsx「触发策略」卡片）

新增「通知通道」区块：

- 渠道多选：企业微信 / Webhook / 邮件（未选择时回退默认企业微信）；
- 企业微信 chat_id 输入（仅选中企微时显示，保持原字段兼容）；
- Webhook URL 输入（选中 webhook 时显示，空地址给出黄色提示）；
- 邮件收件人 textarea（逗号/换行分隔），并说明 SMTP 相关敏感项用环境变量；
- 复用 `alertsApi.policy()` / `alertsApi.savePolicy()`，**未新增 api.ts 方法**；
- 本地类型 `AlertPolicyExt` 扩展 `notify` 并携带 `notify_ext`；加载时
  `normalizePolicy()` 归一化，保存时 `toPolicyPayload()` 同时回写兼容字段与
  `notify_ext`。

## 2. 非 Runs 回退路径的实时 steer 等价能力（Task B）

### 2.1 旧行为

非 Runs 回退路径没有 `steer_run`：`_watch_coalesced_alerts` 只写一条时间线提示
「当前执行路径不支持中途 steer 注入……如需完整覆盖请重跑」，随后结束。

### 2.2 新行为

1. 监听协程仍把分析期并入的告警写入 `state["late_alerts"]`；
2. **没有 steer 能力时**（`state["steer"]` 不存在 / 非回退路径不会出现）额外写入
   `state["pending_late_alerts"]`，时间线文案改为「已记为待补充告警，本次分析
   完成后将自动创建补充分析会话」；steer 成功的告警记入 `state["steered_ids"]`；
3. 成功分支收尾时做一次兜底扫描：`实际附着告警 − 分析开始时的告警 − 已成功
   steer 的告警 = 待补充告警`。这样即使监听协程 15s 轮询还没跑到最后一刻并入的
   告警，也不会漏建 followup；
4. 仅在**成功分支**（报告/知识库/审计落库之后）创建补充会话，失败/超时/取消
   都不会创建；创建失败也只 warning（独立事务），不影响本次已完成的分析。

### 2.3 补充会话字段

- `service_name`：与父会话相同；
- `time_window_start/end`：late alerts 的 `min(alert_time)` ~ `max(alert_time)`；
- `trigger_reason`：`followup:{parent_id}`；
- `alert_count`：late 告警条数；
- `status=QUEUED`；`trigger_type` / `rule_id` 继承父会话；
- 通过 `asyncio.create_task(run_rca_session(id))` 入队（强引用保存在
  `_BACKGROUND_TASKS`），与 webhook 触发共用同一并发闸门与执行器。

### 2.4 告警归属

`alerts.rca_session_id` 会从父会话改挂到补充会话，使 runner 原有的
`SELECT ... WHERE rca_session_id = ?` 直接把这些告警喂给 Hermes（无需改表结构）。
父会话保留已落库的报告与 `alert_count` 快照；父时间线追加
`rca_followup_created` 事件，补充会话追加 `rca_followup` 起始事件并写审计
「RCA补充分析」。

### 2.5 防递归

`_is_followup_session(session)` 判断 `trigger_reason` 是否以 `followup:` 开头；
补充会话即使再次遇到 late alerts 也不会再创建 followup。

### 2.6 与 Runs 路径的关系

- Runs API 正常且 steer 成功：`steered_ids` 覆盖这些告警，不建 followup；
- Runs API 调用中途 steer 失败 / 监听没来得及处理：兜底扫描会把这些告警纳入
  补充会话（属于「实时 steer 等价能力」的超集，行为更可靠）。

## 3. 验证

```powershell
python -m py_compile backend/app/services/notify.py backend/app/services/rca_runner.py
# 前端（仓库 tsconfig 的 baseUrl 与 TS7 不兼容，临时配置等价于 tsconfig.app.json）
node node_modules/typescript/bin/tsc -p tsconfig.check.tmp.json --noEmit
```

- `py_compile` 通过；`notify.py` ruff 无告警。
- `rca_runner.py` 的 3 条 ruff F401（`User`、`DEFAULT_POLICY`、`_deep_merge`）
  为改动前既有问题，未新增。
- 前端 tsc：`src/pages/alerts.tsx` 无错误；仓库其它文件存在改动前既有错误
  （dashboard-shell / datasources / knowledge / users 等），与本次无关。
- 已用假 DB / 真实 `send_notification` 做过行为验证：webhook 不可达时只 warning、
  邮件未配置静默跳过、企微未配置静默跳过；followup 会话字段与告警改挂正确、
  `followup:` 前缀下不再递归创建。

## 4. 运维注意

- 若要只用 Webhook/邮件，记得在 UI 勾选对应通道并保持「启用通知」打开；
- Webhook 接收端需在 5s 内响应，否则记 warning（不影响 RCA）；
- 邮件通道依赖出网 SMTP；内网 relay 若不需要认证，目前按需求仍要求配置
  `SMTP_USER/SMTP_PASS`；
- followup 会话与普通会话一样占用并发槽位；父会话结束后才真正开始跑。
