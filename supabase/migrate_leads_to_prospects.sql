-- ============================================
-- Full migration: leads → prospects
-- Safe to re-run (idempotent via ON CONFLICT).
-- Does NOT delete anything from leads — both systems run in parallel during transition.
-- After verifying everything works, run drop_leads_table.sql to retire leads.
-- ============================================

BEGIN;

-- ============================================
-- Step 1: MIGRATE LEADS → PROSPECTS
-- ============================================
-- Maps all lead fields to prospect fields per the field mapping spec.
-- The website normalization trigger on prospects will clean the website value.
-- Preserves lead UUIDs as prospect IDs so FK references survive.

INSERT INTO prospects (
  id,
  org_id,
  website,
  website_raw,
  company_name,
  physical_address,
  city,
  state,
  hq_country,
  industry_primary,
  employee_range,
  revenue_annual,
  icp_fit,
  research_notes,
  decision_makers,
  pain_points,
  talking_points,
  fit_reason,
  ecommerce_platform,
  estimated_products,
  catalog_analyzed_at,
  store_rank,
  estimated_sales,
  sells_d2c,
  has_contacts,
  contact_name,
  contact_email,
  company_id,
  status,
  enrichment_source,
  source,
  source_metadata,
  created_at,
  updated_at
)
SELECT
  l.id,
  l.org_id,
  l.website,
  l.website,
  COALESCE(l.company_name, split_part(replace(replace(l.website, 'https://', ''), 'http://', ''), '/', 1)),
  l.headquarters,
  l.city,
  l.state,
  -- country text → hq_country char(2): take first 2 chars if looks like ISO code
  CASE
    WHEN l.country IS NOT NULL AND length(trim(l.country)) = 2 THEN upper(trim(l.country))
    WHEN l.country ILIKE 'US%' THEN 'US'
    WHEN l.country ILIKE 'Canada%' OR l.country ILIKE 'CA%' THEN 'CA'
    WHEN l.country ILIKE 'United Kingdom%' OR l.country ILIKE 'UK%' THEN 'GB'
    ELSE NULL
  END,
  l.industry,
  l.employee_count,
  -- revenue_range text → revenue_annual numeric: parse where possible
  CASE
    WHEN l.revenue_range ~ '^\d+(\.\d+)?$' THEN l.revenue_range::NUMERIC
    ELSE NULL
  END,
  l.icp_fit,
  l.research_notes,
  l.decision_makers,
  l.pain_points,
  l.talking_points,
  l.fit_reason,
  COALESCE(l.ecommerce_platform, l.platform),
  COALESCE(l.estimated_products, l.product_count),
  l.catalog_analyzed_at,
  l.store_rank,
  COALESCE(l.estimated_sales, NULL),
  l.sells_d2c,
  COALESCE(l.has_contacts, FALSE),
  l.contact_name,
  l.contact_email,
  l.company_id,
  -- Status mapping
  CASE l.status
    WHEN 'new'       THEN 'new'
    WHEN 'enriched'  THEN 'enriched'
    WHEN 'contacted' THEN 'contacted'
    WHEN 'replied'   THEN 'replied'
    WHEN 'qualified' THEN 'qualified'
    WHEN 'demo'      THEN 'engaged'
    WHEN 'lost'      THEN 'disqualified'
    ELSE 'new'
  END,
  'lead_migration',
  COALESCE(l.source, 'manual'),
  jsonb_build_object('migrated_from_lead_id', l.id, 'original_enrichment_status', l.enrichment_status),
  l.created_at,
  COALESCE(l.updated_at, l.created_at)
FROM leads l
WHERE l.org_id IS NOT NULL
  AND l.website IS NOT NULL
ON CONFLICT (org_id, website) DO NOTHING;

-- ============================================
-- Step 2: MIGRATE CONTACTS → PROSPECT_CONTACTS
-- ============================================
-- Uses the preserved UUIDs (lead.id = prospect.id) for direct mapping.

INSERT INTO prospect_contacts (
  org_id,
  prospect_id,
  first_name,
  last_name,
  full_name,
  email,
  title,
  company_name,
  company_website,
  linkedin_url,
  match_score,
  match_level,
  match_reason,
  contacted,
  contacted_at,
  source,
  elv_status,
  elv_verified_at,
  apollo_email_status,
  apollo_verified_at,
  metadata,
  created_at,
  updated_at
)
SELECT
  c.org_id,
  c.lead_id,  -- same UUID now exists in prospects.id
  c.first_name,
  c.last_name,
  c.full_name,
  c.email,
  c.title,
  COALESCE(c.company_name, l.company_name),
  COALESCE(c.company_website, l.website),
  c.linkedin_url,
  c.match_score,
  c.match_level,
  c.match_reason,
  c.contacted,
  c.contacted_at,
  'lead_migration',
  c.elv_status,
  c.elv_verified_at,
  c.apollo_email_status,
  c.apollo_verified_at,
  jsonb_build_object(
    'migrated_from_contact_id', c.id,
    'migrated_from_lead_id', c.lead_id
  ),
  c.created_at,
  COALESCE(c.contacted_at, c.created_at)
FROM contacts c
JOIN leads l ON l.id = c.lead_id
WHERE c.org_id IS NOT NULL
  AND c.email IS NOT NULL
  AND c.lead_id IS NOT NULL
  -- Only migrate contacts whose lead was successfully migrated
  AND c.lead_id IN (SELECT id FROM prospects)
ON CONFLICT (prospect_id, email) DO NOTHING;

-- ============================================
-- Step 3: REPOINT FOREIGN KEYS
-- ============================================
-- Since we preserved UUIDs (leads.id → prospects.id), the lead_id values
-- in referencing tables already match prospects.id. We just need to drop
-- the old FK constraints and add new ones pointing to prospects.

-- contacts.lead_id → prospects(id)
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_lead_id_fkey;
ALTER TABLE contacts ADD CONSTRAINT contacts_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;

-- outreach_log.lead_id → prospects(id)
ALTER TABLE outreach_log DROP CONSTRAINT IF EXISTS outreach_log_lead_id_fkey;
ALTER TABLE outreach_log ADD CONSTRAINT outreach_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;

-- activity_log.lead_id → prospects(id)
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_lead_id_fkey;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE SET NULL;

-- emails.lead_id → prospects(id)
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_lead_id_fkey;
ALTER TABLE emails ADD CONSTRAINT emails_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;

-- campaign_leads.lead_id → prospects(id)
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_lead_id_fkey;
ALTER TABLE campaign_leads ADD CONSTRAINT campaign_leads_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;

-- email_conversations.lead_id → prospects(id)
ALTER TABLE email_conversations DROP CONSTRAINT IF EXISTS email_conversations_lead_id_fkey;
ALTER TABLE email_conversations ADD CONSTRAINT email_conversations_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE SET NULL;

-- agent_jobs.lead_id → prospects(id)
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_lead_id_fkey;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;

-- ============================================
-- Step 4: CREATE BACKWARDS-COMPATIBLE VIEW
-- ============================================
-- During transition, create a 'leads' view pointing to prospects
-- so any missed code references still work.

-- First drop the old leads_with_stats view that depends on leads table
DROP VIEW IF EXISTS leads_with_stats CASCADE;
DROP VIEW IF EXISTS pipeline_metrics CASCADE;

-- Recreate views pointing to prospects
CREATE OR REPLACE VIEW leads_with_stats AS
SELECT
  p.*,
  COUNT(DISTINCT c.id) as contact_count,
  COUNT(DISTINCT o.id) as email_count,
  MAX(o.sent_at) as last_contacted_at,
  SUM(CASE WHEN o.replied_at IS NOT NULL THEN 1 ELSE 0 END) as reply_count
FROM prospects p
LEFT JOIN prospect_contacts c ON c.prospect_id = p.id
LEFT JOIN outreach_log o ON o.lead_id = p.id
GROUP BY p.id;

CREATE OR REPLACE VIEW pipeline_metrics AS
SELECT
  org_id,
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN icp_fit = 'HIGH' THEN 1 END) as high_fit_count,
  COUNT(CASE WHEN icp_fit = 'MEDIUM' THEN 1 END) as medium_fit_count,
  COUNT(CASE WHEN icp_fit = 'LOW' THEN 1 END) as low_fit_count
FROM prospects
GROUP BY org_id, status;

COMMIT;
