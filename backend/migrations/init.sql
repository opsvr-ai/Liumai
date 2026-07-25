-- ═══════════════════════════════════════════════════════════════════════════════
-- 六脉 (Liumai) AIOps Platform — PostgreSQL Schema Initialisation
-- ═══════════════════════════════════════════════════════════════════════════════
-- This script is executed automatically by docker-compose via the
-- postgres container's docker-entrypoint-initdb.d mechanism.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ═══════════════════════════════════════════════════════════════════════════════
-- Enum types
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE auth_type AS ENUM ('LOCAL', 'LDAP');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE rca_trigger_type AS ENUM ('PASSIVE', 'ACTIVE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE rca_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE collab_event_type AS ENUM (
        'GROUP_CREATED',
        'MEMBER_JOINED',
        'AGENT_PROGRESS',
        'MANUAL_FINDING',
        'BOT_MENTIONED',
        'RCA_COMPLETED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS teams (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    username        VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255),
    role            user_role    NOT NULL DEFAULT 'VIEWER',
    auth_type       auth_type    NOT NULL DEFAULT 'LDAP',
    avatar_url      VARCHAR(512),
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);

CREATE TABLE IF NOT EXISTS alert_rules (
    id          SERIAL PRIMARY KEY,
    team_id     INTEGER      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    description TEXT         NOT NULL DEFAULT '',
    conditions  JSONB        NOT NULL DEFAULT '[]'::jsonb,
    actions     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_team_id ON alert_rules(team_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_team_enabled ON alert_rules(team_id, enabled);

CREATE TABLE IF NOT EXISTS rca_sessions (
    id                  SERIAL PRIMARY KEY,
    team_id             INTEGER          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    rule_id             INTEGER          REFERENCES alert_rules(id) ON DELETE SET NULL,
    trigger_type        rca_trigger_type NOT NULL,
    status              rca_status       NOT NULL DEFAULT 'QUEUED',
    time_window_start   TIMESTAMPTZ,
    time_window_end     TIMESTAMPTZ,
    hermes_session_id   VARCHAR(255)     UNIQUE,
    wecom_chat_id       VARCHAR(255),
    root_cause_summary  TEXT,
    evidence            JSONB            DEFAULT '[]'::jsonb,
    created_by          INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rca_sessions_team_id    ON rca_sessions(team_id);
CREATE INDEX IF NOT EXISTS idx_rca_sessions_status      ON rca_sessions(status);
CREATE INDEX IF NOT EXISTS idx_rca_sessions_created_at  ON rca_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rca_sessions_status_created ON rca_sessions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_events (
    id              SERIAL PRIMARY KEY,
    rca_session_id  INTEGER          NOT NULL REFERENCES rca_sessions(id) ON DELETE CASCADE,
    event_type      collab_event_type NOT NULL,
    content         TEXT,
    metadata        JSONB            DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collab_events_session_id ON collaboration_events(rca_session_id);
CREATE INDEX IF NOT EXISTS idx_collab_events_created_at  ON collaboration_events(created_at ASC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Seed data: default team + admin user
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO teams (id, name)
    VALUES (1, 'Default Team')
    ON CONFLICT (id) DO NOTHING;

-- Add columns that may be missing on upgrades from older schemas (safe for re-runs)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_type auth_type NOT NULL DEFAULT 'LDAP';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(512);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- First admin account is created dynamically via the setup endpoint
-- (POST /api/auth/setup).  No pre-seeded admin credentials are stored in
-- this repository.  See the quickstart guide for the setup flow.
-- The default team (ID 1) is still seeded so the setup flow can
-- assign the first admin to it.

-- ═══════════════════════════════════════════════════════════════════════════════
-- Chat history
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_sessions (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(255) NOT NULL DEFAULT '新对话',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_mode ON chat_sessions(mode_slug);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          SERIAL PRIMARY KEY,
    session_id  INTEGER      NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role        VARCHAR(20)  NOT NULL,
    content     TEXT         NOT NULL DEFAULT '',
    tool_calls  JSONB,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at ASC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- System configuration (runtime settings persisted across restarts)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_config (
    key         VARCHAR(255) PRIMARY KEY,
    value       TEXT         NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default LDAP config so the UI has entries to edit
INSERT INTO system_config (key, value) VALUES
    ('ldap_enabled', 'false'),
    ('ldap_server', 'ldap://localhost:389'),
    ('ldap_base_dn', 'dc=example,dc=com'),
    ('ldap_user_filter', '(uid={username})'),
    ('ldap_bind_dn', ''),
    ('ldap_bind_password', ''),
    ('ldap_username_attr', 'uid'),
    ('ldap_auto_create_user', 'true')
ON CONFLICT (key) DO NOTHING;

-- Seed empty Hermes config (admin must configure via UI)
INSERT INTO system_config (key, value) VALUES
    ('hermes_url', ''),
    ('hermes_api_key', '')
ON CONFLICT (key) DO NOTHING;

-- Seed empty LLM config (admin must configure via UI → 智能引擎)
INSERT INTO system_config (key, value) VALUES
    ('llm_base_url', ''),
    ('llm_api_key', ''),
    ('llm_model', ''),
    ('welcome_prompt', ''),
    ('skills_refresh_secs', '300'),
    ('distill_auto_enabled', 'false'),
    ('distill_interval_secs', '3600'),
    ('webhook_registered', '[]')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Chat modes — conversation presets with custom system prompts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_modes (
    id            SERIAL PRIMARY KEY,
    slug          VARCHAR(50)  NOT NULL UNIQUE,
    name          VARCHAR(100) NOT NULL,
    system_prompt TEXT         NOT NULL DEFAULT '',
    config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_modes_enabled ON chat_modes(enabled);

INSERT INTO chat_modes (slug, name, system_prompt, config, enabled) VALUES
    ('default', '智能助理',
     '你是一个专业的运维智能助手，帮助用户分析系统状态、排查故障、解读监控指标、推荐处置方案。请用清晰、简洁的语言回答用户的问题。',
     '{}'::jsonb, TRUE),
    ('general', '通用',
     '',
     '{"provider": "llm", "file_upload": true}'::jsonb, TRUE),
    ('rca', '故障定界',
     '你是一个专业的故障根因分析（RCA）助手。请严格按照以下步骤：1) 解析时间窗口和服务名称 2) 查询监控指标、日志、事务数据 3) 综合分析识别根因。以 JSON 格式返回结果，包含 root_cause、confidence、evidence、impacted_services、recommended_actions。',
     '{"time_window": true}'::jsonb, TRUE),
    ('knowledge', '知识问答',
     '你是一个知识库检索助手，基于 llm-wiki v2 知识库进行知识检索。请根据 llm-wiki v2 中的文档内容回答用户的问题。如果知识库中没有相关信息，请明确说明。回答时应引用知识库中的原文段落，确保信息的准确性和可追溯性。',
     '{}'::jsonb, TRUE)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS mode_slug VARCHAR(50);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS distillation_status VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_cs_distill_status ON chat_sessions(distillation_status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Data sources — external monitoring/telemetry connections
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_sources (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    type        VARCHAR(50)  NOT NULL,
    config      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_sources_type ON data_sources(type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Query templates — pre-built queries for data source types
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS query_templates (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    source_type VARCHAR(50)  NOT NULL,
    query       TEXT         NOT NULL,
    params      JSONB        DEFAULT '[]'::jsonb,
    description TEXT         DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qt_source_type ON query_templates(source_type);

-- Add unique constraint on name (safe for re-runs)
DO $$ BEGIN
    ALTER TABLE data_sources ADD CONSTRAINT uq_data_sources_name UNIQUE (name);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

INSERT INTO data_sources (name, type, config) VALUES
    ('Demo Prometheus', 'prometheus', '{"url": "http://localhost:9090", "query_interval": 60}'::jsonb),
    ('Demo ClickHouse', 'clickhouse', '{"host": "localhost", "port": 8123, "database": "default", "user": "default", "password": ""}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Knowledge Center — documents ingested into llm-wiki v2
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id                  SERIAL PRIMARY KEY,
    title               VARCHAR(255) NOT NULL,
    source_type         VARCHAR(20)  NOT NULL DEFAULT 'upload',
    source_name         VARCHAR(100),
    content             TEXT         NOT NULL DEFAULT '',
    processed_content   TEXT,
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
    hermes_session_id   VARCHAR(255),
    knowledge_id        VARCHAR(255),
    hit_count           INTEGER      NOT NULL DEFAULT 0,
    error_message       TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kd_status ON knowledge_documents(status);
CREATE INDEX IF NOT EXISTS idx_kd_source_type ON knowledge_documents(source_type);
CREATE INDEX IF NOT EXISTS idx_kd_source_name ON knowledge_documents(source_name);
CREATE INDEX IF NOT EXISTS idx_kd_type_name ON knowledge_documents(source_type, source_name);

-- Full-text search support for knowledge_documents
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_kd_title_trgm ON knowledge_documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kd_content_trgm ON knowledge_documents USING gin (content gin_trgm_ops);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Webhook request logs — monitoring for knowledge center webhooks
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS webhook_logs (
    id          SERIAL PRIMARY KEY,
    source      VARCHAR(100) NOT NULL,
    payload     JSONB        DEFAULT '{}'::jsonb,
    status      VARCHAR(20)  NOT NULL DEFAULT 'received',
    doc_id      INTEGER,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wl_source ON webhook_logs(source);
CREATE INDEX IF NOT EXISTS idx_wl_created ON webhook_logs(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Knowledge Distillation — auto-extracted knowledge from conversations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS distilled_knowledge (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(255) NOT NULL,
    content         TEXT         NOT NULL DEFAULT '',
    category        VARCHAR(50),
    tags            TEXT[],
    source_type     VARCHAR(20)  NOT NULL DEFAULT 'chat',
    source_ids      INTEGER[],
    score           REAL         NOT NULL DEFAULT 0,
    score_details   JSONB        DEFAULT '{}'::jsonb,
    status          VARCHAR(20)  NOT NULL DEFAULT 'candidate',
    reviewer_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    knowledge_id    VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dk_status ON distilled_knowledge(status);
CREATE INDEX IF NOT EXISTS idx_dk_score ON distilled_knowledge(score DESC);
CREATE INDEX IF NOT EXISTS idx_dk_category ON distilled_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_dk_source_type ON distilled_knowledge(source_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- User custom chat modes — private AI assistants
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_chat_modes (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    system_prompt   TEXT         NOT NULL DEFAULT '',
    icon            VARCHAR(10)  DEFAULT '🤖',
    provider        VARCHAR(10)  DEFAULT 'llm',
    enabled         BOOLEAN      DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ucm_user_id ON user_chat_modes(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Unanswered queries — knowledge blind spot tracking
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS unanswered_queries (
    id          SERIAL PRIMARY KEY,
    question    TEXT NOT NULL UNIQUE,
    count       INTEGER DEFAULT 1,
    last_asked  TIMESTAMPTZ DEFAULT NOW(),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uq_count ON unanswered_queries(count DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Application systems — lightweight index for Hermes mem0-backed system profiles
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_systems (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL UNIQUE,
    tier        VARCHAR(10)  NOT NULL DEFAULT 'L2',
    status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    description VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_system_resources (
    id            SERIAL PRIMARY KEY,
    system_id     INTEGER NOT NULL REFERENCES app_systems(id) ON DELETE CASCADE,
    resource_type VARCHAR(30) NOT NULL,
    resource_id   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(system_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_asr_system_id ON app_system_resources(system_id);
CREATE INDEX IF NOT EXISTS idx_asr_type_id ON app_system_resources(resource_type, resource_id);
