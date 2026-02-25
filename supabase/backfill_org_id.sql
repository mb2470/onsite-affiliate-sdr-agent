-- ============================================
-- Multi-Tenant Migration: Step 3 — Backfill org_id
-- ============================================
-- Creates a default organization, links the current user to it,
-- and backfills org_id on all existing rows so they become visible
-- under the new RLS policies.
--
-- Prerequisite: add_multi_tenant.sql and add_rls_policies.sql
-- must have been run first.
--
-- IMPORTANT: Run this in the Supabase SQL Editor while logged in,
-- or replace the auth.uid() calls with your actual user UUID.
-- ============================================


-- ============================================
-- 1. CREATE DEFAULT ORGANIZATION
-- ============================================
-- Insert a default org (skip if it already exists by slug).
INSERT INTO organizations (id, name, slug)
VALUES (
  uuid_generate_v4(),
  'Onsite Affiliate',
  'onsite-affiliate'
)
ON CONFLICT (slug) DO NOTHING;


-- ============================================
-- 2. LINK CURRENT USER TO THE ORG
-- ============================================
-- Grabs the first user from auth.users and makes them owner.
-- If you have multiple users, adjust accordingly.
DO $$
DECLARE
  v_org_id UUID;
  v_user_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  SELECT id INTO v_user_id FROM auth.users LIMIT 1;

  IF v_user_id IS NOT NULL AND v_org_id IS NOT NULL THEN
    INSERT INTO user_organizations (user_id, org_id, role)
    VALUES (v_user_id, v_org_id, 'owner')
    ON CONFLICT (user_id, org_id) DO NOTHING;
  END IF;
END $$;


-- ============================================
-- 3. BACKFILL org_id ON ALL DATA TABLES
-- ============================================
-- Sets org_id for every row where it is currently NULL.
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';

  UPDATE leads SET org_id = v_org_id WHERE org_id IS NULL;
  UPDATE contacts SET org_id = v_org_id WHERE org_id IS NULL;
  UPDATE emails SET org_id = v_org_id WHERE org_id IS NULL;
  UPDATE agent_jobs SET org_id = v_org_id WHERE org_id IS NULL;
  UPDATE icp_profiles SET org_id = v_org_id WHERE org_id IS NULL;

  -- These tables may not exist yet — guard with IF EXISTS
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'audit_log') THEN
    EXECUTE 'UPDATE audit_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'contact_database') THEN
    EXECUTE 'UPDATE contact_database SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'outreach_log') THEN
    EXECUTE 'UPDATE outreach_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'activity_log') THEN
    EXECUTE 'UPDATE activity_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'agent_settings') THEN
    EXECUTE 'UPDATE agent_settings SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  RAISE NOTICE 'Backfill complete for org %', v_org_id;
END $$;


-- ============================================
-- DONE! All existing data now belongs to the
-- "onsite-affiliate" organization.
--
-- Your chatbot/frontend should now be able to
-- see all the data again through the RLS policies.
-- ============================================
