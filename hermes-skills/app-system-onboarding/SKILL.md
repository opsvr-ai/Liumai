---
name: app-system-onboarding
description: 六脉应用系统知识采集 — 交互式访谈引导用户构建系统档案
version: 1.0.0
author: 六脉 Team
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [AIOps, Knowledge, Onboarding, mem0]
    related_skills: [rca-fault-delimitation]
    requires_toolsets: [mem0]
    config:
      - key: onboarding.max_turns_per_step
        description: 每个访谈步骤的最大对话轮次
        default: 5
        prompt: 单步最大对话轮次
      - key: onboarding.profile_template
        description: 系统档案模板（Markdown）
        default: |
          # 系统档案: {name}
          ## 元信息
          - 业务层级: {tier}
          - 负责团队: {team}
          - Owner: {owner}
          - SLA目标: {sla}
          ## 架构概览
          {architecture}
          ## 组件清单
          {components}
          ## 依赖拓扑
          {dependencies}
          ## 监控与告警
          {monitoring}
          ## 历史故障
          {incidents}
          ## 运维手册
          {runbooks}
        prompt: 系统档案 Markdown 模板，使用 {field} 占位符
required_environment_variables:
  - name: MEM0_API_URL
    prompt: mem0 API 地址
    required_for: 写入和检索系统知识记忆
  - name: MEM0_API_KEY
    prompt: mem0 API Key
    required_for: 写入和检索系统知识记忆
---

# 应用系统知识采集 — 交互式访谈

六脉平台的应用系统知识采集技能。通过 AI 主导的渐进式访谈，引导用户逐步描述应用系统的架构、组件、依赖和运维知识，实时生成结构化 Markdown 档案，最终写入 mem0 记忆系统供 RCA 等场景检索使用。

## When to Use

**触发方式：**

1. **平台触发**：用户在六脉平台点击「新建系统档案」，平台以 `mode_slug: "app-system-onboarding"` 发起对话
2. **更新触发**：用户在已有系统档案上点击「继续访谈」或「更新知识」，以 `mode_slug: "app-system-update"` 发起对话

## Core Principles

### 访谈行为准则

- **渐进式，不追根究底** — 用户说多少就生成多少，不强迫填满所有字段。用户回复"不太清楚"或"先跳过"时，礼貌地进入下一步
- **多模态输入接受** — 用户可以用简短描述、粘贴文档片段、URL 链接来回答问题。遇到粘贴的大段文档时，主动提取关键信息并确认
- **即时反馈** — 每个回答后立即更新档案草稿，通过 `tool_call` 事件将最新 Markdown 回传给平台前端渲染
- **可中断可续** — 每一步都保存进度到 mem0（`category: "system_profile_draft"`），用户中断后可从上次位置继续
- **确认后归档** — 所有步骤完成后展示完整档案，用户确认后才写入正式的系统记忆

### 档案生成原则

- 档案是**结构化 Markdown 文档**，自然语言可读，也适合语义检索
- 每个系统生成一份完整档案，内容拆分为多条 mem0 记忆（按章节拆分，便于精准检索）
- 档案内容应该精确、具体、可操作 — 避免"视情况而定"式的模糊表述

## Procedure

### Step 1: 基本信息采集

**目标：** 建立系统的基本身份信息。

**开场白：**
> 你好！我来帮你建立应用系统档案，让智能体更好地理解你的系统。我们一步一步来——先告诉我，这个系统叫什么名字？它在业务中扮演什么角色？

**提问清单（逐项引导，不一次性抛出）：**

1. 系统名称 — "这个系统叫什么？比如「订单系统」「支付网关」"
2. 业务定位 — "它在业务链路中处于什么位置？一句话描述它的核心职责"
3. 业务层级 — "如果按重要性分级：L0（核心，挂了业务中断）、L1（重要，影响体验）、L2（一般，可降级），它属于哪一级？"
4. 负责团队 — "哪个团队或谁负责这个系统的运维？"
5. SLA 目标 — "有没有明确的 SLA 目标？比如可用性 99.9%、P99 延迟 < 200ms"

**每完成一个子项，立即更新预览。**

**进度保存：** 本步完成后，调用 mem0 写入草稿：

```
记忆类别: system_profile_draft
标题: {system_name} — 基本信息
内容: 包含名称、定位、层级、团队、SLA 的结构化摘要
```

### Step 2: 组件梳理

**目标：** 识别构成系统的所有技术组件。

**开场白：**
> 了解了。那 {system_name} 由哪些技术组件构成？比如微服务、数据库、缓存、消息队列……可以一个一个说，也可以一起列出来。

**对于每个组件，追问关键信息：**

1. 组件名称和类型（service / database / cache / message-queue / gateway / cronjob / storage）
2. 技术栈 — "用什么语言/框架/版本？比如 Go 1.21、PostgreSQL 14"
3. 部署方式 — "K8s Deployment？StatefulSet？物理机？"
4. 副本数/集群规模 — "几个副本？有没有主从？"
5. 关键配置 — "有没有重要的配置参数？比如连接池大小、超时时间、JVM 堆内存"
6. 健康检查端点 — "有没有健康检查接口？比如 GET /healthz"

**示例对话：**

> 🤖: "那它有哪些组件？"
>
> 👤: "order-api 是 Go 服务跑在 K8s 上，3 副本。order-db 是 PostgreSQL 14 主从。还有一个 Redis 做缓存，Kafka 做异步消息。"
>
> 🤖: "好的，先记下这四个组件。order-api 有没有什么关键配置我想了解的？比如连接池大小、超时设置？"

**进度保存：** 生成组件清单 Markdown 片段，写入 mem0 草稿。

### Step 3: 依赖关系梳理

**目标：** 绘制组件间的依赖拓扑，标注强弱关系。

**开场白：**
> 组件清楚了。接下来是最关键的部分——它们之间怎么协作？哪些是**强依赖**（断了整个链路就挂了），哪些是**弱依赖**（可以降级或异步重试）？

**对于每对依赖关系，追问：**

1. 调用方向 — "A → B"（A 依赖 B）
2. 强弱类型 — 强依赖（同步、不可降级）/ 弱依赖（异步、可降级、可重试）
3. 通信协议 — HTTP / gRPC / Kafka / Redis PubSub / 数据库直连
4. 降级策略 — "如果这个依赖挂了，调用方怎么做？有降级方案吗？"

**示例对话：**

> 🤖: "order-api 依赖哪些下游？"
>
> 👤: "order-api 强依赖 order-db，走直连。异步发消息到 Kafka 给下游消费。调 user-api 的 gRPC 查用户信息，但挂了可以用缓存。"
>
> 🤖: "明白了。我记下：
> - order-api → order-db: 强依赖，同步直连，不可降级
> - order-api → Kafka: 异步，可重试
> - order-api → user-api: 弱依赖，gRPC，降级用本地缓存
> 这样对吗？"
>
> 👤: "对。"

**进度保存：** 生成依赖拓扑 Markdown 表格，写入 mem0 草稿。

### Step 4: 监控与告警关联

**目标：** 关联现有的监控指标、告警规则和数据源。

**提问：**

1. "有哪些关键监控指标？比如 QPS、延迟、错误率、成功率"
2. "在平台上有没有对应的告警规则？告诉我规则名或 ID，我帮你关联"
3. "有没有配置 Prometheus/Grafana 数据源？也一起关联上"
4. "平时看哪些监控面板？有没有链接可以记下来？"

**进度保存：** 生成监控章节，记录关键指标和资源关联清单。

### Step 5: 历史故障与运维经验

**目标：** 记录过去的故障案例和已知的修复方案。

**开场白：**
> （可选步骤）过去出过什么印象深刻的故障吗？或者有什么运维要点想记录下来？这些经验会成为智能体做 RCA 时的重要参考。不确定的话可以跳过，以后随时补充。

**引导要点：**

- "什么时间发生的？什么症状？根因是什么？怎么修复的？"
- "有没有固定的运维操作流程？比如怎么扩容、怎么回滚、怎么降级？"

**进度保存：** 生成历史故障和运维手册章节，写入 mem0 草稿。

### Step 6: 预览确认与归档

**目标：** 展示完整档案，用户确认后正式写入系统记忆。

**操作：**

1. 合并所有章节生成完整 Markdown
2. 展示给用户预览
3. 提示: "这是完整的系统档案。你可以直接编辑任何部分，比如告诉我「把第三段改成...」"
4. 用户确认后，执行最终归档：

**最终归档流程：**

1. 将完整档案按章节拆分为多条 mem0 记忆：

```
记忆 1 — 元信息:
  category: system_profile
  system: {system_name}
  section: metadata
  content: "# {system_name} — 元信息\n- 业务层级: {tier}\n- 负责团队: {team}..."

记忆 2 — 组件清单:
  category: system_profile
  system: {system_name}
  section: components
  content: "# {system_name} — 组件清单\n## order-api\n..."

记忆 3 — 依赖拓扑:
  category: system_profile
  system: {system_name}
  section: dependencies
  content: "# {system_name} — 依赖拓扑\n| 调用方 | 被调用方 | 强度 | 协议 |..."

记忆 4 — 监控告警:
  category: system_profile
  system: {system_name}
  section: monitoring
  content: "# {system_name} — 监控与告警\n..."

记忆 5 — 历史故障:
  category: system_profile
  system: {system_name}
  section: incidents
  content: "# {system_name} — 历史故障\n..."

记忆 6 — 运维手册:
  category: system_profile
  system: {system_name}
  section: runbooks
  content: "# {system_name} — 运维手册\n..."
```

2. 返回完成消息，包含：
   - 系统名称和档案摘要
   - mem0 记忆写入数量
   - 平台应创建的索引记录提示
3. 清理草稿记忆

## Output Format

### SSE tool_call 事件（实时回传）

访谈过程中，每步完成时通过 SSE `tool_call` 事件回传实时预览：

```json
{
  "tool": "update_system_profile_preview",
  "input": {
    "step": 2,
    "step_label": "组件清单",
    "progress": "2/6",
    "markdown_preview": "## 系统档案: 订单系统\n\n### 组件清单\n- **order-api** (Go 微服务, K8s Deployment, 3 副本)...\n",
    "system_name": "订单系统",
    "can_skip": false,
    "next_step_prompt": "这些组件之间的依赖关系是怎样的？"
  }
}
```

### 最终输出（归档完成后）

```json
{
  "status": "archived",
  "system_name": "订单系统",
  "tier": "L0",
  "sections_completed": 6,
  "mem0_memory_count": 6,
  "mem0_memory_ids": ["mem_001", "mem_002", "..."],
  "profile_preview": "完整的 Markdown 档案文本...",
  "platform_action": {
    "action": "create_index",
    "endpoint": "POST /api/systems",
    "payload": {
      "name": "订单系统",
      "tier": "L0",
      "description": "承接用户下单到履约全流程"
    }
  }
}
```

## Pitfalls

1. **用户回答过于简略** — 如果用户连续以"嗯""好的""不知道"回应，不要反复追问同一问题。用更具体的引导方式帮助用户："比如你可以从数据库开始说起"
2. **大段粘贴文本** — 用户可能粘贴整篇架构文档。此时应提取关键信息并逐项确认，而不是直接丢弃或全盘接受
3. **同名系统覆盖** — 归档前检查是否已有同名系统档案。如有，提示用户是否覆盖更新
4. **mem0 写入失败** — 归档时如果 mem0 部分写入失败，应标记哪些成功了哪些失败了，允许重试。不要静默失败
5. **依赖循环** — 用户描述的依赖关系中可能隐式包含循环。主动检测并提醒用户确认："order-api 依赖 user-api, user-api 也依赖 order-api —— 这是有意设计的，还是我理解有误？"
6. **信息不一致** — Step 2 提到某个组件但 Step 3 没涉及它的依赖关系时，主动追问："之前提到的 Redis 缓存，它被哪些组件使用？"

## Verification

确认项：

- [ ] 每个步骤完成后，SSE 回传了正确的 `update_system_profile_preview` tool_call 事件
- [ ] 草稿在每一步结束时成功保存到 mem0（category: system_profile_draft）
- [ ] 完整档案按章节拆分为独立 mem0 记忆（元信息、组件、依赖、监控、故障、手册各一条）
- [ ] 每条记忆包含正确的 system、section 等元数据
- [ ] 归档后草稿被清理
- [ ] 最终输出包含 platform_action，指示平台创建索引记录
- [ ] 用户可随时中断并续访（通过读取草稿记忆恢复进度）
- [ ] 同名系统存在时提示用户确认覆盖

---

# 应用系统知识更新 — 增量更新

## When to Use

**触发方式：** 用户在已有系统档案上点击「继续访谈」或「更新知识」

## Procedure

### Step 1: 加载现有档案

从 mem0 加载该系统的所有记忆，展示给用户当前档案内容。

### Step 2: 选择更新目标

询问用户想更新哪个章节：

> 当前 {system_name} 档案包含：元信息、4 个组件、6 条依赖、1 次历史故障。你想更新哪部分？也可以直接告诉我新的发现。

### Step 3: 增量更新

针对用户选择的章节，执行对应步骤的访谈流程。修改后的内容合并到档案中。

### Step 4: 重新归档

更新后的档案重新按章节写入 mem0，覆盖对应记忆。

## Output Format

与 onboarding 相同。归档完成后返回更新结果，包含受影响的记忆 ID。

## Pitfalls

同 onboarding。额外注意：
- 不要覆盖用户未明确要求修改的章节
- 更新后应展示 diff（旧 vs 新），让用户确认变更
