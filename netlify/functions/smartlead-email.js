const { createClient } = require('@supabase/supabase-js');
const { SmartleadService, SmartleadApiError } = require('./lib/smartlead-api');

// Use service role key (bypasses RLS) for server-side function
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Org-Id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

function getSmartlead(settings) {
  if (!settings || !settings.smartlead_api_key) return null;
  return new SmartleadService(settings.smartlead_api_key);
}

async function logActivity(orgId, activityType, summary, status = 'success') {
  await supabase.from('activity_log').insert({
    org_id: orgId,
    activity_type: activityType,
    summary,
    status,
  });
}

// ── Settings Actions ─────────────────────────────────────────────────────────

async function handleGetSettings(orgId) {
  const settings = await getOrgSettings(orgId);
  if (!settings) {
    return respond(200, {
      smartlead_api_key: '',
      has_smartlead: false,
      has_cloudflare: false,
      has_gmail: false,
    });
  }

  const whois = settings.metadata?.whois || {};

  return respond(200, {
    smartlead_api_key: maskKey(settings.smartlead_api_key),
    has_smartlead: !!settings.smartlead_api_key,
    has_cloudflare: !!(settings.cloudflare_api_token && settings.cloudflare_account_id),
    has_gmail: !!settings.gmail_oauth_credentials,
    cloudflare_account_id: settings.cloudflare_account_id || '',
    gmail_from_email: settings.gmail_from_email || '',
    gmail_from_name: settings.gmail_from_name || '',
    whois_first_name: whois.first_name || '',
    whois_last_name: whois.last_name || '',
    whois_address: whois.address || '',
    whois_city: whois.city || '',
    whois_state: whois.state || '',
    whois_zip: whois.zip || '',
    whois_country: whois.country || 'US',
    whois_phone: whois.phone || '',
    whois_email: whois.email || '',
  });
}

async function handleUpdateSettings(orgId, body) {
  // Whitelist allowed fields
  const updates = {};

  if (body.smartlead_api_key !== undefined) updates.smartlead_api_key = body.smartlead_api_key;
  if (body.cloudflare_account_id !== undefined) updates.cloudflare_account_id = body.cloudflare_account_id;
  if (body.cloudflare_api_token !== undefined) updates.cloudflare_api_token = body.cloudflare_api_token;
  if (body.gmail_from_email !== undefined) updates.gmail_from_email = body.gmail_from_email;
  if (body.gmail_from_name !== undefined) updates.gmail_from_name = body.gmail_from_name;
  if (body.smartlead_webhook_secret !== undefined) updates.smartlead_webhook_secret = body.smartlead_webhook_secret;

  // Handle WHOIS fields → stored in metadata.whois
  const whoisFields = [
    'whois_first_name', 'whois_last_name', 'whois_address',
    'whois_city', 'whois_state', 'whois_zip', 'whois_country',
    'whois_phone', 'whois_email',
  ];
  const hasWhoisUpdate = whoisFields.some(f => body[f] !== undefined);

  if (hasWhoisUpdate) {
    // Fetch existing metadata to merge
    const existing = await getOrgSettings(orgId);
    const existingMetadata = existing?.metadata || {};
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

    updates.metadata = { ...existingMetadata, whois: newWhois };
  }

  if (Object.keys(updates).length === 0) {
    return respond(400, { error: 'No valid fields to update.' });
  }

  // Upsert: insert if no row exists, update if it does
  const { data, error } = await supabase
    .from('email_settings')
    .upsert({ org_id: orgId, ...updates }, { onConflict: 'org_id' })
    .select()
    .single();

  if (error) return respond(500, { error: 'Failed to update settings', details: error.message });

  return respond(200, { success: true });
}

async function handleTestSmartlead(orgId) {
  const settings = await getOrgSettings(orgId);
  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  const result = await sl.testConnection();
  return respond(200, result);
}

// ── Email Accounts Actions ───────────────────────────────────────────────────

async function handleListAccounts(orgId) {
  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('*, email_domains!inner(domain, status)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return respond(500, { error: 'Failed to fetch accounts', details: error.message });

  const result = (accounts || []).map(a => ({
    id: a.id,
    email_address: a.email_address,
    display_name: a.display_name,
    smartlead_account_id: a.smartlead_account_id,
    smtp_host: a.smtp_host,
    smtp_port: a.smtp_port,
    imap_host: a.imap_host,
    imap_port: a.imap_port,
    warmup_enabled: a.smartlead_warmup_enabled,
    warmup_status: a.smartlead_warmup_status,
    daily_send_limit: a.daily_send_limit,
    status: a.status,
    domain: {
      domain: a.email_domains.domain,
      status: a.email_domains.status,
    },
  }));

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

  // Register in Smartlead
  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  const smtpHostVal = smtp_host || 'smtp.zoho.com';
  const imapHostVal = imap_host || 'imap.zoho.com';
  const smtpPortVal = smtp_port || 587;
  const imapPortVal = imap_port || 993;

  const slResult = await sl.addEmailAccount({
    from_email: emailAddress,
    from_name: from_name || local_part,
    username: emailAddress,
    password,
    smtp_host: smtpHostVal,
    smtp_port: smtpPortVal,
    imap_host: imapHostVal,
    imap_port: imapPortVal,
    warmup_enabled: true,
  });

  const smartleadAccountId = slResult?.id?.toString() || slResult?.email_account_id?.toString() || null;

  // Store in database
  const { data: account, error: insertErr } = await supabase
    .from('email_accounts')
    .insert({
      org_id: orgId,
      domain_id,
      email_address: emailAddress,
      display_name: from_name || local_part,
      first_name: from_name ? from_name.split(' ')[0] : local_part,
      smartlead_account_id: smartleadAccountId,
      smartlead_warmup_enabled: true,
      smartlead_warmup_status: 'in_progress',
      warmup_started_at: new Date().toISOString(),
      smtp_host: smtpHostVal,
      smtp_port: smtpPortVal,
      imap_host: imapHostVal,
      imap_port: imapPortVal,
      daily_send_limit: settings.default_daily_send_limit || 30,
      status: 'warming',
    })
    .select()
    .single();

  if (insertErr) return respond(500, { error: 'Failed to save email account', details: insertErr.message });

  await logActivity(orgId, 'email_account_created', `Created email account ${emailAddress} (Smartlead ID: ${smartleadAccountId})`);

  return respond(200, {
    id: account.id,
    email_address: account.email_address,
    smartlead_account_id: account.smartlead_account_id,
    warmup_enabled: account.smartlead_warmup_enabled,
    warmup_status: account.smartlead_warmup_status,
    status: account.status,
  });
}

async function handleToggleWarmup(orgId, body, settings) {
  const { account_id, enabled } = body;
  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });
  if (enabled === undefined) return respond(400, { error: 'Missing required field: enabled' });

  const { data: account, error: accErr } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', account_id)
    .eq('org_id', orgId)
    .single();

  if (accErr || !account) return respond(404, { error: 'Email account not found.' });
  if (!account.smartlead_account_id) return respond(400, { error: 'Account not registered with Smartlead.' });

  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  await sl.updateWarmup(account.smartlead_account_id, enabled);

  const newStatus = enabled ? 'in_progress' : 'paused';
  await supabase
    .from('email_accounts')
    .update({
      smartlead_warmup_enabled: enabled,
      smartlead_warmup_status: newStatus,
    })
    .eq('id', account_id);

  return respond(200, {
    id: account.id,
    warmup_enabled: enabled,
    warmup_status: newStatus,
  });
}

async function handleGetWarmupStats(orgId, body, settings) {
  const { account_id } = body;
  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });

  const { data: account, error: accErr } = await supabase
    .from('email_accounts')
    .select('smartlead_account_id')
    .eq('id', account_id)
    .eq('org_id', orgId)
    .single();

  if (accErr || !account) return respond(404, { error: 'Email account not found.' });
  if (!account.smartlead_account_id) return respond(400, { error: 'Account not registered with Smartlead.' });

  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  const stats = await sl.getWarmupStats(account.smartlead_account_id);
  return respond(200, stats);
}

async function handleAssignAccount(orgId, body, settings) {
  const { account_id, campaign_id } = body;
  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });
  if (!campaign_id) return respond(400, { error: 'Missing required field: campaign_id' });

  // Validate account
  const { data: account, error: accErr } = await supabase
    .from('email_accounts')
    .select('id, email_address, smartlead_account_id')
    .eq('id', account_id)
    .eq('org_id', orgId)
    .single();

  if (accErr || !account) return respond(404, { error: 'Email account not found.' });
  if (!account.smartlead_account_id) return respond(400, { error: 'Account not registered with Smartlead.' });

  // Validate campaign
  const { data: campaign, error: campErr } = await supabase
    .from('outreach_campaigns')
    .select('id, name, smartlead_campaign_id, sending_account_ids')
    .eq('id', campaign_id)
    .eq('org_id', orgId)
    .single();

  if (campErr || !campaign) return respond(404, { error: 'Campaign not found.' });
  if (!campaign.smartlead_campaign_id) return respond(400, { error: 'Campaign not registered with Smartlead.' });

  // Assign in Smartlead
  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  await sl.addEmailsToCampaign(campaign.smartlead_campaign_id, [account.smartlead_account_id]);

  // Update sending_account_ids array in DB
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

// ── Campaign Actions ─────────────────────────────────────────────────────────

async function handleListCampaigns(orgId) {
  const { data: campaigns, error } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return respond(500, { error: 'Failed to fetch campaigns', details: error.message });

  return respond(200, { campaigns: campaigns || [] });
}

async function handleCreateCampaign(orgId, body, settings) {
  const { name } = body;
  if (!name) return respond(400, { error: 'Missing required field: name' });

  const sl = getSmartlead(settings);
  if (!sl) return respond(400, { error: 'Smartlead API key not configured.' });

  const slResult = await sl.createCampaign(name);
  const smartleadCampaignId = slResult?.id?.toString() || null;

  const { data: campaign, error: insertErr } = await supabase
    .from('outreach_campaigns')
    .insert({
      org_id: orgId,
      name,
      smartlead_campaign_id: smartleadCampaignId,
      status: 'draft',
    })
    .select()
    .single();

  if (insertErr) return respond(500, { error: 'Failed to save campaign', details: insertErr.message });

  await logActivity(orgId, 'campaign_created', `Created campaign "${name}" (Smartlead ID: ${smartleadCampaignId})`);

  return respond(200, {
    id: campaign.id,
    name: campaign.name,
    smartlead_campaign_id: campaign.smartlead_campaign_id,
    status: campaign.status,
    total_leads: 0,
    total_sent: 0,
    total_replied: 0,
  });
}

async function handleGetCampaign(orgId, body, settings) {
  const { campaign_id } = body;
  if (!campaign_id) return respond(400, { error: 'Missing required field: campaign_id' });

  const { data: campaign, error: campErr } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('id', campaign_id)
    .eq('org_id', orgId)
    .single();

  if (campErr || !campaign) return respond(404, { error: 'Campaign not found.' });

  // Fetch assigned accounts
  const accountIds = campaign.sending_account_ids || [];
  let accounts = [];
  if (accountIds.length > 0) {
    const { data: accts } = await supabase
      .from('email_accounts')
      .select('id, email_address, smartlead_warmup_status, status')
      .in('id', accountIds);
    accounts = accts || [];
  }

  // Fetch reply count from email_conversations
  const { count: replyCount } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign_id)
    .eq('direction', 'inbound');

  // Try to get live Smartlead stats (graceful degradation)
  let smartleadStats = null;
  if (campaign.smartlead_campaign_id) {
    const sl = getSmartlead(settings);
    if (sl) {
      try {
        smartleadStats = await sl.getCampaignStats(campaign.smartlead_campaign_id);
      } catch (err) {
        console.error(`Failed to fetch Smartlead stats for campaign ${campaign_id}:`, err.message);
      }
    }
  }

  return respond(200, {
    ...campaign,
    accounts,
    reply_count: replyCount || 0,
    smartlead_stats: smartleadStats,
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
    pagination: {
      page,
      limit,
      total: total || 0,
      total_pages: Math.ceil((total || 0) / limit),
    },
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

  // Auto-mark as read
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
  // Total inbound conversations
  const { count: total } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'inbound');

  // Unread count
  const { count: unread } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'inbound')
    .eq('is_read', false);

  // Count by campaign
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
    // Settings actions (don't require Smartlead key)
    if (action === 'get-settings') return await handleGetSettings(orgId);
    if (action === 'update-settings') return await handleUpdateSettings(orgId, body);

    // Inbox/read-only actions (don't require Smartlead key)
    if (action === 'list-inbox') return await handleListInbox(orgId, body);
    if (action === 'get-conversation') return await handleGetConversation(orgId, body);
    if (action === 'mark-read') return await handleMarkRead(orgId, body);
    if (action === 'inbox-stats') return await handleInboxStats(orgId);
    if (action === 'list-campaigns') return await handleListCampaigns(orgId);

    // All remaining actions require Smartlead credentials
    const settings = await getOrgSettings(orgId);

    // Account listing doesn't need Smartlead key (DB-only)
    if (action === 'list-accounts') return await handleListAccounts(orgId);

    if (action === 'test-smartlead') return await handleTestSmartlead(orgId);

    // All remaining actions require Smartlead API key
    if (!settings || !settings.smartlead_api_key) {
      return respond(400, { error: 'Smartlead API key not configured. Update Email Settings first.' });
    }

    switch (action) {
      case 'create-account':
        return await handleCreateAccount(orgId, body, settings);
      case 'toggle-warmup':
        return await handleToggleWarmup(orgId, body, settings);
      case 'warmup-stats':
        return await handleGetWarmupStats(orgId, body, settings);
      case 'assign-account':
        return await handleAssignAccount(orgId, body, settings);
      case 'create-campaign':
        return await handleCreateCampaign(orgId, body, settings);
      case 'get-campaign':
        return await handleGetCampaign(orgId, body, settings);
      default:
        return respond(400, {
          error: `Unknown action: ${action}. Valid actions: get-settings, update-settings, test-smartlead, list-accounts, create-account, toggle-warmup, warmup-stats, assign-account, list-campaigns, create-campaign, get-campaign, list-inbox, get-conversation, mark-read, inbox-stats`,
        });
    }
  } catch (error) {
    if (error.name === 'SmartleadApiError') {
      console.error(`Smartlead API error (action=${action}):`, error.message, error.responseBody);
      return respond(error.statusCode || 500, { error: error.message });
    }
    console.error(`smartlead-email error (action=${action}):`, error);
    return respond(500, { error: error.message });
  }
};
