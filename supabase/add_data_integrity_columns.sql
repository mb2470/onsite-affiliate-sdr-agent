-- Migration: Data Integrity Improvements
-- Adds structured columns for bounce tracking to eliminate regex parsing
-- of free-text summary fields.
--
-- Changes:
--   1. activity_log.bounced_email  — Stores the bounced email address directly
--   2. outreach_log.bounced        — Boolean flag for bounced outreach rows
--
-- These columns replace the fragile pattern of extracting emails from
-- activity_log.summary via regex (/Bounced:\s+(\S+@\S+)/i).

-- 1. Add bounced_email column to activity_log
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'activity_log' AND column_name = 'bounced_email'
    ) THEN
        ALTER TABLE activity_log ADD COLUMN bounced_email TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_activity_log_bounced_email
    ON activity_log(bounced_email)
    WHERE bounced_email IS NOT NULL;

-- 2. Add bounced flag to outreach_log
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'bounced'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN bounced BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_log_bounced
    ON outreach_log(bounced)
    WHERE bounced = TRUE;

-- 3. Backfill: populate bounced_email from existing activity_log summary text
UPDATE activity_log
SET bounced_email = LOWER(TRIM((regexp_match(summary, 'Bounced:\s+(\S+@\S+)', 'i'))[1]))
WHERE activity_type = 'email_bounced'
  AND bounced_email IS NULL
  AND summary ~ 'Bounced:\s+\S+@\S+';

-- 4. Backfill: mark outreach_log rows as bounced where a bounce activity exists
UPDATE outreach_log ol
SET bounced = TRUE
WHERE bounced = FALSE
  AND EXISTS (
    SELECT 1 FROM activity_log al
    WHERE al.activity_type = 'email_bounced'
      AND al.bounced_email IS NOT NULL
      AND LOWER(ol.contact_email) = al.bounced_email
      AND (al.org_id = ol.org_id OR al.org_id IS NULL)
  );
