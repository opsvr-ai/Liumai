# 应用系统知识 — 智能体认知层

> 让智能体"理解"它运维的应用系统，而非仅检索文档片段。

**版本:** v1.0 | **日期:** 2026-07-25 | **状态:** 已确认

---

## 1. 问题与目标

### 1.1 现状

当前 Liumai 的知识中心存储的是通用运维文档（runbook、架构说明），通过 llm-wiki v2 做语义检索后注入对话。问题是：

- **知识碎片化**：文档之间没有关联，智能体不知道"订单服务挂了会影响支付"
- **缺乏拓扑认知**：智能体不了解系统间的强弱依赖关系，做 RCA 时只能靠猜测
- **知识入口分散**：上传文档、webhook、蒸馏各管各的，没有统一的"应用系统"视角
- **经验无法沉淀**：RCA 结论、故障处理经验散落在会话历史中，下次相似故障仍需重头来

### 1.2 目标

构建以**应用系统**为中心的知识认知层，让智能体在故障定界时：

- 知道受影响的系统是什么，有哪些组件
- 理解组件间的强弱依赖，计算爆炸半径
- 能检索历史故障经验和已知修复方案
- 能调用关联的告警规则、数据源、监控指标

---

## 2. 架构

```
┌─────────── 六脉平台 ───────────┐   ┌──── Hermes ────────────────────┐
│                                │   │                                │
│  系统页面 [/systems]           │   │  app-system-onboarding 技能    │
│  ├ 卡片列表                    │   │  ├ 渐进式访谈 (Step 1~6)       │
│  ├ 详情页 (档案预览)           │   │  ├ 实时生成 Markdown 档案       │
│  └ [新建]按钮                  │   │  ├ SSE tool_call 回传预览      │
│                                │   │  └ 写入 mem0 记忆              │
│  ┌── 触发性对话 ────────────→  │   │                                │
│  │  ┌── SSE 流式预览 ────────→ │   │  app-system-update 技能        │
│  │  └── 确认信号 ────────────→ │   │  ├ 追加特定章节                │
│  └─────────────────────────── │   │  └ 重新写入 mem0              │
│                                │   │                                │
│  app_systems 索引表 (PG)      │   │  mem0                          │
│  ├ id, name, tier             │   │  ├ 系统档案记忆                 │
│  ├ status                     │   │  ├ 组件依赖记忆                 │
│  └ updated_at                 │   │  └ 故障经验记忆                 │
│                                │   │                                │
│  关联表: app_system_resources  │   │  RCA 时自动检索                 │
│  ├ system_id                  │   │  "订单系统 组件 依赖 历史故障"   │
│  ├ resource_type              │   │  → 注入 system prompt           │
│  └ resource_id                │   │                                │
└────────────────────────────────┘   └────────────────────────────────┘
```

### 核心决策

| 决策 | 说明 |
|------|------|
| **知识存储在 Hermes mem0** | 平台不存内容，只存轻量索引。检索由 Hermes 自己做 |
| **采集用访谈模式** | Hermes `app-system-onboarding` 技能主导渐进式提问 |
| **档案格式是 Markdown** | 结构化为系统档案模板，自然语言可读，也可语义检索 |
| **平台存索引 + 关联** | `app_systems` + `app_system_resources` 做目录和关联 |

---

## 3. 数据模型（平台侧）

### 3.1 app_systems（轻量索引）

```sql
CREATE TABLE app_systems (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL UNIQUE,
    tier        VARCHAR(10)  NOT NULL DEFAULT 'L2',  -- L0/L1/L2
    status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    description VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### 3.2 app_system_resources（关联）

```sql
CREATE TABLE app_system_resources (
    id            SERIAL PRIMARY KEY,
    system_id     INTEGER NOT NULL REFERENCES app_systems(id) ON DELETE CASCADE,
    resource_type VARCHAR(30) NOT NULL,  -- alert_rule | data_source | rca_session | knowledge_doc
    resource_id   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(system_id, resource_type, resource_id)
);
```

平台不存档案内容——记忆全在 Hermes mem0 侧。

---

## 4. 交互式访谈流程 (Hermes 技能)

### 4.1 `app-system-onboarding` 技能

平台通过 chat API 以专用 mode 触发，Hermes 接管对话。

**访谈步骤：**

| Step | 主题 | 目标产出 |
|------|------|----------|
| 1 | 基本信息 | 系统名称、业务定位、管理层级(L0~L2)、负责团队、SLA 目标 |
| 2 | 组件清单 | 每个组件的名称、类型(service/db/cache/mq)、技术栈、关键配置 |
| 3 | 依赖拓扑 | 组件间调用关系、强弱依赖标注、降级策略 |
| 4 | 监控关联 | 关联已有告警规则 + 数据源、关键监控指标 |
| 5 | 历史经验 | 过去故障案例、已知修复方案、运维注意事项 |
| 6 | 预览归档 | 展示完整档案 → 用户确认或修改 → 写入 mem0 |

**行为特征：**
- 渐进式，不强迫填满所有字段
- 每步用 SSE `tool_call` 事件回传实时生成的 Markdown 预览
- 接受多模态输入：文本描述、文档粘贴、URL（后续支持抓取）
- 可中断保存进度，后续可继续

### 4.2 `app-system-update` 技能

对已有系统档案的增量更新。用户指定要更新的章节 → 技能提问 → 生成更新 → 预览 → 写入 mem0。

---

## 5. 前端设计

### 5.1 新页面：应用系统 (`/systems`)

**卡片列表页：**
- 每个系统一张信息卡片：名称、层级标签(L0红/L1橙/L2灰)、状态
- 组件数量、关联告警数、数据源数、最近更新时间
- 搜索 + 层级筛选
- 「新建系统档案」按钮 → 进入访谈

**系统详情页：**
- 档案内容 Markdown 渲染（从 Hermes 拉取或缓存预览）
- 「继续访谈」按钮 → 触发 `app-system-update` 技能
- 「重新灌输」按钮 → 全量重写 mem0
- 关联资源表格：告警规则、数据源、知识文档、RCA 历史
- 「手动管理关联」入口

### 5.2 导航调整

侧边栏新增「应用系统」条目，放在「告警规则」和「知识中心」之间。

---

## 6. 后端 API 设计（平台侧）

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/systems` | 系统列表（搜索、层级筛选）|
| `GET` | `/api/systems/{id}` | 系统详情（含关联资源）|
| `POST` | `/api/systems` | 创建索引记录（访谈归档后调用）|
| `PUT` | `/api/systems/{id}` | 更新元信息 |
| `DELETE` | `/api/systems/{id}` | 删除（软删除？确认）|
| `GET` | `/api/systems/{id}/resources` | 获取关联资源列表 |
| `POST` | `/api/systems/{id}/resources` | 添加关联 |
| `DELETE` | `/api/systems/{id}/resources/{res_id}` | 移除关联 |

### 6.2 触发性对话

平台前端点击「新建系统档案」→ 发起 SSE 对话请求，`mode_slug: "app-system-onboarding"` → Hermes 接管 → SSE 流式回传 tool_call 事件（含 Markdown 预览块）→ 前端渲染分屏视图。

---

## 7. 实施分工

| 模块 | 谁做 | 说明 |
|------|------|------|
| `app-system-onboarding` 技能 | Hermes 侧 | 渐进式访谈、档案生成、mem0 写入 |
| `app-system-update` 技能 | Hermes 侧 | 增量更新已归档系统 |
| mem0 记忆存储 | Hermes 侧 | 已就绪 |
| `app_systems` 表 + API | 平台后端 | 轻量索引，不做内容存储 |
| `/systems` 页面 | 平台前端 | 卡片列表 + 详情 + 新建入口 |
| Hermes 记忆写入端点 | Hermes 侧 | `POST /mem0/memories` 或现有接口 |

---

## 8. 后续扩展（不在本期范围）

- **文档上传** → 自动提取 → 结构化 → 灌输到 mem0
- **ITSM/CMDB 对接** → 拉取服务目录 → 批量生成系统档案草稿
- **故障报告自动追加** → RCA 完成后，摘要自动写入对应系统的「历史故障」章节
- **知识图谱可视化** → 依赖拓扑 DAG 图（v0.7.0）

---

## 9. 自检清单

- [x] 存储方案明确：Hermes mem0，平台轻量索引
- [x] 知识采集入口明确：交互式访谈，Hermes 技能驱动
- [x] 知识使用路径明确：RCA 时 Hermes 自动检索 mem0
- [x] API 设计覆盖基本 CRUD + 关联管理
- [x] 分工清晰：平台做索引和 UI，Hermes 做访谈和记忆
- [x] 无歧义：档案格式、访谈步骤、api 路径都已定义
