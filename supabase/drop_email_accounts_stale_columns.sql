-- Drop stale counter columns from email_accounts.
-- Per-sender daily counts are now derived from outreach_log.sender_email
-- (the single source of truth). These columns were no longer being updated
-- by any active send path.

ALTER TABLE public.email_accounts DROP COLUMN IF EXISTS current_daily_sent;
ALTER TABLE public.email_accounts DROP COLUMN IF EXISTS last_sent_at;
