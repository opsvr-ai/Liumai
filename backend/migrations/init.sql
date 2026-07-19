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
    CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE rca_trigger_type AS ENUM ('passive', 'active');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE rca_status AS ENUM ('queued', 'running', 'completed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE collab_event_type AS ENUM (
        'group_created',
        'member_joined',
        'agent_progress',
        'manual_finding',
        'bot_mentioned',
        'rca_completed'
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
    role        user_role    NOT NULL DEFAULT 'viewer',
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
    status              rca_status       NOT NULL DEFAULT 'queued',
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

INSERT INTO users (id, team_id, username, role)
    VALUES (1, 1, 'admin', 'admin')
    ON CONFLICT (id) DO NOTHING;
