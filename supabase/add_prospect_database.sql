-- Prospect Database Migration
-- Medallion Architecture: Gold layer (prospects table)
-- Multi-tenant with org_id per CLAUDE.md architecture rules

-- ============================================
-- 0. EXTENSIONS
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- 1. PROSPECTS TABLE (Gold Layer)
-- ============================================

CREATE TABLE IF NOT EXISTS prospects (
  -- Primary Key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-Tenant (required per architecture)
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Hierarchy
  parent_id UUID REFERENCES prospects(id) ON DELETE SET NULL,

  -- ============================================
  -- Identity
  -- ============================================
  website TEXT NOT NULL,
  website_raw TEXT,
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

-- ============================================
-- 2. SEARCH_SIGNALS TABLE (Bronze Layer)
-- ============================================

CREATE TABLE IF NOT EXISTS search_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,

  -- Signal source
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'job_posting', 'funding_round', 'news_mention', 'tech_adoption',
    'social_post', 'review', 'partnership', 'expansion', 'other'
  )),
  source TEXT NOT NULL,
  source_url TEXT,

  -- Signal content
  title TEXT,
  snippet TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Relevance
  relevance_score NUMERIC(3,2) CHECK (relevance_score >= 0 AND relevance_score <= 1),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_search_signals_org_id ON search_signals(org_id);
CREATE INDEX idx_search_signals_prospect_id ON search_signals(prospect_id);
CREATE INDEX idx_search_signals_type ON search_signals(org_id, signal_type);
CREATE INDEX idx_search_signals_detected ON search_signals(detected_at DESC);

-- ============================================
-- 3. COMPANY_CRAWLS TABLE (Bronze Layer)
-- ============================================

CREATE TABLE IF NOT EXISTS company_crawls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,

  -- Crawl target
  url TEXT NOT NULL,
  page_type TEXT CHECK (page_type IN (
    'homepage', 'about', 'pricing', 'blog', 'careers', 'contact', 'product', 'other'
  )),

  -- Crawl result
  status_code INTEGER,
  content_text TEXT,
  content_html TEXT,
  extracted_data JSONB DEFAULT '{}'::jsonb,

  -- Metadata
  crawled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  crawl_duration_ms INTEGER,
  error_message TEXT,

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_company_crawls_org_id ON company_crawls(org_id);
CREATE INDEX idx_company_crawls_prospect_id ON company_crawls(prospect_id);
CREATE INDEX idx_company_crawls_url ON company_crawls(url);
CREATE INDEX idx_company_crawls_crawled ON company_crawls(crawled_at DESC);

-- ============================================
-- 4. PROSPECT_EMBEDDINGS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS prospect_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  -- Embedding
  embedding_type TEXT NOT NULL CHECK (embedding_type IN (
    'company_profile', 'product_description', 'icp_match', 'crawl_content'
  )),
  embedding vector(1536),
  model TEXT NOT NULL,

  -- Source reference
  source_text TEXT,
  source_metadata JSONB DEFAULT '{}'::jsonb,

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(prospect_id, embedding_type)
);

CREATE INDEX idx_prospect_embeddings_org_id ON prospect_embeddings(org_id);
CREATE INDEX idx_prospect_embeddings_prospect_id ON prospect_embeddings(prospect_id);
CREATE INDEX idx_prospect_embeddings_type ON prospect_embeddings(embedding_type);

-- ============================================
-- 5. PROSPECT_CONTACTS TABLE (Gold Layer)
-- ============================================

CREATE TABLE IF NOT EXISTS prospect_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  -- Contact Info
  first_name TEXT,
  last_name TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  title TEXT,

  -- LinkedIn
  linkedin_url TEXT,

  -- Scoring
  match_score INTEGER DEFAULT 0,
  match_level TEXT CHECK (match_level IN ('Best Match', 'Great Match', 'Good Match', 'Possible Match')),
  match_reason TEXT,

  -- Verification
  elv_status TEXT,
  elv_verified_at TIMESTAMPTZ,
  apollo_email_status TEXT,
  apollo_verified_at TIMESTAMPTZ,

  -- Outreach state
  contacted BOOLEAN DEFAULT FALSE,
  contacted_at TIMESTAMPTZ,

  -- Source
  source TEXT DEFAULT 'migration',
  source_metadata JSONB DEFAULT '{}'::jsonb,

  -- System
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(prospect_id, email)
);

CREATE INDEX idx_prospect_contacts_org_id ON prospect_contacts(org_id);
CREATE INDEX idx_prospect_contacts_prospect_id ON prospect_contacts(prospect_id);
CREATE INDEX idx_prospect_contacts_email ON prospect_contacts(email);
CREATE INDEX idx_prospect_contacts_match_score ON prospect_contacts(match_score DESC);

-- ============================================
-- 6. PROSPECTS INDEXES
-- ============================================

CREATE INDEX idx_prospects_org_id ON prospects(org_id);
CREATE INDEX idx_prospects_status ON prospects(org_id, status);
CREATE INDEX idx_prospects_website ON prospects(website);
CREATE INDEX idx_prospects_company_name ON prospects(company_name);
CREATE INDEX idx_prospects_industry ON prospects(org_id, industry_primary);
CREATE INDEX idx_prospects_confidence ON prospects(org_id, confidence_score DESC);
CREATE INDEX idx_prospects_parent_id ON prospects(parent_id);
CREATE INDEX idx_prospects_last_enriched ON prospects(last_enriched_at);

-- ============================================
-- 7. UPDATED_AT TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION update_prospect_tables_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION update_prospect_tables_updated_at();

CREATE TRIGGER trg_prospect_contacts_updated_at
  BEFORE UPDATE ON prospect_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_prospect_tables_updated_at();

CREATE TRIGGER trg_prospect_embeddings_updated_at
  BEFORE UPDATE ON prospect_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION update_prospect_tables_updated_at();

-- ============================================
-- 8. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_crawls ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_contacts ENABLE ROW LEVEL SECURITY;

-- Org-isolation policies for all prospect tables
CREATE POLICY prospects_org_isolation ON prospects
  FOR ALL
  USING (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()));

CREATE POLICY search_signals_org_isolation ON search_signals
  FOR ALL
  USING (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()));

CREATE POLICY company_crawls_org_isolation ON company_crawls
  FOR ALL
  USING (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()));

CREATE POLICY prospect_embeddings_org_isolation ON prospect_embeddings
  FOR ALL
  USING (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()));

CREATE POLICY prospect_contacts_org_isolation ON prospect_contacts
  FOR ALL
  USING (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM user_organizations WHERE user_id = auth.uid()));
