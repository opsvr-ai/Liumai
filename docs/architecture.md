# 六脉 (Liumai) 平台架构文档

## 概述

六脉是一个面向企业运维场景的 AI 驱动智能运维平台。通过对接 Hermes Agent 和大语言模型，提供智能对话、故障根因分析、知识库管理、定时任务调度、多源数据接入等核心 AIOps 能力。

## 系统架构

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
 └──────────────────────────────────────────────┘
                    │
                    │ (通用模式)
                    ▼
 ┌──────────────────────────────────────────────┐
 │     LLM Provider (通用大模型直连)            │
 │  OpenAI-compatible API · DeepSeek · etc.     │
 └──────────────────────────────────────────────┘
```

## 核心模块

### 智能对话 (Chat)

支持四种模式：

| 模式 | slug | 引擎 | 功能 |
|------|------|------|------|
| 通用 | `general` | LLM 直连 | 通用问答、模型切换、文件上传 |
| 智能助理 | `default` | Hermes | 工具调用、自主执行 |
| 故障定界 | `rca` | Hermes | RCA 根因分析 |
| 知识问答 | `knowledge` | Hermes | llm-wiki v2 检索 |

### 知识中心 (Knowledge)

```
文档上传 ──→ MarkItDown 转换 ──→ Hermes ──→ llm-wiki v2
Webhook ───→ 自动提炼 ─────────→ Hermes ──→ llm-wiki v2
                                         ↓
                              知识问答模式 ←── 命中测试 ←── 反馈
```

### 认证与授权

- JWT (HS256) + bcrypt 密码哈希
- LDAP/AD 企业目录集成（RFC 4515 安全转义）
- 三级 RBAC：ADMIN / OPERATOR / VIEWER
- 首次设置向导（强密码策略：10位+四类字符）

### 数据流

1. **用户请求** → Nginx 反向代理 → FastAPI 路由
2. **认证层**：JWT 验证 + 角色检查
3. **业务逻辑**：路由 → 服务层 → 数据库 / Hermes / LLM
4. **SSE 流**：`text/event-stream` 实时推送 delta/tool_call/done/error 事件

## 数据库

### 核心表

| 表 | 用途 | 索引 |
|---|------|------|
| `users` | 用户账户 | team_id, username(UNIQUE), role |
| `chat_sessions` | 对话会话 | user_id, mode_slug, updated_at DESC |
| `chat_messages` | 对话消息 | session_id, created_at |
| `chat_modes` | 对话模式配置 | slug(UNIQUE), enabled |
| `rca_sessions` | RCA 分析会话 | team_id, status, created_at DESC |
| `alert_rules` | 告警规则 | team_id, enabled, team+enabled(复合) |
| `data_sources` | 数据源连接 | type, name(UNIQUE) |
| `knowledge_documents` | 知识文档 | status, source_type, source_name, title/content(trigram GIN) |
| `system_config` | 系统配置 (KV) | key(PK) |

### 性能优化

- 复合索引覆盖高频联合查询
- GIN trigram 索引支撑知识文档全文搜索
- 外键列自动创建 B-tree 索引
- 时间序列查询使用 DESC 排序索引

## 安全

- JWT_SECRET 启动时验证（拒绝弱默认值）
- CORS 白名单 + 安全头 (CSP / X-Frame-Options / X-Content-Type-Options)
- LDAP 注入防御（RFC 4515 十六进制转义）
- SSRF 防御（数据源 URL 不可被用户覆盖）
- API 密钥掩码显示（仅展示后 4 位）
- PostgreSQL 端口不对外暴露
- Redis 密码认证
- 文件上传魔数校验
- 前端角色路由保护 + 401 自动拦截

## 部署

```bash
git clone git@github.com:opsvr-ai/Liumai.git
cd Liumai
cp .env.example .env    # 编辑配置（必须设置 JWT_SECRET）
docker compose up -d     # 启动全部服务
```

服务端口：前端 `:3000` · 后端 `:8000` · PostgreSQL `:5432` · Redis `:6379`
