-- Add email verification columns to the contacts table
-- Tracks when each contact email was verified via EmailListVerify
-- so we can gate sending on a valid verification and skip re-verification
-- for 30 days.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS elv_status TEXT,
  ADD COLUMN IF NOT EXISTS elv_verified_at TIMESTAMP WITH TIME ZONE;

-- Index for quickly finding unverified or stale contacts
CREATE INDEX IF NOT EXISTS idx_contacts_elv_status ON contacts(elv_status);
CREATE INDEX IF NOT EXISTS idx_contacts_elv_verified_at ON contacts(elv_verified_at);

COMMENT ON COLUMN contacts.elv_status IS 'EmailListVerify result: ok, ok_for_all, accept_all, invalid, email_disabled, dead_server, syntax_error, etc.';
COMMENT ON COLUMN contacts.elv_verified_at IS 'When the email was last verified via EmailListVerify — re-verify after 30 days';
