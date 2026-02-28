const { createClient } = require('@supabase/supabase-js');

// Use service role key (bypasses RLS) for server-side function
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

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

async function getOrgSettings(orgId) {
  const { data, error } = await supabase
    .from('email_settings')
    .select('*')
    .eq('org_id', orgId)
    .single();

  if (error || !data) return null;
  return data;
}

function cfHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

async function logActivity(orgId, activityType, summary, status = 'success') {
  await supabase.from('activity_log').insert({
    org_id: orgId,
    activity_type: activityType,
    summary,
    status,
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * test — Verify Cloudflare API token is valid
 */
async function handleTest(orgId, settings) {
  const res = await fetch(`${CF_API_BASE}/user/tokens/verify`, {
    headers: cfHeaders(settings.cloudflare_api_token),
  });

  const data = await res.json();

  if (data.success && data.result) {
    return respond(200, {
      valid: true,
      status: data.result.status,
    });
  }

  return respond(200, {
    valid: false,
    status: data.result?.status || 'unknown',
    errors: data.errors,
  });
}

/**
 * search — Search for available domains via Cloudflare Registrar
 */
async function handleSearch(orgId, settings, body) {
  const { query } = body;
  if (!query) return respond(400, { error: 'Missing required field: query' });

  const accountId = settings.cloudflare_account_id;
  if (!accountId) return respond(400, { error: 'Cloudflare account_id not configured in Email Settings.' });

  // Cloudflare domain search endpoint
  const url = `${CF_API_BASE}/accounts/${accountId}/registrar/domains/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: cfHeaders(settings.cloudflare_api_token),
  });

  const data = await res.json();

  if (!data.success) {
    console.error('Cloudflare search error:', JSON.stringify(data.errors));
    return respond(500, { error: 'Cloudflare domain search failed', details: data.errors });
  }

  const domains = (data.result || []).map(d => ({
    name: d.name,
    available: d.available,
    price: d.price,
  }));

  return respond(200, { domains });
}

/**
 * purchase — Buy a domain via Cloudflare Registrar
 */
async function handlePurchase(orgId, settings, body) {
  const { domain, years } = body;
  if (!domain) return respond(400, { error: 'Missing required field: domain' });

  const accountId = settings.cloudflare_account_id;
  if (!accountId) return respond(400, { error: 'Cloudflare account_id not configured in Email Settings.' });

  const whois = settings.metadata?.whois;
  if (!whois) return respond(400, { error: 'WHOIS contact info not configured in Email Settings metadata.whois.' });

  // Check if domain already exists in our DB for this org
  const { data: existing } = await supabase
    .from('email_domains')
    .select('id')
    .eq('org_id', orgId)
    .eq('domain', domain)
    .limit(1);

  if (existing && existing.length > 0) {
    return respond(400, { error: `Domain ${domain} already exists in your account.` });
  }

  // Purchase via Cloudflare Registrar API
  const purchaseUrl = `${CF_API_BASE}/accounts/${accountId}/registrar/domains`;
  const purchaseRes = await fetch(purchaseUrl, {
    method: 'POST',
    headers: cfHeaders(settings.cloudflare_api_token),
    body: JSON.stringify({
      name: domain,
      years: years || 1,
      registrant: {
        first_name: whois.first_name,
        last_name: whois.last_name,
        address: whois.address,
        city: whois.city,
        state: whois.state,
        zip: whois.zip,
        country: whois.country,
        phone: whois.phone,
        email: whois.email,
        organization: whois.organization,
      },
    }),
  });

  const purchaseData = await purchaseRes.json();

  if (!purchaseData.success) {
    console.error('Cloudflare purchase error:', JSON.stringify(purchaseData.errors));
    await logActivity(orgId, 'domain_purchase_failed', `Failed to purchase ${domain}: ${JSON.stringify(purchaseData.errors)}`, 'error');
    return respond(500, { error: 'Domain purchase failed', details: purchaseData.errors });
  }

  // Fetch the zone ID (Cloudflare auto-creates a zone for registered domains)
  let zoneId = null;
  const zoneRes = await fetch(
    `${CF_API_BASE}/zones?name=${encodeURIComponent(domain)}&account.id=${accountId}`,
    { headers: cfHeaders(settings.cloudflare_api_token) }
  );
  const zoneData = await zoneRes.json();
  if (zoneData.success && zoneData.result && zoneData.result.length > 0) {
    zoneId = zoneData.result[0].id;
  }

  // Calculate expiry
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + (years || 1));

  // Insert into email_domains
  const { data: domainRow, error: insertError } = await supabase
    .from('email_domains')
    .insert({
      org_id: orgId,
      domain,
      status: 'purchased',
      registrar: 'cloudflare',
      purchased_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      purchase_price: purchaseData.result?.price || null,
      cloudflare_zone_id: zoneId,
      cloudflare_account_id: accountId,
    })
    .select()
    .single();

  if (insertError) {
    console.error('DB insert error:', insertError.message);
    return respond(500, { error: 'Domain purchased but failed to save to database', details: insertError.message });
  }

  await logActivity(orgId, 'domain_purchased', `Purchased domain ${domain} via Cloudflare`);

  return respond(201, { domain: domainRow });
}

/**
 * provision-dns — Create MX, SPF, DKIM, DMARC records on a domain's zone
 */
async function handleProvisionDns(orgId, settings, body) {
  const { domain_id, provider } = body;
  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });

  // Load domain from DB
  const { data: domainRow, error: domainErr } = await supabase
    .from('email_domains')
    .select('*')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domainErr || !domainRow) return respond(404, { error: 'Domain not found.' });

  const accountId = settings.cloudflare_account_id;
  let zoneId = domainRow.cloudflare_zone_id;

  // If no zone ID stored, try to find or create one
  if (!zoneId) {
    const zoneRes = await fetch(
      `${CF_API_BASE}/zones?name=${encodeURIComponent(domainRow.domain)}&account.id=${accountId}`,
      { headers: cfHeaders(settings.cloudflare_api_token) }
    );
    const zoneData = await zoneRes.json();

    if (zoneData.success && zoneData.result && zoneData.result.length > 0) {
      zoneId = zoneData.result[0].id;
    } else {
      // Create zone
      const createRes = await fetch(`${CF_API_BASE}/zones`, {
        method: 'POST',
        headers: cfHeaders(settings.cloudflare_api_token),
        body: JSON.stringify({
          name: domainRow.domain,
          account: { id: accountId },
          type: 'full',
        }),
      });
      const createData = await createRes.json();
      if (createData.success && createData.result) {
        zoneId = createData.result.id;
      } else {
        return respond(500, { error: 'Failed to create Cloudflare zone', details: createData.errors });
      }
    }

    // Save zone ID back to domain record
    await supabase
      .from('email_domains')
      .update({ cloudflare_zone_id: zoneId })
      .eq('id', domain_id);
  }

  // Build DNS records — default to Zoho if no provider specified
  const mxRecords = provider?.mxRecords || [
    { content: 'mx.zoho.com', priority: 10 },
    { content: 'mx2.zoho.com', priority: 20 },
    { content: 'mx3.zoho.com', priority: 50 },
  ];
  const spfInclude = provider?.spfInclude || 'zoho.com';
  const dkimRecords = provider?.dkimRecords || [];
  const domainName = domainRow.domain;

  const results = { mx: [], spf: null, dkim: [], dmarc: null, errors: [] };

  // Helper to create a DNS record
  async function createRecord(record) {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: cfHeaders(settings.cloudflare_api_token),
      body: JSON.stringify(record),
    });
    const data = await res.json();
    if (!data.success) {
      results.errors.push({ record, errors: data.errors });
      return null;
    }
    return data.result;
  }

  // MX records
  for (const mx of mxRecords) {
    const result = await createRecord({
      type: 'MX',
      name: domainName,
      content: mx.content,
      priority: mx.priority,
      ttl: 3600,
    });
    if (result) results.mx.push(result);
  }

  // SPF record
  const spfResult = await createRecord({
    type: 'TXT',
    name: domainName,
    content: `v=spf1 include:${spfInclude} -all`,
    ttl: 3600,
  });
  if (spfResult) results.spf = spfResult;

  // DMARC record
  const dmarcResult = await createRecord({
    type: 'TXT',
    name: `_dmarc.${domainName}`,
    content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domainName}`,
    ttl: 3600,
  });
  if (dmarcResult) results.dmarc = dmarcResult;

  // DKIM records (if provided)
  for (const dkim of dkimRecords) {
    const result = await createRecord({
      type: dkim.type || 'TXT',
      name: dkim.name,
      content: dkim.content,
      ttl: 3600,
    });
    if (result) results.dkim.push(result);
  }

  // Update domain record with provisioning status
  const updateData = {
    status: 'dns_pending',
    dns_configured: true,
    dns_configured_at: new Date().toISOString(),
    mx_verified: results.mx.length > 0,
    spf_verified: !!results.spf,
    dmarc_verified: !!results.dmarc,
    dkim_verified: results.dkim.length > 0,
  };

  // If all verified, set active
  if (updateData.mx_verified && updateData.spf_verified && updateData.dmarc_verified && updateData.dkim_verified) {
    updateData.status = 'active';
  }

  await supabase
    .from('email_domains')
    .update(updateData)
    .eq('id', domain_id);

  await logActivity(orgId, 'dns_provisioned', `DNS records provisioned for ${domainName} (MX: ${results.mx.length}, SPF: ${results.spf ? 'yes' : 'no'}, DKIM: ${results.dkim.length}, DMARC: ${results.dmarc ? 'yes' : 'no'})`);

  return respond(200, { results });
}

/**
 * verify-dns — Check DNS record propagation on a domain's zone
 */
async function handleVerifyDns(orgId, settings, body) {
  const { domain_id } = body;
  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });

  // Load domain from DB
  const { data: domainRow, error: domainErr } = await supabase
    .from('email_domains')
    .select('*')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domainErr || !domainRow) return respond(404, { error: 'Domain not found.' });

  const zoneId = domainRow.cloudflare_zone_id;
  if (!zoneId) return respond(400, { error: 'No Cloudflare zone ID found for this domain. Run provision-dns first.' });

  // List all DNS records on the zone
  const res = await fetch(
    `${CF_API_BASE}/zones/${zoneId}/dns_records?per_page=100`,
    { headers: cfHeaders(settings.cloudflare_api_token) }
  );
  const data = await res.json();

  if (!data.success) {
    return respond(500, { error: 'Failed to fetch DNS records from Cloudflare', details: data.errors });
  }

  const records = data.result || [];

  // Check for each record type
  const hasMx = records.some(r => r.type === 'MX');
  const hasSpf = records.some(r => r.type === 'TXT' && r.content.startsWith('v=spf1'));
  const hasDkim = records.some(r => r.type === 'TXT' && r.content.startsWith('v=DKIM1'));
  const hasDmarc = records.some(r => r.type === 'TXT' && r.name.startsWith('_dmarc.'));

  const allVerified = hasMx && hasSpf && hasDkim && hasDmarc;
  const newStatus = allVerified ? 'active' : 'dns_pending';

  // Update domain record
  await supabase
    .from('email_domains')
    .update({
      mx_verified: hasMx,
      spf_verified: hasSpf,
      dkim_verified: hasDkim,
      dmarc_verified: hasDmarc,
      status: newStatus,
    })
    .eq('id', domain_id);

  return respond(200, {
    status: { mx: hasMx, spf: hasSpf, dkim: hasDkim, dmarc: hasDmarc },
    all_verified: allVerified,
    domain_status: newStatus,
  });
}

/**
 * list — List all domains for an org with email account stats
 */
async function handleList(orgId) {
  const { data: domains, error } = await supabase
    .from('email_domains')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return respond(500, { error: 'Failed to fetch domains', details: error.message });

  // Enrich with account counts
  const enriched = [];
  for (const d of (domains || [])) {
    const { count: accountCount } = await supabase
      .from('email_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('domain_id', d.id);

    const { count: activeCount } = await supabase
      .from('email_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('domain_id', d.id)
      .eq('status', 'active');

    enriched.push({
      ...d,
      account_count: accountCount || 0,
      active_account_count: activeCount || 0,
    });
  }

  return respond(200, { domains: enriched });
}

/**
 * status — Get single domain detail with associated email accounts
 */
async function handleStatus(orgId, body) {
  const { domain_id } = body;
  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });

  const { data: domainRow, error: domainErr } = await supabase
    .from('email_domains')
    .select('*')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domainErr || !domainRow) return respond(404, { error: 'Domain not found.' });

  const { data: accounts } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('domain_id', domain_id)
    .order('created_at', { ascending: false });

  return respond(200, {
    domain: domainRow,
    accounts: accounts || [],
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
    // Load org settings (needed for Cloudflare credentials)
    const settings = await getOrgSettings(orgId);

    // Actions that don't need Cloudflare credentials
    if (action === 'list') return await handleList(orgId);
    if (action === 'status') return await handleStatus(orgId, body);

    // All other actions require Cloudflare credentials
    if (!settings || !settings.cloudflare_api_token) {
      return respond(400, { error: 'Cloudflare credentials not configured. Update Email Settings first.' });
    }

    switch (action) {
      case 'test':
        return await handleTest(orgId, settings);
      case 'search':
        return await handleSearch(orgId, settings, body);
      case 'purchase':
        return await handlePurchase(orgId, settings, body);
      case 'provision-dns':
        return await handleProvisionDns(orgId, settings, body);
      case 'verify-dns':
        return await handleVerifyDns(orgId, settings, body);
      default:
        return respond(400, { error: `Unknown action: ${action}. Valid actions: test, search, purchase, provision-dns, verify-dns, list, status` });
    }
  } catch (error) {
    console.error(`cloudflare-domains error (action=${action}):`, error);
    return respond(500, { error: error.message });
  }
};
