/**
 * Pre-send email verification endpoint.
 *
 * Runs the verification waterfall (Apollo cached status → ELV) for a list of
 * emails BEFORE sending, so the UI can show verification badges and gate
 * email generation on verified contacts.
 *
 * POST body: { emails: string[] }
 *
 * Returns: { results: [{ email, status, safe, source }] }
 */

const { createClient } = require('@supabase/supabase-js');
const { classifyApolloStatus } = require('./lib/apollo-verify');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const ELV_API_KEY = process.env.EMAILLISTVERIFY_API_KEY;

const SAFE_ELV_STATUSES = ['ok', 'ok_for_all', 'accept_all'];
const BAD_ELV_STATUSES = ['invalid', 'email_disabled', 'dead_server', 'syntax_error'];
const VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Check cached Apollo email status from contact_database.
 */
async function getCachedApolloStatus(email) {
  const { data } = await supabase
    .from('contact_database')
    .select('apollo_email_status, apollo_verified_at')
    .eq('email', email)
    .not('apollo_email_status', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;
  return data[0];
}

/**
 * Check if an email previously bounced and is permanently suppressed.
 */
async function isPermanentlySuppressed(email) {
  const { data } = await supabase
    .from('activity_log')
    .select('id')
    .eq('activity_type', 'email_bounced')
    .ilike('summary', `Bounced: ${email} %`)
    .limit(1);

  return !!(data && data.length > 0);
}

/**
 * Check cached ELV status from contacts table.
 */
async function getCachedElvStatus(email) {
  const { data } = await supabase
    .from('contacts')
    .select('elv_status, elv_verified_at')
    .eq('email', email)
    .not('elv_status', 'is', null)
    .not('elv_verified_at', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0];
  const age = Date.now() - new Date(row.elv_verified_at).getTime();
  if (age > VERIFICATION_MAX_AGE_MS) return null;

  return { status: row.elv_status, safe: SAFE_ELV_STATUSES.includes(row.elv_status) };
}

/**
 * Run live ELV verification and cache the result.
 */
async function verifyViaElv(email) {
  if (!ELV_API_KEY) {
    return { status: 'skipped', safe: true };
  }

  try {
    const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(ELV_API_KEY)}&email=${encodeURIComponent(email)}&timeout=15`;
    const res = await fetch(url);
    const status = (await res.text()).trim().toLowerCase();

    const safe = SAFE_ELV_STATUSES.includes(status);
    const now = new Date().toISOString();

    // Cache in contacts table
    await supabase
      .from('contacts')
      .update({ elv_status: status, elv_verified_at: now })
      .eq('email', email);

    // Also cache in contact_database
    await supabase
      .from('contact_database')
      .update({ elv_status: status, elv_verified_at: now })
      .eq('email', email);

    return { status, safe };
  } catch (e) {
    console.error(`ELV error for ${email}: ${e.message}`);
    return { status: 'error', safe: true }; // Fail open
  }
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { emails } = JSON.parse(event.body || '{}');

    if (!emails || emails.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No emails provided' }) };
    }

    const results = [];

    for (const email of emails) {
      if (await isPermanentlySuppressed(email)) {
        results.push({ email, status: 'previously_bounced_suppressed', safe: false, source: 'suppression' });
        continue;
      }

      // Stage 1: Check cached Apollo status
      const apollo = await getCachedApolloStatus(email);

      if (apollo) {
        const action = classifyApolloStatus(apollo.apollo_email_status);

        if (action === 'send') {
          results.push({ email, status: apollo.apollo_email_status, safe: true, source: 'apollo' });
          continue;
        }

        if (action === 'discard') {
          results.push({ email, status: apollo.apollo_email_status, safe: false, source: 'apollo' });
          continue;
        }
      }

      // Stage 2: Check cached ELV status
      const cachedElv = await getCachedElvStatus(email);
      if (cachedElv) {
        results.push({ email, status: cachedElv.status, safe: cachedElv.safe, source: 'elv_cached' });
        continue;
      }

      // Stage 3: Live ELV verification
      const elv = await verifyViaElv(email);
      results.push({ email, status: elv.status, safe: elv.safe, source: 'elv' });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ results }),
    };

  } catch (error) {
    console.error('Verify emails error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
