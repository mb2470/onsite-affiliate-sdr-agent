-- ============================================
-- Prospect Database Migration
-- Medallion Architecture: Bronze → Silver → Gold
-- Multi-tenant with org_id per CLAUDE.md architecture rules
--
-- Tables created (purely additive — no existing tables modified):
--   1. prospects          (Gold)   — enriched company profiles
--   2. search_signals     (Bronze) — raw search results
--   3. company_crawls     (Silver) — crawled & cleaned page data
--   4. prospect_embeddings         — vector chunks for similarity search
--   5. prospect_contacts  (Gold)   — people at prospect companies
-- ============================================


-- ============================================
-- 0. EXTENSIONS
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================
-- 1. PROSPECTS TABLE (Gold Layer)
-- ============================================
-- Enriched, deduplicated company records. One row per company per org.
-- Website is normalized on write via trigger (section 8).

CREATE TABLE IF NOT EXISTS prospects (
  -- Primary Key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-Tenant (required per architecture — not in original spec)
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Hierarchy (for parent/subsidiary relationships)
  parent_id UUID REFERENCES prospects(id) ON DELETE SET NULL,

  -- ============================================
  -- Identity
  -- ============================================
  website TEXT NOT NULL,                -- normalized by trigger
  website_raw TEXT,                     -- original input preserved by trigger
  company_name TEXT NOT NULL,
  physical_address TEXT,
  city TEXT,
  email TEXT,
  phone TEXT,
  facebook_url TEXT,
  instagram_url TEXT,
  linkedin_url TEXT,

  -- ============================================
  -- Classification
  -- ============================================
  industry_primary TEXT,
  industry_sub TEXT,
  naics_code TEXT,
  business_model TEXT CHECK (business_model IN ('B2B', 'B2C', 'SaaS', 'Marketplace', 'D2C', 'Other')),
  target_market TEXT CHECK (target_market IN ('Enterprise', 'Mid-Market', 'SMB', 'Consumer')),

  -- ============================================
  -- Scale
  -- ============================================
  employee_range TEXT,
  employee_actual INTEGER,
  revenue_annual NUMERIC,
  funding_stage TEXT,
  total_funding NUMERIC,
  last_funding_date DATE,

  -- ============================================
  -- Geo
  -- ============================================
  hq_city TEXT,
  hq_country CHAR(2),
  timezone TEXT,
  is_public BOOLEAN DEFAULT FALSE,

  -- ============================================
  -- Technical
  -- ============================================
  technographics TEXT[],
  keywords TEXT[],

  -- ============================================
  -- Pipeline
  -- ============================================
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'enriching', 'enriched', 'qualified', 'contacted', 'engaged', 'disqualified'
  )),
  confidence_score NUMERIC(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  confidence_details JSONB,
  last_enriched_at TIMESTAMPTZ,
  enrichment_source TEXT,
  source_metadata JSONB,

  -- ============================================
  -- System
  -- ============================================
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ============================================
  -- Constraints
  -- ============================================
  UNIQUE(org_id, website)
);

-- Prospects indexes
CREATE INDEX idx_prospects_org_id ON prospects(org_id);
CREATE INDEX idx_prospects_status ON prospects(org_id, status);
CREATE INDEX idx_prospects_website ON prospects(website);
CREATE INDEX idx_prospects_company_name ON prospects(company_name);
CREATE INDEX idx_prospects_industry ON prospects(org_id, industry_primary);
CREATE INDEX idx_prospects_confidence ON prospects(org_id, confidence_score DESC);
CREATE INDEX idx_prospects_parent_id ON prospects(parent_id);
CREATE INDEX idx_prospects_last_enriched ON prospects(last_enriched_at);


-- ============================================
-- 2. SEARCH_SIGNALS TABLE (Bronze Layer)
-- ============================================
-- Raw search results captured before enrichment.
-- No org_id — scoped to org via prospect_id → prospects.org_id.
-- prospect_id is nullable (signals can exist before prospect linkage)
-- and ON DELETE SET NULL (preserve signal history if prospect is removed).

CREATE TABLE IF NOT EXISTS search_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to prospect (nullable — may be unlinked initially)
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,

  -- Search context
  search_query TEXT NOT NULL,
  source_platform TEXT,                 -- e.g. 'google', 'linkedin', 'crunchbase'
  search_type TEXT,                     -- e.g. 'company_discovery', 'contact_search'

  -- Raw result data
  raw_response JSONB NOT NULL,
  result_position INTEGER,              -- rank in search results
  result_snippet TEXT,                  -- preview text from result

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes per spec: prospect_id and search_query
CREATE INDEX idx_search_signals_prospect_id ON search_signals(prospect_id);
CREATE INDEX idx_search_signals_search_query ON search_signals(search_query);


-- ============================================
-- 3. COMPANY_CRAWLS TABLE (Silver Layer)
-- ============================================
-- Crawled and partially cleaned web page data for a prospect.
-- No org_id — scoped to org via prospect_id → prospects.org_id.
-- prospect_id is NOT NULL (every crawl belongs to a prospect).

CREATE TABLE IF NOT EXISTS company_crawls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent prospect (required)
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  -- Crawl target & result
  url_crawled TEXT NOT NULL,
  raw_markdown TEXT,                    -- raw markdown conversion of page
  cleaned_text TEXT,                    -- cleaned/stripped text content
  meta_description TEXT,                -- <meta name="description"> content
  detected_keywords TEXT[],             -- keywords extracted from page
  word_count INTEGER,
  http_status INTEGER,                  -- HTTP response status code

  -- System
  crawled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index per spec: prospect_id
CREATE INDEX idx_company_crawls_prospect_id ON company_crawls(prospect_id);


-- ============================================
-- 4. PROSPECT_EMBEDDINGS TABLE
-- ============================================
-- Vector chunks for semantic search / ICP matching.
-- No org_id — scoped to org via prospect_id → prospects.org_id.
-- Each row is one chunk from a crawled page.

CREATE TABLE IF NOT EXISTS prospect_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent references
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  crawl_id UUID REFERENCES company_crawls(id) ON DELETE CASCADE,

  -- Chunk data
  chunk_text TEXT,
  chunk_index INTEGER,
  page_source TEXT,                     -- URL or identifier of source page

  -- Vector embedding (OpenAI ada-002 / text-embedding-3-small dimension)
  embedding vector(1536),

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Standard indexes
CREATE INDEX idx_prospect_embeddings_prospect_id ON prospect_embeddings(prospect_id);

-- HNSW index for fast approximate nearest-neighbor cosine search
-- m=16 (max connections per node), ef_construction=64 (build-time search width)
CREATE INDEX idx_prospect_embeddings_hnsw ON prospect_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);


-- ============================================
-- 5. PROSPECT_CONTACTS TABLE (Gold Layer)
-- ============================================
-- People associated with prospect companies.
-- Mirrors the existing contacts table structure but FK to prospects(id)
-- instead of leads(id). Has its own org_id for direct RLS scoping.

CREATE TABLE IF NOT EXISTS prospect_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Parent prospect
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  -- Contact Info
  first_name TEXT,
  last_name TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT,

  -- Company Info (denormalized from prospect for convenience)
  company_name TEXT,
  company_website TEXT,

  -- Scoring
  match_score INTEGER DEFAULT 0,
  match_level TEXT CHECK (match_level IN ('Best Match', 'Great Match', 'Good Match', 'Possible Match')),
  match_reason TEXT,

  -- LinkedIn
  linkedin_url TEXT,

  -- Outreach state
  contacted BOOLEAN DEFAULT FALSE,
  contacted_at TIMESTAMPTZ,

  -- Source
  source TEXT DEFAULT 'csv_database',

  -- Verification (EmailListVerify)
  elv_status TEXT,
  elv_verified_at TIMESTAMPTZ,

  -- Verification (Apollo People Match)
  apollo_email_status TEXT,
  apollo_verified_at TIMESTAMPTZ,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One contact email per prospect
  UNIQUE(prospect_id, email)
);

-- Indexes per spec: prospect_id, email, match_score DESC, org_id
CREATE INDEX idx_prospect_contacts_org_id ON prospect_contacts(org_id);
CREATE INDEX idx_prospect_contacts_prospect_id ON prospect_contacts(prospect_id);
CREATE INDEX idx_prospect_contacts_email ON prospect_contacts(email);
CREATE INDEX idx_prospect_contacts_match_score ON prospect_contacts(match_score DESC);


-- ============================================
-- 6. UPDATED_AT AUTO-UPDATE TRIGGER
-- ============================================
-- Shared trigger function for all tables with updated_at column.

CREATE OR REPLACE FUNCTION update_prospect_tables_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- prospects.updated_at
CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION update_prospect_tables_updated_at();

-- prospect_contacts.updated_at
CREATE TRIGGER trg_prospect_contacts_updated_at
  BEFORE UPDATE ON prospect_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_prospect_tables_updated_at();


-- ============================================
-- 7. WEBSITE NORMALIZATION TRIGGER
-- ============================================
-- On INSERT/UPDATE of website: preserve raw input in website_raw,
-- then normalize website field.
-- Normalization steps: lowercase → strip protocol → strip www. → strip trailing slash
-- Consistent with normalize_company_domain() in add_company_identity.sql.

CREATE OR REPLACE FUNCTION normalize_prospect_website()
RETURNS TRIGGER AS $$
DECLARE
  raw_val TEXT;
  normalized TEXT;
BEGIN
  raw_val := NEW.website;

  -- Preserve the original input in website_raw (on insert, or when website changes)
  IF TG_OP = 'INSERT' OR OLD.website IS DISTINCT FROM NEW.website THEN
    NEW.website_raw := raw_val;
  END IF;

  -- Normalize: lowercase, strip protocol, strip www., strip trailing slash
  IF raw_val IS NOT NULL THEN
    normalized := lower(trim(raw_val));
    normalized := regexp_replace(normalized, '^https?://', '');
    normalized := regexp_replace(normalized, '^www\.', '');
    normalized := regexp_replace(normalized, '/+$', '');
    -- Strip query string and fragment
    normalized := split_part(normalized, '?', 1);
    normalized := split_part(normalized, '#', 1);
    normalized := trim(normalized);

    IF normalized = '' THEN
      normalized := raw_val;  -- fallback: keep original if normalization empties it
    END IF;

    NEW.website := normalized;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prospects_normalize_website
  BEFORE INSERT OR UPDATE OF website ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION normalize_prospect_website();


-- ============================================
-- 8. ROW LEVEL SECURITY
-- ============================================
-- Enable RLS on all five new tables.

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_crawls ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_contacts ENABLE ROW LEVEL SECURITY;


-- ============================================
-- 9. RLS POLICIES
-- ============================================
-- Pattern: matches existing add_rls_policies.sql using get_user_org_ids().
--
-- Tables WITH org_id (prospects, prospect_contacts):
--   Direct org_id check.
--
-- Tables WITHOUT org_id (search_signals, company_crawls, prospect_embeddings):
--   Scoped via JOIN to prospects.org_id through prospect_id FK.
-- ============================================

-- ----- PROSPECTS (has org_id) -----
CREATE POLICY "Users can view their org prospects"
  ON prospects FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert prospects into their org"
  ON prospects FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org prospects"
  ON prospects FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org prospects"
  ON prospects FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- ----- PROSPECT_CONTACTS (has org_id) -----
CREATE POLICY "Users can view their org prospect contacts"
  ON prospect_contacts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can insert prospect contacts into their org"
  ON prospect_contacts FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can update their org prospect contacts"
  ON prospect_contacts FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Users can delete their org prospect contacts"
  ON prospect_contacts FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- ----- SEARCH_SIGNALS (no org_id — scope via prospects.org_id) -----
CREATE POLICY "Users can view their org search signals"
  ON search_signals FOR SELECT
  USING (
    prospect_id IS NULL  -- unlinked signals are visible (pre-assignment)
    OR prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can insert search signals for their org prospects"
  ON search_signals FOR INSERT
  WITH CHECK (
    prospect_id IS NULL
    OR prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can update their org search signals"
  ON search_signals FOR UPDATE
  USING (
    prospect_id IS NULL
    OR prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can delete their org search signals"
  ON search_signals FOR DELETE
  USING (
    prospect_id IS NULL
    OR prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

-- ----- COMPANY_CRAWLS (no org_id — scope via prospects.org_id) -----
-- prospect_id is NOT NULL so no null check needed.
CREATE POLICY "Users can view their org company crawls"
  ON company_crawls FOR SELECT
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can insert company crawls for their org prospects"
  ON company_crawls FOR INSERT
  WITH CHECK (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can update their org company crawls"
  ON company_crawls FOR UPDATE
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can delete their org company crawls"
  ON company_crawls FOR DELETE
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

-- ----- PROSPECT_EMBEDDINGS (no org_id — scope via prospects.org_id) -----
-- prospect_id is NOT NULL so no null check needed.
CREATE POLICY "Users can view their org prospect embeddings"
  ON prospect_embeddings FOR SELECT
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can insert prospect embeddings for their org"
  ON prospect_embeddings FOR INSERT
  WITH CHECK (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can update their org prospect embeddings"
  ON prospect_embeddings FOR UPDATE
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Users can delete their org prospect embeddings"
  ON prospect_embeddings FOR DELETE
  USING (
    prospect_id IN (
      SELECT id FROM prospects WHERE org_id IN (SELECT get_user_org_ids())
    )
  );
