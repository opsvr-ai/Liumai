# UX Copy and Content Writing Guidelines — 六脉

**Purpose:** Establish consistent voice, tone, and content patterns across all user-facing text in the 六脉 intelligent operations platform.

**Audience:** SRE / DevOps engineers managing production incidents (primary), on-call engineers (secondary), operations managers reviewing history (tertiary).

---

## 1. Voice and Tone Principles

### 1.1 Core Principles

| Principle | Description | Example |
|-----------|-------------|---------|
| **Professional** | Authoritative but not arrogant; assumes operator competence | "请确认根因分析结果" (Please confirm the RCA result) |
| **Calm** | No alarmist language even during active incidents | "当前有 3 个活跃告警" rather than "紧急！大量告警！" |
| **Concise** | Every word earns its place; operators scan under time pressure | "触发 RCA" rather than "请点击此按钮以触发根因分析流程" |
| **Chinese-primary** | Simplified Chinese as the default UI language | All labels, messages, and descriptions in Chinese |
| **English technical terms** | Standard ops terms in English where domain convention dictates | RCA, SLA, metrics, traces, logs, Hermes Agent, WeCom |

### 1.2 English Term Usage Rules

Use English for these categories — they are standard in Chinese SRE/DevOps culture and translating them would be unnatural:

- **Protocols and formats**: HTTP, gRPC, SQL, JSON, YAML
- **Platform/project names**: Hermes Agent, WeCom, ClickHouse, PostgreSQL
- **Standard concepts**: RCA (root cause analysis), SLA, SLO, RBAC, API, UI, WebSocket
- **Data types**: metrics, traces, logs, events, alerts
- **System roles**: Agent, Gateway, Adapter, Skill, Webhook

Translate everything else: "连接失败" not "Connection Failed" for buttons, "分析完成" not "Analysis Complete" for status messages.

### 1.3 What to Avoid

- **Don't** use jargon real operators wouldn't say (e.g., "模型推理管道" — "model inference pipeline" is too academic)
- **Don't** use English articles in Chinese text ("该告警匹配一个规则" should be "此告警匹配一条规则")
- **Don't** mix Chinese punctuation with English terms ("RCA结果" should be "RCA 结果" — add space between Chinese and English)

---

## 2. Button Label Conventions

### 2.1 Length Constraints

| Button Type | Max Characters | Examples |
|-------------|---------------|----------|
| **Primary action** | 4 Chinese characters | "触发RCA", "创建规则", "确认结果", "开始分析", "保存" |
| **Secondary action** | 6 Chinese characters | "查看详情", "重新分析", "导出报告", "忽略告警" |
| **Destructive action** | 6 Chinese characters | "删除规则", "停止分析", "清除历史" |
| **Tertiary / ghost** | 6 Chinese characters | "取消", "关闭", "返回", "跳过" |

### 2.2 Verb-First Convention

Every action button starts with a verb in active voice, never a noun or adjective.

| Correct | Incorrect |
|---------|-----------|
| 触发RCA | RCA触发 |
| 创建规则 | 规则创建 |
| 查看详情 | 详情查看 |
| 确认结果 | 结果确认 |
| 配置规则 | 规则配置 |

### 2.3 Button Variant Mapping

| Variant | Usage | Button Text Examples |
|---------|-------|---------------------|
| **Primary (solid)** | Main call to action, one per view | "触发RCA", "创建规则", "保存" |
| **Secondary (outline)** | Alternative actions | "取消", "返回", "跳过" |
| **Ghost** | Low-visibility toolbar actions | "筛选", "导出", "刷新" |
| **Ghost--muted** | Minimal toolbar actions (from Task 02) | "缩放", "全屏" |
| **Destructive (red)** | Irreversible actions; requires confirmation dialog | "删除规则", "停止分析" |
| **Disabled** | Action unavailable; must include tooltip explanation | Tooltip: "已达到最大并发限制 (5/5)" |

### 2.4 Disabled State Tooltip Templates

| Scenario | Tooltip Text |
|----------|-------------|
| Max concurrency reached | "已达到最大并发限制 (5/5)，请等待进行中的分析完成" |
| Insufficient permissions | "您没有执行此操作的权限，请联系管理员" |
| Missing required config | "请先完成规则配置" |
| Analysis already in progress | "该事件已有进行中的 RCA 分析" |

### 2.5 Confirmation Dialog Patterns

| Action Type | Dialog Title | Description | Button(s) |
|-------------|-------------|-------------|-----------|
| Delete rule | "确认删除规则" | "删除后无法恢复，相关的自动触发也将停止" | "取消" / "删除" (destructive) |
| Stop analysis | "确认停止分析" | "当前分析进度将丢失，已发现的证据将被保存" | "取消" / "停止分析" |
| Dismiss alert | "确认忽略告警" | "该告警将被标记为已处理，不会触发 RCA" | "取消" / "确认忽略" |

---

## 3. Error Message Hierarchy

### 3.1 Three-Part Structure

Every error message must include all three parts when space permits:

```
[Title]     — short, direct, what happened (1-8 chars)
[Description] — what went wrong and why (1-2 sentences)
[Action]    — what the user can do (linked text or button)
```

### 3.2 Error Type Examples

**Connection errors:**
```
标题: 连接失败
描述: 无法连接到 Hermes Agent，请检查网关状态和网络连接
操作: 重试 · 查看网关配置
```

**Authentication errors:**
```
标题: 认证失败
描述: WeCom API 凭证无效或已过期，消息推送已停止
操作: 更新凭证 · 联系管理员
```

**Permission errors:**
```
标题: 权限不足
描述: 您没有删除 RCA 规则的权限。仅管理员可执行此操作
操作: 联系管理员
```

**Data errors:**
```
标题: 数据加载失败
描述: 无法从 ClickHouse 查询指标数据，数据源返回超时
操作: 重试 · 检查数据源状态
```

**Validation errors (inline form):**
```
字段级别: 告警级别为必填项
字段级别: 时间范围不能超过 7 天
字段级别: 规则名称已存在，请使用其他名称
```

**Rate limit / concurrency errors:**
```
标题: 并发已达到上限
描述: 当前有 5 个进行中的 RCA 分析，已达到系统最大并发数
操作: 等待分析完成 · 调整并发限制设置
```

### 3.3 Toast/Sonner Notification Patterns

| Severity | Title | Description | Behavior |
|----------|-------|-------------|----------|
| Success | "RCA 分析完成" | "根因定位完成，详情请查看分析报告" | Auto-dismiss 5s |
| Info | "告警已接收" | "已匹配规则 #{rule_name}，RCA 即将开始" | Auto-dismiss 5s |
| Warning | "数据源返回异常" | "日志查询部分失败，分析基于可用数据进行" | Auto-dismiss 8s |
| Error (non-critical) | "发送消息失败" | "WeCom 消息推送失败，分析结果将在 UI 中查看" | Auto-dismiss 8s |
| Error (critical) | "RCA 分析失败" | "Hermes Agent 异常退出，错误代码: {code}" | Manual dismiss only |

### 3.4 Error State Icons

Use Lucide icons matching severity:
- Error: `AlertCircle` (red)
- Warning: `AlertTriangle` (amber)
- Info: `Info` (blue)
- Success: `CheckCircle` (green)

---

## 4. Loading and Waiting States

### 4.1 General Principle

NEVER use generic "加载中..." (Loading...). Always be specific about what the system is doing and, where possible, show progress.

### 4.2 Agent Investigation Phase Messages

These messages correspond to the progression of a Hermes RCA skill investigation. Each maps to a step card (see §6) with a shadcn/ui Progress bar:

```
Phase 1 — "正在准备分析环境..."
  0-10%  | 初始化分析上下文、加载数据源配置

Phase 2 — "正在分析指标数据..."
  10-40% | 查询指标基线、检测异常偏移

Phase 3 — "正在查询日志..."
  40-60% | 检索相关时间段日志、提取异常模式

Phase 4 — "正在关联追踪数据..."
  60-80% | 关联 Trace ID、构建调用链

Phase 5 — "正在生成根因分析报告..."
  80-95% | 综合多源数据、生成根因结论

Phase 6 — "分析完成 ✓"
  100%   | 根因定位完成
```

### 4.3 Session Queue Message

When max concurrent sessions (default 5) is reached:

```
"您的RCA已加入队列。当前位置: {N}，当前活跃分析: {M} 个"
```

Updated in real-time as queue position changes.

### 4.4 Long Wait Guidance

Displayed when analysis exceeds 60 seconds:

```
"分析预计需要 2-5 分钟，您可以最小化此面板并在分析完成后收到通知"
```

With action link/button: "分析完成后通知我" (Notify me when complete).

### 4.5 Data Source Loading Patterns

| Context | Message | Icon |
|---------|---------|------|
| Loading rule list | "正在加载规则列表..." | `Loader2` |
| Loading history | "正在加载 RCA 历史记录..." | `Loader2` |
| Loading analytics | "正在加载仪表盘数据..." | `Loader2` |
| Loading alert feed | "正在获取最新告警..." | `Loader2` |
| Connecting to Hermes | "正在连接 Hermes Agent..." | `Loader2` |

### 4.6 Skeleton Placeholder Pattern

For initial page loads, use shadcn/ui Skeleton components rather than text messages. Reserve text loading messages for agent investigation steps and data-fetching operations that take >3 seconds.

---

## 5. Empty State Patterns

### 5.1 Empty State Structure

Each empty state has:
1. Illustration area (Lucide icon or simple graphic, 48-64px)
2. Title (short, descriptive)
3. Description (what this area is for, why it's empty)
4. Action button (what to do next)

### 5.2 Scenario: No RCA History

```
图标: ClipboardList (或 History)
标题: 暂无 RCA 记录
描述: 当告警触发 RCA 或您手动发起根因分析后，分析记录将显示在此处
按钮: 手动触发 RCA
```

### 5.3 Scenario: No Alerts Matching Rules

```
图标: BellOff (或 Shield)
标题: 暂无匹配告警
描述: 当前没有满足规则条件的告警。您可以调整触发规则或检查告警源状态
按钮: 配置规则
```

### 5.4 Scenario: No Search Results

```
图标: SearchX
标题: 未找到匹配结果
描述: 未找到与 "{query}" 匹配的记录。请尝试不同的搜索关键词或调整筛选条件
按钮: 清除筛选
```

### 5.5 Scenario: No Rules Configured

```
图标: FileCog
标题: 尚未配置规则
描述: 告警触发规则为空。配置规则后，符合条件的告警将自动触发 RCA 分析
按钮: 创建规则
```

### 5.6 Scenario: No Active Incidents

```
图标: CheckCircle2
标题: 当前无活跃告警
描述: 系统运行正常，暂无需要关注的告警或进行分析中的 RCA
按钮: 查看历史记录
```

### 5.7 Empty State Button Rules

- The action button should navigate the operator to the most relevant configuration or action screen.
- Secondary link: "了解更多" (Learn more) linking to contextual help if applicable.
- Empty states for filtered views (after user has applied filters) should always include a "清除筛选" (Clear Filters) action.

---

## 6. Agent Investigation Step Copy Templates

### 6.1 Step Card Structure

Each investigation step is rendered as a card in the agent progress stream (consistent with Task 04 motion patterns):

```
┌─────────────────────────────────────────────┐
│ [icon] 正在分析: {data_source}    {progress} │
│                                             │
│ {status_message}                            │
│                                             │
│ [progress bar: ████████░░░░ 65%]            │
└─────────────────────────────────────────────┘
```

### 6.2 Step Templates by State

**Running state:**
```
图标: Loader2 (rotating)
标题: 正在分析: {data_source}
状态: {具体描述当前操作}
进度: Progress bar with percentage
```

Templates by data source:

| Data Source | Running Message |
|-------------|-----------------|
| Metrics | "正在分析指标数据 — 对比历史基线中..." |
| Logs | "正在查询日志 — 检索异常模式..." |
| Traces | "正在关联追踪数据 — 构建调用链..." |
| Topology | "正在分析服务拓扑 — 计算影响范围..." |
| Report | "正在生成根因分析报告..." |

**Completed state:**
```
图标: CheckCircle (green)
标题: [{data_source}] 分析完成
状态摘要: 发现 {N} 个异常 · 耗时 {duration}
证据摘要行: "异常指标: {metric_name} 在 {time} 偏离基线 {percentage}%"
```

Templates by data source:

| Data Source | Completed Message |
|-------------|-------------------|
| Metrics | "发现 {N} 个异常指标" |
| Logs | "发现 {N} 条异常日志" |
| Traces | "追踪到 {N} 条异常路径" |
| Topology | "影响范围: {N} 个服务" |

**Failed state:**
```
图标: XCircle (red)
标题: [{data_source}] 分析失败
原因: {具体错误信息}
操作: 重试 · 查看详情
```

| Failure Scenario | Error Message |
|-----------------|---------------|
| Connection timeout | "数据源连接超时，请检查 {source_name} 状态" |
| No data available | "查询时间段内无可用数据" |
| Authentication error | "数据源认证失败，请联系管理员更新凭证" |
| Unknown error | "未知错误，错误代码: {code}" |

### 6.3 Evidence Discovery Templates

When the agent finds specific evidence during investigation, push an additional card:

```
"发现异常指标: {metric_name} 在 {time} 时偏离基线 {percentage}%"
"发现异常日志: {service_name} 出现 {error_count} 次 {error_type}"
"发现调用链异常: {trace_id} 延迟 {latency}ms (基线 {baseline}ms)"
```

### 6.4 Root Cause Summary Final Message

```
┌─────────────────────────────────────────────┐
│ ✅ RCA 分析完成                              │
│                                             │
│ 根因: {service_name} → {component}          │
│ 类型: {issue_type}                          │
│ 置信度: {confidence_level} (高/中/低)        │
│ 耗时: {duration}                            │
│                                             │
│ 影响范围: {impact_scope}                     │
│                                             │
│ [查看详细报告] [确认结果] [提出异议]          │
└─────────────────────────────────────────────┘
```

Confidence level labels:
- 高 (High) > 80% confidence
- 中 (Medium) 50-80% confidence
- 低 (Low) < 50% confidence — should include human verification prompt

### 6.5 WeCom Group Streaming Copy

Same content as above, adapted for WeCom markdown:

```
**🔍 Hermes Agent 分析进度**

[步骤 1/5] ✅ 指标分析完成
→ 发现 CPU 使用率异常: MySQL 节点在 14:32 偏离基线 45%

[步骤 2/5] ⏳ 日志查询中...
→ 正在检索 14:00-15:00 时间段的应用日志

[步骤 3/5] ⏳ 追踪数据关联中...
→ 正在等待...

---

*预计剩余时间: 2-3 分钟*
*分析完成后将自动通知本群*
```

---

## 7. Agent Latency UX Copy

### 7.1 The Three Time Thresholds

Agent RCA investigation typically takes 3-30 minutes. UX copy changes at three thresholds to manage operator expectations.

#### Threshold 1: Immediate (0-30s)

Displayed the moment the operator triggers RCA:

```
标题: 正在准备分析环境...
描述: 正在初始化 Hermes Agent 会话、加载数据源配置
预计耗时: 2-5 分钟
行为: Show progress stream immediately with first step running
```

Side panel or modal shows the investigation step stream (§6) from second 0, so the operator sees immediate confirmation that the process started.

#### Threshold 2: At 30 Seconds

If no step has completed after 30 seconds:

```
更新状态: 数据源连接中 — 请稍候
说明: 首次查询可能需要额外时间初始化数据源连接池
选项: [分析完成后通知我]
```

If the first step is still running at 30s, leave the stream visible but add a helper note beneath the progress bar.

#### Threshold 3: At 2 Minutes

If still in progress after 2 minutes:

```
更新状态: 分析仍在进行中
说明: 根因定位通常需要 3-5 分钟，复杂场景可能需要更长时间
选项: [分析完成后通知我] [最小化面板]
```

At this threshold, show the "estimated time remaining" badge if determinable from current progress.

### 7.2 Notification Preference Pattern

```
"分析完成后通知我" (Notify me when complete)
```

- Implemented as a toggle or single-click button
- When enabled, shows: "分析完成后将通过 {notification_method} 通知您"
- Notification methods: WeCom bot message, in-app notification, or both
- Toggle state persists for the current analysis session

### 7.3 Queue Position and Wait Time

When the operator triggers RCA but the concurrency limit is reached:

```
立即显示:
  标题: 您的 RCA 已加入队列
  描述: 当前有 {M} 个活跃分析正在进行中
  队列位置: 第 {N} 位
  预计等待: ~{estimated_minutes} 分钟

当队列前进时:
  标题: 队列位置更新
  描述: 您现在排在队列第 {N} 位
  更新: 实时刷新位置编号

当轮到该任务时:
  标题: 您的 RCA 即将开始
  描述: 分析环境正在准备中，请稍候
```

### 7.4 WeCom Notification Templates

When operator chooses to be notified:

```
**分析完成通知** 🔔

您触发的 RCA 分析已完成。

根因: {service_name} → {component}
类型: {issue_type}
耗时: {duration}

[点击查看详细报告]({platform_url})
```

### 7.5 Long Analysis Feedback

If analysis exceeds 5 minutes (above typical range):

```
提示: 分析超过预期时间
说明: 当前分析所需时间超出常规范围，可能原因:
     - 数据源查询响应缓慢
     - 分析范围较大（时间窗口较长）
     - 多个异常事件同时发生
操作: [查看当前进度] [联系技术支持]
```

---

## 8. Form Field Labels and Validation Copy

### 8.1 Standard Form Field Label Templates

| Field | Label | Placeholder |
|-------|-------|-------------|
| Rule name | "规则名称" | "例如：生产环境关键告警" |
| Alert severity | "告警级别" | "选择告警级别" |
| Service name | "服务名称" | "输入服务名称或选择" |
| Time window | "时间窗口" | "例如：最近 30 分钟" |
| Data source | "数据源" | "选择数据源类型" |
| Notification channel | "通知渠道" | "WeCom 群聊" |
| Max concurrency | "最大并发数" | "默认: 5" |
| RCA skill | "RCA 技能" | "选择分析技能" |
| Trigger condition | "触发条件" | "例如：severity >= warning" |

### 8.2 Inline Validation Messages

| Context | Error | Success |
|---------|-------|---------|
| Required field | "{field_name} 为必填项" | — |
| Name uniqueness | "规则名称已存在" | "名称可用" |
| Time range | "时间范围不能超过 7 天" | — |
| Invalid format | "格式不正确，请输入有效值" | — |
| Character limit | "最多输入 {N} 个字符" | — |
| Number range | "请输入 {min}-{max} 之间的数值" | — |
| Conditional required | "选择当前数据源后，此项为必填" | — |

### 8.3 Form Submission Feedback

| State | Message |
|-------|---------|
| Saving | "正在保存..." |
| Save success | "保存成功 ✓" |
| Save failed | "保存失败: {error_message}" |
| Discard confirmation | "有未保存的更改，确定要放弃吗？" |

---

## 9. Notification and Toast Copy Cheat Sheet

| Scenario | Title | Description | Type |
|----------|-------|-------------|------|
| RCA triggered | "RCA 已触发" | "正在分析 {time_window} 时间窗口内的数据" | Info |
| RCA complete | "RCA 分析完成" | "根因定位完成，请查看分析报告" | Success |
| RCA failed | "RCA 分析失败" | "{reason}" | Error |
| WeCom group created | "应急群已创建" | "WeCom 应急协同群已建立，成员已加入" | Success |
| Alert matched rule | "告警匹配规则" | "告警 {alert_name} 匹配规则 {rule_name}，RCA 即将开始" | Info |
| @bot feedback received | "收到人工反馈" | "{user} 提交了手动分析发现" | Info |
| Rule saved | "规则保存成功" | "规则 {rule_name} 已生效" | Success |
| Rule deleted | "规则已删除" | "规则 {rule_name} 已删除，关联的自动触发将停止" | Warning |
| Permission change | "权限已更新" | "{user} 的角色已更新为 {role}" | Info |
| Configuration updated | "配置已更新" | "系统配置已修改并生效" | Success |
| Data source offline | "数据源离线" | "{source_name} 连接断开，部分功能可能不可用" | Error |
| Session expired | "会话已过期" | "请重新登录" | Error |

---

## 10. Quick Reference: Copy Consistency Checklist

Use when writing new UI copy:

- [ ] Primary button: verb-first, max 4 Chinese characters?
- [ ] Secondary button: verb-first, max 6 Chinese characters?
- [ ] Destructive action: red button + confirmation dialog?
- [ ] Error has all 3 parts (title + description + action)?
- [ ] Loading state says WHAT is happening, not just "Loading"?
- [ ] Empty state has action button, not just description?
- [ ] English technical terms used where standard, translated elsewhere?
- [ ] Chinese + English separated by spaces (e.g., "触发 RCA")?
- [ ] No alarmist or exaggerated language?
- [ ] Status conveyed by text/icon, not color alone?
- [ ] Disabled button has tooltip explaining why?

---

*This document is part of the 六脉 design system. For implementation questions, refer to the corresponding shadcn/ui components and Tailwind v4 token system defined in `src/styles/globals.css`.*
