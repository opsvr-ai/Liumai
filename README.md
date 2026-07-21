<p align="center">
  <img alt="六脉 Liumai" src="public/favicon.svg" width="80" />
</p>

<h1 align="center">六脉 Liumai</h1>

<p align="center"><strong>智能化运维数智平台</strong> · Intelligent AIOps Platform</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#架构">架构</a> ·
  <a href="#功能模块">功能模块</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#开发指南">开发指南</a>
</p>

---

六脉（Liumai）是一个面向企业运维场景的 AI 驱动智能运维平台。通过对接 Hermes Agent 引擎和大语言模型，提供**智能对话**、**故障根因分析（RCA）**、**知识中心**、**定时任务调度**、**多源数据接入**等核心 AIOps 能力。平台支持多种对话模式：通用 LLM 直连问答、智能运维助理（Hermes 工具调用）、基于 llm-wiki v2 的知识库检索、故障根因分析。

## 快速开始

### 前置依赖

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/) v2+
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — AI 引擎（需单独安装运行）

### 一键启动

```bash
git clone git@github.com:opsvr-ai/Liumai.git
cd Liumai
cp .env.example .env    # 编辑配置（可选）
docker compose up -d     # 启动全部服务
```

访问 `http://localhost:3000`，首次使用需创建管理员账号。

### 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Frontend (Nginx) | 3000 | Web 管理界面 |
| Backend (FastAPI) | 8000 | API 服务 |
| PostgreSQL 16 | 5432 | 主数据库 |
| Redis 7 | 6379 | 缓存 |

## 架构

```
                          ┌──────────────────────────────┐
                          │      Browser / Mobile        │
                          │   React 19 · Tailwind CSS 4  │
                          │   shadcn/ui · Lucide Icons   │
                          └─────────────┬────────────────┘
                                        │ HTTP (:3000)
                                        ▼
                          ┌──────────────────────────────┐
                          │         Nginx (:3000)        │
                          │   静态资源 + API 反向代理     │
                          └─────────────┬────────────────┘
                                        │ /api/*
                                        ▼
                   ┌──────────────────────────────────────┐
                   │       FastAPI Backend (:8000)        │
                   │         Python 3.12 · async          │
                   ├──────┬──────┬───────┬───────┬───────┤
                   │ Auth │ Chat │  RCA  │ Rules │ Users │
                   │ JWT  │ SSE  │Engine │ Alert │  RBAC │
                   │LDAP  │Modes │Queue  │ CRUD  │ CRUD  │
                   ├──────┼──────┼───────┼───────┼───────┤
                   │ Jobs │History│ DS   │Skills │Config │
                   │Proxy │ Audit │Adapt.│ Cache │System │
                   ├──────┼──────┼───────┼───────┼───────┤
                   │Knowl │         LLM Direct           │
                   │edge  │    (通用模型直连 + 模型切换)   │
                   └──┬───┴──┬───┴───────┴───────┴───────┘
                      │      │
            ┌─────────┘      └──────────┐
            ▼                           ▼
   ┌──────────────────┐      ┌──────────────────┐
   │ PostgreSQL 16    │      │   Redis 7        │
   │   (主数据库)      │      │  (缓存 / Session) │
   └──────────────────┘      └──────────────────┘
                      │
                      │ HTTP API
                      ▼
   ┌──────────────────────────────────────────────┐
   │           Hermes Agent (AI 引擎)              │
   │  Chat Completions · Skills · Toolsets        │
   │  Cron Jobs · SSE Streaming                  │
   │  Health: GET /health                        │
   └──────────────────────────────────────────────┘
```

## 功能模块

### 概览仪表盘
- 系统运行状态一览：活跃 RCA 会话、排队任务、Hermes 健康状态
- 快速入口导航到各功能模块
- 最近分析会话列表，一键跳转详情

### 智能对话
- **四种对话模式**：通用（LLM 直连 + 模型切换）、智能助理（Hermes 工具调用）、知识问答（llm-wiki v2）、故障定界（RCA）
- **模型自动探测**：通用模式自动发现 LLM endpoint 可用模型，支持下拉切换
- **文件上传**：通用模式支持上传 PDF/Word/Excel/PPT 等 30+ 格式（MarkItDown 转换）
- SSE 流式响应，实时展示 AI 思考过程
- 工具调用可视化：状态驱动彩色指示器（蓝色运行/绿色完成/红色失败）
- 模式感知 placeholder 提示文案
- AI 生成个性化欢迎语 + 打字机动画 + 快捷提问入口

### 知识中心
- **文档管理**：上传文档或粘贴文本，批量文件上传支持
- **知识入库**：调用 Hermes + llm-wiki v2 将文档内容提炼存储
- **命中测试**：测试知识库检索命中率，支持命中/未命中反馈
- **Webhook 热更新**：配置 Webhook 端点，外部系统推送数据自动提炼入库
- **统计分析**：文档总数、存储状态、命中次数、Webhook 来源统计

### RCA 分析
- 自动/手动触发故障根因分析
- 时间窗口灵活选择（15分钟/1小时/4小时/24小时/自定义）
- 分析结果详情抽屉：时间线、根因摘要、影响范围
- 并发队列管理，支持排队和并发上限控制

### 告警规则
- 创建/编辑/启用/禁用告警匹配规则
- 支持多严重级别（严重/高/中/低）
- 灵活的条件表达式匹配
- 关联数据源自动触发 RCA

### 定时任务
- 管理 Hermes 后台定时作业
- 支持 Cron 表达式、间隔调度、一次性任务
- 任务状态监控（运行/暂停/完成）
- 一键触发、暂停、恢复、删除

### 数据源管理
- 支持 Prometheus、Zabbix、ClickHouse、Kafka、HTTP API 五种数据源
- 可视化配置表单：连接信息、认证方式（Basic/Bearer/OAuth2/API Key）
- HTTP API 支持自定义 Headers 和 Body 编辑器
- 连接测试功能

### 技能中心
- 浏览 Hermes Agent 全部技能（146+）和工具集（25+）
- 按分类分组折叠，支持搜索和状态筛选
- 自动缓存刷新（可配置周期）

### 用户管理
- 用户 CRUD、角色分配（管理员/运维/只读）
- Local + LDAP 双认证模式
- 在线用户实时统计
- 管理员重置密码

### 系统设置
- 分类导航：智能引擎 / 认证安全 / 通用
- Hermes 连接配置 + 健康检测
- 通用 LLM 模型配置（Base URL / API Key / Model）
- LDAP/AD 企业目录集成
- 对话模式 Prompt 编辑
- 技能缓存周期配置

### 个人中心
- 个人信息查看编辑、头像上传
- 密码修改（LDAP 用户自动隐藏）
- 聊天会话历史管理
- 使用统计（对话次数、消息总数）
- 亮色/暗色主题切换

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19, TypeScript, Tailwind CSS 4, shadcn/ui (base-nova), Vite 8 |
| **后端** | Python 3.12, FastAPI, SQLAlchemy 2.0 (async), Alembic |
| **数据库** | PostgreSQL 16, Redis 7 |
| **AI 引擎** | Hermes Agent (OpenAI-compatible API) |
| **容器化** | Docker, Docker Compose |
| **认证** | JWT + bcrypt, LDAP/AD |

## 开发指南

### 本地开发

```bash
# 后端
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 前端
npm install
npm run dev    # Vite dev server @ :5173
```

### 项目结构

```
├── backend/
│   ├── app/
│   │   ├── routes/       # API 路由 (auth, chat, rca, rules, users, jobs, datasources, knowledge)
│   │   ├── models/       # SQLAlchemy ORM 模型
│   │   ├── services/     # 业务逻辑 (hermes, ldap, datasource_adapters)
│   │   └── main.py       # FastAPI 入口
│   ├── alembic/          # 数据库迁移
│   └── requirements.txt
├── src/
│   ├── components/       # React 组件 (chat, layout, ui, auth)
│   ├── pages/            # 页面组件
│   ├── hooks/            # 自定义 Hooks
│   ├── lib/              # API 客户端、工具函数
│   └── styles/           # 全局样式 + 设计 Token
├── docker/               # Docker 配置
├── docs/                 # 设计文档 & 规格说明
└── docker-compose.yml
```

## License

MIT
