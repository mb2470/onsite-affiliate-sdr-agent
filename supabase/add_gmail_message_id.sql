-- ============================================
-- Migration: Add gmail_message_id to email_conversations
-- ============================================
-- The gmail-inbox.js function needs a dedicated column to store
-- Gmail's internal message ID (e.g. "18e1a2b3c4d5e6f7") for:
--   1. Deduplication during sync (skip already-imported messages)
--   2. Linking conversations to Gmail messages for mark-read/thread
--
-- The existing thread_id column already handles Gmail thread IDs.
-- The existing message_id column is for RFC 2822 Message-ID headers.
--
-- Prerequisites:
--   - add_email_outreach.sql (email_conversations table)
-- ============================================

ALTER TABLE email_conversations
  ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_email_conversations_gmail_message_id
  ON email_conversations(gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;
