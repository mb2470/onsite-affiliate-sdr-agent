-- ============================================
-- Backfill Step 3: Optional/extra tables
-- ============================================
-- Run this LAST. Handles tables that may or
-- may not exist in your schema.
-- ============================================

SET statement_timeout = '120s';

DO $$
DECLARE
  v_org_id UUID;
  v_rows INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';

  -- contact_database (batched — may be large)
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'contact_database') THEN
    LOOP
      EXECUTE 'UPDATE contact_database SET org_id = $1
               WHERE id IN (SELECT id FROM contact_database WHERE org_id IS NULL LIMIT 500)'
        USING v_org_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      EXIT WHEN v_rows = 0;
      RAISE NOTICE 'contact_database: updated % rows', v_rows;
    END LOOP;
  END IF;

  -- outreach_log
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'outreach_log') THEN
    EXECUTE 'UPDATE outreach_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  -- activity_log
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'activity_log') THEN
    EXECUTE 'UPDATE activity_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  -- audit_log
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    EXECUTE 'UPDATE audit_log SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  -- agent_settings
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agent_settings') THEN
    EXECUTE 'UPDATE agent_settings SET org_id = $1 WHERE org_id IS NULL' USING v_org_id;
  END IF;

  RAISE NOTICE 'Step 3 complete for org %', v_org_id;
END $$;
