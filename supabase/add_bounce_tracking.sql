-- ============================================
-- Migration: Robust bounce tracking
-- ============================================
-- Replaces fragile regex-parsing of activity_log.summary with:
--   1. activity_log.bounced_email   — stores the bounced address directly
--   2. outreach_log.bounced         — direct flag on each sent email
--   3. outreach_log.bounced_at      — timestamp of when bounce was detected
--
-- This fixes:
--   - Suppression silently breaking when summary format changes
--   - Inability to query "all sends to this bounced address" efficiently
--   - campaign_leads sequences continuing after bounce
-- ============================================

-- 1. Add bounced_email column to activity_log
ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS bounced_email TEXT;

CREATE INDEX IF NOT EXISTS idx_activity_log_bounced_email
  ON activity_log(org_id, bounced_email)
  WHERE bounced_email IS NOT NULL;

-- 2. Add bounced flag + timestamp to outreach_log
ALTER TABLE outreach_log
  ADD COLUMN IF NOT EXISTS bounced BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE outreach_log
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outreach_log_bounced
  ON outreach_log(org_id, bounced)
  WHERE bounced = TRUE;

-- 3. Backfill: populate bounced_email from existing activity_log entries
--    Extracts email from summary text like "Bounced: user@example.com — removed from contacts"
UPDATE activity_log
SET bounced_email = LOWER(
  TRIM(
    SUBSTRING(summary FROM 'Bounced:\s+(\S+@\S+)')
  )
)
WHERE activity_type = 'email_bounced'
  AND bounced_email IS NULL
  AND summary ~ 'Bounced:\s+\S+@\S+';

-- 4. Backfill: mark outreach_log rows as bounced for already-known bounce addresses
UPDATE outreach_log ol
SET
  bounced    = TRUE,
  bounced_at = al.created_at
FROM activity_log al
WHERE al.activity_type = 'email_bounced'
  AND al.bounced_email IS NOT NULL
  AND al.org_id       = ol.org_id
  AND al.bounced_email = LOWER(ol.contact_email)
  AND ol.bounced = FALSE;
