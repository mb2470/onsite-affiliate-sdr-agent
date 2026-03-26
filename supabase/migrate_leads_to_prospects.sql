-- ============================================
-- Full migration: leads → prospects
-- Safe to re-run (idempotent via ON CONFLICT).
-- Does NOT delete anything from leads — both systems run in parallel during transition.
-- After verifying everything works, run drop_leads_table.sql to retire leads.
--
-- PREREQUISITE: Run add_prospect_pipeline_columns.sql first to add
-- crawl_status, analysis_status, raw_markdown, extracted_services,
-- extracted_contacts, social_urls, scout_query, google_shopping columns.
--
-- NOTE: The leads table may not have all columns (they were added via separate
-- ALTER TABLE migrations). This script dynamically checks which columns exist
-- and only migrates what's available.
-- ============================================

BEGIN;

-- ============================================
-- Step 1: MIGRATE LEADS → PROSPECTS
-- ============================================
-- Use a DO block to dynamically build the INSERT based on which columns
-- actually exist on the leads table.

DO $$
DECLARE
  has_col RECORD;
  -- Track which optional columns exist on leads
  has_headquarters BOOLEAN := FALSE;
  has_city BOOLEAN := FALSE;
  has_state BOOLEAN := FALSE;
  has_country BOOLEAN := FALSE;
  has_fit_reason BOOLEAN := FALSE;
  has_ecommerce_platform BOOLEAN := FALSE;
  has_platform BOOLEAN := FALSE;
  has_estimated_products BOOLEAN := FALSE;
  has_product_count BOOLEAN := FALSE;
  has_store_rank BOOLEAN := FALSE;
  has_estimated_sales BOOLEAN := FALSE;
  has_sells_d2c BOOLEAN := FALSE;
  has_has_contacts BOOLEAN := FALSE;
  has_contact_name BOOLEAN := FALSE;
  has_contact_email BOOLEAN := FALSE;
  has_company_id BOOLEAN := FALSE;
  has_enrichment_status BOOLEAN := FALSE;
  has_decision_makers BOOLEAN := FALSE;
  -- Pipeline columns (may exist on leads from crawl/analysis features)
  has_raw_markdown BOOLEAN := FALSE;
  has_crawl_status BOOLEAN := FALSE;
  has_crawl_attempted_at BOOLEAN := FALSE;
  has_analysis_status BOOLEAN := FALSE;
  has_analysis_attempted_at BOOLEAN := FALSE;
  has_extracted_services BOOLEAN := FALSE;
  has_extracted_contacts BOOLEAN := FALSE;
  has_social_urls BOOLEAN := FALSE;
  has_scout_query BOOLEAN := FALSE;
  has_google_shopping BOOLEAN := FALSE;
  has_catalog_size BOOLEAN := FALSE;
BEGIN
  -- Check which columns exist on leads
  FOR has_col IN
    SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'
  LOOP
    CASE has_col.column_name
      WHEN 'headquarters' THEN has_headquarters := TRUE;
      WHEN 'city' THEN has_city := TRUE;
      WHEN 'state' THEN has_state := TRUE;
      WHEN 'country' THEN has_country := TRUE;
      WHEN 'fit_reason' THEN has_fit_reason := TRUE;
      WHEN 'ecommerce_platform' THEN has_ecommerce_platform := TRUE;
      WHEN 'platform' THEN has_platform := TRUE;
      WHEN 'estimated_products' THEN has_estimated_products := TRUE;
      WHEN 'product_count' THEN has_product_count := TRUE;
      WHEN 'store_rank' THEN has_store_rank := TRUE;
      WHEN 'estimated_sales' THEN has_estimated_sales := TRUE;
      WHEN 'sells_d2c' THEN has_sells_d2c := TRUE;
      WHEN 'has_contacts' THEN has_has_contacts := TRUE;
      WHEN 'contact_name' THEN has_contact_name := TRUE;
      WHEN 'contact_email' THEN has_contact_email := TRUE;
      WHEN 'company_id' THEN has_company_id := TRUE;
      WHEN 'enrichment_status' THEN has_enrichment_status := TRUE;
      WHEN 'decision_makers' THEN has_decision_makers := TRUE;
      WHEN 'raw_markdown' THEN has_raw_markdown := TRUE;
      WHEN 'crawl_status' THEN has_crawl_status := TRUE;
      WHEN 'crawl_attempted_at' THEN has_crawl_attempted_at := TRUE;
      WHEN 'analysis_status' THEN has_analysis_status := TRUE;
      WHEN 'analysis_attempted_at' THEN has_analysis_attempted_at := TRUE;
      WHEN 'extracted_services' THEN has_extracted_services := TRUE;
      WHEN 'extracted_contacts' THEN has_extracted_contacts := TRUE;
      WHEN 'social_urls' THEN has_social_urls := TRUE;
      WHEN 'scout_query' THEN has_scout_query := TRUE;
      WHEN 'google_shopping' THEN has_google_shopping := TRUE;
      WHEN 'catalog_size' THEN has_catalog_size := TRUE;
      ELSE NULL;
    END CASE;
  END LOOP;

  -- Build and execute dynamic INSERT
  EXECUTE format(
    'INSERT INTO prospects (
      id, org_id, website, website_raw, company_name,
      physical_address, city, state, hq_country,
      industry_primary, employee_range, revenue_annual,
      icp_fit, research_notes, decision_makers, pain_points, talking_points,
      fit_reason, ecommerce_platform, estimated_products, catalog_analyzed_at,
      store_rank, estimated_sales, sells_d2c,
      has_contacts, contact_name, contact_email, company_id,
      raw_markdown, crawl_status, crawl_attempted_at,
      analysis_status, analysis_attempted_at,
      extracted_services, extracted_contacts, social_urls,
      scout_query, google_shopping,
      status, enrichment_source, source, source_metadata,
      created_at, updated_at
    )
    SELECT
      l.id,
      l.org_id,
      l.website,
      l.website,
      COALESCE(l.company_name, split_part(replace(replace(l.website, ''https://'', ''''), ''http://'', ''''), ''/'', 1)),
      %s,
      %s,
      %s,
      %s,
      l.industry,
      l.employee_count,
      CASE WHEN l.revenue_range ~ ''^\d+(\.\d+)?$'' THEN l.revenue_range::NUMERIC ELSE NULL END,
      l.icp_fit,
      l.research_notes,
      %s,
      l.pain_points,
      l.talking_points,
      %s,
      %s,
      %s,
      l.catalog_analyzed_at,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      CASE l.status
        WHEN ''new''       THEN ''new''
        WHEN ''enriched''  THEN ''enriched''
        WHEN ''contacted'' THEN ''contacted''
        WHEN ''replied''   THEN ''replied''
        WHEN ''qualified'' THEN ''qualified''
        WHEN ''demo''      THEN ''engaged''
        WHEN ''lost''      THEN ''disqualified''
        ELSE ''new''
      END,
      ''lead_migration'',
      COALESCE(l.source, ''manual''),
      jsonb_build_object(''migrated_from_lead_id'', l.id %s),
      l.created_at,
      COALESCE(l.updated_at, l.created_at)
    FROM leads l
    WHERE l.org_id IS NOT NULL
      AND l.website IS NOT NULL
    ON CONFLICT (org_id, website) DO NOTHING',
    -- physical_address
    CASE WHEN has_headquarters THEN 'l.headquarters' ELSE 'NULL' END,
    -- city
    CASE WHEN has_city THEN 'l.city' ELSE 'NULL' END,
    -- state
    CASE WHEN has_state THEN 'l.state' ELSE 'NULL' END,
    -- hq_country
    CASE WHEN has_country THEN
      'CASE WHEN l.country IS NOT NULL AND length(trim(l.country)) = 2 THEN upper(trim(l.country))
            WHEN l.country ILIKE ''US%'' THEN ''US''
            WHEN l.country ILIKE ''Canada%'' OR l.country ILIKE ''CA%'' THEN ''CA''
            WHEN l.country ILIKE ''United Kingdom%'' OR l.country ILIKE ''UK%'' THEN ''GB''
            ELSE NULL END'
    ELSE 'NULL' END,
    -- decision_makers (TEXT in leads → TEXT[] in prospects)
    CASE WHEN has_decision_makers THEN
      'CASE WHEN l.decision_makers IS NOT NULL THEN string_to_array(l.decision_makers, '';'') ELSE NULL END'
    ELSE 'NULL' END,
    -- fit_reason
    CASE WHEN has_fit_reason THEN 'l.fit_reason' ELSE 'NULL' END,
    -- ecommerce_platform
    CASE
      WHEN has_ecommerce_platform AND has_platform THEN 'COALESCE(l.ecommerce_platform, l.platform)'
      WHEN has_ecommerce_platform THEN 'l.ecommerce_platform'
      WHEN has_platform THEN 'l.platform'
      ELSE 'NULL'
    END,
    -- estimated_products (check estimated_products, product_count, and catalog_size)
    CASE
      WHEN has_estimated_products AND has_product_count AND has_catalog_size THEN 'COALESCE(l.estimated_products, l.product_count, l.catalog_size)'
      WHEN has_estimated_products AND has_product_count THEN 'COALESCE(l.estimated_products, l.product_count)'
      WHEN has_estimated_products AND has_catalog_size THEN 'COALESCE(l.estimated_products, l.catalog_size)'
      WHEN has_estimated_products THEN 'l.estimated_products'
      WHEN has_product_count THEN 'l.product_count'
      WHEN has_catalog_size THEN 'l.catalog_size'
      ELSE 'NULL'
    END,
    -- store_rank
    CASE WHEN has_store_rank THEN 'l.store_rank' ELSE 'NULL' END,
    -- estimated_sales
    CASE WHEN has_estimated_sales THEN 'l.estimated_sales' ELSE 'NULL' END,
    -- sells_d2c
    CASE WHEN has_sells_d2c THEN 'l.sells_d2c' ELSE 'NULL' END,
    -- has_contacts
    CASE WHEN has_has_contacts THEN 'COALESCE(l.has_contacts, FALSE)' ELSE 'FALSE' END,
    -- contact_name
    CASE WHEN has_contact_name THEN 'l.contact_name' ELSE 'NULL' END,
    -- contact_email
    CASE WHEN has_contact_email THEN 'l.contact_email' ELSE 'NULL' END,
    -- company_id
    CASE WHEN has_company_id THEN 'l.company_id' ELSE 'NULL' END,
    -- raw_markdown
    CASE WHEN has_raw_markdown THEN 'l.raw_markdown' ELSE 'NULL' END,
    -- crawl_status
    CASE WHEN has_crawl_status THEN 'l.crawl_status' ELSE 'NULL' END,
    -- crawl_attempted_at
    CASE WHEN has_crawl_attempted_at THEN 'l.crawl_attempted_at' ELSE 'NULL' END,
    -- analysis_status
    CASE WHEN has_analysis_status THEN 'l.analysis_status' ELSE 'NULL' END,
    -- analysis_attempted_at
    CASE WHEN has_analysis_attempted_at THEN 'l.analysis_attempted_at' ELSE 'NULL' END,
    -- extracted_services
    CASE WHEN has_extracted_services THEN 'l.extracted_services' ELSE 'NULL' END,
    -- extracted_contacts
    CASE WHEN has_extracted_contacts THEN 'l.extracted_contacts' ELSE 'NULL' END,
    -- social_urls
    CASE WHEN has_social_urls THEN 'l.social_urls' ELSE 'NULL' END,
    -- scout_query
    CASE WHEN has_scout_query THEN 'l.scout_query' ELSE 'NULL' END,
    -- google_shopping
    CASE WHEN has_google_shopping THEN 'l.google_shopping' ELSE 'NULL' END,
    -- enrichment_status in metadata
    CASE WHEN has_enrichment_status THEN ', ''original_enrichment_status'', l.enrichment_status' ELSE '' END
  );

  RAISE NOTICE 'Step 1 complete: leads migrated to prospects';
END $$;

-- ============================================
-- Step 2: MIGRATE CONTACTS → PROSPECT_CONTACTS
-- ============================================
-- Uses the preserved UUIDs (lead.id = prospect.id) for direct mapping.

DO $$
DECLARE
  has_elv_status BOOLEAN := FALSE;
  has_elv_verified_at BOOLEAN := FALSE;
  has_apollo_email_status BOOLEAN := FALSE;
  has_apollo_verified_at BOOLEAN := FALSE;
  has_col RECORD;
BEGIN
  FOR has_col IN
    SELECT column_name FROM information_schema.columns WHERE table_name = 'contacts'
  LOOP
    CASE has_col.column_name
      WHEN 'elv_status' THEN has_elv_status := TRUE;
      WHEN 'elv_verified_at' THEN has_elv_verified_at := TRUE;
      WHEN 'apollo_email_status' THEN has_apollo_email_status := TRUE;
      WHEN 'apollo_verified_at' THEN has_apollo_verified_at := TRUE;
      ELSE NULL;
    END CASE;
  END LOOP;

  EXECUTE format(
    'INSERT INTO prospect_contacts (
      org_id, prospect_id, first_name, last_name, full_name, email, title,
      company_name, company_website, linkedin_url, match_score, match_level,
      match_reason, contacted, contacted_at, source,
      elv_status, elv_verified_at, apollo_email_status, apollo_verified_at,
      metadata, created_at, updated_at
    )
    SELECT
      c.org_id,
      c.lead_id,
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
      ''lead_migration'',
      %s,
      %s,
      %s,
      %s,
      jsonb_build_object(''migrated_from_contact_id'', c.id, ''migrated_from_lead_id'', c.lead_id),
      c.created_at,
      COALESCE(c.contacted_at, c.created_at)
    FROM contacts c
    JOIN leads l ON l.id = c.lead_id
    WHERE c.org_id IS NOT NULL
      AND c.email IS NOT NULL
      AND c.lead_id IS NOT NULL
      AND c.lead_id IN (SELECT id FROM prospects)
    ON CONFLICT (prospect_id, email) DO NOTHING',
    CASE WHEN has_elv_status THEN 'c.elv_status' ELSE 'NULL' END,
    CASE WHEN has_elv_verified_at THEN 'c.elv_verified_at' ELSE 'NULL' END,
    CASE WHEN has_apollo_email_status THEN 'c.apollo_email_status' ELSE 'NULL' END,
    CASE WHEN has_apollo_verified_at THEN 'c.apollo_verified_at' ELSE 'NULL' END
  );

  RAISE NOTICE 'Step 2 complete: contacts migrated to prospect_contacts';
END $$;

-- ============================================
-- Step 3: REPOINT FOREIGN KEYS
-- ============================================
-- Since we preserved UUIDs (leads.id → prospects.id), the lead_id values
-- in referencing tables already match prospects.id. We just need to drop
-- the old FK constraints and add new ones pointing to prospects.
-- Each block is wrapped in a DO to skip gracefully if the table doesn't exist.

-- contacts.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_lead_id_fkey;
  ALTER TABLE contacts ADD CONSTRAINT contacts_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- outreach_log.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE outreach_log DROP CONSTRAINT IF EXISTS outreach_log_lead_id_fkey;
  ALTER TABLE outreach_log ADD CONSTRAINT outreach_log_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- activity_log.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_lead_id_fkey;
  ALTER TABLE activity_log ADD CONSTRAINT activity_log_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- emails.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_lead_id_fkey;
  ALTER TABLE emails ADD CONSTRAINT emails_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- campaign_leads.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_lead_id_fkey;
  ALTER TABLE campaign_leads ADD CONSTRAINT campaign_leads_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- email_conversations.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE email_conversations DROP CONSTRAINT IF EXISTS email_conversations_lead_id_fkey;
  ALTER TABLE email_conversations ADD CONSTRAINT email_conversations_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- agent_jobs.lead_id → prospects(id)
DO $$ BEGIN
  ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_lead_id_fkey;
  ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES prospects(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ============================================
-- Step 4: CREATE BACKWARDS-COMPATIBLE VIEWS
-- ============================================

DROP VIEW IF EXISTS leads_with_stats CASCADE;
DROP VIEW IF EXISTS pipeline_metrics CASCADE;

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
