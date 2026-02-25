-- ============================================
-- Multi-Tenant Migration: Step 1 — Database Schema
-- ============================================
-- This migration adds organization-based multi-tenancy to the database.
-- All data tables get an org_id column linking them to an organization.
-- org_id is NULLABLE initially so existing data isn't broken.
-- A follow-up migration will backfill org_id for existing rows.
--
-- Run this AFTER the base schema.sql and all prior migrations.
-- ============================================


-- ============================================
-- 1. ORGANIZATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Org identity
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,  -- URL-friendly identifier (e.g., "onsite-affiliate")

  -- Billing/plan (future use)
  plan TEXT DEFAULT 'free',

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 2. USER_ORGANIZATIONS TABLE (many-to-many)
-- ============================================
-- Maps Supabase auth users to organizations with a role.
-- A user can belong to multiple orgs; an org can have multiple users.
CREATE TABLE IF NOT EXISTS user_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),

  UNIQUE(user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_user_orgs_user_id ON user_organizations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_orgs_org_id ON user_organizations(org_id);


-- ============================================
-- 3. ADD org_id TO ALL DATA TABLES
-- ============================================
-- Using DO blocks for idempotency (safe to re-run).

-- 3a. leads
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE leads ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_leads_org_id ON leads(org_id);
  END IF;
END $$;

-- 3b. contacts
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contacts' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE contacts ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_contacts_org_id ON contacts(org_id);
  END IF;
END $$;

-- 3c. emails
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'emails' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE emails ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_emails_org_id ON emails(org_id);
  END IF;
END $$;

-- 3d. agent_jobs
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_jobs' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE agent_jobs ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_agent_jobs_org_id ON agent_jobs(org_id);
  END IF;
END $$;

-- 3e. icp_profiles
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'icp_profiles' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE icp_profiles ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_icp_profiles_org_id ON icp_profiles(org_id);
  END IF;
END $$;

-- 3f. audit_log
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_log' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE audit_log ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_audit_log_org_id ON audit_log(org_id);
  END IF;
END $$;

-- 3g. contact_database
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_database' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE contact_database ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_contact_database_org_id ON contact_database(org_id);
  END IF;
END $$;

-- 3h. outreach_log
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'outreach_log' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE outreach_log ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_outreach_log_org_id ON outreach_log(org_id);
  END IF;
END $$;

-- 3i. activity_log
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activity_log' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE activity_log ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_activity_log_org_id ON activity_log(org_id);
  END IF;
END $$;

-- 3j. agent_settings
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_settings' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE agent_settings ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
    CREATE INDEX idx_agent_settings_org_id ON agent_settings(org_id);
  END IF;
END $$;


-- ============================================
-- 4. RLS ON NEW TABLES
-- ============================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_organizations ENABLE ROW LEVEL SECURITY;

-- Temporary permissive policies (will be replaced in Step 2 migration)
CREATE POLICY "Allow all for authenticated users" ON organizations
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON user_organizations
  FOR ALL USING (auth.role() = 'authenticated');


-- ============================================
-- 5. HELPER FUNCTION: get user's org IDs
-- ============================================
-- This function will be used by RLS policies in Step 2.
-- Creating it now so it's available for testing.
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM user_organizations WHERE user_id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;


-- ============================================
-- 6. UPDATE VIEWS TO INCLUDE org_id
-- ============================================
-- Drop and recreate views so they include the new org_id column.

DROP VIEW IF EXISTS leads_with_stats;
CREATE VIEW leads_with_stats AS
SELECT
  l.*,
  COUNT(DISTINCT c.id) as contact_count,
  COUNT(DISTINCT e.id) as email_count,
  MAX(e.sent_at) as last_contacted_at,
  SUM(CASE WHEN e.replied THEN 1 ELSE 0 END) as reply_count
FROM leads l
LEFT JOIN contacts c ON c.lead_id = l.id
LEFT JOIN emails e ON e.lead_id = l.id
GROUP BY l.id;

DROP VIEW IF EXISTS pipeline_metrics;
CREATE VIEW pipeline_metrics AS
SELECT
  org_id,
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN icp_fit = 'HIGH' THEN 1 END) as high_fit_count,
  COUNT(CASE WHEN icp_fit = 'MEDIUM' THEN 1 END) as medium_fit_count,
  COUNT(CASE WHEN icp_fit = 'LOW' THEN 1 END) as low_fit_count
FROM leads
GROUP BY org_id, status;


-- ============================================
-- DONE! Multi-tenant schema infrastructure is ready.
-- Next steps:
--   Step 2: Replace permissive RLS policies with org-scoped ones
--   Step 3: Update frontend services to pass org_id
--   Step 4: Update Python agent to accept org_id
-- ============================================
