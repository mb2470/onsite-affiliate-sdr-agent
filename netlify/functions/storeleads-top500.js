const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreStoreLeads, buildStoreLeadsFitReason, catalogSizeLabel, checkFastTrack } = require('./lib/icp-scoring');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

async function fetchTopDomains(page, pageSize = 50) {
  const params = new URLSearchParams({
    'sort': 'rank',
    'page_size': pageSize.toString(),
    'page': page.toString(),
    'fields': 'name,categories,country,product_count,estimated_sales,rank,city,state,platform,plan,contact_info',
  });

  const url = `https://storeleads.app/json/api/v1/all/domain?${params}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` },
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || 5;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return fetchTopDomains(page, pageSize);
  }

  if (!response.ok) throw new Error(`StoreLeads API error: ${response.status}`);

  const data = await response.json();
  return data.domains || [];
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];
    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    // Load scoring config from ICP profile
    const config = await getIcpScoringConfig(supabase, orgId);
    console.log(`📐 Scoring thresholds: products≥${config.minProductCount}, sales≥$${config.minMonthlySalesCents/100}/mo`);

    // Get existing websites
    let existingWebsites = new Set();
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data } = await supabase.from('leads').select('website').eq('org_id', orgId).range(from, from + 999);
      if (data && data.length > 0) {
        data.forEach(l => existingWebsites.add(l.website.toLowerCase().replace(/^www\./, '')));
        from += 1000;
        if (data.length < 1000) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 ${existingWebsites.size} existing leads`);

    let newAdded = 0;
    let alreadyExisted = 0;
    let totalFetched = 0;

    // Fetch 10 pages of 50 = 500 top ranked domains
    for (let page = 0; page < 10; page++) {
      console.log(`📦 Fetching page ${page + 1}/10...`);
      const domains = await fetchTopDomains(page, 50);
      totalFetched += domains.length;

      for (const d of domains) {
        const cleanName = (d.name || '').toLowerCase().replace(/^www\./, '');
        if (!cleanName) continue;

        if (existingWebsites.has(cleanName)) {
          alreadyExisted++;
          continue;
        }

        let icpScore = scoreStoreLeads(d, config);
        let fitReason = buildStoreLeadsFitReason(d, config);

        // Opt 2: Fast-track check — technographic signals override to HIGH
        const { fastTrack, reason: ftReason } = checkFastTrack(d);
        if (fastTrack) {
          icpScore = 'HIGH';
          fitReason = ftReason;
          console.log(`  ⚡ Fast-tracked ${cleanName}: ${ftReason}`);
        }

        const { error: insertError } = await supabase.from('leads').insert({
          org_id: orgId,
          website: cleanName,
          status: 'enriched',
          source: 'storeleads_top500',
          icp_fit: icpScore,
          industry: (d.categories || []).join('; ') || null,
          catalog_size: catalogSizeLabel(d.product_count, config.minProductCount),
          sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
          headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
          country: d.country || null,
          fit_reason: fitReason,
          platform: d.platform || null,
          product_count: d.product_count || null,
          store_rank: d.rank || null,
          estimated_sales: d.estimated_sales ? d.estimated_sales.toString() : null,
          city: d.city || null,
          state: d.state || null,
          research_notes: [
            `Platform: ${d.platform || 'Unknown'}`,
            `Products: ${d.product_count || 0}`,
            `Categories: ${(d.categories || []).join('; ') || 'Unknown'}`,
            `Country: ${d.country || 'Unknown'}`,
            `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
            `Rank: ${d.rank || 'Unknown'}`,
            `Est Monthly Sales: ${d.estimated_sales ? `$${Math.round(d.estimated_sales / 100).toLocaleString()}/mo` : 'Unknown'}`,
            `Plan: ${d.plan || 'Unknown'}`,
          ].join('\n'),
        });

        if (insertError) {
          console.error(`Error adding ${cleanName}:`, insertError.message);
        } else {
          newAdded++;
          existingWebsites.add(cleanName);
        }
      }

      // Rate limit between pages
      await new Promise(r => setTimeout(r, 250));
    }

    // Now match contacts for any new leads + Opt 3: parallel Apollo discovery for HIGH
    if (newAdded > 0) {
      const { data: newLeads } = await supabase
        .from('leads')
        .select('id, website, icp_fit')
        .eq('source', 'storeleads_top500')
        .eq('org_id', orgId)
        .is('has_contacts', null);

      let contactsMatched = 0;
      const apolloDiscoveryPromises = [];

      for (const lead of (newLeads || [])) {
        const cleanDomain = lead.website.replace(/^www\./, '');
        const { data: contacts } = await supabase
          .from('contact_database')
          .select('first_name, last_name, email')
          .eq('org_id', orgId)
          .or(`website.ilike.%${cleanDomain}%,email_domain.ilike.%${cleanDomain}%`)
          .limit(1);

        if (contacts && contacts.length > 0) {
          const c = contacts[0];
          await supabase.from('leads').update({
            has_contacts: true,
            contact_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
            contact_email: c.email,
          }).eq('id', lead.id).eq('org_id', orgId);
          contactsMatched++;
        } else {
          await supabase.from('leads').update({ has_contacts: false }).eq('id', lead.id).eq('org_id', orgId);

          // Opt 3: For HIGH leads with no DB matches, trigger Apollo discovery
          if (lead.icp_fit === 'HIGH' && APOLLO_API_KEY) {
            apolloDiscoveryPromises.push(
              fetch('/.netlify/functions/apollo-find-contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: cleanDomain, leadId: lead.id, org_id: orgId }),
              }).catch(err => console.error(`Apollo discovery error for ${cleanDomain}: ${err.message}`))
            );
          }
        }
      }

      if (apolloDiscoveryPromises.length > 0) {
        console.log(`🔀 Triggering ${apolloDiscoveryPromises.length} parallel Apollo discoveries for HIGH leads...`);
        await Promise.allSettled(apolloDiscoveryPromises);
      }

      console.log(`👥 Matched contacts for ${contactsMatched} new leads`);
    }

    const summary = {
      totalFetched,
      newAdded,
      alreadyExisted,
    };

    console.log(`✅ Top 500 import complete:`, summary);

    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'lead_discovery',
      summary: `Top 500 import: fetched ${totalFetched}, added ${newAdded} new (${alreadyExisted} already existed)`,
      status: 'success',
    });

    return { statusCode: 200, headers, body: JSON.stringify(summary) };

  } catch (error) {
    console.error('💥 Top 500 import error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
