-- Supabase Database Schema for AI SDR Agent
-- Multi-tenant architecture with organization-based data isolation

-- ============================================
-- 0. ORGANIZATIONS & USER MAPPING
-- ============================================

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,  -- URL-friendly identifier (e.g., "onsite-affiliate")
  plan TEXT DEFAULT 'free',

  metadata JSONB DEFAULT '{}'::jsonb
);

-- Maps Supabase auth users to organizations (many-to-many)
CREATE TABLE user_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),

  UNIQUE(user_id, org_id)
);

CREATE INDEX idx_user_orgs_user_id ON user_organizations(user_id);
CREATE INDEX idx_user_orgs_org_id ON user_organizations(org_id);

-- ============================================
-- 1. LEADS TABLE
-- ============================================
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Company Info
  website TEXT NOT NULL,
  company_name TEXT,
  industry TEXT,
  revenue_range TEXT,
  employee_count TEXT,

  -- Research Data
  icp_fit TEXT CHECK (icp_fit IN ('HIGH', 'MEDIUM', 'LOW')),
  research_notes TEXT,
  decision_makers TEXT[],
  pain_points TEXT,
  talking_points TEXT,

  -- Catalog Info
  ecommerce_platform TEXT,
  estimated_products INTEGER,
  catalog_analyzed_at TIMESTAMP WITH TIME ZONE,

  -- Status Tracking
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'enriched', 'contacted', 'replied', 'qualified', 'demo', 'lost')),
  enrichment_status TEXT DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'in_progress', 'completed', 'failed')),

  -- Source
  source TEXT DEFAULT 'manual',

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Website unique per org (not globally)
  UNIQUE(org_id, website)
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_icp_fit ON leads(icp_fit);
CREATE INDEX idx_leads_website ON leads(website);
CREATE INDEX idx_leads_enrichment_status ON leads(enrichment_status);
CREATE INDEX idx_leads_org_id ON leads(org_id);

-- ============================================
-- 2. CONTACTS TABLE
-- ============================================
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Lead Association
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,

  -- Contact Info
  first_name TEXT,
  last_name TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT,

  -- Company Info
  company_name TEXT,
  company_website TEXT,

  -- Scoring
  match_score INTEGER DEFAULT 0,
  match_level TEXT CHECK (match_level IN ('Best Match', 'Great Match', 'Good Match', 'Possible Match')),
  match_reason TEXT,

  -- LinkedIn
  linkedin_url TEXT,

  -- Status
  contacted BOOLEAN DEFAULT FALSE,
  contacted_at TIMESTAMP WITH TIME ZONE,

  -- Source
  source TEXT DEFAULT 'csv_database',

  -- Email Verification (EmailListVerify)
  elv_status TEXT,
  elv_verified_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  UNIQUE(lead_id, email)
);

CREATE INDEX idx_contacts_lead_id ON contacts(lead_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_match_score ON contacts(match_score DESC);
CREATE INDEX idx_contacts_org_id ON contacts(org_id);
CREATE INDEX idx_contacts_elv_status ON contacts(elv_status);
CREATE INDEX idx_contacts_elv_verified_at ON contacts(elv_verified_at);

-- ============================================
-- 3. EMAILS TABLE
-- ============================================
CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Associations
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,

  -- Email Content
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  email_type TEXT DEFAULT 'initial' CHECK (email_type IN ('initial', 'followup', 'breakup')),

  -- AI Generation
  generated_by TEXT DEFAULT 'claude-sonnet-4-5',
  word_count INTEGER,
  includes_amazon_proof BOOLEAN DEFAULT FALSE,

  -- Sending Status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'bounced')),
  sent_at TIMESTAMP WITH TIME ZONE,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,

  -- Engagement Tracking
  opened BOOLEAN DEFAULT FALSE,
  opened_at TIMESTAMP WITH TIME ZONE,
  clicked BOOLEAN DEFAULT FALSE,
  clicked_at TIMESTAMP WITH TIME ZONE,
  replied BOOLEAN DEFAULT FALSE,
  replied_at TIMESTAMP WITH TIME ZONE,

  -- Error Tracking
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_emails_lead_id ON emails(lead_id);
CREATE INDEX idx_emails_contact_id ON emails(contact_id);
CREATE INDEX idx_emails_status ON emails(status);
CREATE INDEX idx_emails_sent_at ON emails(sent_at DESC);
CREATE INDEX idx_emails_org_id ON emails(org_id);

-- ============================================
-- 4. AGENT_JOBS TABLE
-- ============================================
CREATE TABLE agent_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Job Details
  job_type TEXT NOT NULL CHECK (job_type IN ('enrich_lead', 'find_contacts', 'draft_email', 'send_email', 'full_workflow')),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,

  -- Status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  priority INTEGER DEFAULT 0,

  -- Execution
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Results
  result JSONB,
  error_message TEXT,

  -- Retry
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
CREATE INDEX idx_agent_jobs_job_type ON agent_jobs(job_type);
CREATE INDEX idx_agent_jobs_priority ON agent_jobs(priority DESC);
CREATE INDEX idx_agent_jobs_created_at ON agent_jobs(created_at DESC);
CREATE INDEX idx_agent_jobs_org_id ON agent_jobs(org_id);

-- ============================================
-- 5. CONTACT_DATABASE TABLE (CSV contacts)
-- ============================================
CREATE TABLE contact_database (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Company Info
  website TEXT,
  account_name TEXT,

  -- Contact Info
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  email TEXT NOT NULL,

  -- LinkedIn
  linkedin_url TEXT,

  -- For search optimization
  email_domain TEXT GENERATED ALWAYS AS (
    LOWER(SUBSTRING(email FROM '@(.*)$'))
  ) STORED,

  -- Full text search
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(account_name, '') || ' ' ||
                           COALESCE(first_name, '') || ' ' ||
                           COALESCE(last_name, '') || ' ' ||
                           COALESCE(title, ''))
  ) STORED,

  UNIQUE(email)
);

CREATE INDEX idx_contact_db_website ON contact_database(website);
CREATE INDEX idx_contact_db_email_domain ON contact_database(email_domain);
CREATE INDEX idx_contact_db_search ON contact_database USING GIN(search_vector);
CREATE INDEX idx_contact_db_title ON contact_database(title);
CREATE INDEX idx_contact_database_org_id ON contact_database(org_id);

-- ============================================
-- 6. AUDIT_LOG TABLE
-- ============================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- What happened
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,

  -- Who did it
  actor TEXT DEFAULT 'ai_agent',

  -- Details
  old_values JSONB,
  new_values JSONB,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_org_id ON audit_log(org_id);

-- ============================================
-- 7. ICP_PROFILES TABLE
-- ============================================
CREATE TABLE icp_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Part 1: Product & Value Propositions
  elevator_pitch TEXT,
  core_problem TEXT,
  uvp_1 TEXT,
  uvp_2 TEXT,
  uvp_3 TEXT,
  alternative TEXT,

  -- Part 2: Firmographics
  industries TEXT[],
  company_size TEXT,
  geography TEXT[],
  revenue_range TEXT,
  tech_stack TEXT[],
  trigger_events TEXT[],

  -- Part 2b: Scoring Thresholds
  min_product_count INTEGER DEFAULT 250,
  min_monthly_sales INTEGER DEFAULT 1000000,
  min_annual_revenue INTEGER DEFAULT 12000000,
  min_employee_count INTEGER DEFAULT 50,

  -- Part 3: Buyer Persona
  primary_titles TEXT[],
  key_responsibilities TEXT,
  daily_obstacles TEXT,
  success_metrics TEXT,
  user_persona TEXT,
  gatekeeper_persona TEXT,
  champion_persona TEXT,

  -- Part 4: Summary
  perfect_fit_narrative TEXT,

  -- Part 5: Messaging & Tone
  sender_name TEXT,
  sender_url TEXT,
  email_tone TEXT,
  social_proof TEXT,
  messaging_do TEXT[],
  messaging_dont TEXT[],
  email_example TEXT,

  -- Status
  is_active BOOLEAN DEFAULT TRUE,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================
-- 8. FUNCTIONS & TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_jobs_updated_at
  BEFORE UPDATE ON agent_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_icp_profiles_updated_at
  BEFORE UPDATE ON icp_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Helper function: get current user's org IDs (used by RLS policies)
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM user_organizations WHERE user_id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ============================================
-- 9. ROW LEVEL SECURITY
-- ============================================
-- Permissive policies for now (Step 2 migration will tighten these
-- to org-scoped policies using get_user_org_ids()).

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON organizations
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON user_organizations
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON leads
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON contacts
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON emails
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON agent_jobs
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON icp_profiles
  FOR ALL USING (auth.role() = 'authenticated');

-- ============================================
-- 10. VIEWS
-- ============================================

CREATE VIEW leads_with_stats AS
SELECT
  l.*,
  COUNT(DISTINCT c.id) as contact_count,
  COUNT(DISTINCT e.id) as email_count,
  MAX(e.sent_at) as last_contacted_at,
  SUM(CASE WHEN e.replied THEN 1 ELSE 0 END) as reply_count
FROM leads l
LEFT JOIN contacts c ON c.lead_id = l.id
LEFT JOIN emails e ON e.lead_id = l.id
GROUP BY l.id;

CREATE VIEW pipeline_metrics AS
SELECT
  org_id,
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN icp_fit = 'HIGH' THEN 1 END) as high_fit_count,
  COUNT(CASE WHEN icp_fit = 'MEDIUM' THEN 1 END) as medium_fit_count,
  COUNT(CASE WHEN icp_fit = 'LOW' THEN 1 END) as low_fit_count
FROM leads
GROUP BY org_id, status;

-- ============================================
-- DONE! Multi-tenant database schema ready.
-- Run add_multi_tenant.sql for existing databases.
-- ============================================
