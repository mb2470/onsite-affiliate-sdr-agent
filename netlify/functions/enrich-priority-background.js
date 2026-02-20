const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

const TARGET_CATEGORIES = ['apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
  'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
  'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
  'electronics', 'computers', 'consumer electronics', 'phones', 'networking'];

function scoreICP(d) {
  const categories = (d.categories || []).map(c => c.toLowerCase());
  const productCount = d.product_count || 0;
  const estSales = d.estimated_sales || 0;
  const country = (d.country || '').toUpperCase();

  const isTarget = categories.some(c => TARGET_CATEGORIES.some(t => c.includes(t))) ? 1 : 0;
  const hasLargeCatalog = productCount >= 250 ? 1 : 0;
  const hasGoodSales = estSales >= 100000000 ? 1 : 0;

  const score = hasLargeCatalog + hasGoodSales + isTarget;
  const isUSCA = ['US', 'CA'].includes(country);

  if (isUSCA && score === 3) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}

async function enrichBatch(domains) {
  const response = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STORELEADS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ domains }),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || 5;
    console.log(`  ⏳ Rate limited, waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return enrichBatch(domains);
  }

  if (!response.ok) throw new Error(`StoreLeads API error: ${response.status}`);

  return await response.json();
}

exports.handler = async (event, context) => {
  console.log('🎯 Starting prioritized enrichment (leads with contacts, no ICP)...');

  try {
    // Get leads with contacts but no ICP score
    let leads = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, website')
        .eq('has_contacts', true)
        .is('icp_fit', null)
        .eq('status', 'new')
        .range(from, from + 499);

      if (error) throw error;
      if (data && data.length > 0) {
        leads = leads.concat(data);
        from += 500;
        if (data.length < 500) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📋 ${leads.length} leads to enrich`);

    let enriched = 0;
    let notFound = 0;
    let highCount = 0;
    let medCount = 0;
    let lowCount = 0;

    // Process in batches of 50
    for (let i = 0; i < leads.length; i += 50) {
      const batch = leads.slice(i, i + 50);
      const domains = batch.map(l => l.website.replace(/^www\./, ''));
      const batchNum = Math.floor(i / 50) + 1;
      const totalBatches = Math.ceil(leads.length / 50);

      console.log(`📦 Batch ${batchNum}/${totalBatches} (${domains.length} domains)...`);

      try {
        const result = await enrichBatch(domains);

        for (const lead of batch) {
          const domain = lead.website.replace(/^www\./, '');
          const d = result[domain];

          if (!d) {
            notFound++;
            await supabase.from('leads').update({
              icp_fit: 'LOW',
              status: 'enriched',
              fit_reason: '❌ Not found in StoreLeads',
            }).eq('id', lead.id);
            continue;
          }

          const icpScore = scoreICP(d);
          const productCount = d.product_count || 0;
          const estSales = d.estimated_sales || 0;
          const categories = d.categories || [];
          const salesFormatted = estSales ? `$${Math.round(estSales / 100).toLocaleString()}/mo` : 'Unknown';

          const cats = categories.map(c => c.toLowerCase());
          const isTarget = cats.some(c => TARGET_CATEGORIES.some(t => c.includes(t)));

          const factors = [];
          factors.push(productCount >= 250 ? `✅ ${productCount} products` : `❌ ${productCount} products (<250)`);
          factors.push(estSales >= 100000000 ? `✅ ${salesFormatted} sales` : `❌ ${salesFormatted} sales`);
          factors.push(isTarget ? `✅ ${categories.join(', ')}` : `❌ ${categories.join(', ') || 'no target category'}`);

          const catalogLabel = productCount < 100 ? `Small (${productCount} products)` :
            productCount < 250 ? `Medium (${productCount} products)` : `Large (${productCount} products)`;

          await supabase.from('leads').update({
            status: 'enriched',
            icp_fit: icpScore,
            industry: categories.join('; ') || null,
            catalog_size: catalogLabel,
            country: d.country || null,
            fit_reason: factors.join(' | '),
            platform: d.platform || null,
            product_count: productCount || null,
            store_rank: d.rank || null,
            estimated_sales: estSales ? estSales.toString() : null,
            city: d.city || null,
            state: d.state || null,
            headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
            research_notes: [
              `Platform: ${d.platform || 'Unknown'}`,
              `Products: ${productCount}`,
              `Categories: ${categories.join('; ') || 'Unknown'}`,
              `Country: ${d.country || 'Unknown'}`,
              `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
              `Rank: ${d.rank || 'Unknown'}`,
              `Est Monthly Sales: ${salesFormatted}`,
            ].join('\n'),
          }).eq('id', lead.id);

          enriched++;
          if (icpScore === 'HIGH') highCount++;
          else if (icpScore === 'MEDIUM') medCount++;
          else lowCount++;
        }
      } catch (batchErr) {
        console.error(`  ❌ Batch error: ${batchErr.message}`);
      }

      // Rate limit: 250ms between batches
      await new Promise(r => setTimeout(r, 250));
    }

    const summary = `Prioritized enrichment: ${enriched} enriched (${highCount} HIGH, ${medCount} MED, ${lowCount} LOW), ${notFound} not found`;
    console.log(`✅ ${summary}`);

    await supabase.from('activity_log').insert({
      activity_type: 'prioritized_enrichment',
      summary,
      status: 'success',
    });

  } catch (error) {
    console.error('💥 Enrichment error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'prioritized_enrichment',
      summary: `Failed: ${error.message}`,
      status: 'failed',
    });
  }
};
