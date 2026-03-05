const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreStoreLeads, buildStoreLeadsFitReason, catalogSizeLabel, checkFastTrack } = require('./lib/icp-scoring');
const { resolveOrgId } = require('./lib/org-id');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

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

/**
 * Opt 3: Trigger Apollo contact discovery for a HIGH lead in parallel.
 * Fire-and-forget — errors don't block the main discovery flow.
 */
async function discoverContactsForLead(leadId, domain) {
  if (!APOLLO_API_KEY) return;

  try {
    // Check if contacts already exist for this domain
    const { data: existing } = await supabase
      .from('contact_database')
      .select('id')
      .or(`website.ilike.%${domain}%,email_domain.ilike.%${domain}%`)
      .limit(1);

    if (existing && existing.length > 0) {
      // Already have contacts — just link them to the lead
      const { data: contacts } = await supabase
        .from('contact_database')
        .select('first_name, last_name, email')
        .or(`website.ilike.%${domain}%,email_domain.ilike.%${domain}%`)
        .limit(1);

      if (contacts && contacts.length > 0) {
        const c = contacts[0];
        await supabase.from('leads').update({
          has_contacts: true,
          contact_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          contact_email: c.email,
        }).eq('id', leadId);
      }
      return;
    }

    // No existing contacts — call Apollo search + enrich
    const searchRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({
        q_organization_domains_list: [domain],
        person_titles: [
          'VP Marketing', 'Head of Marketing', 'Director of Marketing',
          'CMO', 'Chief Marketing Officer',
          'CEO', 'Founder', 'Co-Founder', 'President',
          'VP Ecommerce', 'Head of Ecommerce',
        ],
        per_page: 5,
      }),
    });

    if (!searchRes.ok) return;
    const searchData = await searchRes.json();
    const people = (searchData.people || []).filter(p => p.has_email).slice(0, 2);
    if (people.length === 0) return;

    const enrichRes = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({ details: people.map(p => ({ id: p.id })) }),
    });

    if (!enrichRes.ok) return;
    const enrichData = await enrichRes.json();

    for (const m of (enrichData.matches || [])) {
      if (!m.email) continue;
      const emailStatus = (m.email_status || 'unavailable').toLowerCase();
      if (emailStatus === 'invalid') continue;

      const { count } = await supabase
        .from('contact_database')
        .select('*', { count: 'exact', head: true })
        .eq('email', m.email.toLowerCase());

      if (count > 0) continue;

      await supabase.from('contact_database').insert({
        first_name: m.first_name || null,
        last_name: m.last_name || null,
        email: m.email.toLowerCase(),
        title: m.title || null,
        website: domain,
        account_name: m.organization?.name || domain,
        linkedin_url: m.linkedin_url || null,
        apollo_email_status: emailStatus,
        apollo_verified_at: new Date().toISOString(),
        org_id: orgId,
      });

      // Update lead with first contact found
      await supabase.from('leads').update({
        has_contacts: true,
        contact_name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        contact_email: m.email.toLowerCase(),
      }).eq('id', leadId);
      break; // One contact is enough for now
    }
  } catch (err) {
    console.error(`  ⚠️ Parallel contact discovery error for ${domain}: ${err.message}`);
  }
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!STORELEADS_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'STORELEADS_API_KEY not configured' }) };
  }

  const orgId = await resolveOrgId(supabase);

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

    // Opt 3: Collect parallel contact discovery promises for HIGH leads
    const contactDiscoveryPromises = [];

    // Search each target category for US and CA
    for (const category of TARGET_CATEGORIES) {
      for (const country of ['US', 'CA']) {
        console.log(`🔍 Searching: ${category} in ${country}...`);

        try {
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
            let icpFit = scoreStoreLeads(d, config);
            let fitReason = buildStoreLeadsFitReason(d, config);

            // Opt 2: Fast-track check
            const { fastTrack, reason: ftReason } = checkFastTrack(d);
            if (fastTrack) {
              icpFit = 'HIGH';
              fitReason = ftReason;
              console.log(`  ⚡ Fast-tracked ${cleanName}: ${ftReason}`);
            }

            const { data: inserted, error: insertError } = await supabase.from('leads').insert({
              website: cleanName,
              status: 'enriched',
              source: 'storeleads_discovery',
              org_id: orgId,
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
            }).select('id').single();

            if (insertError) {
              console.error(`Error adding ${cleanName}:`, insertError.message);
            } else {
              newLeadsAdded++;
              existingWebsites.add(cleanName);

              // Opt 3: For HIGH leads, trigger contact discovery in parallel
              if (icpFit === 'HIGH' && inserted?.id) {
                contactDiscoveryPromises.push(discoverContactsForLead(inserted.id, cleanName));
              }
            }
          }

          // Rate limit between API calls
          await new Promise(r => setTimeout(r, 250));

        } catch (catError) {
          console.error(`Error searching ${category} ${country}:`, catError.message);
        }
      }
    }

    // Opt 3: Wait for all parallel contact discovery to settle
    if (contactDiscoveryPromises.length > 0) {
      console.log(`🔀 Waiting for ${contactDiscoveryPromises.length} parallel contact discoveries...`);
      await Promise.allSettled(contactDiscoveryPromises);
      console.log(`🔀 Parallel contact discovery complete.`);
    }

    const summary = {
      totalDiscovered: allDiscovered.length,
      newLeadsAdded,
      alreadyExisted,
      categories: TARGET_CATEGORIES,
      parallelContactDiscoveries: contactDiscoveryPromises.length,
    };

    console.log(`✅ Discovery complete:`, summary);

    await supabase.from('activity_log').insert({
      activity_type: 'lead_discovery',
      summary: `StoreLeads discovery: found ${allDiscovered.length} top stores, added ${newLeadsAdded} new leads (${alreadyExisted} already existed, ${contactDiscoveryPromises.length} parallel contact searches)`,
      status: 'success',
      org_id: orgId,
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
