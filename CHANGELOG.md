# Changelog

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
