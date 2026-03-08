-- Add extended StoreLeads fields to storeleads table
-- These columns capture the full StoreLeads API payload

-- Pricing
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS average_product_price NUMERIC;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS average_product_price_usd NUMERIC;

-- Company info
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS domain_url TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS merchant_name TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS employee_count INTEGER;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS street_address TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS company_location TEXT;

-- Sales estimates
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS estimated_monthly_sales BIGINT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS estimated_yearly_sales BIGINT;

-- Product metrics
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS product_images INTEGER;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS product_variants INTEGER;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS products_created_90 INTEGER;

-- Platform details
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS platform_domain TEXT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS platform_rank BIGINT;

-- Social followers
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS pinterest_followers BIGINT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS tiktok_followers BIGINT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS twitter_followers BIGINT;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS youtube_followers BIGINT;

-- Emails and phones as JSONB arrays (API can return multiple)
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT '[]'::jsonb;
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS phones JSONB DEFAULT '[]'::jsonb;

-- LinkedIn account (separate from contact linkedin)
ALTER TABLE storeleads ADD COLUMN IF NOT EXISTS linkedin_account TEXT;
