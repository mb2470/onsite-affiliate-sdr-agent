const { createClient } = require('@supabase/supabase-js');
const { ZohoMailService, ZohoMailApiError } = require('./lib/zoho-mail-api');

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
 * test-connection — Verify Zoho OAuth credentials are valid
 */
async function handleTestConnection(zoho) {
  const result = await zoho.testConnection();
  return respond(200, result);
}

/**
 * list-domains — List all domains in the Zoho organization
 */
async function handleListDomains(zoho) {
  const data = await zoho.listDomains();
  return respond(200, { domains: data?.data || [] });
}

/**
 * add-domain — Add a domain to the Zoho organization
 */
async function handleAddDomain(orgId, zoho, body) {
  const { domain_name } = body;
  if (!domain_name) return respond(400, { error: 'Missing required field: domain_name' });

  const data = await zoho.addDomain(domain_name);

  await logActivity(orgId, 'zoho_domain_added', `Added domain ${domain_name} to Zoho Mail organization`);

  return respond(200, {
    success: true,
    domain: data?.data || data,
  });
}

/**
 * verify-domain — Trigger domain verification in Zoho
 */
async function handleVerifyDomain(orgId, zoho, body) {
  const { domain_name, method } = body;
  if (!domain_name) return respond(400, { error: 'Missing required field: domain_name' });

  const data = await zoho.verifyDomain(domain_name, method || 'verifyDomainByTXT');

  const verified = data?.data?.verificationStatus === true || data?.data?.verificationStatus === 'true';

  if (verified) {
    await logActivity(orgId, 'zoho_domain_verified', `Domain ${domain_name} verified in Zoho Mail`);
  }

  return respond(200, {
    success: true,
    verified,
    domain: data?.data || data,
  });
}

/**
 * create-mailbox — Create a user/mailbox in Zoho and optionally set up forwarding + IMAP
 */
async function handleCreateMailbox(orgId, zoho, body) {
  const { email_address, password, first_name, last_name, display_name, forward_to } = body;

  if (!email_address) return respond(400, { error: 'Missing required field: email_address' });
  if (!password) return respond(400, { error: 'Missing required field: password' });

  const result = await zoho.provisionMailbox({
    emailAddress: email_address,
    password,
    firstName: first_name,
    lastName: last_name,
    displayName: display_name,
    forwardTo: forward_to,
  });

  await logActivity(orgId, 'zoho_mailbox_created',
    `Created Zoho mailbox ${email_address} (IMAP: ${result.imapEnabled}, Forwarding: ${result.forwardingConfigured})`
  );

  return respond(200, {
    success: true,
    ...result,
  });
}

/**
 * setup-forwarding — Configure email forwarding for an existing Zoho account
 */
async function handleSetupForwarding(orgId, zoho, body) {
  const { account_id, zuid, forward_to } = body;

  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });
  if (!zuid) return respond(400, { error: 'Missing required field: zuid' });
  if (!forward_to) return respond(400, { error: 'Missing required field: forward_to' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forward_to)) {
    return respond(400, { error: 'Invalid forwarding email address.' });
  }

  await zoho.addEmailForwarding(account_id, zuid, forward_to);
  await zoho.enableEmailForwarding(account_id, zuid);

  await logActivity(orgId, 'zoho_forwarding_configured',
    `Configured Zoho email forwarding to ${forward_to}`
  );

  return respond(200, { success: true, forward_to });
}

/**
 * enable-imap — Enable IMAP access for a Zoho account
 */
async function handleEnableImap(orgId, zoho, body) {
  const { account_id, zuid } = body;

  if (!account_id) return respond(400, { error: 'Missing required field: account_id' });
  if (!zuid) return respond(400, { error: 'Missing required field: zuid' });

  await zoho.enableImap(account_id, zuid);

  await logActivity(orgId, 'zoho_imap_enabled', `Enabled IMAP access for Zoho account ${account_id}`);

  return respond(200, { success: true });
}

/**
 * list-users — List all users/mailboxes in the Zoho org
 */
async function handleListUsers(zoho) {
  const data = await zoho.listUsers();
  return respond(200, { users: data?.data || [] });
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
    const settings = await getOrgSettings(orgId);
    const zoho = getZohoClient(settings);

    if (!zoho) {
      return respond(400, {
        error: 'Zoho Mail credentials not configured. Go to Settings > Zoho Mail and enter your OAuth credentials.',
      });
    }

    switch (action) {
      case 'test-connection':
        return await handleTestConnection(zoho);
      case 'list-domains':
        return await handleListDomains(zoho);
      case 'add-domain':
        return await handleAddDomain(orgId, zoho, body);
      case 'verify-domain':
        return await handleVerifyDomain(orgId, zoho, body);
      case 'create-mailbox':
        return await handleCreateMailbox(orgId, zoho, body);
      case 'setup-forwarding':
        return await handleSetupForwarding(orgId, zoho, body);
      case 'enable-imap':
        return await handleEnableImap(orgId, zoho, body);
      case 'list-users':
        return await handleListUsers(zoho);
      default:
        return respond(400, {
          error: `Unknown action: ${action}. Valid actions: test-connection, list-domains, add-domain, verify-domain, create-mailbox, setup-forwarding, enable-imap, list-users`,
        });
    }
  } catch (error) {
    if (error.name === 'ZohoMailApiError') {
      console.error(`Zoho Mail API error (action=${action}):`, error.message, error.responseBody);
      return respond(error.statusCode || 502, { error: error.message, details: error.responseBody });
    }
    console.error(`zoho-mail error (action=${action}):`, error);
    return respond(500, { error: error.message });
  }
};
