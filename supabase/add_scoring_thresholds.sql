-- Add configurable scoring thresholds to icp_profiles
-- These replace hardcoded values across enrichment functions

ALTER TABLE icp_profiles
  ADD COLUMN IF NOT EXISTS min_product_count INTEGER DEFAULT 250,
  ADD COLUMN IF NOT EXISTS min_monthly_sales INTEGER DEFAULT 1000000,
  ADD COLUMN IF NOT EXISTS min_annual_revenue INTEGER DEFAULT 12000000,
  ADD COLUMN IF NOT EXISTS min_employee_count INTEGER DEFAULT 50;

COMMENT ON COLUMN icp_profiles.min_product_count IS 'Minimum product count for catalog size factor (default 250)';
COMMENT ON COLUMN icp_profiles.min_monthly_sales IS 'Minimum monthly sales in dollars for sales factor (default $1,000,000)';
COMMENT ON COLUMN icp_profiles.min_annual_revenue IS 'Minimum annual revenue in dollars for Apollo revenue factor (default $12,000,000)';
COMMENT ON COLUMN icp_profiles.min_employee_count IS 'Minimum employee count for Apollo size factor (default 50)';
