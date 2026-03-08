const { createClient } = require('@supabase/supabase-js');
const { upsertStoreLeadsRecord } = require('./lib/storeleads');
const { corsHeaders } = require('./lib/cors');
const { resolveOrgId } = require('./lib/org-id');

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

/**
 * Fetch a single domain from StoreLeads API.
 * Retries once on 429 rate-limit.
 */
async function fetchDomain(domain) {
  const res = await fetch(
    `https://storeleads.app/json/api/v1/all/domain/${encodeURIComponent(domain)}`,
    { headers: { Authorization: `Bearer ${STORELEADS_API_KEY}` } }
  );

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 5;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    const retry = await fetch(
      `https://storeleads.app/json/api/v1/all/domain/${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${STORELEADS_API_KEY}` } }
    );
    if (!retry.ok) return null;
    const data = await retry.json();
    return data.result || data;
  }

  if (!res.ok) return null;
  const data = await res.json();
  return data.result || data;
}

/**
 * Load all domains from the storeleads table, paginating past the 1000-row limit.
 */
async function loadAllDomains() {
  const domains = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('storeleads')
      .select('domain')
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    domains.push(...data.map((r) => r.domain));
    if (data.length < 1000) break;
    from += 1000;
  }
  return domains;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!STORELEADS_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'STORELEADS_API_KEY not configured' }) };
  }

  const orgId = await resolveOrgId(supabase);

  try {
    const domains = await loadAllDomains();
    console.log(`📦 Bulk update: ${domains.length} domains to refresh`);

    let updated = 0;
    let failed = 0;
    let notFound = 0;
    const errors = [];

    for (const domain of domains) {
      try {
        const store = await fetchDomain(domain);
        if (!store) {
          notFound++;
          continue;
        }

        await upsertStoreLeadsRecord(supabase, orgId, store);
        updated++;

        // Rate-limit: ~200ms between requests to stay under API limits
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        failed++;
        errors.push({ domain, error: err.message });
        console.error(`  ❌ ${domain}: ${err.message}`);
      }
    }

    const summary = {
      total: domains.length,
      updated,
      notFound,
      failed,
      errors: errors.slice(0, 10), // cap error list
    };

    console.log(`✅ Bulk update complete:`, summary);

    await supabase.from('activity_log').insert({
      activity_type: 'storeleads_bulk_update',
      summary: `Bulk refreshed ${updated}/${domains.length} storeleads records (${notFound} not found, ${failed} failed)`,
      status: failed === 0 ? 'success' : 'partial',
      org_id: orgId,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(summary),
    };
  } catch (error) {
    console.error('💥 Bulk update error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
