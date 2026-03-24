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
-- 2. INDEXES
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
-- 3. UPDATED_AT TRIGGER
-- ============================================

CREATE OR REPLACE FUNCTION update_prospects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION update_prospects_updated_at();

-- ============================================
-- 4. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;

-- Users can only see prospects belonging to their organization
CREATE POLICY prospects_org_isolation ON prospects
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM user_organizations
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM user_organizations
      WHERE user_id = auth.uid()
    )
  );
