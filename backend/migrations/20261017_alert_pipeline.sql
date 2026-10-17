-- ═══════════════════════════════════════════════════════════════════════════════
-- 2026-10-17 · Webhook alert pipeline migration (existing installations)
-- ═══════════════════════════════════════════════════════════════════════════════
-- New database volumes already get this schema from init.sql.  Run this file
-- against an existing deployment (from the repository root, PowerShell):
--
--   Get-Content backend/migrations/20261017_alert_pipeline.sql -Raw |
--     docker exec -i liumai-postgres psql -U liumai -d liumai -v ON_ERROR_STOP=1
--
-- Or mount/copy the file into the postgres container and use psql -f.
-- ═══════════════════════════════════════════════════════════════════════════════

-- RCA session metadata added by the alert-driven pipeline
ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS service_name VARCHAR(255);
ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS alert_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rca_sessions ADD COLUMN IF NOT EXISTS trigger_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_rca_sessions_service ON rca_sessions(service_name);

-- Inbound alert inbox / trash
CREATE TABLE IF NOT EXISTS alerts (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER      NOT NULL DEFAULT 1 REFERENCES teams(id) ON DELETE CASCADE,
    alert_uid       VARCHAR(128),
    dedup_key       VARCHAR(512),
    source          VARCHAR(100),
    ip              VARCHAR(100),
    ci_name         VARCHAR(255),
    ci_application  VARCHAR(255),
    ci_id           VARCHAR(255),
    content         TEXT,
    severity        VARCHAR(50),
    severity_level  INTEGER,
    alert_type      VARCHAR(50),
    metric          TEXT,
    alert_time      TIMESTAMPTZ,
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
    trigger_reason  TEXT,
    rca_session_id  INTEGER      REFERENCES rca_sessions(id) ON DELETE SET NULL,
    raw_payload     JSONB        DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_status        ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at    ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_alert_time    ON alerts(alert_time DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_alert_uid     ON alerts(alert_uid);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup_key     ON alerts(dedup_key);
CREATE INDEX IF NOT EXISTS idx_alerts_session       ON alerts(rca_session_id);

-- Structured RCA reports
CREATE TABLE IF NOT EXISTS rca_reports (
    id                  SERIAL PRIMARY KEY,
    team_id             INTEGER      NOT NULL DEFAULT 1,
    session_id          INTEGER      NOT NULL UNIQUE REFERENCES rca_sessions(id) ON DELETE CASCADE,
    service_name        VARCHAR(255),
    alert_count         INTEGER      NOT NULL DEFAULT 1,
    category            VARCHAR(50),
    root_cause          TEXT,
    confidence          REAL,
    evidence            JSONB        DEFAULT '[]'::jsonb,
    impacted_services   JSONB        DEFAULT '[]'::jsonb,
    recommended_actions JSONB        DEFAULT '[]'::jsonb,
    raw_output          TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rca_reports_service ON rca_reports(service_name);
CREATE INDEX IF NOT EXISTS idx_rca_reports_created ON rca_reports(created_at DESC);

-- Historical root-cause knowledge (L1 retrieval augmentation)
CREATE TABLE IF NOT EXISTS root_cause_knowledge (
    id           SERIAL PRIMARY KEY,
    team_id      INTEGER      NOT NULL DEFAULT 1,
    session_id   INTEGER      REFERENCES rca_sessions(id) ON DELETE SET NULL,
    service_name VARCHAR(255),
    alert_type   VARCHAR(50),
    title        VARCHAR(255),
    root_cause   TEXT,
    digest       TEXT,
    evidence     JSONB        DEFAULT '[]'::jsonb,
    label        VARCHAR(20)  NOT NULL DEFAULT 'pending',
    created_by   VARCHAR(255),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rck_service  ON root_cause_knowledge(service_name);
CREATE INDEX IF NOT EXISTS idx_rck_label    ON root_cause_knowledge(label);
CREATE INDEX IF NOT EXISTS idx_rck_created  ON root_cause_knowledge(created_at DESC);

-- Audit trail
CREATE TABLE IF NOT EXISTS audit_logs (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(255),
    action     VARCHAR(100) NOT NULL,
    detail     TEXT,
    ip         VARCHAR(100),
    extra      JSONB        DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs(action);

-- Runtime defaults for the alert pipeline
INSERT INTO system_config (key, value) VALUES
    ('rca_alert_mode', 'auto'),
    ('rca_alert_policy', '{}'),
    ('webhook_token', ''),
    ('alert_notify_enabled', 'false'),
    ('wecom_alert_chat_id', '')
ON CONFLICT (key) DO NOTHING;
