const { createClient } = require('@supabase/supabase-js');
const { classifyApolloStatus } = require('./lib/apollo-verify');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const ELV_API_KEY = process.env.EMAILLISTVERIFY_API_KEY;

// Valid statuses from EmailListVerify that are safe to send
const SAFE_STATUSES = ['ok', 'ok_for_all', 'accept_all'];
const BAD_STATUSES = ['invalid', 'email_disabled', 'dead_server', 'syntax_error'];

// Verification is valid for 30 days
const VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Look up a contact's cached apollo_email_status from contact_database.
 * Contacts are pre-verified during discovery (Opt 1), so we just read the status.
 */
async function getCachedApolloStatus(email, orgId) {
  const { data } = await supabase
    .from('contact_database')
    .select('apollo_email_status, apollo_verified_at')
    .eq('org_id', orgId)
    .eq('email', email)
    .not('apollo_email_status', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;
  return data[0];
}

/**
 * Check whether this email has previously bounced.
 * We treat bounced contacts as permanently suppressed.
 */
async function isPermanentlySuppressed(email, orgId) {
  const { data } = await supabase
    .from('activity_log')
    .select('id')
    .eq('org_id', orgId)
    .eq('activity_type', 'email_bounced')
    .ilike('summary', `Bounced: ${email} %`)
    .limit(1);

  return !!(data && data.length > 0);
}

/**
 * Check if a contact already has a valid (non-expired) ELV verification cached
 * in the contacts table. Returns the cached result or null.
 */
async function getCachedVerification(email, orgId) {
  const { data } = await supabase
    .from('contacts')
    .select('elv_status, elv_verified_at')
    .eq('org_id', orgId)
    .eq('email', email)
    .not('elv_status', 'is', null)
    .not('elv_verified_at', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0];
  const verifiedAt = new Date(row.elv_verified_at);
  const age = Date.now() - verifiedAt.getTime();

  if (age > VERIFICATION_MAX_AGE_MS) {
    console.log(`📧 Cached verification for ${email} expired (${Math.round(age / 86400000)}d old)`);
    return null;
  }

  const safe = SAFE_STATUSES.includes(row.elv_status);
  console.log(`📧 Using cached verification for ${email}: ${row.elv_status} (${Math.round(age / 86400000)}d old)`);
  return { email, status: row.elv_status, safe, cached: true, verifiedAt: row.elv_verified_at };
}

/**
 * Save verification result to both contacts and contact_database tables.
 */
async function saveVerification(email, status, orgId) {
  const now = new Date().toISOString();

  await supabase
    .from('contacts')
    .update({ elv_status: status, elv_verified_at: now })
    .eq('org_id', orgId)
    .eq('email', email);

  await supabase
    .from('contact_database')
    .update({ elv_status: status, elv_verified_at: now })
    .eq('org_id', orgId)
    .eq('email', email);
}

async function verifyEmail(email, orgId) {
  // 1. Check for a valid cached verification first
  const cached = await getCachedVerification(email, orgId);
  if (cached) return cached;

  // 2. No valid cache — do a live verification (ELV_API_KEY is checked before calling)
  try {
    const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(ELV_API_KEY)}&email=${encodeURIComponent(email)}&timeout=15`;
    const res = await fetch(url);
    const status = (await res.text()).trim().toLowerCase();

    console.log(`📧 Verify ${email}: ${status}`);

    const safe = SAFE_STATUSES.includes(status);

    if (!safe && BAD_STATUSES.includes(status)) {
      console.log(`🗑️ Removing invalid email ${email} from contact_database`);
      await supabase.from('contact_database').delete().eq('org_id', orgId).eq('email', email);
    }

    await saveVerification(email, status, orgId);

    return { email, status, safe, cached: false, verifiedAt: new Date().toISOString() };
  } catch (e) {
    // Fail CLOSED: if we can't verify, don't send — prevents bounces
    console.error(`🚫 Verify error for ${email}: ${e.message} — blocking send`);
    return { email, status: 'verification_error', safe: false };
  }
}

async function getAccessToken() {
  const creds = JSON.parse(process.env.GMAIL_OAUTH_CREDENTIALS);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('Failed to refresh token');
  return data.access_token;
}


async function getEmailSettings(orgId) {
  const { data } = await supabase
    .from('email_settings')
    .select('gmail_from_email, gmail_from_name')
    .eq('org_id', orgId)
    .maybeSingle();
  return data || {};
}

async function selectSenderAccount(orgId, preferredAccountId = null) {
  const query = () => supabase
    .from('email_accounts')
    .select('id, email_address, display_name, daily_send_limit, current_daily_sent, status')
    .eq('org_id', orgId)
    .in('status', ['active', 'ready'])
    .order('current_daily_sent', { ascending: true })
    .order('created_at', { ascending: true });

  const hasCapacity = (account) => {
    const sent = account?.current_daily_sent || 0;
    const limit = Number.isFinite(account?.daily_send_limit)
      ? account.daily_send_limit
      : parseInt(account?.daily_send_limit, 10);
    return Number.isFinite(limit) && limit > 0 && sent < limit;
  };

  if (preferredAccountId) {
    const { data: preferred } = await query().eq('id', preferredAccountId).limit(1);
    const account = (preferred || [])[0] || null;
    if (account && hasCapacity(account)) {
      return { account, hasConfiguredAccounts: true };
    }
  }

  const { data: accounts } = await query();
  const list = accounts || [];
  const available = list.find(hasCapacity) || null;
  return { account: available, hasConfiguredAccounts: list.length > 0 };
}

async function incrementSenderDailySent(accountId, amount = 1) {
  if (!accountId || amount < 1) return;

  const { data: account } = await supabase
    .from('email_accounts')
    .select('id, current_daily_sent')
    .eq('id', accountId)
    .limit(1)
    .maybeSingle();

  if (!account) return;

  await supabase
    .from('email_accounts')
    .update({ current_daily_sent: (account.current_daily_sent || 0) + amount })
    .eq('id', accountId);
}
function buildRawEmail({ to, bcc, subject, body, fromEmail, fromName }) {
  const lines = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
  ];

  if (bcc && bcc.length > 0) {
    lines.push(`Bcc: ${bcc.join(', ')}`);
  }

  lines.push(`Subject: ${subject}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { to, bcc, subject, body, leadId, website, contactDetails, org_id, from_account_id } = JSON.parse(event.body || '{}');
    const orgId = org_id || event.headers['x-org-id'];

    if (!orgId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    }

    if (!to && (!bcc || bcc.length === 0)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No recipients' }) };
    }

    // ── Step 1: Use cached Apollo status from discovery triage ─────
    // verified -> send directly
    // extrapolated/catch_all/unavailable -> route to ELV
    // invalid or missing -> block
    const allEmails = [...(to ? [to] : []), ...(bcc || [])];

    const blocked = [];
    const apolloVerified = [];
    const emailsForElv = [];

    for (const email of allEmails) {
      if (await isPermanentlySuppressed(email, orgId)) {
        blocked.push({ email, status: 'previously_bounced_suppressed' });
        console.log(`🚫 Blocked (Suppressed bounce): ${email}`);

        // Keep contact_database clean even if this address got rediscovered.
        await supabase.from('contact_database').delete().eq('org_id', orgId).eq('email', email);
        continue;
      }

      const cachedApollo = await getCachedApolloStatus(email, orgId);
      if (!cachedApollo || !cachedApollo.apollo_email_status) {
        blocked.push({ email, status: 'missing_apollo_status' });
        console.log(`🚫 Blocked (Apollo missing): ${email}`);
        continue;
      }

      const apolloStatus = cachedApollo.apollo_email_status.toLowerCase();
      const action = classifyApolloStatus(apolloStatus);

      if (action === 'discard') {
        blocked.push({ email, status: `apollo_${apolloStatus}` });
        console.log(`🚫 Blocked (Apollo): ${email} [${apolloStatus}]`);
        await supabase.from('contact_database').delete().eq('org_id', orgId).eq('email', email);
        continue;
      }

      if (action === 'send') {
        apolloVerified.push(email);
        console.log(`✅ Apollo verified — skipping ELV for ${email}`);
        continue;
      }

      console.log(`📋 Apollo status for ${email}: ${apolloStatus} — routing to ELV`);
      emailsForElv.push(email);
    }

    // ── Step 2: ELV verification — ONLY for risky Apollo statuses ────
    let elvResults = [];
    if (emailsForElv.length > 0) {
      if (!ELV_API_KEY) {
        console.error('❌ EMAILLISTVERIFY_API_KEY not configured — cannot verify risky Apollo statuses');
        blocked.push(...emailsForElv.map(email => ({ email, status: 'elv_unavailable_for_risky_apollo_status' })));
      } else {
        elvResults = await Promise.all(emailsForElv.map(e => verifyEmail(e, orgId)));
      }
    }

    const elvSafe = elvResults.filter(r => r.safe).map(r => r.email);
    const elvBlocked = elvResults.filter(r => !r.safe);

    // Combine results
    const safeEmails = [...apolloVerified, ...elvSafe];
    const blockedEmails = [...blocked, ...elvBlocked.map(r => ({ email: r.email, status: r.status }))];

    // Log verification results to activity log
    const freshlyVerified = elvResults.filter(r => r.safe && !r.cached && r.status !== 'skipped' && r.status !== 'error');
    const verificationSummary = [
      apolloVerified.length > 0 ? `Apollo verified (no ELV): ${apolloVerified.join(', ')}` : null,
      freshlyVerified.length > 0 ? `ELV verified: ${freshlyVerified.map(r => `${r.email} (${r.status})`).join(', ')}` : null,
      elvSafe.length > 0 && freshlyVerified.length === 0 ? `ELV cached: ${elvSafe.join(', ')}` : null,
      blocked.length > 0 ? `Blocked: ${blocked.map(r => `${r.email} (${r.status})`).join(', ')}` : null,
      elvBlocked.length > 0 ? `ELV blocked: ${elvBlocked.map(r => `${r.email} (${r.status})`).join(', ')}` : null,
    ].filter(Boolean).join(' | ');

    if (verificationSummary && leadId) {
      await supabase.from('activity_log').insert({
        org_id: orgId,
        activity_type: 'email_verified',
        lead_id: leadId,
        summary: verificationSummary,
        status: 'success',
      });
    }

    if (blockedEmails.length > 0) {
      console.log(`🚫 Blocked ${blockedEmails.length} invalid emails: ${blockedEmails.map(r => `${r.email} (${r.status})`).join(', ')}`);
    }

    if (safeEmails.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `All emails failed verification: ${blockedEmails.map(r => `${r.email} (${r.status})`).join(', ')}`,
          blocked: blockedEmails,
        }),
      };
    }

    const settings = await getEmailSettings(orgId);
    const { account: selectedSender, hasConfiguredAccounts } = await selectSenderAccount(orgId, from_account_id);

    if (!selectedSender && hasConfiguredAccounts) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'All sender accounts are at their daily limit. Increase limits or wait for reset.' }),
      };
    }

    const fromEmail = selectedSender?.email_address
      || settings.gmail_from_email
      || process.env.GMAIL_FROM_EMAIL
      || 'sam@onsiteaffiliate.com';
    const fromName = selectedSender?.display_name
      || settings.gmail_from_name
      || 'Sam Reid';

    const accessToken = await getAccessToken();

    const raw = buildRawEmail({
      to: safeEmails[0],
      bcc: safeEmails.slice(1),
      subject,
      body,
      fromEmail,
      fromName,
    });

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      throw new Error(`Gmail send failed: ${JSON.stringify(err)}`);
    }

    const sendData = await sendRes.json();
    console.log(`✅ Email sent to ${safeEmails.join(', ')} (message ID: ${sendData.id})`);

    // Log outreach for verified recipients only
    const outreachRows = safeEmails.map(email => {
      const contact = (contactDetails || []).find(c => c.email === email);
      return {
        lead_id: leadId,
        website: website || '',
        contact_email: email,
        contact_name: contact?.name || null,
        email_subject: subject,
        email_body: body,
        sent_at: new Date().toISOString(),
        org_id: orgId,
      };
    });

    await supabase.from('outreach_log').insert(outreachRows);

    if (selectedSender?.id) {
      await incrementSenderDailySent(selectedSender.id, 1);
    }

    if (leadId) {
      const firstContact = outreachRows[0] || {};

      await supabase.from('leads').update({
        status: 'contacted',
        has_contacts: true,
        contact_name: firstContact.contact_name || null,
        contact_email: firstContact.contact_email || null,
        updated_at: new Date().toISOString(),
      }).eq('id', leadId).eq('org_id', orgId);

      await supabase.from('activity_log').insert({
        org_id: orgId,
        activity_type: 'email_sent',
        lead_id: leadId,
        summary: `Email sent from ${fromEmail} to ${safeEmails.join(', ')}${blockedEmails.length ? ` (${blockedEmails.length} blocked)` : ''}`,
        status: 'success',
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        messageId: sendData.id,
        recipients: safeEmails,
        blocked: blockedEmails,
        sender: {
          email: fromEmail,
          name: fromName,
          account_id: selectedSender?.id || null,
          daily_limit: selectedSender?.daily_send_limit || null,
          current_daily_sent: selectedSender?.current_daily_sent || null,
        },
      }),
    };

  } catch (error) {
    console.error('💥 Send email error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
