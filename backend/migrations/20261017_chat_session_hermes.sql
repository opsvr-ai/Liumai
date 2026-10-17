-- ═══════════════════════════════════════════════════════════════════════════════
-- 2026-10-17 · Chat session ↔ Hermes agent linkage (existing installations)
-- ═══════════════════════════════════════════════════════════════════════════════
-- New database volumes already get these columns from init.sql.  Run this file
-- against an existing deployment (from the repository root, PowerShell):
--
--   Get-Content backend/migrations/20261017_chat_session_hermes.sql -Raw |
--     docker exec -i liumai-postgres psql -U liumai -d liumai -v ON_ERROR_STOP=1
--
-- Idempotent: every statement is guarded with IF NOT EXISTS, so re-running it
-- (or running it on a database that already has the columns) is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Hermes agent session bound to the chat (multi-turn continuity token).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS hermes_session_id VARCHAR(128);

-- Hermes run currently executing for the chat (reattach after a reload).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_run_id VARCHAR(128);

-- Lookups when resolving a chat from a Hermes session / stale run.
CREATE INDEX IF NOT EXISTS idx_chat_sessions_hermes_session
    ON chat_sessions(hermes_session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_active_run
    ON chat_sessions(active_run_id);

-- Verification (should return two rows):
--   SELECT column_name, data_type, character_maximum_length
--     FROM information_schema.columns
--    WHERE table_name = 'chat_sessions'
--      AND column_name IN ('hermes_session_id', 'active_run_id');
