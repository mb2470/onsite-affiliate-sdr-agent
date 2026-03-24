-- Data Migration: leads → prospects, contacts → prospect_contacts
-- Idempotent (ON CONFLICT DO NOTHING) — safe to re-run
-- Non-destructive — does NOT delete from leads or contacts

-- ============================================
-- 1. MIGRATE LEADS → PROSPECTS
-- ============================================
-- Maps existing lead fields to prospect Gold layer fields.
-- Stores original lead_id in source_metadata for traceability.

INSERT INTO prospects (
  org_id,
  website,
  website_raw,
  company_name,
  industry_primary,
  employee_range,
  technographics,
  status,
  source_metadata,
  created_at,
  updated_at
)
SELECT
  l.org_id,
  -- website: use as canonical (already normalized in leads)
  l.website,
  -- website_raw: preserve the original
  l.website,
  -- company_name: required NOT NULL, fallback to website domain
  COALESCE(l.company_name, split_part(replace(replace(l.website, 'https://', ''), 'http://', ''), '/', 1)),
  -- industry_primary: from leads.industry
  l.industry,
  -- employee_range: from leads.employee_count (text field)
  l.employee_count,
  -- technographics: pull ecommerce_platform into array if present
  CASE
    WHEN l.ecommerce_platform IS NOT NULL THEN ARRAY[l.ecommerce_platform]
    ELSE NULL
  END,
  -- status: map lead statuses to prospect statuses
  CASE l.status
    WHEN 'new'       THEN 'new'
    WHEN 'enriched'  THEN 'enriched'
    WHEN 'contacted' THEN 'contacted'
    WHEN 'replied'   THEN 'engaged'
    WHEN 'qualified' THEN 'qualified'
    WHEN 'demo'      THEN 'qualified'
    WHEN 'lost'      THEN 'disqualified'
    ELSE 'new'
  END,
  -- source_metadata: preserve original lead data for traceability
  jsonb_build_object(
    'migrated_from', 'leads',
    'lead_id', l.id,
    'original_status', l.status,
    'enrichment_status', l.enrichment_status,
    'icp_fit', l.icp_fit,
    'source', l.source,
    'revenue_range', l.revenue_range,
    'research_notes', l.research_notes,
    'pain_points', l.pain_points,
    'talking_points', l.talking_points,
    'decision_makers', to_jsonb(l.decision_makers),
    'metadata', l.metadata,
    'migrated_at', NOW()
  ),
  l.created_at,
  l.updated_at
FROM leads l
WHERE l.org_id IS NOT NULL
  AND l.website IS NOT NULL
ON CONFLICT (org_id, website) DO NOTHING;

-- ============================================
-- 2. MIGRATE CONTACTS → PROSPECT_CONTACTS
-- ============================================
-- Looks up the prospect by matching lead_id → leads.website → prospects.website
-- within the same org. Only migrates contacts whose parent lead was migrated.

INSERT INTO prospect_contacts (
  org_id,
  prospect_id,
  first_name,
  last_name,
  full_name,
  email,
  title,
  linkedin_url,
  match_score,
  match_level,
  match_reason,
  elv_status,
  elv_verified_at,
  apollo_email_status,
  apollo_verified_at,
  contacted,
  contacted_at,
  source,
  source_metadata,
  created_at,
  updated_at
)
SELECT
  c.org_id,
  p.id,
  c.first_name,
  c.last_name,
  c.full_name,
  c.email,
  c.title,
  c.linkedin_url,
  c.match_score,
  c.match_level,
  c.match_reason,
  c.elv_status,
  c.elv_verified_at,
  c.apollo_email_status,
  c.apollo_verified_at,
  c.contacted,
  c.contacted_at,
  'migration',
  jsonb_build_object(
    'migrated_from', 'contacts',
    'contact_id', c.id,
    'lead_id', c.lead_id,
    'original_source', c.source,
    'metadata', c.metadata,
    'migrated_at', NOW()
  ),
  c.created_at,
  COALESCE(c.contacted_at, c.created_at)
FROM contacts c
JOIN leads l ON l.id = c.lead_id
JOIN prospects p ON p.org_id = l.org_id AND p.website = l.website
WHERE c.org_id IS NOT NULL
  AND c.email IS NOT NULL
  AND c.lead_id IS NOT NULL
ON CONFLICT (prospect_id, email) DO NOTHING;
