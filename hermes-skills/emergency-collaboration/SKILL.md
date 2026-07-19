---
name: emergency-collaboration
description: 六脉应急协同 — 企业微信群协作
version: 1.0.0
author: 六脉 Team
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [AIOps, Collaboration, WeCom]
    related_skills: [rca-fault-delimitation]
    requires_toolsets: [terminal]
required_environment_variables:
  - name: WECOM_CORP_ID
    prompt: 企业微信 CorpID
    required_for: WeCom API 鉴权
  - name: WECOM_CORP_SECRET
    prompt: 企业微信自建应用 Secret
    required_for: WeCom API 鉴权
  - name: WECOM_AGENT_ID
    prompt: 企业微信自建应用 AgentID
    required_for: 创建群聊和发送消息
  - name: WECOM_BOT_ID
    prompt: 企业微信 Bot ID（WEBHOOK）
    required_for: 群内消息接收和 @bot 交互
  - name: WECOM_SECRET
    prompt: 企业微信 Bot Secret
    required_for: 群内消息接收和 @bot 交互
---

# 应急协同 — 企业微信群协作

六脉平台的应急协同技能。当 RCA 会话启动时自动创建企业微信群聊（作战室），
将调查进度实时推送至群内，并监听群成员的 @bot 反馈，实现人与 Agent 的双向协作。

## When to Use

触发条件：

1. **自动触发**：RCA 会话启动时，此技能与 `rca-fault-delimitation` 同时激活。
2. **手动触发**：运维人员在现有事件中发起协同请求。

## Procedure

### Step 1: 接收 RCA 会话上下文

从 RCA 技能获取初始上下文，包含：

- `session_id` — Hermes Agent 会话 ID
- `incident_id` — 事件 ID（如有）
- `service` — 影响服务
- `severity` — 告警级别
- `time_window` — 分析时间窗口
- `alert_detail` — 原始告警详情（JSON）

### Step 2: 创建企业微信作战室群组

调用 WeCom 自建应用 API 创建一个专属群聊：

```bash
python ${HERMES_SKILL_DIR}/scripts/wecom_group.py create \
  --name "故障定界-#${INCIDENT_ID}-${SERVICE}" \
  --members userid1,userid2,userid3
```

成功创建后记录 `chat_id`，所有后续操作使用此 ID。

### Step 3: 发送初始事件简报

```bash
python ${HERMES_SKILL_DIR}/scripts/wecom_group.py send \
  --chat-id <CHAT_ID> \
  --step "initial_brief" \
  --status "investigating" \
  --detail "$(cat incident_brief.json)"
```

简报内容包含：

- 事件时间及影响范围
- 涉及的服务和资源
- 当前状态：**调查中**（investigating）
- 预计后续步骤

### Step 4: 流式推送调查进度

RCA 每完成一个分析步骤，向群内推送一条 Markdown 消息：

```bash
python ${HERMES_SKILL_DIR}/scripts/wecom_group.py send \
  --chat-id <CHAT_ID> \
  --step "query_monitoring" \
  --status "completed" \
  --detail "..."
```

进度推送步骤：

| 步骤 | 触发时机 | 消息内容 |
|------|----------|----------|
| `query_monitoring` | 监控指标查询完成 | 指标异常概览 + 异常评分 |
| `query_logs` | 日志查询完成 | 错误分布 + Top 错误模式 |
| `query_clickhouse` | 事务查询完成 | 调用量/延迟/错误率变化 |
| `correlation` | 跨源关联完成 | 关键发现摘要 |
| `completed` | RCA 定界完成 | 最终根因报告 |

每条消息包含状态指示：

- `investigating` — 黄色：正在调查
- `completed` — 绿色：步骤完成
- `failed` — 红色：步骤异常
- `needs_input` — 蓝色：需要人工介入

### Step 5: 监听 @bot 反馈

群成员可以通过 @mention Agent Bot 的方式提交人工发现：

```
@六脉机器人 我们刚刚重启了 db-01，看起来内存泄漏了
@六脉机器人 trace_id=trace-abc-123 的请求来自老版本客户端
```

技能监听 Markdown 消息中的 @bot 提及，通过 `parse_bot_mention` 提取结构化内容：

```bash
python ${HERMES_SKILL_DIR}/scripts/wecom_group.py parse \
  --message "@六脉机器人 我们刚刚重启了 db-01，看起来内存泄漏了"
```

提取的发现将注入到 RCA 上下文，影响后续分析步骤。

### Step 6: 发送最终定界报告

RCA 完成后，向群内推送最终根因分析总结：

```bash
python ${HERMES_SKILL_DIR}/scripts/wecom_group.py send \
  --chat-id <CHAT_ID> \
  --step "completed" \
  --status "completed" \
  --detail "$(cat rca_result.json)"
```

最终报告包含：

- 根因（root_cause）
- 置信度（confidence）及证据链
- 影响服务列表
- 推荐操作项（recommended_actions）
- 调查耗时

## Output Format

本技能本身不产生输出文件。其效果反映在企业微信群聊中：
群内会收到从 initial_brief 到 completed 的完整消息序列。

## Pitfalls

1. **API 限频**：企业微信 API 有频率限制（每分钟最多创建群聊数、发送消息数等）。
   如果短时间内多次调用，应加入退避逻辑（exponential backoff）。
2. **群成员重复**：创建群时如果传入已在群的成员 ID，API 会返回错误。建议先去重。
3. **Bot 未入群**：确保 Hermes WeCom Bot 已在群中；如果 Bot 不在群内，@bot 消息无法送达。
4. **消息截断**：Markdown 消息正文建议不超过 2048 字符，过长的内容分段发送。
5. **敏感信息**：日志和指标详情可能包含敏感数据。建议在推送到群前做脱敏处理
   （如隐藏 IP 末尾、脱敏 Trace ID）。

## Verification

确认项：

- [ ] 企业微信群创建成功，返回非空 chat_id
- [ ] 初始简报已推送至群内，成员可查看到
- [ ] RCA 各步骤进度消息按顺序到达群内
- [ ] @bot 提及消息被正确解析并提取结构化工单
- [ ] 最终定界报告已推送
- [ ] 无 API 限频错误
