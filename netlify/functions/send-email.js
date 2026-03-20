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
 * Queries bounced_email column directly — no fragile regex on summary text.
 * Falls back to checking outreach_log.bounced flag as a secondary guard.
 */
async function isPermanentlySuppressed(email, orgId) {
  const normalizedEmail = email.toLowerCase().trim();

  // Primary: dedicated bounced_email column (set by check-bounces.js)
  const { data: activityHit } = await supabase
    .from('activity_log')
    .select('id')
    .eq('org_id', orgId)
    .eq('activity_type', 'email_bounced')
    .eq('bounced_email', normalizedEmail)
    .limit(1);

  if (activityHit && activityHit.length > 0) return true;

  // Secondary: outreach_log.bounced flag (in case activity_log entry is missing)
  const { data: outreachHit } = await supabase
    .from('outreach_log')
    .select('id')
    .eq('org_id', orgId)
    .eq('contact_email', normalizedEmail)
    .eq('bounced', true)
    .limit(1);

  return !!(outreachHit && outreachHit.length > 0);
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

async function getGmailCredentials(orgId) {
  const { data } = await supabase
    .from('email_settings')
    .select('gmail_oauth_credentials')
    .eq('org_id', orgId)
    .maybeSingle();
  return data?.gmail_oauth_credentials || null;
}

async function getAccessToken(orgId) {
  // Use per-org credentials from DB first (consistent with gmail-inbox.js),
  // then fall back to env var
  const orgCreds = await getGmailCredentials(orgId);
  const credsJson = orgCreds || process.env.GMAIL_OAUTH_CREDENTIALS;
  if (!credsJson) throw new Error('No Gmail OAuth credentials available (neither org-level nor env var)');

  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;

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

async function getSendAsAliases(accessToken) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch Gmail aliases: ${errText}`);
  }

  const data = await res.json();
  return Array.isArray(data.sendAs) ? data.sendAs : [];
}

function resolveFromAlias(requestedFromEmail, aliases) {
  const normalized = (requestedFromEmail || '').trim().toLowerCase();
  const byEmail = aliases.find((a) => (a.sendAsEmail || '').trim().toLowerCase() === normalized) || null;
  const primaryAccepted = aliases.find((a) => a.isPrimary && a.verificationStatus === 'accepted')
    || aliases.find((a) => a.verificationStatus === 'accepted')
    || null;

  if (byEmail && byEmail.verificationStatus === 'accepted') {
    return { fromEmail: byEmail.sendAsEmail, warning: null };
  }

  if (byEmail && byEmail.verificationStatus !== 'accepted') {
    return {
      fromEmail: primaryAccepted?.sendAsEmail || requestedFromEmail,
      warning: `Configured sender ${requestedFromEmail} is not accepted in Gmail sendAs (status: ${byEmail.verificationStatus}). Falling back to ${primaryAccepted?.sendAsEmail || requestedFromEmail}.`,
    };
  }

  return {
    fromEmail: primaryAccepted?.sendAsEmail || requestedFromEmail,
    warning: `Configured sender ${requestedFromEmail} was not found in Gmail sendAs aliases. Falling back to ${primaryAccepted?.sendAsEmail || requestedFromEmail}.`,
  };
}


async function getEmailSettings(orgId) {
  const { data } = await supabase
    .from('email_settings')
    .select('gmail_from_email, gmail_from_name, gmail_oauth_credentials')
    .eq('org_id', orgId)
    .maybeSingle();
  return data || {};
}

/**
 * Compute how many emails each sender has sent today from outreach_log
 * (the single source of truth). Returns a Map of email_address -> count.
 */
async function getSenderSentToday(orgId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('outreach_log')
    .select('sender_email')
    .eq('org_id', orgId)
    .not('sender_email', 'is', null)
    .gte('sent_at', todayStart.toISOString());

  const counts = new Map();
  for (const row of (data || [])) {
    const addr = (row.sender_email || '').trim().toLowerCase();
    if (addr) counts.set(addr, (counts.get(addr) || 0) + 1);
  }
  return counts;
}

async function selectSenderAccount(orgId, preferredAccountId = null, acceptedAliasSet = null) {
  const activeQuery = () => supabase
    .from('email_accounts')
    .select('id, email_address, display_name, daily_send_limit, status')
    .eq('org_id', orgId)
    .in('status', ['active', 'ready'])
    .order('created_at', { ascending: true });

  const anyConfiguredQuery = () => supabase
    .from('email_accounts')
    .select('id, status')
    .eq('org_id', orgId);

  // Derive per-sender sent counts from outreach_log (single source of truth)
  const senderSentToday = await getSenderSentToday(orgId);

  const hasCapacity = (account) => {
    const addr = (account?.email_address || '').trim().toLowerCase();
    const sent = senderSentToday.get(addr) || 0;
    const limit = Number.isFinite(account?.daily_send_limit)
      ? account.daily_send_limit
      : parseInt(account?.daily_send_limit, 10);
    return Number.isFinite(limit) && limit > 0 && sent < limit;
  };

  const getSentToday = (account) => {
    const addr = (account?.email_address || '').trim().toLowerCase();
    return senderSentToday.get(addr) || 0;
  };

  const hasAcceptedAlias = (account) => {
    if (!acceptedAliasSet || acceptedAliasSet.size === 0) return true;
    return acceptedAliasSet.has((account?.email_address || '').trim().toLowerCase());
  };

  if (preferredAccountId) {
    const { data: preferred } = await activeQuery().eq('id', preferredAccountId).limit(1);
    const account = (preferred || [])[0] || null;
    if (account) {
      account.current_daily_sent = getSentToday(account);
      if (hasCapacity(account) && hasAcceptedAlias(account)) {
        return {
          account,
          hasConfiguredAccounts: true,
          hasActiveOrReadyAccounts: true,
          hasAliasEligibleAccounts: true,
        };
      }
    }
  }

  const [{ data: allConfigured }, { data: activeAccounts }] = await Promise.all([
    anyConfiguredQuery(),
    activeQuery(),
  ]);

  const configuredList = allConfigured || [];
  const list = (activeAccounts || []).map(a => ({
    ...a,
    current_daily_sent: getSentToday(a),
  }));
  // Sort by fewest sent today (round-robin fairness)
  list.sort((a, b) => a.current_daily_sent - b.current_daily_sent);
  const aliasEligible = list.filter(hasAcceptedAlias);
  const available = aliasEligible.find(hasCapacity) || null;

  return {
    account: available,
    hasConfiguredAccounts: configuredList.length > 0,
    hasActiveOrReadyAccounts: list.length > 0,
    hasAliasEligibleAccounts: aliasEligible.length > 0,
  };
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

async function incrementReportingDaily(orgId, sentDelta = 0) {
  if (!orgId || sentDelta <= 0) return;
  const reportDate = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.rpc('increment_email_reporting_daily', {
    p_org_id: orgId,
    p_report_date: reportDate,
    p_sent_delta: sentDelta,
  });

  if (error) {
    console.warn('⚠️ Failed to increment email_reporting_daily:', error.message || error);
  }
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

    // ── Enforce agent_settings.max_emails_per_day as a global daily cap ──
    const { data: agentSettings } = await supabase
      .from('agent_settings')
      .select('max_emails_per_day')
      .eq('org_id', orgId)
      .maybeSingle();

    if (agentSettings?.max_emails_per_day) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { count: sentToday } = await supabase
        .from('outreach_log')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .gte('sent_at', todayStart.toISOString());

      const allRecipients = [...(to ? [to] : []), ...(bcc || [])];
      const remaining = agentSettings.max_emails_per_day - (sentToday || 0);

      if (remaining <= 0) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: `Daily email limit reached (${agentSettings.max_emails_per_day}/day). ${sentToday} emails already sent today.`,
            daily_limit: agentSettings.max_emails_per_day,
            sent_today: sentToday,
          }),
        };
      }

      if (allRecipients.length > remaining) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: `Batch of ${allRecipients.length} would exceed daily limit. Only ${remaining} of ${agentSettings.max_emails_per_day} remaining today.`,
            daily_limit: agentSettings.max_emails_per_day,
            sent_today: sentToday,
            remaining,
            batch_size: allRecipients.length,
          }),
        };
      }
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
    const accessToken = await getAccessToken(orgId);
    const aliases = await getSendAsAliases(accessToken);
    const acceptedAliases = aliases.filter(
      (a) => a?.verificationStatus === 'accepted' && a?.sendAsEmail
    );
    const acceptedAliasSet = new Set(
      acceptedAliases.map((a) => a.sendAsEmail.trim().toLowerCase())
    );

    console.log(`📋 Gmail aliases found: ${acceptedAliases.map(a => `${a.sendAsEmail} (${a.isPrimary ? 'primary' : 'alias'})`).join(', ') || 'none'}`);

    const {
      account: selectedSender,
      hasConfiguredAccounts,
      hasActiveOrReadyAccounts,
      hasAliasEligibleAccounts,
    } = await selectSenderAccount(orgId, from_account_id, acceptedAliasSet);

    // Enforce batch size against remaining sender capacity
    if (selectedSender) {
      const sent = selectedSender.current_daily_sent || 0;
      const limit = Number.isFinite(selectedSender.daily_send_limit)
        ? selectedSender.daily_send_limit
        : parseInt(selectedSender.daily_send_limit, 10);
      const remaining = (Number.isFinite(limit) && limit > 0) ? limit - sent : 0;

      if (safeEmails.length > remaining) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: `Batch size (${safeEmails.length}) exceeds remaining daily capacity (${remaining}) for sender ${selectedSender.email_address}. Reduce recipients or wait for daily reset.`,
            batch_size: safeEmails.length,
            remaining_capacity: remaining,
            daily_limit: limit,
            current_daily_sent: sent,
          }),
        };
      }
    }

    if (!selectedSender && hasConfiguredAccounts) {
      if (!hasActiveOrReadyAccounts) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Sender accounts exist but none are active/ready. Move at least one account to active/ready status before sending.',
          }),
        };
      }

      if (!hasAliasEligibleAccounts) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'No active sender accounts are verified Gmail sendAs aliases. Verify sender aliases in Gmail settings before sending.',
          }),
        };
      }

      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'All sender accounts are at their daily limit. Increase limits or wait for reset.' }),
      };
    }

    // When no email_accounts are configured, pick a non-primary alias to rotate through
    // instead of always falling back to the primary/hardcoded email
    let fromEmail;
    let fromName;

    if (selectedSender) {
      fromEmail = selectedSender.email_address;
      fromName = selectedSender.display_name || settings.gmail_from_name || 'Sam Reid';
      console.log(`📧 Selected sender account: ${fromEmail} (${selectedSender.current_daily_sent || 0}/${selectedSender.daily_send_limit} sent today)`);
    } else {
      // No email_accounts configured — try to use a non-primary accepted alias
      const nonPrimaryAliases = acceptedAliases.filter((a) => !a.isPrimary);
      if (nonPrimaryAliases.length > 0) {
        // Simple round-robin: pick alias based on minute to distribute sends
        const idx = new Date().getMinutes() % nonPrimaryAliases.length;
        const alias = nonPrimaryAliases[idx];
        fromEmail = alias.sendAsEmail;
        fromName = alias.displayName || settings.gmail_from_name || 'Sam Reid';
        console.log(`📧 No email_accounts configured — using Gmail alias: ${fromEmail}`);
      } else {
        fromEmail = settings.gmail_from_email
          || process.env.GMAIL_FROM_EMAIL
          || 'sam@onsiteaffiliate.com';
        fromName = settings.gmail_from_name || 'Sam Reid';
      }
    }

    const { fromEmail: resolvedFromEmail, warning: aliasWarning } = resolveFromAlias(fromEmail, aliases);

    if (aliasWarning) {
      console.warn(`⚠️ ${aliasWarning}`);
    }

    const raw = buildRawEmail({
      to: safeEmails[0],
      bcc: safeEmails.slice(1),
      subject,
      body,
      fromEmail: resolvedFromEmail,
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

    // Log outreach for verified recipients only — include Gmail message/thread IDs
    // sender_email is written here so outreach_log is the single source of truth
    // for per-sender daily capacity (no stale counters needed).
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
        gmail_message_id: sendData.id || '',
        gmail_thread_id: sendData.threadId || '',
        sender_email: resolvedFromEmail,
      };
    });

    await supabase.from('outreach_log').insert(outreachRows);
    await incrementReportingDaily(orgId, safeEmails.length);

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
        summary: `Email sent from ${resolvedFromEmail} to ${safeEmails.join(', ')}${blockedEmails.length ? ` (${blockedEmails.length} blocked)` : ''}${aliasWarning ? ` | ${aliasWarning}` : ''}`,
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
          email: resolvedFromEmail,
          resolved_email: resolvedFromEmail,
          name: fromName,
          account_id: selectedSender?.id || null,
          daily_limit: selectedSender?.daily_send_limit || null,
          current_daily_sent: selectedSender?.current_daily_sent || null,
          alias_warning: aliasWarning,
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
