-- Add prospect_id to outreach_log and activity_log.
-- Nullable: existing rows keep lead_id; prospect-mode rows will use prospect_id.
-- Safe to re-run (IF NOT EXISTS on columns and indexes).

-- 1. outreach_log
ALTER TABLE outreach_log
  ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_log_prospect_id
  ON outreach_log (prospect_id);

-- 2. activity_log
ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_log_prospect_id
  ON activity_log (prospect_id);
