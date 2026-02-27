-- ============================================
-- Multi-Tenant Migration: Step 2 — Org-Scoped RLS Policies
-- ============================================
-- Replaces the permissive "all authenticated users" policies
-- with org-scoped policies so each user only sees data belonging
-- to their organization(s).
--
-- Prerequisite: add_multi_tenant.sql must have been run first
-- (creates organizations, user_organizations, org_id columns,
--  and get_user_org_ids() helper function).
--
-- NOTE: The Python agent uses SUPABASE_SERVICE_KEY which bypasses
-- RLS entirely. These policies only affect frontend (anon key) access.
-- ============================================


-- ============================================
-- 1. DROP OLD PERMISSIVE POLICIES
-- ============================================
-- Safe: DROP IF EXISTS avoids errors if policies were already removed.

DROP POLICY IF EXISTS "Allow all for authenticated users" ON organizations;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON user_organizations;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON leads;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON contacts;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON emails;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON agent_jobs;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON icp_profiles;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON audit_log;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON contact_database;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON outreach_log;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON activity_log;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON agent_settings;


-- ============================================
-- 2. ORGANIZATIONS — users see orgs they belong to
-- ============================================
CREATE POLICY "Users can view their organizations"
  ON organizations FOR SELECT
  USING (id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their organizations"
  ON organizations FOR UPDATE
  USING (id IN (SELECT get_user_org_ids()));

-- Any authenticated user can create an org (they become owner)
CREATE POLICY "Authenticated users can create organizations"
  ON organizations FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');


-- ============================================
-- 3. USER_ORGANIZATIONS — users see their own memberships
-- ============================================
CREATE POLICY "Users can view their memberships"
  ON user_organizations FOR SELECT
  USING (user_id = auth.uid());

-- Users can add themselves to an org (signup flow)
CREATE POLICY "Users can create their own memberships"
  ON user_organizations FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can leave an org
CREATE POLICY "Users can delete their own memberships"
  ON user_organizations FOR DELETE
  USING (user_id = auth.uid());


-- ============================================
-- 4. LEADS — org-scoped
-- ============================================
CREATE POLICY "Users can view their org leads"
  ON leads FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert leads into their org"
  ON leads FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org leads"
  ON leads FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org leads"
  ON leads FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 5. CONTACTS — org-scoped
-- ============================================
CREATE POLICY "Users can view their org contacts"
  ON contacts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert contacts into their org"
  ON contacts FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org contacts"
  ON contacts FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org contacts"
  ON contacts FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 6. EMAILS — org-scoped
-- ============================================
CREATE POLICY "Users can view their org emails"
  ON emails FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert emails into their org"
  ON emails FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org emails"
  ON emails FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org emails"
  ON emails FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 7. AGENT_JOBS — org-scoped
-- ============================================
CREATE POLICY "Users can view their org jobs"
  ON agent_jobs FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert jobs into their org"
  ON agent_jobs FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org jobs"
  ON agent_jobs FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org jobs"
  ON agent_jobs FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 8. ICP_PROFILES — org-scoped
-- ============================================
CREATE POLICY "Users can view their org ICP profiles"
  ON icp_profiles FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert ICP profiles into their org"
  ON icp_profiles FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org ICP profiles"
  ON icp_profiles FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org ICP profiles"
  ON icp_profiles FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 9. AUDIT_LOG — org-scoped, read-only for users
-- ============================================
-- Users can read their org's audit trail but not modify it.
-- Writes come from the backend agent (service key, bypasses RLS).

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org audit logs"
  ON audit_log FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 10. CONTACT_DATABASE — org-scoped
-- ============================================
-- Each org has their own uploaded contacts.

ALTER TABLE contact_database ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org contact database"
  ON contact_database FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert into their org contact database"
  ON contact_database FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org contact database"
  ON contact_database FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 11. OUTREACH_LOG — org-scoped, read-only for users
-- ============================================
-- Writes come from the agent (service key). Users can view.

DO $$ BEGIN
  EXECUTE 'ALTER TABLE outreach_log ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'outreach_log') THEN
    EXECUTE 'CREATE POLICY "Users can view their org outreach" ON outreach_log FOR SELECT USING (org_id IN (SELECT get_user_org_ids()))';
  END IF;
END $$;


-- ============================================
-- 12. ACTIVITY_LOG — org-scoped, read-only for users
-- ============================================

DO $$ BEGIN
  EXECUTE 'ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'activity_log') THEN
    EXECUTE 'CREATE POLICY "Users can view their org activity" ON activity_log FOR SELECT USING (org_id IN (SELECT get_user_org_ids()))';
  END IF;
END $$;


-- ============================================
-- 13. AGENT_SETTINGS — org-scoped
-- ============================================

DO $$ BEGIN
  EXECUTE 'ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'agent_settings') THEN
    EXECUTE 'CREATE POLICY "Users can view their org agent settings" ON agent_settings FOR SELECT USING (org_id IN (SELECT get_user_org_ids()))';
    EXECUTE 'CREATE POLICY "Users can update their org agent settings" ON agent_settings FOR UPDATE USING (org_id IN (SELECT get_user_org_ids()))';
  END IF;
END $$;


-- ============================================
-- DONE! Org-scoped RLS policies are active.
--
-- Reminder:
--   - Frontend (anon key): sees only their org's data
--   - Python agent (service key): bypasses RLS, sees all data
--   - Rows with NULL org_id are invisible to frontend users
--     (backfill org_id on existing data to make them visible)
-- ============================================
