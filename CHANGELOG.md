# Changelog

## [Unreleased]

### Fixed

- **智能对话：助手正文重复输出两遍** — Hermes Runs API 的 `message.interim` 投递的是整条中途消息的完整文本（同一文本此前已按 `message.delta` 逐 token 到达），前端把两者都当增量追加。`message.interim` 现在按整块快照合并（`_mergeAssistantChunk`），并在回合终态前裁剪完全重复的整块尾部；`COMPLETED` 的 run 以服务端 `output` 为准覆盖正文。
- **智能对话：刷新 / 切换导航页返回后不再继续输出** — 返回时若 run 的 `seq` 游标丢失（刷新会中断落盘请求），此前只能走 `run-state` 轮询并等 `COMPLETED` 才一次性补全。现在只要在 Hermes 5 分钟重放窗口内就优先重订阅 SSE（无游标时从头吸收重放，不重复已显示文本），轮询兜底也会在 RUNNING 阶段刷新进度，间隔由 3s 缩短到 1.5s。

## [0.4.0] — 2026-07-21

### Added

- **Knowledge Center (知识中心)** — full document ingestion pipeline into llm-wiki v2
  - Document CRUD with batch file upload (MarkItDown conversion for 30+ formats)
  - One-click ingest via Hermes with custom knowledge management prompts
  - Q&A hit testing with feedback mechanism (thumbs up/down)
  - Webhook auto-update: external systems push data → auto-refine → store in knowledge base
  - Statistics dashboard: total docs, storage status, hit counts, webhook sources
  - ExpandableText component for long content preview
- **Chat mode restructuring**
  - New `general` mode: direct LLM calls (bypass Hermes), configurable via system settings
  - Renamed `default` → 智能助理 (Hermes-powered ops assistant with tool execution)
  - Knowledge Q&A mode: llm-wiki v2 protocol prompt, document upload moved to general mode
- **Model auto-discovery**: `GET /api/chat/llm-models` proxies LLM endpoint `/v1/models`
- **Model selector**: Dropdown model picker in general chat mode, defaults to configured model
- **Mode-aware placeholder text**: Each chat mode shows contextual hint in the input area
- **Chat input redesign**: Bottom bar layout with file upload (+) button left, model selector + send right

### Changed

- **Security hardening** (55 issues from comprehensive platform audit)
  - Added authentication to 25+ previously unprotected endpoints
  - JWT_SECRET validation at startup (rejects insecure defaults)
  - CORS tightened: specific methods/headers, removed credential wildcard
  - Nginx security headers added (CSP, X-Content-Type-Options, X-Frame-Options, etc.)
  - Redis password authentication enforced
  - PostgreSQL port no longer exposed to host by default
  - API keys (Hermes/LLM) masked in GET responses
  - Image upload content validation (magic bytes check)
  - Frontend route protection: RequireAdmin wrapper for admin-only pages
  - 401 interceptor: auto-redirect to login on expired token
- **Password policy overhaul**: Min 10 chars, complexity requirements (upper/lower/digit/special), random password generator
- **Admin initialization redesign**: Removed hardcoded admin seed, dynamic first-time setup with strength validation
- **Database optimization**: 10 new indexes added (composite, trigram GIN for full-text search, etc.)
- **init.sql comprehensive sync**: All columns, constraints, indexes, seed data aligned with running schema

### Fixed

- SSRF vulnerability in data source query endpoint (URL override removed)
- LDAP injection escape updated to RFC 4515 hex format
- Setup endpoint race condition (PostgreSQL advisory lock)
- HermesClient HTTP connection leak on config reload
- Background cache task cancellation on shutdown
- Typewriter interval memory leak + unmount cleanup
- TooltipProvider missing from component tree
- 401 interceptor for expired JWT tokens
- Datasource auth config serialization bug (type cast issue)
- Alembic env.py missing model imports (ChatMessage, ChatSession, etc.)
- `int(user_id)` 500 error moved inside try/except
- Login timing side-channel mitigated with dummy bcrypt verify
- `generate_welcome` now uses authenticated user identity
- Frontend dark mode color breakage in sidebars and chat bubbles
- MarkItDown content truncation raised from 8K → 30K chars
- Hit test dialog retains previous question (now resets on open)
- Ingest status now shows processing spinner with auto-refresh
- `.env` cleaned: internal IP and potential API key removed
- Version consistency: all components report v0.3.0 → v0.4.0

---

## [0.3.0] — 2026-07-21

### Added

- **Timed tasks module**: Manage Hermes background cron jobs
  - Create/edit/delete jobs with schedule expressions, prompts, skills
  - Run/pause/resume inline actions with real-time status badges
  - Stats dashboard: total, running, paused, next run time
  - Backend proxy via `/api/jobs/*` with admin authentication
- **Profile center**: Personal settings hub with tabbed navigation
  - Personal info: avatar upload (file or URL), username, role badge
  - Password change (hidden for LDAP users)
  - Session history: list and delete own chat sessions
  - Usage statistics: total sessions, message count
  - Dark/light theme toggle
- **LLM model configuration**: Configure a general-purpose model for platform-internal use
  - Settings UI for Base URL, API Key, model name
  - Customisable welcome prompt with `{username}` placeholder
  - Dynamic personalised welcome text with typewriter animation on chat page
- **Hermes health monitoring**: Real-time health status on dashboard
  - Status badge with latency display, auto-poll every 30s
  - Health check card in platform summary
- **Online user tracking**: `last_active_at` column, active user count in users page stats
- **File conversion (MarkItDown)**: Backend file-to-markdown conversion
  - POST `/api/chat/convert-file` supports 30+ formats (PDF, Word, Excel, PPT, images, etc.)
  - Knowledge QA mode uploads via API instead of client-side FileReader
- **Help Center**: Built-in documentation page with platform overview, module guides, architecture, and FAQ
- **User page enhancements**: Stats cards + search/filter + admin password reset
- **Skills center redesign**: Stats cards, grouped skill categories, status filtering, visual polish
- **Dashboard redesign**: Hero section with platform branding, quick shortcut cards, Hermes health
- **Settings page redesign**: Left-right category navigation (AI Engine / Auth & Security / General)
- **Page stats bars**: Unified stat card pattern applied to History, RCA, Rules, DataSources, Users, Skills

### Changed

- **Chat input UX**: Centered input on new conversations, slides to bottom after first message
- **Chat input multi-line**: Textarea with auto-resize (3–5 lines), Shift+Enter for newline
- **Chat input integrated tab bar**: Mode selector embedded as tab bar inside the input card
- **Tab bar visual polish**: Pill-style with icons (MessageCircle/Activity/BookOpen) and active dot indicator
- **Welcome text**: Dynamic AI-generated welcome with typewriter animation effect
- **Tool call display**: State-driven inline style with coloured left accent lines and flow arrows
- **Tool icon mapping**: 30+ lucide icon overrides for known tools (Terminal, Globe, Search, Database, etc.)
- **Message bubbles**: Dark user bubble (`#1a1a2e`) + borderless avatars + copy button on hover
- **Favicon**: Brand-blue hexagon SVG matching platform colour scheme
- **Dark theme**: Complete `.dark` CSS variables with ThemeProvider from next-themes
- **Settings → AI Engine**: Added LLM config card (Brain icon)

### Fixed

- Hermes health check uses root-level `/health` (not `/v1/health`)
- Jobs API proxy strips `/v1` suffix for correct URL construction
- Dockerfile includes `public/` directory for favicon deployment

---

## [0.2.0] — 2026-07-20

### Added

- **Chat modes**: Three conversation modes — 通用 (General), 故障定界 (RCA), 知识问答 (Knowledge Q&A)
- **Chat sidebar redesign**: Fixed left sidebar (DeepSeek-style) with session history
- **Chat input redesign**: Pill-shaped input with integrated send button
- **System settings page**: LDAP configuration, Hermes Gateway URL/API Key, account password change
- **User management page**: List, create, edit role, delete users (Admin only)
- **LDAP configuration UI**: Full LDAP directory settings form with connection test
- **Hermes configuration UI**: Gateway URL and API Key with test connection proxy
- **Brand identity**: SVG logo, favicon, login page branding
- **System configuration persistence**: All settings in `system_config` / `chat_modes` DB tables
- **Chat history auto-save**: Messages automatically persisted when streaming completes
- **Tool call visualization**: Expandable cards with emoji, labels, and argument display
- **Docker build optimization**: `.dockerignore` for smaller build contexts

### Fixed

- FastAPI 204 crash on 4 endpoints (auth/chat/users)
- ChatMessage ORM shadow by Pydantic request model
- Chat auto-save stale closure
- Tool call insertion point targeting
---

## [0.1.0] — 2026-07-18

### Added

- Initial project setup: FastAPI backend + React frontend
- Database schema: users, teams, chat_sessions, chat_messages, rca_sessions, alert_rules
- JWT authentication with bcrypt password hashing
- LDAP authentication support
- RCA analysis engine with Hermes integration
- Docker Compose multi-service deployment
- Nginx reverse proxy with SSE streaming support
