-- ============================================
-- Backfill Step 2: Core tables (batched)
-- ============================================
-- Run this SECOND. Updates rows in batches of
-- 500 to avoid statement timeouts.
-- ============================================

SET statement_timeout = '120s';

-- Backfill leads (batched)
DO $$
DECLARE
  v_org_id UUID;
  v_rows INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  LOOP
    UPDATE prospects SET org_id = v_org_id
    WHERE id IN (
      SELECT id FROM prospects WHERE org_id IS NULL LIMIT 500
    );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXIT WHEN v_rows = 0;
    RAISE NOTICE 'prospects: updated % rows', v_rows;
  END LOOP;
END $$;

-- Backfill contacts (batched)
DO $$
DECLARE
  v_org_id UUID;
  v_rows INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  LOOP
    UPDATE contacts SET org_id = v_org_id
    WHERE id IN (
      SELECT id FROM contacts WHERE org_id IS NULL LIMIT 500
    );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXIT WHEN v_rows = 0;
    RAISE NOTICE 'contacts: updated % rows', v_rows;
  END LOOP;
END $$;

-- Backfill emails (batched)
DO $$
DECLARE
  v_org_id UUID;
  v_rows INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  LOOP
    UPDATE emails SET org_id = v_org_id
    WHERE id IN (
      SELECT id FROM emails WHERE org_id IS NULL LIMIT 500
    );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXIT WHEN v_rows = 0;
    RAISE NOTICE 'emails: updated % rows', v_rows;
  END LOOP;
END $$;

-- Backfill agent_jobs (usually small, no batching needed)
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  UPDATE agent_jobs SET org_id = v_org_id WHERE org_id IS NULL;
END $$;

-- Backfill icp_profiles (usually small, no batching needed)
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  UPDATE icp_profiles SET org_id = v_org_id WHERE org_id IS NULL;
END $$;

-- Verify counts
SELECT 'prospects' AS tbl, count(*) AS total, count(*) FILTER (WHERE org_id IS NULL) AS still_null FROM prospects
UNION ALL
SELECT 'contacts', count(*), count(*) FILTER (WHERE org_id IS NULL) FROM contacts
UNION ALL
SELECT 'emails', count(*), count(*) FILTER (WHERE org_id IS NULL) FROM emails
UNION ALL
SELECT 'agent_jobs', count(*), count(*) FILTER (WHERE org_id IS NULL) FROM agent_jobs
UNION ALL
SELECT 'icp_profiles', count(*), count(*) FILTER (WHERE org_id IS NULL) FROM icp_profiles;
