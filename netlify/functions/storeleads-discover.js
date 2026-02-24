const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreStoreLeads, buildStoreLeadsFitReason, catalogSizeLabel } = require('./lib/icp-scoring');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

// Target categories to search
const TARGET_CATEGORIES = [
  '/Apparel',
  '/Home & Garden',
  '/Consumer Electronics',
  '/Sports & Fitness',
];

// Fetch top domains for a category from StoreLeads
async function fetchTopDomains(category, country, pageSize = 50, page = 0, minProducts = 250) {
  const params = new URLSearchParams({
    'f:categories': category,
    'f:country': country,
    'f:pcmin': minProducts.toString(),
    'sort': 'rank',
    'page_size': pageSize.toString(),
    'page': page.toString(),
    'fields': 'name,categories,country,product_count,estimated_sales,rank,city,state,platform,plan',
  });

  const url = `https://storeleads.app/json/api/v1/all/domain?${params}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` },
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || 5;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return fetchTopDomains(category, country, pageSize, page, minProducts); // retry
  }

  if (!response.ok) {
    throw new Error(`StoreLeads API error: ${response.status}`);
  }

  const data = await response.json();
  return data.domains || [];
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!STORELEADS_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'STORELEADS_API_KEY not configured' }) };
  }

  try {
    // Load scoring config from ICP profile
    const config = await getIcpScoringConfig(supabase);
    console.log(`📐 Scoring thresholds: products≥${config.minProductCount}, sales≥$${config.minMonthlySalesCents/100}/mo`);

    // Get all existing websites to check for duplicates
    let existingWebsites = new Set();
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('website')
        .range(from, from + 999);
      if (error) throw error;
      if (data && data.length > 0) {
        data.forEach(l => existingWebsites.add(l.website.toLowerCase().replace(/^www\./, '')));
        from += 1000;
        if (data.length < 1000) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 ${existingWebsites.size} existing leads in database`);

    let allDiscovered = [];
    let newLeadsAdded = 0;
    let alreadyExisted = 0;

    // Search each target category for US and CA
    for (const category of TARGET_CATEGORIES) {
      for (const country of ['US', 'CA']) {
        console.log(`🔍 Searching: ${category} in ${country}...`);

        try {
          // Get top 50 for each category/country combo, using ICP min product count
          const domains = await fetchTopDomains(category, country, 50, 0, config.minProductCount);
          console.log(`   Found ${domains.length} domains`);

          for (const d of domains) {
            const cleanName = (d.name || '').toLowerCase().replace(/^www\./, '');
            if (!cleanName) continue;

            allDiscovered.push(cleanName);

            if (existingWebsites.has(cleanName)) {
              alreadyExisted++;
              continue;
            }

            // Score ICP using shared config
            const icpFit = scoreStoreLeads(d, config);
            const fitReason = buildStoreLeadsFitReason(d, config);

            const { error: insertError } = await supabase.from('leads').insert({
              website: cleanName,
              status: 'enriched',
              source: 'storeleads_discovery',
              icp_fit: icpFit,
              industry: (d.categories || []).join('; ') || null,
              catalog_size: catalogSizeLabel(d.product_count, config.minProductCount),
              sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
              headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
              country: d.country || null,
              fit_reason: fitReason,
              research_notes: [
                `Platform: ${d.platform || 'Unknown'}`,
                `Products: ${d.product_count || 0}`,
                `Categories: ${(d.categories || []).join('; ') || 'Unknown'}`,
                `Country: ${d.country || 'Unknown'}`,
                `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
                `Rank: ${d.rank || 'Unknown'}`,
                `Est Monthly Sales: ${d.estimated_sales ? `$${Math.round(d.estimated_sales / 100).toLocaleString()}/mo` : 'Unknown'}`,
                `Plan: ${d.plan || 'Unknown'}`,
              ].filter(Boolean).join('\n'),
            });

            if (insertError) {
              console.error(`Error adding ${cleanName}:`, insertError.message);
            } else {
              newLeadsAdded++;
              existingWebsites.add(cleanName); // prevent dupes in same run
            }
          }

          // Rate limit between API calls
          await new Promise(r => setTimeout(r, 250));

        } catch (catError) {
          console.error(`Error searching ${category} ${country}:`, catError.message);
        }
      }
    }

    const summary = {
      totalDiscovered: allDiscovered.length,
      newLeadsAdded,
      alreadyExisted,
      categories: TARGET_CATEGORIES,
    };

    console.log(`✅ Discovery complete:`, summary);

    await supabase.from('activity_log').insert({
      activity_type: 'lead_discovery',
      summary: `StoreLeads discovery: found ${allDiscovered.length} top stores, added ${newLeadsAdded} new leads (${alreadyExisted} already existed)`,
      status: 'success'
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(summary),
    };

  } catch (error) {
    console.error('💥 Discovery error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
