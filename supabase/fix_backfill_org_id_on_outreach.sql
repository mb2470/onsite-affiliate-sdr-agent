-- Fix: Backfill org_id on outreach_log and activity_log rows that are missing it.
-- The Python agent was not setting org_id on inserts, so these rows were invisible
-- to the frontend dashboard which filters by org_id.
--
-- This uses the org_id from agent_settings (single-tenant scenario).
-- Run this once to fix historical data.

-- Step 1: Backfill outreach_log rows missing org_id
UPDATE outreach_log
SET org_id = (SELECT org_id FROM agent_settings LIMIT 1)
WHERE org_id IS NULL
  AND (SELECT org_id FROM agent_settings LIMIT 1) IS NOT NULL;

-- Step 2: Backfill activity_log rows missing org_id
UPDATE activity_log
SET org_id = (SELECT org_id FROM agent_settings LIMIT 1)
WHERE org_id IS NULL
  AND (SELECT org_id FROM agent_settings LIMIT 1) IS NOT NULL;

-- Verify: Check remaining NULLs
SELECT 'outreach_log' AS tbl, COUNT(*) AS null_org_id_count
FROM outreach_log WHERE org_id IS NULL
UNION ALL
SELECT 'activity_log', COUNT(*)
FROM activity_log WHERE org_id IS NULL;
