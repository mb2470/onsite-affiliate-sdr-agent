const { createClient } = require('@supabase/supabase-js');
const { ZohoMailService } = require('./lib/zoho-mail-api');

// Use service role key (bypasses RLS) for server-side function
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

const { corsHeaders } = require('./lib/cors');

// Computed per-request in the handler; module-level so helpers can use respond().
let CORS_HEADERS = {};

// ── Warmup schedule constants ─────────────────────────────────────────────────
// Default ramp: start at 2/day, add 2/day, cap at 50 over ~24 days
const DEFAULT_WARMUP_START = 2;
const DEFAULT_WARMUP_INCREMENT = 2;
const DEFAULT_WARMUP_MAX = 50;
const DEFAULT_WARMUP_DAYS = 21;

// ── Helpers ──────────────────────────────────────────────────────────────────

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? '••••••••' : '';
  return key.slice(0, 6) + '••••••••••••••••' + key.slice(-4);
}

async function getOrgSettings(orgId) {
  const { data, error } = await supabase
    .from('email_settings')
    .select('*')
    .eq('org_id', orgId)
    .single();
  if (error || !data) return null;
  return data;
}

async function logActivity(orgId, activityType, summary, status = 'success') {
  await supabase.from('activity_log').insert({
    org_id: orgId,
    activity_type: activityType,
    summary,
    status,
  });
}

function getZohoClient(settings) {
  const zoho = settings?.metadata?.zoho;
  if (!zoho || !zoho.client_id || !zoho.client_secret || !zoho.refresh_token || !zoho.org_id) {
    return null;
  }
  return new ZohoMailService({
    clientId: zoho.client_id,
    clientSecret: zoho.client_secret,
    refreshToken: zoho.refresh_token,
    orgId: zoho.org_id,
    accountsDomain: zoho.accounts_domain || undefined,
    mailDomain: zoho.mail_domain || undefined,
  });
}

/**
 * Calculate the daily send limit for an account based on warmup schedule.
 * warmup_started_at → days elapsed → limit = start + (days * increment), capped at max
 */
function calculateWarmupLimit(account, settings) {
  const start = settings?.warmup_start_limit || DEFAULT_WARMUP_START;
  const increment = settings?.warmup_increment_per_day || DEFAULT_WARMUP_INCREMENT;
  const max = settings?.warmup_max_daily_limit || DEFAULT_WARMUP_MAX;

  if (!account.warmup_started_at) return start;

  const daysElapsed = Math.floor(
    (Date.now() - new Date(account.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  return Math.min(start + (daysElapsed * increment), max);
}

// ── Settings Actions ─────────────────────────────────────────────────────────

async function handleGetSettings(orgId) {
  const settings = await getOrgSettings(orgId);
  if (!settings) {
    return respond(200, {
      has_cloudflare: false,
      has_gmail: false,
      has_zoho: false,
    });
  }

  const whois = settings.metadata?.whois || {};
  const zoho = settings.metadata?.zoho || {};

  return respond(200, {
    has_cloudflare: !!(settings.cloudflare_api_token && settings.cloudflare_account_id),
    has_gmail: !!settings.gmail_oauth_credentials,
    has_zoho: !!(zoho.client_id && zoho.client_secret && zoho.refresh_token && zoho.org_id),
    cloudflare_account_id: settings.cloudflare_account_id || '',
    gmail_from_email: settings.gmail_from_email || '',
    gmail_from_name: settings.gmail_from_name || '',
    zoho_org_id: zoho.org_id || '',
    zoho_accounts_domain: zoho.accounts_domain || 'https://accounts.zoho.com',
    zoho_mail_domain: zoho.mail_domain || 'https://mail.zoho.com',
    whois_first_name: whois.first_name || '',
    whois_last_name: whois.last_name || '',
    whois_address: whois.address || '',
    whois_city: whois.city || '',
    whois_state: whois.state || '',
    whois_zip: whois.zip || '',
    whois_country: whois.country || 'US',
    whois_phone: whois.phone || '',
    whois_email: whois.email || '',
    warmup_increment_per_day: settings.warmup_increment_per_day || DEFAULT_WARMUP_INCREMENT,
    warmup_max_daily_limit: settings.warmup_max_daily_limit || DEFAULT_WARMUP_MAX,
    warmup_duration_days: settings.warmup_duration_days || DEFAULT_WARMUP_DAYS,
  });
}

async function handleUpdateSettings(orgId, body) {
  const updates = {};

  if (body.cloudflare_account_id !== undefined) updates.cloudflare_account_id = body.cloudflare_account_id;
  if (body.cloudflare_api_token !== undefined) updates.cloudflare_api_token = body.cloudflare_api_token;
  if (body.gmail_from_email !== undefined) updates.gmail_from_email = body.gmail_from_email;
  if (body.gmail_from_name !== undefined) updates.gmail_from_name = body.gmail_from_name;

  // Handle WHOIS fields → stored in metadata.whois
  const whoisFields = [
    'whois_first_name', 'whois_last_name', 'whois_address',
    'whois_city', 'whois_state', 'whois_zip', 'whois_country',
    'whois_phone', 'whois_email',
  ];
  const hasWhoisUpdate = whoisFields.some(f => body[f] !== undefined);

  // Handle Zoho fields → stored in metadata.zoho
  const zohoFields = [
    'zoho_client_id', 'zoho_client_secret', 'zoho_refresh_token',
    'zoho_org_id', 'zoho_accounts_domain', 'zoho_mail_domain',
  ];
  const hasZohoUpdate = zohoFields.some(f => body[f] !== undefined);

  if (hasWhoisUpdate || hasZohoUpdate) {
    const existing = await getOrgSettings(orgId);
    const existingMetadata = existing?.metadata || {};

    if (hasWhoisUpdate) {
      const existingWhois = existingMetadata.whois || {};
      const whoisMap = {
        whois_first_name: 'first_name', whois_last_name: 'last_name',
        whois_address: 'address', whois_city: 'city', whois_state: 'state',
        whois_zip: 'zip', whois_country: 'country', whois_phone: 'phone',
        whois_email: 'email',
      };
      const newWhois = { ...existingWhois };
      for (const [bodyKey, whoisKey] of Object.entries(whoisMap)) {
        if (body[bodyKey] !== undefined) newWhois[whoisKey] = body[bodyKey];
      }
      existingMetadata.whois = newWhois;
    }

    if (hasZohoUpdate) {
      const existingZoho = existingMetadata.zoho || {};
      const zohoMap = {
        zoho_client_id: 'client_id',
        zoho_client_secret: 'client_secret',
        zoho_refresh_token: 'refresh_token',
        zoho_org_id: 'org_id',
        zoho_accounts_domain: 'accounts_domain',
        zoho_mail_domain: 'mail_domain',
      };
      const newZoho = { ...existingZoho };
      for (const [bodyKey, zohoKey] of Object.entries(zohoMap)) {
        if (body[bodyKey] !== undefined) newZoho[zohoKey] = body[bodyKey];
      }
      existingMetadata.zoho = newZoho;
    }

    updates.metadata = existingMetadata;
  }

  if (Object.keys(updates).length === 0) {
    return respond(400, { error: 'No valid fields to update.' });
  }

  const { error } = await supabase
    .from('email_settings')
    .upsert({ org_id: orgId, ...updates }, { onConflict: 'org_id' })
    .select()
    .single();

  if (error) return respond(500, { error: 'Failed to update settings', details: error.message });

  return respond(200, { success: true });
}

// ── Email Accounts Actions ───────────────────────────────────────────────────

async function handleListAccounts(orgId) {
  const settings = await getOrgSettings(orgId);
  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('*, email_domains!inner(domain, status)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return respond(500, { error: 'Failed to fetch accounts', details: error.message });

  const result = (accounts || []).map(a => {
    const warmupLimit = calculateWarmupLimit(a, settings);
    const remaining = Math.max(0, warmupLimit - (a.current_daily_sent || 0));
    const daysElapsed = a.warmup_started_at
      ? Math.floor((Date.now() - new Date(a.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const warmupComplete = warmupLimit >= (settings?.warmup_max_daily_limit || DEFAULT_WARMUP_MAX);

    return {
      id: a.id,
      email_address: a.email_address,
      display_name: a.display_name,
      smtp_host: a.smtp_host,
      smtp_port: a.smtp_port,
      imap_host: a.imap_host,
      imap_port: a.imap_port,
      daily_send_limit: warmupLimit,
      current_daily_sent: a.current_daily_sent || 0,
      remaining_today: remaining,
      warmup_day: daysElapsed,
      warmup_complete: warmupComplete,
      warmup_started_at: a.warmup_started_at,
      status: warmupComplete ? 'active' : a.status,
      domain: {
        domain: a.email_domains.domain,
        status: a.email_domains.status,
      },
    };
  });

  return respond(200, { accounts: result });
}

async function handleCreateAccount(orgId, body, settings) {
  const { domain_id, local_part, password, from_name, smtp_host, imap_host, smtp_port, imap_port } = body;

  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });
  if (!local_part) return respond(400, { error: 'Missing required field: local_part' });
  if (!password) return respond(400, { error: 'Missing required field: password' });

  // Validate domain belongs to org
  const { data: domain, error: domErr } = await supabase
    .from('email_domains')
    .select('id, domain, status')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domErr || !domain) return respond(404, { error: 'Domain not found.' });

  const emailAddress = `${local_part}@${domain.domain}`;

  // Check for duplicate
  const { count } = await supabase
    .from('email_accounts')
    .select('*', { count: 'exact', head: true })
    .eq('email_address', emailAddress);

  if (count > 0) return respond(400, { error: `Email address ${emailAddress} already exists.` });

  const smtpHostVal = smtp_host || 'smtp.zoho.com';
  const imapHostVal = imap_host || 'imap.zoho.com';
  const smtpPortVal = smtp_port || 587;
  const imapPortVal = imap_port || 993;

  // Store in database — start with warmup limit of 2/day
  const startLimit = settings?.warmup_start_limit || DEFAULT_WARMUP_START;
  const { data: account, error: insertErr } = await supabase
    .from('email_accounts')
    .insert({
      org_id: orgId,
      domain_id,
      email_address: emailAddress,
      display_name: from_name || local_part,
      first_name: from_name ? from_name.split(' ')[0] : local_part,
      warmup_started_at: new Date().toISOString(),
      smtp_host: smtpHostVal,
      smtp_port: smtpPortVal,
      imap_host: imapHostVal,
      imap_port: imapPortVal,
      daily_send_limit: startLimit,
      current_daily_sent: 0,
      status: 'warming',
    })
    .select()
    .single();

  if (insertErr) return respond(500, { error: 'Failed to save email account', details: insertErr.message });

  await logActivity(orgId, 'email_account_created', `Created email account ${emailAddress} (warmup: ${startLimit}/day)`);

  // Auto-provision Zoho mailbox if credentials configured
  let zohoProvisioned = false;
  const zoho = getZohoClient(settings);
  if (zoho) {
    const { data: domainFull } = await supabase
      .from('email_domains')
      .select('metadata')
      .eq('id', domain_id)
      .single();
    const forwardTo = domainFull?.metadata?.forward_to_email || null;

    try {
      const zohoResult = await zoho.provisionMailbox({
        emailAddress,
        password,
        firstName: from_name ? from_name.split(' ')[0] : local_part,
        lastName: from_name ? from_name.split(' ').slice(1).join(' ') : '',
        displayName: from_name || local_part,
        forwardTo,
      });

      zohoProvisioned = true;

      await supabase
        .from('email_accounts')
        .update({
          metadata: {
            zoho_account_id: zohoResult.accountId || null,
            zoho_zuid: zohoResult.zuid || null,
            zoho_imap_enabled: zohoResult.imapEnabled,
            zoho_forwarding_configured: zohoResult.forwardingConfigured,
            zoho_forward_to: forwardTo,
          },
        })
        .eq('id', account.id);

      await logActivity(orgId, 'zoho_mailbox_created',
        `Auto-provisioned Zoho mailbox for ${emailAddress} (IMAP: ${zohoResult.imapEnabled}, Fwd: ${zohoResult.forwardingConfigured})`
      );
    } catch (zohoErr) {
      console.error('Auto-provision Zoho mailbox failed (non-blocking):', zohoErr.message);
      await logActivity(orgId, 'zoho_mailbox_failed',
        `Failed to auto-provision Zoho mailbox for ${emailAddress}: ${zohoErr.message}`, 'warning'
      );
    }
  }

  return respond(200, {
    id: account.id,
    email_address: account.email_address,
    daily_send_limit: startLimit,
    status: account.status,
    zoho_provisioned: zohoProvisioned,
  });
}

// ── Send Capacity (for Python agent) ─────────────────────────────────────────

/**
 * send-capacity — Returns all active/warming accounts with remaining send capacity.
 * The Python agent calls this to know how many emails it can send from each account.
 */
async function handleSendCapacity(orgId) {
  const settings = await getOrgSettings(orgId);

  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('*, email_domains!inner(domain, status, metadata)')
    .eq('org_id', orgId)
    .in('status', ['warming', 'active']);

  if (error) return respond(500, { error: 'Failed to fetch accounts', details: error.message });

  const capacity = (accounts || []).map(a => {
    const warmupLimit = calculateWarmupLimit(a, settings);
    const sent = a.current_daily_sent || 0;
    const remaining = Math.max(0, warmupLimit - sent);

    return {
      account_id: a.id,
      email_address: a.email_address,
      display_name: a.display_name,
      domain: a.email_domains.domain,
      domain_status: a.email_domains.status,
      smtp_host: a.smtp_host,
      smtp_port: a.smtp_port,
      daily_limit: warmupLimit,
      sent_today: sent,
      remaining_today: remaining,
      warmup_day: a.warmup_started_at
        ? Math.floor((Date.now() - new Date(a.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0,
      forward_to: a.email_domains.metadata?.forward_to_email || null,
    };
  });

  const totalRemaining = capacity.reduce((sum, a) => sum + a.remaining_today, 0);

  return respond(200, {
    accounts: capacity,
    total_remaining: totalRemaining,
    total_accounts: capacity.length,
  });
}

/**
 * record-send — Called by the Python agent after successfully sending an email.
 * Increments current_daily_sent and enforces hard cap.
 */
async function handleRecordSend(orgId, body) {
  const { account_id, count: sendCount } = body;
  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });

  const numToRecord = sendCount || 1;

  const settings = await getOrgSettings(orgId);

  const { data: account, error: accErr } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', account_id)
    .eq('org_id', orgId)
    .single();

  if (accErr || !account) return respond(404, { error: 'Email account not found.' });

  const warmupLimit = calculateWarmupLimit(account, settings);
  const currentSent = account.current_daily_sent || 0;
  const newSent = currentSent + numToRecord;

  // Hard cap enforcement
  if (currentSent >= warmupLimit) {
    return respond(429, {
      error: 'Daily send limit reached for this account.',
      daily_limit: warmupLimit,
      sent_today: currentSent,
      remaining: 0,
    });
  }

  // Allow partial if they try to record more than remaining
  const actualRecorded = Math.min(numToRecord, warmupLimit - currentSent);

  await supabase
    .from('email_accounts')
    .update({
      current_daily_sent: currentSent + actualRecorded,
      last_sent_at: new Date().toISOString(),
    })
    .eq('id', account_id);

  return respond(200, {
    success: true,
    recorded: actualRecorded,
    sent_today: currentSent + actualRecorded,
    daily_limit: warmupLimit,
    remaining: warmupLimit - (currentSent + actualRecorded),
  });
}

/**
 * warmup-tick — Advance warmup for all accounts in an org.
 * Recalculates daily_send_limit based on days since warmup_started_at.
 * Resets current_daily_sent to 0 for the new day.
 * Marks accounts as 'active' once warmup is complete.
 * Should be called once per day (via cron, scheduled function, or manually).
 */
async function handleWarmupTick(orgId) {
  const settings = await getOrgSettings(orgId);
  const maxLimit = settings?.warmup_max_daily_limit || DEFAULT_WARMUP_MAX;

  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('id, warmup_started_at, daily_send_limit, status, current_daily_sent')
    .eq('org_id', orgId)
    .in('status', ['warming', 'active']);

  if (error) return respond(500, { error: 'Failed to fetch accounts', details: error.message });

  let advanced = 0;
  let completed = 0;
  let reset = 0;

  for (const account of (accounts || [])) {
    const newLimit = calculateWarmupLimit(account, settings);
    const warmupComplete = newLimit >= maxLimit;

    const updates = {
      daily_send_limit: newLimit,
      current_daily_sent: 0, // Reset daily counter
    };

    if (warmupComplete && account.status === 'warming') {
      updates.status = 'active';
      updates.warmup_completed_at = new Date().toISOString();
      completed++;
    }

    if (newLimit !== account.daily_send_limit) advanced++;
    reset++;

    await supabase
      .from('email_accounts')
      .update(updates)
      .eq('id', account.id);
  }

  await logActivity(orgId, 'warmup_tick',
    `Daily warmup tick: ${reset} accounts reset, ${advanced} limits advanced, ${completed} warmups completed`
  );

  return respond(200, {
    success: true,
    accounts_reset: reset,
    limits_advanced: advanced,
    warmups_completed: completed,
  });
}

// ── Campaign Actions (local DB only, no Smartlead) ───────────────────────────

async function handleAssignAccount(orgId, body) {
  const { account_id, campaign_id } = body;
  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });
  if (!campaign_id) return respond(400, { error: 'Missing required field: campaign_id' });

  const { data: account, error: accErr } = await supabase
    .from('email_accounts')
    .select('id, email_address')
    .eq('id', account_id)
    .eq('org_id', orgId)
    .single();

  if (accErr || !account) return respond(404, { error: 'Email account not found.' });

  const { data: campaign, error: campErr } = await supabase
    .from('outreach_campaigns')
    .select('id, name, sending_account_ids')
    .eq('id', campaign_id)
    .eq('org_id', orgId)
    .single();

  if (campErr || !campaign) return respond(404, { error: 'Campaign not found.' });

  const currentIds = campaign.sending_account_ids || [];
  if (!currentIds.includes(account.id)) {
    await supabase
      .from('outreach_campaigns')
      .update({ sending_account_ids: [...currentIds, account.id] })
      .eq('id', campaign_id);
  }

  return respond(200, {
    success: true,
    message: `${account.email_address} assigned to ${campaign.name}`,
  });
}

async function handleListCampaigns(orgId) {
  const { data: campaigns, error } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return respond(500, { error: 'Failed to fetch campaigns', details: error.message });
  return respond(200, { campaigns: campaigns || [] });
}

async function handleCreateCampaign(orgId, body) {
  const { name } = body;
  if (!name) return respond(400, { error: 'Missing required field: name' });

  const { data: campaign, error: insertErr } = await supabase
    .from('outreach_campaigns')
    .insert({ org_id: orgId, name, status: 'draft' })
    .select()
    .single();

  if (insertErr) return respond(500, { error: 'Failed to save campaign', details: insertErr.message });

  await logActivity(orgId, 'campaign_created', `Created campaign "${name}"`);

  return respond(200, {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    total_leads: 0,
    total_sent: 0,
    total_replied: 0,
  });
}

async function handleGetCampaign(orgId, body) {
  const { campaign_id } = body;
  if (!campaign_id) return respond(400, { error: 'Missing required field: campaign_id' });

  const { data: campaign, error: campErr } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('id', campaign_id)
    .eq('org_id', orgId)
    .single();

  if (campErr || !campaign) return respond(404, { error: 'Campaign not found.' });

  const accountIds = campaign.sending_account_ids || [];
  let accounts = [];
  if (accountIds.length > 0) {
    const { data: accts } = await supabase
      .from('email_accounts')
      .select('id, email_address, status, daily_send_limit, current_daily_sent')
      .in('id', accountIds);
    accounts = accts || [];
  }

  const { count: replyCount } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign_id)
    .eq('direction', 'inbound');

  return respond(200, {
    ...campaign,
    accounts,
    reply_count: replyCount || 0,
  });
}

// ── Inbox Actions ────────────────────────────────────────────────────────────

async function handleListInbox(orgId, body) {
  const page = parseInt(body.page) || 1;
  const limit = Math.min(parseInt(body.limit) || 25, 100);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('email_conversations')
    .select('*', { count: 'exact' })
    .eq('org_id', orgId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (body.campaign_id) {
    query = query.eq('campaign_id', body.campaign_id);
  }

  const { data: conversations, error, count: total } = await query;

  if (error) return respond(500, { error: 'Failed to fetch inbox', details: error.message });

  return respond(200, {
    conversations: conversations || [],
    pagination: { page, limit, total: total || 0, total_pages: Math.ceil((total || 0) / limit) },
  });
}

async function handleGetConversation(orgId, body) {
  const { conversation_id } = body;
  if (!conversation_id) return respond(400, { error: 'Missing required field: conversation_id' });

  const { data: conversation, error } = await supabase
    .from('email_conversations')
    .select('*')
    .eq('id', conversation_id)
    .eq('org_id', orgId)
    .single();

  if (error || !conversation) return respond(404, { error: 'Conversation not found.' });

  if (!conversation.is_read) {
    await supabase
      .from('email_conversations')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', conversation_id);
    conversation.is_read = true;
    conversation.read_at = new Date().toISOString();
  }

  return respond(200, { conversation });
}

async function handleMarkRead(orgId, body) {
  const { conversation_id } = body;
  if (!conversation_id) return respond(400, { error: 'Missing required field: conversation_id' });

  const { error } = await supabase
    .from('email_conversations')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', conversation_id)
    .eq('org_id', orgId);

  if (error) return respond(500, { error: 'Failed to mark as read', details: error.message });
  return respond(200, { success: true });
}

async function handleInboxStats(orgId) {
  const { count: total } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'inbound');

  const { count: unread } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'inbound')
    .eq('is_read', false);

  const { data: byCampaignRaw } = await supabase
    .from('email_conversations')
    .select('campaign_id')
    .eq('org_id', orgId)
    .eq('direction', 'inbound')
    .not('campaign_id', 'is', null);

  const campaignCounts = {};
  for (const row of (byCampaignRaw || [])) {
    campaignCounts[row.campaign_id] = (campaignCounts[row.campaign_id] || 0) + 1;
  }

  const byCampaign = Object.entries(campaignCounts).map(([campaignId, count]) => ({
    campaign_id: campaignId,
    count,
  }));

  return respond(200, {
    total: total || 0,
    unread: unread || 0,
    by_campaign: byCampaign,
  });
}

// ── Main Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  CORS_HEADERS = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(400, { error: 'Only POST requests are supported.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const orgId = body.org_id || event.headers['x-org-id'];
  const { action } = body;

  if (!orgId) return respond(400, { error: 'Missing required field: org_id' });
  if (!action) return respond(400, { error: 'Missing required field: action' });

  try {
    // Settings
    if (action === 'get-settings') return await handleGetSettings(orgId);
    if (action === 'update-settings') return await handleUpdateSettings(orgId, body);

    // Agent endpoints (send capacity & recording)
    if (action === 'send-capacity') return await handleSendCapacity(orgId);
    if (action === 'record-send') return await handleRecordSend(orgId, body);
    if (action === 'warmup-tick') return await handleWarmupTick(orgId);

    // Account management
    if (action === 'list-accounts') return await handleListAccounts(orgId);
    const settings = await getOrgSettings(orgId);
    if (action === 'create-account') return await handleCreateAccount(orgId, body, settings);

    // Campaign management
    if (action === 'list-campaigns') return await handleListCampaigns(orgId);
    if (action === 'create-campaign') return await handleCreateCampaign(orgId, body);
    if (action === 'get-campaign') return await handleGetCampaign(orgId, body);
    if (action === 'assign-account') return await handleAssignAccount(orgId, body);

    // Inbox
    if (action === 'list-inbox') return await handleListInbox(orgId, body);
    if (action === 'get-conversation') return await handleGetConversation(orgId, body);
    if (action === 'mark-read') return await handleMarkRead(orgId, body);
    if (action === 'inbox-stats') return await handleInboxStats(orgId);

    return respond(400, {
      error: `Unknown action: ${action}. Valid: get-settings, update-settings, list-accounts, create-account, send-capacity, record-send, warmup-tick, list-campaigns, create-campaign, get-campaign, assign-account, list-inbox, get-conversation, mark-read, inbox-stats`,
    });
  } catch (error) {
    console.error(`email-api error (action=${action}):`, error);
    return respond(500, { error: error.message });
  }
};
