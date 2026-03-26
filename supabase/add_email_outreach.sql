-- ============================================
-- Migration: Email Outreach Infrastructure
-- ============================================
-- Adds 5 new tables for the email domain acquisition and outreach system:
--   1. email_domains       — Domains purchased via Cloudflare for outreach
--   2. email_accounts      — Mailboxes on those domains (managed via Smartlead)
--   3. outreach_campaigns  — Smartlead campaigns with sequencing config
--   4. email_conversations — Inbound replies and conversation threads
--   5. email_settings      — Per-org configuration (API keys, defaults)
--
-- All tables are multi-tenant (org_id), with RLS policies matching
-- the existing pattern from add_rls_policies.sql.
--
-- Prerequisites:
--   - schema.sql (base tables)
--   - add_multi_tenant.sql (organizations, user_organizations, get_user_org_ids())
--   - add_rls_policies.sql (org-scoped RLS pattern)
-- ============================================


-- ============================================
-- 1. EMAIL_DOMAINS
-- ============================================
-- Tracks domains purchased via Cloudflare for cold outreach.
-- Each domain goes through: searching → purchased → dns_pending → active → inactive.

CREATE TABLE IF NOT EXISTS email_domains (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Domain identity
  domain TEXT NOT NULL,

  -- Purchase info
  purchased_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  registrar TEXT DEFAULT 'cloudflare',
  purchase_price NUMERIC(10, 2),

  -- Cloudflare references
  cloudflare_zone_id TEXT,
  cloudflare_account_id TEXT,

  -- DNS provisioning status
  dns_configured BOOLEAN DEFAULT FALSE,
  mx_verified BOOLEAN DEFAULT FALSE,
  spf_verified BOOLEAN DEFAULT FALSE,
  dkim_verified BOOLEAN DEFAULT FALSE,
  dmarc_verified BOOLEAN DEFAULT FALSE,
  dns_configured_at TIMESTAMP WITH TIME ZONE,

  -- Lifecycle
  status TEXT DEFAULT 'searching' CHECK (status IN (
    'searching',     -- domain availability being checked
    'purchased',     -- purchased, DNS not yet configured
    'dns_pending',   -- DNS records created, awaiting propagation
    'active',        -- fully configured and ready for mailboxes
    'inactive',      -- disabled (e.g., expired, paused)
    'failed'         -- purchase or DNS setup failed
  )),
  status_reason TEXT,  -- human-readable reason for current status

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Each domain is unique per org
  UNIQUE(org_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_email_domains_org_id ON email_domains(org_id);
CREATE INDEX IF NOT EXISTS idx_email_domains_status ON email_domains(status);
CREATE INDEX IF NOT EXISTS idx_email_domains_domain ON email_domains(domain);

DROP TRIGGER IF EXISTS update_email_domains_updated_at ON email_domains;
CREATE TRIGGER update_email_domains_updated_at
  BEFORE UPDATE ON email_domains
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 2. EMAIL_ACCOUNTS
-- ============================================
-- Individual mailboxes created on outreach domains.
-- Managed via Smartlead for warmup and sending.

CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Domain association
  domain_id UUID NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,

  -- Account identity
  email_address TEXT NOT NULL,
  display_name TEXT,       -- "Sam Reid", "Alex Johnson", etc.
  first_name TEXT,
  last_name TEXT,

  -- Smartlead integration
  smartlead_account_id TEXT,         -- Smartlead's internal ID for this account
  smartlead_warmup_enabled BOOLEAN DEFAULT FALSE,
  smartlead_warmup_status TEXT CHECK (smartlead_warmup_status IN (
    'not_started', 'in_progress', 'completed', 'paused', 'failed'
  )) DEFAULT 'not_started',
  warmup_started_at TIMESTAMP WITH TIME ZONE,
  warmup_completed_at TIMESTAMP WITH TIME ZONE,

  -- Sending limits
  daily_send_limit INTEGER DEFAULT 30,
  current_daily_sent INTEGER DEFAULT 0,
  last_sent_at TIMESTAMP WITH TIME ZONE,

  -- SMTP / IMAP credentials (encrypted in practice via Smartlead)
  smtp_host TEXT,
  smtp_port INTEGER DEFAULT 587,
  imap_host TEXT,
  imap_port INTEGER DEFAULT 993,

  -- Health
  reputation_score NUMERIC(5, 2),    -- domain/sender reputation if tracked
  bounce_rate NUMERIC(5, 4),         -- rolling bounce rate (0.0000 - 1.0000)
  last_health_check_at TIMESTAMP WITH TIME ZONE,

  -- Lifecycle
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',       -- created, not yet provisioned in Smartlead
    'warming',       -- warmup in progress
    'ready',         -- warmup complete, ready to send campaigns
    'active',        -- actively sending campaigns
    'paused',        -- temporarily paused
    'disabled',      -- permanently disabled (reputation issues, etc.)
    'failed'         -- provisioning failed
  )),

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Each email address is globally unique
  UNIQUE(email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_org_id ON email_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_domain_id ON email_accounts(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_status ON email_accounts(status);
CREATE INDEX IF NOT EXISTS idx_email_accounts_email_address ON email_accounts(email_address);
CREATE INDEX IF NOT EXISTS idx_email_accounts_smartlead_account_id ON email_accounts(smartlead_account_id);

DROP TRIGGER IF EXISTS update_email_accounts_updated_at ON email_accounts;
CREATE TRIGGER update_email_accounts_updated_at
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 3. OUTREACH_CAMPAIGNS
-- ============================================
-- Campaigns managed via Smartlead with multi-step email sequences.
-- Links to the existing leads/contacts tables for targeting.

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Campaign identity
  name TEXT NOT NULL,
  description TEXT,

  -- Smartlead integration
  smartlead_campaign_id TEXT,        -- Smartlead's internal campaign ID
  smartlead_status TEXT,             -- raw status from Smartlead API

  -- Sequence configuration (stored as JSONB for flexibility)
  -- Example: [
  --   { "step": 1, "delay_days": 0, "subject": "...", "body": "..." },
  --   { "step": 2, "delay_days": 3, "subject": "Re: ...", "body": "..." },
  --   { "step": 3, "delay_days": 5, "subject": "Re: ...", "body": "..." }
  -- ]
  sequence_steps JSONB DEFAULT '[]'::jsonb,

  -- Targeting
  target_icp_fit TEXT[] DEFAULT ARRAY['HIGH'],  -- which ICP fits to include
  target_industries TEXT[],                      -- optional industry filter

  -- Sending accounts (which email_accounts to rotate through)
  sending_account_ids UUID[] DEFAULT ARRAY[]::UUID[],

  -- Schedule
  send_days TEXT[] DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri'],
  send_start_hour INTEGER DEFAULT 8,   -- local time start (24h)
  send_end_hour INTEGER DEFAULT 17,    -- local time end (24h)
  timezone TEXT DEFAULT 'America/New_York',

  -- Stats (denormalized for quick dashboard reads — updated by webhooks)
  total_leads INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_replied INTEGER DEFAULT 0,
  total_bounced INTEGER DEFAULT 0,
  total_unsubscribed INTEGER DEFAULT 0,

  -- Lifecycle
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft',         -- being configured
    'scheduled',     -- ready to launch at a future time
    'active',        -- currently sending
    'paused',        -- temporarily paused
    'completed',     -- all sequences finished
    'archived'       -- soft-deleted / hidden
  )),
  launched_at TIMESTAMP WITH TIME ZONE,
  paused_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_org_id ON outreach_campaigns(org_id);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status ON outreach_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_smartlead_campaign_id ON outreach_campaigns(smartlead_campaign_id);

DROP TRIGGER IF EXISTS update_outreach_campaigns_updated_at ON outreach_campaigns;
CREATE TRIGGER update_outreach_campaigns_updated_at
  BEFORE UPDATE ON outreach_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 4. EMAIL_CONVERSATIONS
-- ============================================
-- Stores inbound replies and full conversation threads.
-- Populated by Smartlead webhooks and/or Gmail inbox polling.

CREATE TABLE IF NOT EXISTS email_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Associations (all optional — webhook may arrive before lead matching)
  campaign_id UUID REFERENCES outreach_campaigns(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,

  -- Thread identity
  thread_id TEXT,                    -- Gmail thread ID or Smartlead thread ref
  message_id TEXT,                   -- RFC 2822 Message-ID
  in_reply_to TEXT,                  -- parent message's Message-ID
  smartlead_message_id TEXT,         -- Smartlead's internal message ID

  -- Message content
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,                    -- plain text body
  body_html TEXT,                    -- HTML body (if available)

  -- Direction & classification
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  message_type TEXT DEFAULT 'reply' CHECK (message_type IN (
    'reply',           -- prospect replied
    'auto_reply',      -- OOO / auto-responder
    'bounce',          -- bounce notification
    'unsubscribe',     -- unsubscribe request
    'forwarded',       -- forwarded to someone else
    'initial',         -- our initial outreach (for context)
    'followup'         -- our follow-up (for context)
  )),

  -- Sentiment (set by AI classification or manual review)
  sentiment TEXT CHECK (sentiment IN (
    'positive',        -- interested, wants to learn more
    'neutral',         -- informational, no clear intent
    'negative',        -- not interested, asked to stop
    'meeting_request'  -- explicitly asked for a meeting/demo
  )),

  -- Review status
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP WITH TIME ZONE,
  is_starred BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,

  -- Raw webhook payload (for debugging)
  raw_payload JSONB,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_email_conversations_org_id ON email_conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_campaign_id ON email_conversations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_lead_id ON email_conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_contact_id ON email_conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_account_id ON email_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_thread_id ON email_conversations(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_conversations_direction ON email_conversations(direction);
CREATE INDEX IF NOT EXISTS idx_email_conversations_message_type ON email_conversations(message_type);
CREATE INDEX IF NOT EXISTS idx_email_conversations_sentiment ON email_conversations(sentiment);
CREATE INDEX IF NOT EXISTS idx_email_conversations_is_read ON email_conversations(is_read) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS idx_email_conversations_from_email ON email_conversations(from_email);
CREATE INDEX IF NOT EXISTS idx_email_conversations_created_at ON email_conversations(created_at DESC);

DROP TRIGGER IF EXISTS update_email_conversations_updated_at ON email_conversations;
CREATE TRIGGER update_email_conversations_updated_at
  BEFORE UPDATE ON email_conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 5. EMAIL_SETTINGS
-- ============================================
-- Per-org configuration for outreach infrastructure.
-- Stores API keys (encrypted in practice), defaults, and preferences.
-- One row per org (enforced by UNIQUE on org_id).

CREATE TABLE IF NOT EXISTS email_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant (one settings row per org)
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Cloudflare configuration
  cloudflare_api_token TEXT,         -- API token with DNS + Registrar perms
  cloudflare_account_id TEXT,        -- Cloudflare account ID

  -- Smartlead configuration
  smartlead_api_key TEXT,            -- Smartlead API key

  -- Gmail / Google Workspace configuration
  gmail_oauth_credentials JSONB,     -- OAuth client_id, client_secret, refresh_token
  gmail_from_email TEXT,             -- default sender for manual sends
  gmail_from_name TEXT,              -- default sender display name

  -- Default sending preferences
  default_daily_send_limit INTEGER DEFAULT 30,
  default_warmup_enabled BOOLEAN DEFAULT TRUE,
  default_send_days TEXT[] DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri'],
  default_send_start_hour INTEGER DEFAULT 8,
  default_send_end_hour INTEGER DEFAULT 17,
  default_timezone TEXT DEFAULT 'America/New_York',

  -- Warmup configuration
  warmup_increment_per_day INTEGER DEFAULT 2,    -- increase daily limit by N/day
  warmup_max_daily_limit INTEGER DEFAULT 50,     -- cap after warmup
  warmup_duration_days INTEGER DEFAULT 21,       -- target warmup period

  -- Email verification preferences
  emaillistverify_api_key TEXT,      -- ELV API key (moves from env var to per-org)
  verify_before_send BOOLEAN DEFAULT TRUE,
  block_risky_emails BOOLEAN DEFAULT TRUE,       -- block catch-all / extrapolated

  -- Webhook configuration
  smartlead_webhook_secret TEXT,     -- shared secret for webhook signature verification

  -- Feature flags (future multi-tenant billing gates)
  max_domains INTEGER DEFAULT 5,
  max_accounts_per_domain INTEGER DEFAULT 3,
  max_active_campaigns INTEGER DEFAULT 3,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- One settings row per org
  UNIQUE(org_id)
);

CREATE INDEX IF NOT EXISTS idx_email_settings_org_id ON email_settings(org_id);

DROP TRIGGER IF EXISTS update_email_settings_updated_at ON email_settings;
CREATE TRIGGER update_email_settings_updated_at
  BEFORE UPDATE ON email_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 6. CAMPAIGN_LEADS JUNCTION TABLE
-- ============================================
-- Many-to-many: which leads are enrolled in which campaigns.
-- Tracks per-lead sequence progress within a campaign.

CREATE TABLE IF NOT EXISTS campaign_leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Tenant
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Associations
  campaign_id UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Sequence progress
  current_step INTEGER DEFAULT 0,    -- which step in the sequence (0 = not started)
  last_step_sent_at TIMESTAMP WITH TIME ZONE,
  next_step_scheduled_at TIMESTAMP WITH TIME ZONE,

  -- Per-lead status within this campaign
  status TEXT DEFAULT 'active' CHECK (status IN (
    'active',          -- receiving sequence emails
    'replied',         -- replied (stop sequence)
    'bounced',         -- email bounced
    'unsubscribed',    -- requested removal
    'completed',       -- all steps sent
    'paused',          -- manually paused
    'removed'          -- manually removed from campaign
  )),

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Each lead can only be in a campaign once
  UNIQUE(campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_org_id ON campaign_leads(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_id ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead_id ON campaign_leads(lead_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status ON campaign_leads(status);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_next_step ON campaign_leads(next_step_scheduled_at) WHERE status = 'active';

DROP TRIGGER IF EXISTS update_campaign_leads_updated_at ON campaign_leads;
CREATE TRIGGER update_campaign_leads_updated_at
  BEFORE UPDATE ON campaign_leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- 7. ROW LEVEL SECURITY
-- ============================================
-- All new tables use org-scoped RLS matching the existing pattern.
-- Frontend (anon key) sees only their org's data.
-- Backend (service key) bypasses RLS entirely.

ALTER TABLE email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_leads ENABLE ROW LEVEL SECURITY;

-- email_domains: org-scoped CRUD
CREATE POLICY "Users can view their org email domains"
  ON email_domains FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert email domains into their org"
  ON email_domains FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org email domains"
  ON email_domains FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can delete their org email domains"
  ON email_domains FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- email_accounts: org-scoped CRUD
CREATE POLICY "Users can view their org email accounts"
  ON email_accounts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert email accounts into their org"
  ON email_accounts FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org email accounts"
  ON email_accounts FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can delete their org email accounts"
  ON email_accounts FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- outreach_campaigns: org-scoped CRUD
CREATE POLICY "Users can view their org outreach campaigns"
  ON outreach_campaigns FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert outreach campaigns into their org"
  ON outreach_campaigns FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org outreach campaigns"
  ON outreach_campaigns FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can delete their org outreach campaigns"
  ON outreach_campaigns FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- email_conversations: org-scoped CRUD
CREATE POLICY "Users can view their org email conversations"
  ON email_conversations FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert email conversations into their org"
  ON email_conversations FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org email conversations"
  ON email_conversations FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can delete their org email conversations"
  ON email_conversations FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));

-- email_settings: org-scoped CRUD
CREATE POLICY "Users can view their org email settings"
  ON email_settings FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert email settings into their org"
  ON email_settings FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org email settings"
  ON email_settings FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));

-- campaign_leads: org-scoped CRUD
CREATE POLICY "Users can view their org campaign leads"
  ON campaign_leads FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can insert campaign leads into their org"
  ON campaign_leads FOR INSERT
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can update their org campaign leads"
  ON campaign_leads FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()));
CREATE POLICY "Users can delete their org campaign leads"
  ON campaign_leads FOR DELETE
  USING (org_id IN (SELECT get_user_org_ids()));


-- ============================================
-- 8. VIEWS
-- ============================================

-- Domain health overview per org
CREATE OR REPLACE VIEW email_domains_with_stats AS
SELECT
  d.*,
  COUNT(DISTINCT a.id) AS account_count,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'active') AS active_account_count,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'warming') AS warming_account_count
FROM email_domains d
LEFT JOIN email_accounts a ON a.domain_id = d.id
GROUP BY d.id;

-- Campaign performance overview
CREATE OR REPLACE VIEW outreach_campaigns_with_stats AS
SELECT
  c.*,
  COUNT(DISTINCT cl.id) AS enrolled_leads,
  COUNT(DISTINCT cl.id) FILTER (WHERE cl.status = 'replied') AS replied_leads,
  COUNT(DISTINCT cl.id) FILTER (WHERE cl.status = 'bounced') AS bounced_leads,
  COUNT(DISTINCT cl.id) FILTER (WHERE cl.status = 'completed') AS completed_leads,
  COUNT(DISTINCT ec.id) FILTER (WHERE ec.direction = 'inbound') AS inbound_messages
FROM outreach_campaigns c
LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
LEFT JOIN email_conversations ec ON ec.campaign_id = c.id
GROUP BY c.id;

-- Inbox view: unread inbound messages with lead context
CREATE OR REPLACE VIEW inbox_messages AS
SELECT
  ec.id,
  ec.org_id,
  ec.created_at,
  ec.from_email,
  ec.from_name,
  ec.to_email,
  ec.subject,
  ec.body_text,
  ec.direction,
  ec.message_type,
  ec.sentiment,
  ec.is_read,
  ec.is_starred,
  ec.thread_id,
  ec.campaign_id,
  ec.lead_id,
  ec.contact_id,
  l.website AS lead_website,
  l.company_name AS lead_company,
  l.icp_fit AS lead_icp_fit,
  oc.name AS campaign_name
FROM email_conversations ec
LEFT JOIN prospects l ON l.id = ec.lead_id
LEFT JOIN outreach_campaigns oc ON oc.id = ec.campaign_id
WHERE ec.direction = 'inbound'
  AND ec.message_type IN ('reply', 'meeting_request')
  AND NOT ec.is_archived;


-- ============================================
-- 9. RPC FUNCTIONS
-- ============================================

-- Atomically increment total_replied on outreach_campaigns.
-- Used by the Smartlead webhook to avoid read-then-write race conditions
-- when multiple replies arrive concurrently for the same campaign.
CREATE OR REPLACE FUNCTION increment_campaign_replies(p_campaign_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE outreach_campaigns
  SET total_replied = total_replied + 1
  WHERE id = p_campaign_id;
$$;


-- ============================================
-- DONE! Email outreach infrastructure is ready.
--
-- New tables:
--   email_domains          — domain lifecycle management
--   email_accounts         — per-domain mailboxes with warmup tracking
--   outreach_campaigns     — campaign config + sequence steps
--   campaign_leads         — lead enrollment + sequence progress
--   email_conversations    — inbound/outbound message log
--   email_settings         — per-org API keys + defaults
--
-- All tables have:
--   ✓ org_id (multi-tenant)
--   ✓ RLS policies (org-scoped)
--   ✓ updated_at triggers
--   ✓ Performance indexes
--   ✓ Status enums with CHECK constraints
--   ✓ JSONB metadata columns for extensibility
-- ============================================
