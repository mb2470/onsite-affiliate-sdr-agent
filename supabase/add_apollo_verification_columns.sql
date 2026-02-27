-- Add Apollo email verification columns to contacts and contact_database tables
-- These track results from Apollo's People Match API (POST /v1/people/match)
--
-- apollo_email_status: The email_status/verification_status from Apollo
--   verified     = confirmed inbox exists, safe to send
--   extrapolated = likely correct pattern, needs secondary verification
--   catch_all    = server accepts all mail, proceed with caution
--   invalid      = dead email, discard
--   unavailable  = could not determine
--
-- apollo_verified_at: Timestamp of last Apollo verification (30-day cache)

-- Contacts table (per-lead contact associations)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS apollo_email_status TEXT,
  ADD COLUMN IF NOT EXISTS apollo_verified_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_contacts_apollo_email_status
  ON contacts(apollo_email_status);

CREATE INDEX IF NOT EXISTS idx_contacts_apollo_verified_at
  ON contacts(apollo_verified_at);

-- Contact database table (500k+ master contact list)
ALTER TABLE contact_database
  ADD COLUMN IF NOT EXISTS apollo_email_status TEXT,
  ADD COLUMN IF NOT EXISTS apollo_verified_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_contact_db_apollo_email_status
  ON contact_database(apollo_email_status);
