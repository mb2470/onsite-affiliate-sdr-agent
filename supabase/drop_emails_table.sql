-- Migration: Drop the unused `emails` table and fix dependent views.
--
-- The `emails` table was never written to by the send pipeline.
-- All email activity (sent, bounced, replied) lives in `outreach_log`.
-- This migration:
--   1. Drops the `leads_with_stats` view (it JOINs emails)
--   2. Drops the `emails` table
--   3. Recreates `leads_with_stats` using `outreach_log` (the actual source of truth)

-- Step 1: Drop the view that depends on the emails table
DROP VIEW IF EXISTS leads_with_stats CASCADE;

-- Step 2: Drop the emails table (nothing writes to it)
DROP TABLE IF EXISTS emails CASCADE;

-- Step 3: Recreate the view using outreach_log
CREATE VIEW leads_with_stats AS
SELECT
  l.*,
  COUNT(DISTINCT c.id) AS contact_count,
  COUNT(DISTINCT o.id) AS email_count,
  MAX(o.sent_at) AS last_contacted_at,
  COUNT(DISTINCT CASE WHEN o.replied_at IS NOT NULL THEN o.id END) AS reply_count
FROM leads l
LEFT JOIN contacts c ON c.lead_id = l.id
LEFT JOIN outreach_log o ON o.lead_id = l.id
GROUP BY l.id;
