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

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

const { corsHeaders } = require('./lib/cors');

// Computed per-request in the handler; module-level so helpers can use respond().
let CORS_HEADERS = {};

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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function extractZohoDnsBundle(payload) {
  const data = payload?.data || payload || {};

  const verificationToken = firstNonEmpty(
    data.zbcode,
    data.zbCode,
    data.ZBCODE,
    data.txtVerificationCode,
    data.TXTVerificationCode,
    data.CNAMEVerificationCode,
    data.HTMLVerificationCode
  );

  const dkimEntries = [];
  const candidates = [];
  if (Array.isArray(data.dkim)) candidates.push(...data.dkim);
  if (Array.isArray(data.dkimRecords)) candidates.push(...data.dkimRecords);
  if (Array.isArray(data.domainKeys)) candidates.push(...data.domainKeys);
  if (data.dkimSelector || data.dkimValue || data.dkimPublicKey) candidates.push(data);

  for (const item of candidates) {
    const selector = firstNonEmpty(item.selector, item.dkimSelector, item.domainKey, item.name);
    const value = firstNonEmpty(item.value, item.publicKey, item.dkimValue, item.dkimPublicKey, item.content);
    if (!selector || !value) continue;
    const normalized = String(value).startsWith('v=DKIM1') ? String(value) : `v=DKIM1; k=rsa; p=${value}`;
    dkimEntries.push({ selector: String(selector).trim(), value: normalized });
  }

  return { verificationToken, dkimEntries };
}

async function ensureDomainInZohoAndGetDns(zoho, domainName) {
  let response;
  try {
    response = await zoho.addDomain(domainName);
  } catch (err) {
    if (err.statusCode !== 400 && err.statusCode !== 409) throw err;
  }

  let details = null;
  try {
    details = await zoho.getDomain(domainName);
  } catch (err) {
    if (!response) throw err;
  }

  return extractZohoDnsBundle(details || response || {});
}

// ── Fetch with timeout ───────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15000; // 15s — leaves headroom inside Netlify's 26s limit

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Cloudflare API request timed out. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine whether a Cloudflare error response represents an auth/permissions
 * problem vs. a benign "unsupported TLD" or "domain not found" type error.
 */
function isCloudflareAuthError(httpStatus, errors) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const authCodes = new Set([6003, 6100, 6103, 9109, 10000]);
  return (errors || []).some(e => authCodes.has(e.code));
}


function normalizeDnsName(name) {
  return String(name || '').replace(/\.$/, '').toLowerCase();
}

async function upsertDnsRecord(zoneId, apiToken, record) {
  const targetName = normalizeDnsName(record.name);
  const query = new URLSearchParams({
    type: record.type,
    name: targetName,
    per_page: '100',
  });

  const listRes = await fetchWithTimeout(
    `${CF_API_BASE}/zones/${zoneId}/dns_records?${query.toString()}`,
    { headers: cfHeaders(apiToken) }
  );
  const listData = await listRes.json();

  if (!listData.success) {
    return { ok: false, errors: listData.errors || [{ message: 'Failed to query existing DNS records.' }] };
  }

  const existingRecords = listData.result || [];
  const match = existingRecords.find((r) => {
    if (normalizeDnsName(r.name) !== targetName) return false;
    // MX can have multiple records on same name; match by priority so updates are deterministic.
    if (record.type === 'MX') return Number(r.priority || 0) === Number(record.priority || 0);
    // TXT/CNAME/etc should be unique by type+name in our provisioning flow.
    return true;
  });

  if (match) {
    const updateRes = await fetchWithTimeout(
      `${CF_API_BASE}/zones/${zoneId}/dns_records/${match.id}`,
      {
        method: 'PUT',
        headers: cfHeaders(apiToken),
        body: JSON.stringify({
          ...record,
          proxied: false,
        }),
      }
    );
    const updateData = await updateRes.json();
    if (!updateData.success) return { ok: false, errors: updateData.errors || [{ message: 'Failed to update DNS record.' }] };
    return { ok: true, record: updateData.result, operation: 'updated' };
  }

  const createRes = await fetchWithTimeout(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: cfHeaders(apiToken),
    body: JSON.stringify({
      ...record,
      proxied: false,
    }),
  });
  const createData = await createRes.json();
  if (!createData.success) return { ok: false, errors: createData.errors || [{ message: 'Failed to create DNS record.' }] };
  return { ok: true, record: createData.result, operation: 'created' };
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * test — Verify Cloudflare API token is valid
 */
async function handleTest(orgId, settings) {
  const res = await fetchWithTimeout(`${CF_API_BASE}/user/tokens/verify`, {
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
 * search — Check domain availability via Cloudflare Registrar.
 * Cloudflare has no search endpoint — we check individual domain names
 * using GET /registrar/domains/{domain_name} for common TLDs.
 */
async function handleSearch(orgId, settings, body) {
  const { query } = body;
  if (!query) return respond(400, { error: 'Missing required field: query' });

  const accountId = settings.cloudflare_account_id;
  if (!accountId) return respond(400, { error: 'Cloudflare account_id not configured in Email Settings.' });

  // Strip whitespace. If user entered a full domain (has a dot), check just that.
  // Otherwise, check the base name across popular TLDs.
  const trimmed = query.trim().toLowerCase().replace(/[^a-z0-9.\-]/g, '');
  if (!trimmed) return respond(400, { error: 'Invalid search query.' });

  let domainsToCheck;
  if (trimmed.includes('.')) {
    domainsToCheck = [trimmed];
  } else {
    domainsToCheck = [
      `${trimmed}.com`, `${trimmed}.net`, `${trimmed}.org`,
      `${trimmed}.io`, `${trimmed}.co`, `${trimmed}.dev`,
    ];
  }

  // Check each domain in parallel — collect results and errors separately
  let authError = null;
  let transportFailures = 0;
  const results = await Promise.allSettled(
    domainsToCheck.map(async (domainName) => {
      const url = `${CF_API_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(domainName)}`;
      let res;
      try {
        res = await fetchWithTimeout(url, { headers: cfHeaders(settings.cloudflare_api_token) });
      } catch (fetchErr) {
        console.error(`Fetch failed for ${domainName}:`, fetchErr.message);
        transportFailures++;
        return null; // skip this TLD on network/timeout errors
      }

      let data;
      try {
        data = await res.json();
      } catch {
        console.error(`Invalid JSON from Cloudflare for ${domainName}, HTTP ${res.status}`);
        transportFailures++;
        return null;
      }

      if (!data.success) {
        if (isCloudflareAuthError(res.status, data.errors)) {
          const errMsg = (data.errors || []).map(e => e.message).join('; ');
          authError = errMsg || `HTTP ${res.status}`;
        }
        // Non-auth errors (unsupported TLD, not found, etc.) — skip this domain
        return null;
      }

      const d = data.result || {};
      return {
        name: domainName,
        available: d.can_register === true,
        price: d.fees?.register_fee ?? null,
        supported_tld: d.supported_tld ?? true,
      };
    })
  );

  const domains = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  // If ALL checks failed with an auth error and we got zero results, surface the auth error
  if (domains.length === 0 && authError) {
    return respond(502, {
      error: `Cloudflare API error: ${authError}`,
      hint: 'Check that your API token has "Account > Registrar > Read" permission and the Account ID is correct in Email Settings.',
    });
  }

  // If ALL checks failed due to transport errors (Cloudflare unreachable), surface that
  if (domains.length === 0 && transportFailures === domainsToCheck.length) {
    return respond(502, {
      error: 'Could not reach Cloudflare API for any domain check. The service may be temporarily unavailable.',
      hint: 'Try again in a few moments. If the problem persists, check your network or Cloudflare status.',
    });
  }

  // Build warnings for partial failures
  const warnings = [];
  if (authError) warnings.push(`Some TLDs could not be checked: ${authError}`);
  if (transportFailures > 0 && domains.length > 0) warnings.push(`${transportFailures} TLD(s) could not be reached`);

  return respond(200, {
    domains,
    ...(warnings.length ? { warning: warnings.join('. ') } : {}),
  });
}

/**
 * purchase — Register a domain and import it into the system.
 *
 * Cloudflare's domain registration API is not publicly available (Enterprise only).
 * Instead we:
 *   1. Verify the domain is in the user's Cloudflare account (already registered)
 *   2. Look up its zone ID
 *   3. Import it into our email_domains table
 *   4. Auto-add to Zoho if configured
 *
 * The user registers the domain via Cloudflare Dashboard first, then clicks "Import".
 */
async function handlePurchase(orgId, settings, body) {
  const { domain } = body;
  if (!domain) return respond(400, { error: 'Missing required field: domain' });

  const accountId = settings.cloudflare_account_id;
  if (!accountId) return respond(400, { error: 'Cloudflare account_id not configured in Email Settings.' });

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

  // Verify domain is in the Cloudflare account
  const domainRes = await fetchWithTimeout(
    `${CF_API_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(domain)}`,
    { headers: cfHeaders(settings.cloudflare_api_token) }
  );
  const domainData = await domainRes.json();

  // Distinguish auth/API errors from domain-not-found
  if (!domainData.success) {
    const errMsg = (domainData.errors || []).map(e => e.message).join('; ');
    if (isCloudflareAuthError(domainRes.status, domainData.errors)) {
      return respond(502, {
        error: `Cloudflare API error: ${errMsg || `HTTP ${domainRes.status}`}. Check your API token permissions.`,
        hint: 'Ensure your API token has "Account > Registrar > Read" permission.',
      });
    }
    return respond(400, {
      error: `Domain ${domain} not found in your Cloudflare account. Register it first at the Cloudflare Dashboard, then import it here.`,
      dashboard_url: `https://dash.cloudflare.com/${accountId}/domains/register`,
    });
  }
  if (!domainData.result) {
    return respond(400, {
      error: `Domain ${domain} not found in your Cloudflare account. Register it first at the Cloudflare Dashboard, then import it here.`,
      dashboard_url: `https://dash.cloudflare.com/${accountId}/domains/register`,
    });
  }

  const cfDomain = domainData.result;

  // If it shows as available for registration, it hasn't been purchased yet
  if (cfDomain.can_register && !cfDomain.current_registrar) {
    return respond(400, {
      error: `Domain ${domain} is available but not yet registered. Register it at the Cloudflare Dashboard first, then import it here.`,
      dashboard_url: `https://dash.cloudflare.com/${accountId}/domains/register/${encodeURIComponent(domain)}`,
    });
  }

  // Fetch the zone ID
  let zoneId = null;
  const zoneRes = await fetchWithTimeout(
    `${CF_API_BASE}/zones?name=${encodeURIComponent(domain)}&account.id=${accountId}`,
    { headers: cfHeaders(settings.cloudflare_api_token) }
  );
  const zoneData = await zoneRes.json();
  if (zoneData.success && zoneData.result && zoneData.result.length > 0) {
    zoneId = zoneData.result[0].id;
  }

  // Insert into email_domains
  const { data: domainRow, error: insertError } = await supabase
    .from('email_domains')
    .insert({
      org_id: orgId,
      domain,
      status: 'purchased',
      registrar: 'cloudflare',
      purchased_at: new Date().toISOString(),
      expires_at: cfDomain.expires_at || null,
      cloudflare_zone_id: zoneId,
      cloudflare_account_id: accountId,
    })
    .select()
    .single();

  if (insertError) {
    console.error('DB insert error:', insertError.message);
    return respond(500, { error: 'Failed to save domain to database', details: insertError.message });
  }

  await logActivity(orgId, 'domain_imported', `Imported domain ${domain} from Cloudflare`);

  // Auto-add domain to Zoho Mail if credentials are configured
  let zohoAdded = false;
  const zoho = getZohoClient(settings);
  if (zoho) {
    try {
      const zohoDns = await ensureDomainInZohoAndGetDns(zoho, domain);
      zohoAdded = true;
      await supabase
        .from('email_domains')
        .update({
          metadata: {
            ...(domainRow.metadata || {}),
            zoho_added: true,
            zoho_verification_status: false,
            zoho_txt_verification: zohoDns.verificationToken,
            zoho_dkim_records: zohoDns.dkimEntries,
          },
        })
        .eq('id', domainRow.id);
      await logActivity(orgId, 'zoho_domain_added', `Auto-added domain ${domain} to Zoho Mail organization`);
    } catch (zohoErr) {
      console.error('Auto-add to Zoho failed (non-blocking):', zohoErr.message);
      await logActivity(orgId, 'zoho_domain_add_failed', `Failed to auto-add ${domain} to Zoho: ${zohoErr.message}`, 'warning');
    }
  }

  return respond(201, { domain: domainRow, zoho_added: zohoAdded });
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
    const zoneRes = await fetchWithTimeout(
      `${CF_API_BASE}/zones?name=${encodeURIComponent(domainRow.domain)}&account.id=${accountId}`,
      { headers: cfHeaders(settings.cloudflare_api_token) }
    );
    const zoneData = await zoneRes.json();

    if (zoneData.success && zoneData.result && zoneData.result.length > 0) {
      zoneId = zoneData.result[0].id;
    } else {
      // Create zone
      const createRes = await fetchWithTimeout(`${CF_API_BASE}/zones`, {
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

  const zoho = getZohoClient(settings);
  let zohoDns = { verificationToken: null, dkimEntries: [] };
  if (zoho) {
    try {
      zohoDns = await ensureDomainInZohoAndGetDns(zoho, domainRow.domain);
    } catch (err) {
      console.error('Failed to fetch Zoho domain DNS bundle:', err.message, err.responseBody || '');
    }
  }

  // Build DNS records — default to Zoho if no provider specified
  const mxRecords = provider?.mxRecords || [
    { content: 'mx.zoho.com', priority: 10 },
    { content: 'mx2.zoho.com', priority: 20 },
    { content: 'mx3.zoho.com', priority: 50 },
  ];
  const spfValue = provider?.spfValue || 'v=spf1 include:zoho.com ~all';
  const dkimRecords = provider?.dkimRecords || zohoDns.dkimEntries.map((entry) => ({
    type: 'TXT',
    name: `${entry.selector}._domainkey.${domainRow.domain}`,
    content: entry.value,
  }));
  const domainName = domainRow.domain;

  const results = { mx: [], spf: null, dkim: [], dmarc: null, zoho_verification: null, errors: [] };

  // Helper to create a DNS record
  async function createRecord(record) {
    const upsert = await upsertDnsRecord(zoneId, settings.cloudflare_api_token, record);
    if (!upsert.ok) {
      results.errors.push({ record, errors: upsert.errors });
      return null;
    }
    return upsert.record;
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
    content: spfValue,
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

  // DKIM records
  for (const dkim of dkimRecords) {
    const result = await createRecord({
      type: dkim.type || 'TXT',
      name: dkim.name,
      content: dkim.content,
      ttl: 3600,
    });
    if (result) results.dkim.push(result);
  }

  // Zoho verification record
  const zohoVerificationCode = zohoDns.verificationToken || domainRow.metadata?.zoho_txt_verification;
  if (zohoVerificationCode) {
    const zohoVerifyResult = await createRecord({
      type: 'TXT',
      name: domainName,
      content: zohoVerificationCode,
      ttl: 3600,
    });
    results.zoho_verification = !!zohoVerifyResult;
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
    metadata: {
      ...(domainRow.metadata || {}),
      zoho_added: zoho ? true : domainRow.metadata?.zoho_added,
      zoho_txt_verification: zohoVerificationCode || domainRow.metadata?.zoho_txt_verification || null,
      zoho_dkim_records: zohoDns.dkimEntries.length ? zohoDns.dkimEntries : (domainRow.metadata?.zoho_dkim_records || []),
    },
  };

  await supabase
    .from('email_domains')
    .update(updateData)
    .eq('id', domain_id);

  await logActivity(orgId, 'dns_provisioned', `DNS records provisioned for ${domainName} (MX: ${results.mx.length}, SPF: ${results.spf ? 'yes' : 'no'}, DKIM: ${results.dkim.length}, verification: ${results.zoho_verification ? 'yes' : 'no'})`);

  return respond(200, { results, zoho_dns_bundle: zohoDns });
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
  const res = await fetchWithTimeout(
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
  const zohoVerified = domainRow.metadata?.zoho_verification_status === true;
  const newStatus = allVerified && zohoVerified ? 'active' : 'dns_pending';

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
    zoho_verified: zohoVerified,
    domain_status: newStatus,
  });
}

/**
 * configure-provider — Save email provider config (provider name, forwarding inbox) on a domain
 */
async function handleConfigureProvider(orgId, body) {
  const { domain_id, forward_to_email } = body;
  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });
  if (!forward_to_email) return respond(400, { error: 'Missing required field: forward_to_email' });

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forward_to_email)) {
    return respond(400, { error: 'Invalid forwarding email address.' });
  }

  // Verify domain belongs to org
  const { data: domainRow, error: domainErr } = await supabase
    .from('email_domains')
    .select('*')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domainErr || !domainRow) return respond(404, { error: 'Domain not found.' });

  // Merge into existing metadata
  const existingMetadata = domainRow.metadata || {};
  const updatedMetadata = {
    ...existingMetadata,
    email_provider: 'zoho',
    forward_to_email,
    provider_configured_at: new Date().toISOString(),
  };

  const { error: updateErr } = await supabase
    .from('email_domains')
    .update({ metadata: updatedMetadata })
    .eq('id', domain_id);

  if (updateErr) return respond(500, { error: 'Failed to save provider config', details: updateErr.message });

  await logActivity(orgId, 'provider_configured', `Configured Zoho Mail for ${domainRow.domain} — forwarding replies to ${forward_to_email}`);

  return respond(200, {
    success: true,
    email_provider: 'zoho',
    forward_to_email,
    zoho_verified: existingMetadata.zoho_verification_status === true,
  });
}

/**
 * verify-zoho — Trigger Zoho domain verification (tells Zoho to check for the TXT record)
 */
async function handleVerifyZoho(orgId, settings, body) {
  const { domain_id } = body;
  if (!domain_id) return respond(400, { error: 'Missing required field: domain_id' });

  const { data: domainRow, error: domainErr } = await supabase
    .from('email_domains')
    .select('*')
    .eq('id', domain_id)
    .eq('org_id', orgId)
    .single();

  if (domainErr || !domainRow) return respond(404, { error: 'Domain not found.' });

  const zoho = getZohoClient(settings);
  if (!zoho) {
    return respond(400, { error: 'Zoho Mail credentials not configured. Update Email Settings first.' });
  }

  const meta = domainRow.metadata || {};

  // Ensure domain exists in Zoho and refresh verification/DKIM metadata.
  let zohoDns = { verificationToken: null, dkimEntries: [] };
  try {
    zohoDns = await ensureDomainInZohoAndGetDns(zoho, domainRow.domain);
  } catch (err) {
    console.error('Zoho add/get domain error:', err.message, err.responseBody || '');
    const status = err.statusCode || 502;
    return respond(status, {
      error: `Failed to sync domain with Zoho: ${err.message}`,
      details: err.responseBody || null,
    });
  }

  const updatedMeta = {
    ...meta,
    zoho_added: true,
    zoho_txt_verification: zohoDns.verificationToken || meta.zoho_txt_verification || null,
    zoho_dkim_records: zohoDns.dkimEntries.length ? zohoDns.dkimEntries : (meta.zoho_dkim_records || []),
  };

  await supabase
    .from('email_domains')
    .update({ metadata: updatedMeta })
    .eq('id', domain_id);

  const checks = {
    domain: { mode: 'verifyDomainByTXT', ok: false, detail: null },
    mx: { mode: 'verifyMXRecords', ok: false, detail: null },
    spf: { mode: 'verifySPFRecord', ok: false, detail: null },
    dkim: { mode: 'verifyDKIMRecord', ok: false, detail: null },
  };

  for (const key of Object.keys(checks)) {
    const check = checks[key];
    try {
      const result = await zoho.verifyDomain(domainRow.domain, check.mode);
      const data = result?.data || {};
      check.ok = data.verificationStatus === true || data.isVerified === true || data.status === 'success';
      check.detail = data;
    } catch (err) {
      check.ok = false;
      check.detail = err.responseBody || { message: err.message };
    }
  }

  const fullyVerified = checks.domain.ok && checks.mx.ok && checks.spf.ok && checks.dkim.ok;

  const metadataPatch = {
    ...updatedMeta,
    zoho_verification_status: fullyVerified,
    zoho_verified_at: fullyVerified ? new Date().toISOString() : null,
    zoho_verify_checks: {
      domain: checks.domain.ok,
      mx: checks.mx.ok,
      spf: checks.spf.ok,
      dkim: checks.dkim.ok,
    },
    zoho_verify_error: fullyVerified ? null : JSON.stringify({
      domain: checks.domain.detail,
      mx: checks.mx.detail,
      spf: checks.spf.detail,
      dkim: checks.dkim.detail,
    }),
  };

  let mailHostingEnabled = !!meta.zoho_mail_hosting_enabled;
  if (fullyVerified && !mailHostingEnabled) {
    try {
      await zoho.enableMailHosting(domainRow.domain);
      metadataPatch.zoho_mail_hosting_enabled = true;
      metadataPatch.zoho_mail_hosting_enabled_at = new Date().toISOString();
      mailHostingEnabled = true;
      await logActivity(orgId, 'zoho_mail_hosting_enabled', `Enabled Zoho mail hosting for ${domainRow.domain}`);
    } catch (hostingErr) {
      console.error('Failed to enable Zoho mail hosting (non-blocking):', hostingErr.message, hostingErr.responseBody || '');
      metadataPatch.zoho_mail_hosting_error = hostingErr.message;
      await logActivity(orgId, 'zoho_mail_hosting_failed', `Failed to enable mail hosting for ${domainRow.domain}: ${hostingErr.message}`, 'warning');
    }
  }

  await supabase
    .from('email_domains')
    .update({ metadata: metadataPatch })
    .eq('id', domain_id);

  if (fullyVerified) {
    await logActivity(orgId, 'zoho_domain_verified', `Zoho Mail verified domain ${domainRow.domain} (ownership, MX, SPF, DKIM)`);
  }

  return respond(200, {
    success: true,
    domain: domainRow.domain,
    zoho_verified: fullyVerified,
    mail_hosting_enabled: mailHostingEnabled,
    verification: {
      ownership: checks.domain.ok,
      mx: checks.mx.ok,
      spf: checks.spf.ok,
      dkim: checks.dkim.ok,
    },
    message: fullyVerified
      ? `Zoho verification complete for ${domainRow.domain}.`
      : 'Zoho verification pending. Ensure DNS records have propagated, then retry verification.',
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
  CORS_HEADERS = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  return respond(410, {
    error: 'Outreach Manager has been deprecated. Domain acquisition, Cloudflare, Smartlead, and Zoho configuration are now handled offline.',
  });

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
    if (action === 'configure-provider') return await handleConfigureProvider(orgId, body);

    // verify-zoho needs Zoho creds (from settings) but not necessarily Cloudflare
    if (action === 'verify-zoho') {
      if (!settings) return respond(400, { error: 'Email settings not configured.' });
      return await handleVerifyZoho(orgId, settings, body);
    }

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
        return respond(400, { error: `Unknown action: ${action}. Valid actions: test, search, purchase, provision-dns, verify-dns, verify-zoho, configure-provider, list, status` });
    }
  } catch (error) {
    console.error(`cloudflare-domains error (action=${action}):`, error);

    // Distinguish timeout vs network vs unexpected errors
    if (error.message && error.message.includes('timed out')) {
      return respond(504, { error: error.message });
    }
    const errCode = error.code || error.cause?.code;
    if (errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND' || errCode === 'ECONNRESET') {
      return respond(502, { error: 'Could not reach Cloudflare API. Please try again.' });
    }

    return respond(500, { error: error.message || 'An unexpected error occurred.' });
  }
};
