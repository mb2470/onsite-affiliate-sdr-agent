-- Add email verification status column to contact_database
-- Caches EmailListVerify results so we can batch-verify contacts
-- and skip re-verification at send time.

ALTER TABLE contact_database
  ADD COLUMN IF NOT EXISTS elv_status TEXT,
  ADD COLUMN IF NOT EXISTS elv_verified_at TIMESTAMP WITH TIME ZONE;

-- Index for quickly finding unverified contacts
CREATE INDEX IF NOT EXISTS idx_contact_db_elv_status ON contact_database(elv_status);

COMMENT ON COLUMN contact_database.elv_status IS 'EmailListVerify result: ok, ok_for_all, accept_all, invalid, email_disabled, dead_server, syntax_error, unknown, error, etc.';
COMMENT ON COLUMN contact_database.elv_verified_at IS 'When the email was last verified via EmailListVerify';
