-- One-time migration: leads → prospects. Safe to re-run (idempotent via ON CONFLICT).
-- Does NOT delete anything from leads or contacts — both systems run in parallel during transition.

BEGIN;

-- ============================================
-- Step 1: MIGRATE LEADS → PROSPECTS
-- ============================================
-- Maps existing lead fields to prospect fields.
-- The website normalization trigger on prospects will clean the website value.

INSERT INTO prospects (
  org_id,
  website,
  website_raw,
  company_name,
  industry_primary,
  employee_actual,
  status,
  enrichment_source,
  source_metadata,
  created_at,
  updated_at
)
SELECT
  l.org_id,
  l.website,
  l.website,
  COALESCE(l.company_name, split_part(replace(replace(l.website, 'https://', ''), 'http://', ''), '/', 1)),
  l.industry,
  -- employee_count is TEXT in leads; safely cast to INTEGER, NULL if not numeric
  CASE
    WHEN l.employee_count ~ '^\d+$' THEN l.employee_count::INTEGER
    ELSE NULL
  END,
  CASE l.status
    WHEN 'new'       THEN 'new'
    WHEN 'enriched'  THEN 'enriched'
    WHEN 'contacted' THEN 'contacted'
    WHEN 'replied'   THEN 'engaged'
    ELSE 'new'
  END,
  'lead_migration',
  jsonb_build_object('migrated_from_lead_id', l.id),
  l.created_at,
  COALESCE(l.updated_at, l.created_at)
FROM leads l
WHERE l.org_id IS NOT NULL
  AND l.website IS NOT NULL
ON CONFLICT (org_id, website) DO NOTHING;

-- ============================================
-- Step 2: MIGRATE CONTACTS → PROSPECT_CONTACTS
-- ============================================
-- Uses a CTE to build the lead_id → prospect_id mapping via the shared
-- (org_id, website) key, then joins contacts through leads to find their
-- matching prospect.

WITH lead_prospect_map AS (
  -- Map each lead to its corresponding prospect via org_id + website
  SELECT
    l.id   AS lead_id,
    p.id   AS prospect_id,
    l.org_id,
    l.company_name,
    l.website
  FROM leads l
  JOIN prospects p ON p.org_id = l.org_id AND p.website = l.website
  WHERE l.org_id IS NOT NULL
    AND l.website IS NOT NULL
)
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
  metadata,
  created_at,
  updated_at
)
SELECT
  c.org_id,
  lpm.prospect_id,
  c.first_name,
  c.last_name,
  c.full_name,
  c.email,
  c.title,
  COALESCE(c.company_name, lpm.company_name),
  COALESCE(c.company_website, lpm.website),
  c.linkedin_url,
  c.match_score,
  c.match_level,
  c.match_reason,
  c.contacted,
  c.contacted_at,
  'lead_migration',
  jsonb_build_object(
    'migrated_from_contact_id', c.id,
    'migrated_from_lead_id', c.lead_id
  ),
  c.created_at,
  COALESCE(c.contacted_at, c.created_at)
FROM contacts c
JOIN lead_prospect_map lpm ON lpm.lead_id = c.lead_id
WHERE c.org_id IS NOT NULL
  AND c.email IS NOT NULL
  AND c.lead_id IS NOT NULL
ON CONFLICT (prospect_id, email) DO NOTHING;

COMMIT;
