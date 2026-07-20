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
    id          SERIAL PRIMARY KEY,
    team_id     INTEGER      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    username    VARCHAR(255) NOT NULL UNIQUE,
    role        user_role    NOT NULL DEFAULT 'VIEWER',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
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

-- Add password_hash column (safe for re-runs)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Add auth_type column (safe for re-runs)
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_type auth_type NOT NULL DEFAULT 'LDAP';

-- Seed admin with default password 'admin123' (bcrypt hash)
-- IMPORTANT: change this password in production!
INSERT INTO users (id, team_id, username, role, password_hash, auth_type)
    VALUES (1, 1, 'admin', 'ADMIN',
            '$2b$12$HlecgoPIhDe2E1maMkRVIeKxvyl/gJpAPsJKtDfrIGXRwyLphOKjS',
            'LOCAL')
    ON CONFLICT (id) DO NOTHING;

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

-- Seed default Hermes config
INSERT INTO system_config (key, value) VALUES
    ('hermes_url', 'http://host.docker.internal:8642/v1'),
    ('hermes_api_key', '')
ON CONFLICT (key) DO NOTHING;
