<p align="center">
  <picture>
    <source srcset="public/logo.svg" />
    <img alt="六脉 Liumai" src="public/logo.svg" width="64" />
  </picture>
</p>

<h1 align="center">六脉 Liumai</h1>

<p align="center"><strong>智能化运维数智平台</strong> · Intelligent AIOps Platform</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#架构">架构</a> ·
  <a href="#功能">功能</a> ·
  <a href="#技术栈">技术栈</a>
</p>

---

六脉（Liumai）是一个面向运维场景的智能对话与分析平台。通过对接 Hermes AI 引擎，提供**故障根因分析**、**知识库问答**、**实时监控告警**等 AIOps 核心能力。

## 快速开始

### 前置依赖

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — AI 引擎（需单独安装）

### 一键启动

```bash
git clone git@github.com:opsvr-ai/Liumai.git
cd Liumai

# 启动所有服务（PostgreSQL + Redis + Backend + Frontend）
docker compose up -d
```

打开 <http://localhost:3000>，首次使用会进入**初始化设置**，创建管理员账户。

> [!WARNING]
> **不要使用 `docker compose down -v`** — 这会删除数据库卷，导致所有配置和对话历史丢失。

### 配置 Hermes 引擎

1. 管理员登录后进入**系统设置** → **Hermes 智能引擎**
2. 填写 Hermes API Server 地址（默认 `http://host.docker.internal:8642/v1`）
3. 点击测试连接并保存

## 架构

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Browser    │────▶│  Nginx (:3000)  │────▶│  React SPA (Vite)│
│              │     │  Static + Proxy │     │                  │
└─────────────┘     └─────────────────┘     └──────────────────┘
                                                    │
                                                    ▼
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  PostgreSQL │◀────│ FastAPI (:8000) │────▶│  Hermes AI Engine │
│   + Redis   │     │   Backend API   │ SSE │  (:8642 / :8080) │
└─────────────┘     └─────────────────┘     └──────────────────┘
```

| 服务 | 技术 | 端口 |
|------|------|------|
| Frontend | React 19 + TypeScript + Vite + Tailwind | 3000 |
| Backend | FastAPI + SQLAlchemy (async) + asyncpg | 8000 |
| Database | PostgreSQL 16 (Alpine) | 5432 |
| Cache | Redis 7 (Alpine) | 6379 |
| AI Engine | Hermes Agent (OpenAI 兼容 API) | 8642 |

## 功能

### 🤖 智能对话

- SSE 流式对话 — 实时显示 AI 回复
- **三种对话模式**：通用 / 故障定界 (RCA) / 知识问答
- 工具调用可视化 — Hermes 调用的每个工具以卡片展示
- 对话历史持久化 — 侧栏显示所有历史会话

### 🔍 故障定界 (RCA)

- 选择时间窗口 + 描述问题 → AI 自动分析
- 支持快速预设：15 分钟 / 1 小时 / 4 小时 / 24 小时
- 结构化 JSON 输出：根因 + 置信度 + 证据 + 受影响服务 + 建议

### 📚 知识问答

- 上传文档（文本/代码/PDF）→ AI 基于文档内容回答
- 自定义系统提示词 — 每种模式可独立编辑

### 👥 用户与权限

- 多角色 RBAC：管理员 / 运维 / 只读
- LDAP / Active Directory 企业目录集成
- 本地账号 + LDAP 双认证模式

### ⚙️ 系统配置

- 全部通过 Web UI 配置（无需改 .env）
- Hermes 连接配置 + 测试连通性
- LDAP 目录配置 + 连接测试
- 对话模式提示词编辑器

### 📊 仪表盘

- RCA 会话概览 + 队列状态
- 告警规则管理 + 启用/禁用
- 历史记录审计追踪

## 开发

### 本地运行（无 Docker）

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Frontend
npm install
npm run dev  # Vite dev server on :5173
```

### 目录结构

```
Liumai/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI 入口
│   │   ├── config.py        # 配置 (Pydantic Settings)
│   │   ├── auth.py          # JWT + bcrypt + LDAP 认证
│   │   ├── models/          # SQLAlchemy ORM 模型
│   │   ├── routes/          # API 路由
│   │   └── services/        # Hermes / LDAP 客户端
│   └── migrations/init.sql  # PostgreSQL Schema
├── src/
│   ├── App.tsx              # 前端路由 + 布局
│   ├── pages/               # 页面组件
│   ├── components/          # 可复用组件
│   ├── hooks/               # 自定义 Hooks
│   └── lib/api.ts           # API 客户端
├── docker/                  # Dockerfile + Nginx 配置
├── docker-compose.yml       # 容器编排
└── hermes-skills/           # Hermes 技能定义
```

## 技术栈

**后端：** Python 3.12 · FastAPI · SQLAlchemy 2 (async) · PostgreSQL 16 · Redis 7 · JWT · bcrypt · LDAP3

**前端：** TypeScript · React 19 · Vite 8 · Tailwind CSS · shadcn/ui · React Router · React Markdown

**基础设施：** Docker · Docker Compose · Nginx · WSL2

## License

MIT
