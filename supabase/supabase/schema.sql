-- Supabase Database Schema for AI SDR Agent
-- Migration from Google Sheets to Supabase

-- ============================================
-- 1. LEADS TABLE
-- ============================================
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Company Info
  website TEXT NOT NULL UNIQUE,
  company_name TEXT,
  industry TEXT,
  revenue_range TEXT,
  employee_count TEXT,
  
  -- Research Data
  icp_fit TEXT CHECK (icp_fit IN ('HIGH', 'MEDIUM', 'LOW')),
  research_notes TEXT,
  decision_makers TEXT[], -- Array of recommended titles
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
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for performance
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_icp_fit ON leads(icp_fit);
CREATE INDEX idx_leads_website ON leads(website);
CREATE INDEX idx_leads_enrichment_status ON leads(enrichment_status);

-- ============================================
-- 2. CONTACTS TABLE
-- ============================================
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
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
  
  -- Scoring (from smart matching)
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
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,
  
  UNIQUE(lead_id, email)
);

-- Indexes
CREATE INDEX idx_contacts_lead_id ON contacts(lead_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_match_score ON contacts(match_score DESC);

-- ============================================
-- 3. EMAILS TABLE
-- ============================================
CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
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

-- Indexes
CREATE INDEX idx_emails_lead_id ON emails(lead_id);
CREATE INDEX idx_emails_contact_id ON emails(contact_id);
CREATE INDEX idx_emails_status ON emails(status);
CREATE INDEX idx_emails_sent_at ON emails(sent_at DESC);

-- ============================================
-- 4. AGENT_JOBS TABLE (for queue management)
-- ============================================
CREATE TABLE agent_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
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

-- Indexes
CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
CREATE INDEX idx_agent_jobs_job_type ON agent_jobs(job_type);
CREATE INDEX idx_agent_jobs_priority ON agent_jobs(priority DESC);
CREATE INDEX idx_agent_jobs_created_at ON agent_jobs(created_at DESC);

-- ============================================
-- 5. CONTACT_DATABASE TABLE (500k CSV contacts)
-- ============================================
CREATE TABLE contact_database (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
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

-- Indexes for fast search
CREATE INDEX idx_contact_db_website ON contact_database(website);
CREATE INDEX idx_contact_db_email_domain ON contact_database(email_domain);
CREATE INDEX idx_contact_db_search ON contact_database USING GIN(search_vector);
CREATE INDEX idx_contact_db_title ON contact_database(title);

-- ============================================
-- 6. AUDIT_LOG TABLE
-- ============================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- What happened
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- 'lead', 'email', 'contact', etc.
  entity_id UUID,
  
  -- Who did it
  actor TEXT DEFAULT 'ai_agent',
  
  -- Details
  old_values JSONB,
  new_values JSONB,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Index
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);

-- ============================================
-- 7. FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_jobs_updated_at
  BEFORE UPDATE ON agent_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 8. ROW LEVEL SECURITY (Optional for multi-tenant)
-- ============================================

-- Enable RLS
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;

-- For now, allow all authenticated users (single tenant)
-- You can add more granular policies later

CREATE POLICY "Allow all for authenticated users" ON leads
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON contacts
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON emails
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Allow all for authenticated users" ON agent_jobs
  FOR ALL USING (auth.role() = 'authenticated');

-- ============================================
-- 9. INITIAL DATA & VIEWS
-- ============================================

-- View for leads with contact count
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

-- View for pipeline metrics
CREATE VIEW pipeline_metrics AS
SELECT 
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN icp_fit = 'HIGH' THEN 1 END) as high_fit_count,
  COUNT(CASE WHEN icp_fit = 'MEDIUM' THEN 1 END) as medium_fit_count,
  COUNT(CASE WHEN icp_fit = 'LOW' THEN 1 END) as low_fit_count
FROM leads
GROUP BY status;

-- ============================================
-- DONE! Database schema ready for AI SDR Agent
-- ============================================
