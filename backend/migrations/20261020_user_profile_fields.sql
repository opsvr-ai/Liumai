-- ═══════════════════════════════════════════════════════════════════════════════
-- 2026-10-20 · LDAP profile mirror on users (existing installations)
-- ═══════════════════════════════════════════════════════════════════════════════
-- New database volumes already get these columns from init.sql.  Run this file
-- against an existing deployment (from the repository root, PowerShell):
--
--   Get-Content backend/migrations/20261020_user_profile_fields.sql -Raw |
--     docker exec -i liumai-postgres psql -U liumai -d liumai -v ON_ERROR_STOP=1
--
-- Idempotent: every column/index/seed is guarded, so re-running it (or running
-- it on a database that already has the columns) is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Name / e-mail / department mirrored from LDAP on every successful login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(255);

-- LDAP attribute names used to fill the three columns above (admin-editable).
INSERT INTO system_config (key, value) VALUES
    ('ldap_display_name_attr', 'displayName'),
    ('ldap_email_attr', 'mail'),
    ('ldap_department_attr', 'department')
ON CONFLICT (key) DO NOTHING;

-- Verification (should return three rows):
--   SELECT column_name, data_type, character_maximum_length
--     FROM information_schema.columns
--    WHERE table_name = 'users'
--      AND column_name IN ('display_name', 'email', 'department');
