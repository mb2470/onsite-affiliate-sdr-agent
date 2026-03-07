-- Cache full StoreLeads payloads per organization/domain.
-- Stores normalized columns + raw_payload to preserve every API attribute.

CREATE TABLE IF NOT EXISTS storeleads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,

  company_name TEXT,
  name TEXT,
  title TEXT,
  description TEXT,
  keyword TEXT,
  platform TEXT,
  plan TEXT,
  rank BIGINT,
  product_count INTEGER,
  estimated_sales BIGINT,

  city TEXT,
  state TEXT,
  country TEXT,
  currency TEXT,
  language TEXT,
  timezone TEXT,

  phone TEXT,
  email TEXT,
  linkedin TEXT,
  facebook TEXT,
  instagram TEXT,
  tiktok TEXT,
  youtube TEXT,
  pinterest TEXT,
  twitter TEXT,

  categories JSONB DEFAULT '[]'::jsonb,
  technologies JSONB DEFAULT '[]'::jsonb,
  apps JSONB DEFAULT '[]'::jsonb,
  contact_info JSONB DEFAULT '{}'::jsonb,

  first_seen_at TIMESTAMP WITH TIME ZONE,
  last_seen_at TIMESTAMP WITH TIME ZONE,

  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE(org_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_storeleads_org_id ON storeleads(org_id);
CREATE INDEX IF NOT EXISTS idx_storeleads_domain ON storeleads(domain);
CREATE INDEX IF NOT EXISTS idx_storeleads_updated_at ON storeleads(updated_at DESC);
