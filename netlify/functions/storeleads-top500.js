const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

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

function scoreICP(d) {
  const categories = (d.categories || []).map(c => c.toLowerCase());
  const productCount = d.product_count || 0;
  const estSales = d.estimated_sales || 0;
  const country = (d.country || '').toUpperCase();

  const targetPatterns = ['apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
    'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
    'electronics', 'computers', 'consumer electronics', 'phones', 'networking'];

  const isTarget = categories.some(c => targetPatterns.some(t => c.includes(t))) ? 1 : 0;
  const hasLargeCatalog = productCount >= 250 ? 1 : 0;
  const hasGoodSales = estSales >= 100000000 ? 1 : 0; // $1M/mo in cents

  const score = hasLargeCatalog + hasGoodSales + isTarget;
  const isUSCA = ['US', 'CA'].includes(country);

  if (isUSCA && score === 3) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  if (score === 1) return 'LOW';
  return 'LOW';
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // Get existing websites
    let existingWebsites = new Set();
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data } = await supabase.from('leads').select('website').range(from, from + 999);
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

        const icpScore = scoreICP(d);
        const productCount = d.product_count || 0;
        const estSales = d.estimated_sales || 0;
        const salesFormatted = estSales ? `$${Math.round(estSales / 100).toLocaleString()}/mo` : 'Unknown';
        const categories = d.categories || [];

        const targetPatterns = ['apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
          'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
          'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
          'electronics', 'computers', 'consumer electronics', 'phones', 'networking'];
        const cats = categories.map(c => c.toLowerCase());
        const isTarget = cats.some(c => targetPatterns.some(t => c.includes(t)));

        const factors = [];
        factors.push(productCount >= 250 ? `✅ ${productCount} products` : `❌ ${productCount} products (<250)`);
        factors.push(estSales >= 100000000 ? `✅ ${salesFormatted} sales` : `❌ ${salesFormatted} sales`);
        factors.push(isTarget ? `✅ ${categories.join(', ')}` : `❌ ${categories.join(', ') || 'no target category'}`);

        const catalogLabel = productCount < 100 ? `Small (${productCount} products)` :
          productCount < 250 ? `Medium (${productCount} products)` : `Large (${productCount} products)`;

        const { error: insertError } = await supabase.from('leads').insert({
          website: cleanName,
          status: 'enriched',
          source: 'storeleads_top500',
          icp_fit: icpScore,
          industry: categories.join('; ') || null,
          catalog_size: catalogLabel,
          sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
          headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
          country: d.country || null,
          fit_reason: factors.join(' | '),
          platform: d.platform || null,
          product_count: productCount || null,
          store_rank: d.rank || null,
          estimated_sales: estSales ? estSales.toString() : null,
          city: d.city || null,
          state: d.state || null,
          research_notes: [
            `Platform: ${d.platform || 'Unknown'}`,
            `Products: ${productCount}`,
            `Categories: ${categories.join('; ') || 'Unknown'}`,
            `Country: ${d.country || 'Unknown'}`,
            `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
            `Rank: ${d.rank || 'Unknown'}`,
            `Est Monthly Sales: ${salesFormatted}`,
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

    // Now match contacts for any new leads
    if (newAdded > 0) {
      const { data: newLeads } = await supabase
        .from('leads')
        .select('id, website')
        .eq('source', 'storeleads_top500')
        .is('has_contacts', null);

      let contactsMatched = 0;
      for (const lead of (newLeads || [])) {
        const cleanDomain = lead.website.replace(/^www\./, '');
        const { data: contacts } = await supabase
          .from('contact_database')
          .select('first_name, last_name, email')
          .or(`website.ilike.%${cleanDomain}%,email_domain.ilike.%${cleanDomain}%`)
          .limit(1);

        if (contacts && contacts.length > 0) {
          const c = contacts[0];
          await supabase.from('leads').update({
            has_contacts: true,
            contact_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
            contact_email: c.email,
          }).eq('id', lead.id);
          contactsMatched++;
        } else {
          await supabase.from('leads').update({ has_contacts: false }).eq('id', lead.id);
        }
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
