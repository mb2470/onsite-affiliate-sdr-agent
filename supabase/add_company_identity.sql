-- Introduce company_identity as canonical org-scoped company key.
-- This migration is idempotent and safe to run multiple times.

CREATE TABLE IF NOT EXISTS company_identity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  canonical_domain TEXT NOT NULL,
  source_urls JSONB DEFAULT '[]'::jsonb,
  UNIQUE(org_id, canonical_domain)
);

CREATE INDEX IF NOT EXISTS idx_company_identity_org_id ON company_identity(org_id);
CREATE INDEX IF NOT EXISTS idx_company_identity_canonical_domain ON company_identity(canonical_domain);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID;

CREATE INDEX IF NOT EXISTS idx_leads_company_id ON leads(company_id);
CREATE INDEX IF NOT EXISTS idx_storeleads_company_id ON storeleads(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_company_id_fkey'
      AND conrelid = 'leads'::regclass
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES company_identity(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'storeleads_company_id_fkey'
      AND conrelid = 'storeleads'::regclass
  ) THEN
    ALTER TABLE storeleads
      ADD CONSTRAINT storeleads_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES company_identity(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contacts_company_id_fkey'
      AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES company_identity(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION normalize_company_domain(input_value TEXT)
RETURNS TEXT AS $$
DECLARE
  domain TEXT;
BEGIN
  IF input_value IS NULL THEN
    RETURN NULL;
  END IF;

  domain := lower(trim(input_value));

  domain := regexp_replace(domain, '^https?://', '', 'i');
  domain := regexp_replace(domain, '^www\.', '', 'i');
  domain := split_part(domain, '/', 1);
  domain := split_part(domain, '?', 1);
  domain := split_part(domain, '#', 1);
  domain := trim(domain);

  IF domain = '' THEN
    RETURN NULL;
  END IF;

  RETURN domain;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION resolve_company_identity_id(p_org_id UUID, p_raw_domain TEXT, p_source_url TEXT DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
  v_domain TEXT;
  v_id UUID;
BEGIN
  v_domain := normalize_company_domain(p_raw_domain);

  IF p_org_id IS NULL OR v_domain IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO company_identity (org_id, canonical_domain, source_urls)
  VALUES (
    p_org_id,
    v_domain,
    CASE
      WHEN p_source_url IS NULL OR trim(p_source_url) = '' THEN '[]'::jsonb
      ELSE jsonb_build_array(p_source_url)
    END
  )
  ON CONFLICT (org_id, canonical_domain)
  DO UPDATE SET
    source_urls = CASE
      WHEN p_source_url IS NULL OR trim(p_source_url) = '' THEN company_identity.source_urls
      WHEN company_identity.source_urls @> jsonb_build_array(p_source_url) THEN company_identity.source_urls
      ELSE company_identity.source_urls || jsonb_build_array(p_source_url)
    END,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Backfill company_identity from existing leads + storeleads.
INSERT INTO company_identity (org_id, canonical_domain, source_urls)
SELECT
  src.org_id,
  src.canonical_domain,
  COALESCE(jsonb_agg(DISTINCT src.source_url) FILTER (WHERE src.source_url IS NOT NULL), '[]'::jsonb) AS source_urls
FROM (
  SELECT
    l.org_id,
    normalize_company_domain(l.website) AS canonical_domain,
    l.website AS source_url
  FROM leads l
  WHERE l.org_id IS NOT NULL

  UNION ALL

  SELECT
    s.org_id,
    normalize_company_domain(s.domain) AS canonical_domain,
    s.domain AS source_url
  FROM storeleads s
  WHERE s.org_id IS NOT NULL
) src
WHERE src.canonical_domain IS NOT NULL
GROUP BY src.org_id, src.canonical_domain
ON CONFLICT (org_id, canonical_domain)
DO UPDATE SET
  source_urls = (
    SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
    FROM jsonb_array_elements_text(
      COALESCE(company_identity.source_urls, '[]'::jsonb)
      || COALESCE(EXCLUDED.source_urls, '[]'::jsonb)
    ) AS elem
  ),
  updated_at = NOW();

UPDATE prospects l
SET company_id = ci.id
FROM company_identity ci
WHERE l.org_id = ci.org_id
  AND normalize_company_domain(l.website) = ci.canonical_domain
  AND (l.company_id IS NULL OR l.company_id <> ci.id);

UPDATE storeleads s
SET company_id = ci.id
FROM company_identity ci
WHERE s.org_id = ci.org_id
  AND normalize_company_domain(s.domain) = ci.canonical_domain
  AND (s.company_id IS NULL OR s.company_id <> ci.id);

UPDATE contacts c
SET company_id = p.company_id
FROM prospects p
WHERE c.lead_id = p.id
  AND (c.company_id IS NULL OR c.company_id <> p.company_id);

CREATE OR REPLACE FUNCTION set_prospect_company_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.company_id := resolve_company_identity_id(NEW.org_id, NEW.website, NEW.website);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_lead_company_id_on_write ON leads;
DROP TRIGGER IF EXISTS set_prospect_company_id_on_write ON prospects;
CREATE TRIGGER set_prospect_company_id_on_write
  BEFORE INSERT OR UPDATE OF org_id, website
  ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION set_prospect_company_id();

CREATE OR REPLACE FUNCTION set_storeleads_company_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.company_id := resolve_company_identity_id(NEW.org_id, NEW.domain, NEW.domain);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_storeleads_company_id_on_write ON storeleads;
CREATE TRIGGER set_storeleads_company_id_on_write
  BEFORE INSERT OR UPDATE OF org_id, domain
  ON storeleads
  FOR EACH ROW
  EXECUTE FUNCTION set_storeleads_company_id();

CREATE OR REPLACE FUNCTION set_contacts_company_id_from_lead()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id UUID;
BEGIN
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT company_id INTO v_company_id
  FROM leads
  WHERE id = NEW.lead_id;

  IF v_company_id IS NOT NULL THEN
    NEW.company_id := v_company_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_contacts_company_id_on_write ON contacts;
CREATE TRIGGER set_contacts_company_id_on_write
  BEFORE INSERT OR UPDATE OF lead_id
  ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_contacts_company_id_from_lead();
