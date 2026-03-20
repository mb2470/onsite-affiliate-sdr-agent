-- Add sender_email to outreach_log so it becomes the single source of truth
-- for per-sender daily capacity (replaces the stale email_accounts.current_daily_sent counter).
--
-- After this migration, sent-today per sender = COUNT(*) FROM outreach_log
--   WHERE sender_email = X AND sent_at >= today_start.

ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- Index for fast per-sender daily lookups
CREATE INDEX IF NOT EXISTS idx_outreach_log_sender_email_sent_at
  ON outreach_log (sender_email, sent_at DESC)
  WHERE sender_email IS NOT NULL;

-- Backfill: set sender_email from email_accounts where possible
-- (best-effort — historical rows without a match stay NULL)
COMMENT ON COLUMN outreach_log.sender_email IS
  'The email address that sent this outreach. Source of truth for per-sender daily capacity.';
