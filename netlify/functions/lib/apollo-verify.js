/**
 * Apollo Email Verification via People Match API.
 *
 * Uses Apollo's enrichment endpoint to check email_status and
 * verification_status for contacts before sending.
 *
 * Status handling:
 *   verified     → Safe to send immediately
 *   extrapolated → Likely correct pattern, route to secondary verifier (ELV)
 *   catch_all    → Server accepts all mail, proceed with caution
 *   invalid      → Dead email, discard and optionally search for replacement
 *   unavailable  → Could not determine, treat as extrapolated
 */

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

// Statuses that are safe to send without further verification
const APOLLO_SAFE_STATUSES = ['verified'];

// Statuses that should go through secondary verification (ELV)
const APOLLO_NEEDS_SECONDARY = ['extrapolated', 'unavailable'];

// Statuses where the email is known bad
const APOLLO_BAD_STATUSES = ['invalid'];

// Catch-all: server accepts everything, impossible to verify via SMTP
const APOLLO_CATCHALL_STATUSES = ['catch_all', 'accept_all'];

// Cache duration: 30 days (matches ELV caching)
const APOLLO_VERIFY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Check if a contact already has a valid (non-expired) Apollo verification
 * cached in the contacts table.
 */
async function getCachedApolloVerification(supabase, email) {
  const { data } = await supabase
    .from('contacts')
    .select('apollo_email_status, apollo_verified_at')
    .eq('email', email)
    .not('apollo_email_status', 'is', null)
    .not('apollo_verified_at', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0];
  const verifiedAt = new Date(row.apollo_verified_at);
  const age = Date.now() - verifiedAt.getTime();

  if (age > APOLLO_VERIFY_MAX_AGE_MS) {
    console.log(`🔶 Cached Apollo verification for ${email} expired (${Math.round(age / 86400000)}d old)`);
    return null;
  }

  const status = row.apollo_email_status;
  console.log(`🔶 Using cached Apollo verification for ${email}: ${status} (${Math.round(age / 86400000)}d old)`);

  return {
    email,
    apollo_status: status,
    action: classifyApolloStatus(status),
    cached: true,
    verifiedAt: row.apollo_verified_at,
  };
}

/**
 * Save Apollo verification result to both contacts and contact_database.
 */
async function saveApolloVerification(supabase, email, status) {
  const now = new Date().toISOString();

  await supabase
    .from('contacts')
    .update({ apollo_email_status: status, apollo_verified_at: now })
    .eq('email', email);

  await supabase
    .from('contact_database')
    .update({ apollo_email_status: status, apollo_verified_at: now })
    .eq('email', email);
}

/**
 * Classify an Apollo email_status into a waterfall action.
 */
function classifyApolloStatus(status) {
  if (APOLLO_SAFE_STATUSES.includes(status)) return 'send';
  if (APOLLO_NEEDS_SECONDARY.includes(status)) return 'verify_secondary';
  if (APOLLO_CATCHALL_STATUSES.includes(status)) return 'catchall';
  if (APOLLO_BAD_STATUSES.includes(status)) return 'discard';
  // Unknown status — treat as needing secondary verification
  return 'verify_secondary';
}

/**
 * Verify a single contact via Apollo People Match API.
 *
 * Sends as much data as available (email, name, domain) to maximize
 * match quality. Returns the email_status and a recommended action.
 */
async function verifyViaApollo(supabase, { email, first_name, last_name, domain }) {
  // 1. Check cache first
  const cached = await getCachedApolloVerification(supabase, email);
  if (cached) return cached;

  // 2. No valid cache — call Apollo
  if (!APOLLO_API_KEY) {
    console.log(`⚠️ No APOLLO_API_KEY set, skipping Apollo verification for ${email}`);
    return { email, apollo_status: 'skipped', action: 'verify_secondary', cached: false };
  }

  try {
    const matchPayload = { email };
    if (first_name) matchPayload.first_name = first_name;
    if (last_name) matchPayload.last_name = last_name;
    if (domain) matchPayload.domain = domain;

    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': APOLLO_API_KEY,
      },
      body: JSON.stringify(matchPayload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`⚠️ Apollo verify failed for ${email} (${res.status}): ${errText}`);
      return { email, apollo_status: 'error', action: 'verify_secondary', cached: false };
    }

    const data = await res.json();
    const person = data.person || {};

    const emailStatus = (person.email_status || 'unavailable').toLowerCase();
    const verificationStatus = (person.verification_status || '').toLowerCase();

    // Use the most specific status available
    const effectiveStatus = verificationStatus || emailStatus;

    console.log(`🔶 Apollo verify ${email}: email_status=${emailStatus}, verification_status=${verificationStatus}, effective=${effectiveStatus}`);

    const action = classifyApolloStatus(effectiveStatus);

    // Cache the result
    await saveApolloVerification(supabase, email, effectiveStatus);

    return {
      email,
      apollo_status: effectiveStatus,
      action,
      cached: false,
      verifiedAt: new Date().toISOString(),
      // Pass through enriched data that Apollo may have returned
      apollo_title: person.title || null,
      apollo_seniority: person.seniority || null,
      apollo_new_email: person.email !== email ? person.email : null,
    };
  } catch (e) {
    console.error(`⚠️ Apollo verify error for ${email}: ${e.message}`);
    return { email, apollo_status: 'error', action: 'verify_secondary', cached: false };
  }
}

/**
 * "Double-Check" Loop: If Apollo returns invalid for a high-value contact,
 * search Apollo to see if the person has moved to a new company and has
 * a fresh email.
 *
 * Returns the new contact data or null if not found.
 */
async function apolloDoubleCheck(supabase, { first_name, last_name, domain, leadId }) {
  if (!APOLLO_API_KEY || !first_name || !last_name) return null;

  console.log(`🔄 Apollo double-check: searching for ${first_name} ${last_name} (was at ${domain})`);

  try {
    const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        q_keywords: `${first_name} ${last_name}`,
        per_page: 5,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const people = data.people || [];

    // Find the person (match on name), preferring verified email
    const match = people.find(p =>
      p.first_name?.toLowerCase() === first_name.toLowerCase() &&
      p.last_name?.toLowerCase() === last_name.toLowerCase() &&
      p.email_status === 'verified' &&
      p.has_email
    );

    if (!match) {
      console.log(`🔄 Double-check: no verified match found for ${first_name} ${last_name}`);
      return null;
    }

    console.log(`🔄 Double-check found: ${match.email} at ${match.organization?.name || 'unknown'} (${match.email_status})`);

    return {
      email: match.email?.toLowerCase(),
      first_name: match.first_name,
      last_name: match.last_name,
      title: match.title,
      organization: match.organization?.name,
      linkedin_url: match.linkedin_url,
      email_status: match.email_status,
    };
  } catch (e) {
    console.error(`⚠️ Apollo double-check error: ${e.message}`);
    return null;
  }
}

/**
 * Verify a batch of contacts through the Apollo waterfall.
 *
 * Returns contacts partitioned into:
 *   - send:     Apollo-verified, safe to send
 *   - verify:   Needs secondary verification (ELV)
 *   - catchall:  Catch-all domains, proceed with caution
 *   - discard:  Invalid emails, removed
 *   - refreshed: Contacts found via double-check (new emails)
 */
async function verifyContactsBatch(supabase, contacts, { leadId, skipDoubleCheck = false } = {}) {
  const results = {
    send: [],
    verify: [],
    catchall: [],
    discard: [],
    refreshed: [],
  };

  for (const contact of contacts) {
    const domain = contact.email?.split('@')[1] || contact.website || '';

    const result = await verifyViaApollo(supabase, {
      email: contact.email,
      first_name: contact.first_name,
      last_name: contact.last_name,
      domain,
    });

    switch (result.action) {
      case 'send':
        results.send.push({ ...contact, apollo_result: result });
        break;

      case 'verify_secondary':
        results.verify.push({ ...contact, apollo_result: result });
        break;

      case 'catchall':
        results.catchall.push({ ...contact, apollo_result: result });
        break;

      case 'discard':
        results.discard.push({ ...contact, apollo_result: result });

        // Double-check loop: search for updated email if high-value
        if (!skipDoubleCheck && contact.first_name && contact.last_name) {
          const refreshed = await apolloDoubleCheck(supabase, {
            first_name: contact.first_name,
            last_name: contact.last_name,
            domain,
            leadId,
          });

          if (refreshed) {
            results.refreshed.push({ original: contact, refreshed });
          }
        }
        break;

      default:
        results.verify.push({ ...contact, apollo_result: result });
    }

    // Small delay between API calls to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

module.exports = {
  verifyViaApollo,
  verifyContactsBatch,
  apolloDoubleCheck,
  classifyApolloStatus,
  getCachedApolloVerification,
  saveApolloVerification,
  APOLLO_SAFE_STATUSES,
  APOLLO_NEEDS_SECONDARY,
  APOLLO_BAD_STATUSES,
  APOLLO_CATCHALL_STATUSES,
};
