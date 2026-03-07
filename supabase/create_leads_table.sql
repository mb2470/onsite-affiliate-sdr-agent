-- Standalone leads table create script (copy/paste safe: no line numbers).
-- Useful when manually creating core tables in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  website TEXT NOT NULL,
  company_name TEXT,
  industry TEXT,
  revenue_range TEXT,
  employee_count TEXT,

  icp_fit TEXT CHECK (icp_fit IN ('HIGH', 'MEDIUM', 'LOW')),
  research_notes TEXT,
  decision_makers TEXT[],
  pain_points TEXT,
  talking_points TEXT,

  ecommerce_platform TEXT,
  estimated_products INTEGER,
  catalog_analyzed_at TIMESTAMP WITH TIME ZONE,

  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'enriched', 'contacted', 'replied', 'qualified', 'demo', 'lost')),
  enrichment_status TEXT DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'in_progress', 'completed', 'failed')),

  source TEXT DEFAULT 'manual',
  metadata JSONB DEFAULT '{}'::jsonb,

  UNIQUE(org_id, website)
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_icp_fit ON leads(icp_fit);
CREATE INDEX IF NOT EXISTS idx_leads_website ON leads(website);
CREATE INDEX IF NOT EXISTS idx_leads_enrichment_status ON leads(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_leads_org_id ON leads(org_id);
