const { createClient } = require('@supabase/supabase-js');
const { upsertStoreLeadsRecord } = require('./lib/storeleads');
const { corsHeaders } = require('./lib/cors');
const { resolveOrgId } = require('./lib/org-id');

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const DEFAULT_BATCH_SIZE = 20;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
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
 * Load a batch of domains from the storeleads table.
 */
async function loadDomainBatch(offset, limit) {
  const { data, error, count } = await supabase
    .from('storeleads')
    .select('domain', { count: 'exact' })
    .order('domain')
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { domains: (data || []).map((r) => r.domain), total: count };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    if (!STORELEADS_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'STORELEADS_API_KEY not configured' }) };
    }

    const params = event.queryStringParameters || {};
    const offset = Math.max(0, parseInt(params.offset, 10) || 0);
    const batchSize = Math.min(100, Math.max(1, parseInt(params.batch_size, 10) || DEFAULT_BATCH_SIZE));

    const orgId = await resolveOrgId(supabase);
    if (!orgId) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not resolve org_id' }) };
    }

    const { domains, total } = await loadDomainBatch(offset, batchSize);
    console.log(`Bulk update batch: offset=${offset}, batch_size=${batchSize}, total=${total}, fetched=${domains.length}`);

    if (domains.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No more domains to update', total, offset, hasMore: false }),
      };
    }

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
        console.error(`  Failed ${domain}: ${err.message}`);
      }
    }

    const nextOffset = offset + domains.length;
    const hasMore = nextOffset < total;

    const summary = {
      total,
      batchSize: domains.length,
      offset,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
      remaining: hasMore ? total - nextOffset : 0,
      updated,
      notFound,
      failed,
      errors: errors.slice(0, 10),
    };

    console.log('Batch complete:', JSON.stringify(summary));

    await supabase.from('activity_log').insert({
      activity_type: 'storeleads_bulk_update',
      summary: `Bulk batch ${offset}-${nextOffset}: refreshed ${updated}/${domains.length} (${total - nextOffset} remaining)`,
      status: failed === 0 ? 'success' : 'partial',
      org_id: orgId,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(summary),
    };
  } catch (error) {
    console.error('Bulk update error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
