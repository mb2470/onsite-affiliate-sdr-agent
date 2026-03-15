-- Migration: Add replied_at column to outreach_log
-- Required for reply tracking in check-replies.js and ai_sdr_agent.py.
--
-- outreach_log.replied_at records when a prospect's reply was first detected.
-- It is set by:
--   - check-replies.js  (Netlify function)
--   - ai_sdr_agent.py   check_replies() and process_followups()
--
-- Safe to re-run — uses IF NOT EXISTS guard.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'replied_at'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN replied_at TIMESTAMPTZ;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_log_replied_at
    ON outreach_log(replied_at)
    WHERE replied_at IS NOT NULL;
