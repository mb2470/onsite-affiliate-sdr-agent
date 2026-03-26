-- ============================================
-- Add pipeline columns to prospects table
-- These columns are used by the prospect enrichment pipeline
-- (prospect-crawl.js, prospect-analyze.js, scout-search.js, prospect-score.js)
-- but were missing from the initial prospects schema.
-- Safe to re-run (IF NOT EXISTS / idempotent).
-- ============================================

-- Crawl pipeline tracking
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS crawl_status TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS crawl_attempted_at TIMESTAMPTZ;

-- Analysis pipeline tracking
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS analysis_status TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS analysis_attempted_at TIMESTAMPTZ;

-- Crawled content (stored on prospect for re-analysis)
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS raw_markdown TEXT;

-- Extracted data from website analysis
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS extracted_services TEXT[];
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS extracted_contacts JSONB;

-- Social media URLs discovered during crawl
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS social_urls JSONB;

-- Scout search query that discovered this prospect
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS scout_query TEXT;

-- Google Shopping presence (parsed from Claude enrichment)
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS google_shopping TEXT;

-- Indexes for pipeline status queries
CREATE INDEX IF NOT EXISTS idx_prospects_crawl_status ON prospects(org_id, crawl_status);
CREATE INDEX IF NOT EXISTS idx_prospects_analysis_status ON prospects(org_id, analysis_status);
