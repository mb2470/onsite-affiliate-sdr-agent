const { createClient } = require('@supabase/supabase-js');
const { upsertStoreLeadsRecord } = require('./lib/storeleads');
const { corsHeaders } = require('./lib/cors');
const { resolveOrgId } = require('./lib/org-id');

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const DEFAULT_BATCH_SIZE = 20;

let _supabase;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  _supabase = createClient(url, key);
  return _supabase;
}

/**
 * Clean domain: strip protocol, www, trailing slashes/paths.
 */
function cleanDomain(domain) {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * Fetch domains in bulk from StoreLeads API.
 * Retries once on 429 rate-limit.
 */
async function fetchDomainsBulk(domains) {
  const cleaned = domains.map(cleanDomain);
  const res = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STORELEADS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ domains: cleaned }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 10;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    const retry = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STORELEADS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: cleaned }),
    });
    if (!retry.ok) return {};
    const data = await retry.json();
    return buildResultMap(data.domains || []);
  }

  if (!res.ok) {
    console.log(`Bulk API error: ${res.status} ${res.statusText}`);
    const errBody = await res.text();
    console.log(`Bulk API error body: ${errBody}`);
    return {};
  }
  const data = await res.json();
  console.log(`Bulk API raw response keys: ${JSON.stringify(Object.keys(data))}`);
  console.log(`Bulk API domains count: ${(data.domains || []).length}`);
  if (data.domains && data.domains.length > 0) {
    console.log(`First result sample: ${JSON.stringify(Object.keys(data.domains[0]))}`);
  }
  return buildResultMap(data.domains || []);
}

function buildResultMap(domainResults) {
  const map = {};
  domainResults.forEach((d) => {
    if (d.domain) map[cleanDomain(d.domain)] = d;
    else if (d.name) map[cleanDomain(d.name)] = d;
  });
  return map;
}

/**
 * Load a batch of domains from the storeleads table.
 */
async function loadDomainBatch(supabase, offset, limit) {
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

    const supabase = getSupabase();
    const params = event.queryStringParameters || {};
    const offset = Math.max(0, parseInt(params.offset, 10) || 0);
    const batchSize = Math.min(100, Math.max(1, parseInt(params.batch_size, 10) || DEFAULT_BATCH_SIZE));

    const orgId = await resolveOrgId(supabase);
    if (!orgId) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not resolve org_id' }) };
    }

    const { domains, total } = await loadDomainBatch(supabase, offset, batchSize);
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

    // Debug: log the raw domains from DB and what we send to API
    console.log(`DB domains (raw): ${JSON.stringify(domains)}`);
    const cleanedForLog = domains.map(cleanDomain);
    console.log(`Cleaned domains: ${JSON.stringify(cleanedForLog)}`);

    const resultMap = await fetchDomainsBulk(domains);
    console.log(`Bulk API returned ${Object.keys(resultMap).length} results for ${domains.length} domains`);
    console.log(`API result keys: ${JSON.stringify(Object.keys(resultMap))}`);

    for (const domain of domains) {
      const cleaned = cleanDomain(domain);
      const store = resultMap[cleaned];
      if (!store) {
        console.log(`Not found: raw="${domain}" cleaned="${cleaned}"`);
        notFound++;
        continue;
      }

      try {
        await upsertStoreLeadsRecord(supabase, orgId, { result: store });
        updated++;
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
