# Changelog

## [0.2.0] — 2026-07-20

### Added

- **Chat modes**: Three conversation modes — 通用 (General), 故障定界 (RCA), 知识问答 (Knowledge Q&A)
  - Mode selector tabs above the chat input
  - RCA mode: time window picker with quick presets (15min/1h/4h/24h) and custom datetime inputs
  - Knowledge Q&A mode: file upload with inline content injection
  - Each mode has editable system prompts via the Settings page
  - Mode-aware streaming: backend injects the mode's system prompt and adjusts temperature
- **Chat sidebar redesign**: Fixed left sidebar (DeepSeek-style) with session history
  - Clean two-line session items: title + relative timestamp
  - No per-item icons — full-width titles
  - Subtle accent highlight for active session
  - Collapsible sidebar with smooth width transition
- **Chat input redesign**: Pill-shaped input (`rounded-2xl`) with integrated send button
- **System settings page**: LDAP configuration, Hermes Gateway URL/API Key, account password change
- **User management page**: List, create, edit role, delete users (Admin only)
- **LDAP configuration UI**: Full LDAP directory settings form with connection test
- **Hermes configuration UI**: Gateway URL and API Key with test connection proxy
- **六脉 SVG logo**: Six flowing data meridians converging into an AI core, placed on sidebar, chat welcome, and login page
- **System configuration persistence**: All settings (LDAP, Hermes, chat modes) persisted in `system_config` / `chat_modes` DB tables with env-var fallback
- **Chat history auto-save**: Messages automatically persisted when streaming completes
- **Tool call visualization**: Hermes tool calls rendered as expandable cards with emoji, labels, and argument display
- **Docker build optimization**: `.dockerignore` for smaller build contexts

### Fixed

- **Chat history not saved**: Auto-save using `useEffect` triggered by `isStreaming` transition, avoiding stale closure issues
- **Hermes config lost after restart**: Database-persisted config with env-var fallback; singleton `HermesClient` now detects config changes and recreates itself
- **Chat error "Request URL is missing protocol"**: Added empty-URL guard in chat stream endpoint + singleton rebuild on config change
- **Tool calls positioned incorrectly in multi-turn conversations**: Insert at end before current streaming assistant (not before first assistant in history)
- **Tool emoji reverting to default after completion**: Backend now sends `None` instead of `"🔧"` as default, allowing frontend merge logic to preserve the Hermes-provided emoji
- **Chat auto-scroll not working**: Replaced broken `scrollTo` with bottom sentinel `div` + `scrollIntoView`
- **FastAPI 204 crash**: Fixed `ChatMessage` Pydantic schema shadowing SQLAlchemy ORM model (renamed to `ChatMessageIn`)
- **Data loss on Docker restart**: Switched from named volumes to host-directory bind mounts (later reverted — named volumes are reliable; added prominent warning against `docker compose down -v`)
- **Sidebar toggle button position**: Moved toggle from main content area into the sidebar itself so it collapses together with the sidebar

## [0.1.0] — 2026-07-19

### Added

- Initial project setup — 六脉 (Liumai) RCA Dashboard
- FastAPI backend with 5 DB tables: teams, users, alert_rules, rca_sessions, collaboration_events
- 4 route groups: alerts, rca, rules, history
- PostgreSQL 16 + Redis 7 + Nginx reverse proxy
- Docker Compose with 5 services and China-region npm/pip mirrors
- Intelligent chat with SSE streaming and tool-call visualization
- Hermes Gateway client integration for RCA analysis
- WeCom (企业微信) integration for emergency collaboration
- RBAC: ADMIN / OPERATOR / VIEWER roles
- Auth type-based LOCAL/LDAP login routing
- Dashboard with RCA session overview and queue status
- Alert rules CRUD with enable/disable toggle
- History audit trail for RCA sessions
- Design token layer (colors, typography, spacing, radii, shadows)
- Loading/error/empty states for all feature components
- Confirmation dialogs for destructive actions
