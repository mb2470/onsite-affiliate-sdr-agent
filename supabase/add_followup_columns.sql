-- Migration: Add follow-up email tracking columns to outreach_log
-- Required for the automated follow-up sequence feature.
--
-- New columns:
--   followup_number    — 0 = initial, 1 = follow-up #1, 2 = follow-up #2
--   gmail_message_id   — Gmail API message ID (for threading)
--   gmail_thread_id    — Gmail thread ID (for threading & reply detection)
--   rfc_message_id     — RFC 2822 Message-ID header (for In-Reply-To)
--   parent_outreach_id — References the initial outreach row this follows up on
--   replied            — Whether the prospect replied to this thread

-- Add columns (safe to re-run — uses IF NOT EXISTS pattern via DO block)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'followup_number'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN followup_number INTEGER DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'gmail_message_id'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN gmail_message_id TEXT DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'gmail_thread_id'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN gmail_thread_id TEXT DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'rfc_message_id'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN rfc_message_id TEXT DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'parent_outreach_id'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN parent_outreach_id UUID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_log' AND column_name = 'replied'
    ) THEN
        ALTER TABLE outreach_log ADD COLUMN replied BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Indexes for efficient follow-up queries
CREATE INDEX IF NOT EXISTS idx_outreach_log_followup_number
    ON outreach_log(followup_number);

CREATE INDEX IF NOT EXISTS idx_outreach_log_gmail_thread_id
    ON outreach_log(gmail_thread_id);

CREATE INDEX IF NOT EXISTS idx_outreach_log_sent_at_followup
    ON outreach_log(sent_at, followup_number);

-- Backfill: mark all existing outreach rows as initial emails (followup_number = 0)
UPDATE outreach_log SET followup_number = 0 WHERE followup_number IS NULL;
