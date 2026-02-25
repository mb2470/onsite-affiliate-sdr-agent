-- Fix foreign keys that block lead deletion.
--
-- activity_log.lead_id and outreach_log.lead_id reference leads(id)
-- but were created WITHOUT ON DELETE CASCADE, so deleting a lead that
-- has activity or outreach rows fails with a FK violation.
--
-- activity_log: SET NULL on delete (keep the log entry, just clear lead_id)
-- outreach_log: CASCADE on delete (remove outreach rows when lead is deleted)

-- 1. activity_log — set lead_id to NULL when the lead is deleted
ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_lead_id_fkey;

ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

-- 2. outreach_log — cascade delete when the lead is deleted
ALTER TABLE outreach_log
  DROP CONSTRAINT IF EXISTS outreach_log_lead_id_fkey;

ALTER TABLE outreach_log
  ADD CONSTRAINT outreach_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
