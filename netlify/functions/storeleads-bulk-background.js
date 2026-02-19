const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 250;

function scoreICP(domain) {
  const categories = (domain.categories || []).map(c => c.toLowerCase());
  const productCount = domain.product_count || 0;
  const country = domain.country || '';
  const isUSCA = ['US', 'CA'].includes(country.toUpperCase());

  const targetCategories = ['apparel', 'fashion', 'clothing', 'shoes', 'accessories',
    'home', 'furniture', 'garden', 'kitchen', 'decor', 'home & garden',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness',
    'electronics', 'computers', 'consumer electronics', 'phones'];
  
  const mediumCategories = ['beauty', 'health', 'pet', 'food', 'drink', 'baby', 'toys',
    'jewelry', 'arts', 'crafts', 'automotive', 'office'];

  const isTargetCategory = categories.some(c => targetCategories.some(t => c.includes(t)));
  const isMediumCategory = categories.some(c => mediumCategories.some(t => c.includes(t)));
  const largeCatalog = productCount >= 250;
  const mediumCatalog = productCount >= 100 && productCount < 250;

  if (!domain.name) return 'LOW';
  if (isTargetCategory && largeCatalog && isUSCA) return 'HIGH';
  if (isTargetCategory && largeCatalog && !isUSCA) return 'MEDIUM';
  if (isTargetCategory && mediumCatalog && isUSCA) return 'MEDIUM';
  if (isMediumCategory && largeCatalog && isUSCA) return 'MEDIUM';
  if (isMediumCategory && largeCatalog && !isUSCA) return 'MEDIUM';
  if (productCount < 100 && isTargetCategory) return 'MEDIUM';
  if (!isTargetCategory && !isMediumCategory) return 'LOW';
  return 'MEDIUM';
}

function catalogSizeLabel(count) {
  if (!count) return 'Unknown';
  if (count < 100) return `Small (${count} products)`;
  if (count < 250) return `Medium (${count} products)`;
  return `Large (${count} products)`;
}

function buildFitReason(domain, score) {
  const categories = (domain.categories || []).join(', ');
  const country = domain.country || 'Unknown';
  const products = domain.product_count || 0;
  const parts = [];

  if (score === 'HIGH') {
    parts.push(`D2C ecommerce in ${categories || 'target category'}`);
    parts.push(`${products} products`);
    parts.push(`based in ${country}`);
  } else if (score === 'MEDIUM') {
    if (products < 250) parts.push(`Catalog: ${products} products`);
    if (!['US', 'CA'].includes((country || '').toUpperCase())) parts.push(`based in ${country}`);
    if (categories) parts.push(categories);
  } else {
    parts.push('Not matching target ICP');
    if (categories) parts.push(categories);
  }
  return parts.join(' — ');
}

// Background function — name must end with "-background" for Netlify
exports.handler = async (event) => {
  console.log('🚀 Starting StoreLeads bulk enrichment...');

  if (!STORELEADS_API_KEY) {
    console.error('STORELEADS_API_KEY not configured');
    return;
  }

  try {
    // Get all unenriched leads
    let allLeads = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, website')
        .eq('status', 'new')
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;
      if (data && data.length > 0) {
        allLeads = [...allLeads, ...data];
        from += pageSize;
        if (data.length < pageSize) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 Found ${allLeads.length} unenriched leads`);

    // Log start
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary: `Started StoreLeads bulk enrichment of ${allLeads.length} leads`,
      status: 'success'
    });

    let enriched = 0;
    let notFound = 0;
    let failed = 0;

    for (let i = 0; i < allLeads.length; i += BATCH_SIZE) {
      const batch = allLeads.slice(i, i + BATCH_SIZE);
      const domains = batch.map(l => l.website);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allLeads.length / BATCH_SIZE);

      console.log(`📦 Batch ${batchNum}/${totalBatches}: ${domains.length} domains`);

      try {
        const response = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STORELEADS_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ domains }),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After') || 10;
          console.log(`⏳ Rate limited, waiting ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          i -= BATCH_SIZE; // retry
          continue;
        }

        if (!response.ok) {
          console.error(`❌ API error: ${response.status}`);
          failed += batch.length;
          continue;
        }

        const data = await response.json();
        const domainResults = data.domains || [];

        const resultMap = {};
        domainResults.forEach(d => {
          if (d.name) resultMap[d.name.toLowerCase().replace(/^www\./, '')] = d;
        });

        for (const lead of batch) {
          const cleanDomain = lead.website.toLowerCase().replace(/^www\./, '');
          const d = resultMap[cleanDomain];

          if (!d) {
            notFound++;
            await supabase.from('leads').update({
              status: 'enriched',
              icp_fit: 'LOW',
              fit_reason: 'Not found in StoreLeads — may not be ecommerce',
              sells_d2c: 'UNKNOWN',
            }).eq('id', lead.id);
            continue;
          }

          const icpScore = scoreICP(d);

          const { error: updateError } = await supabase.from('leads').update({
            status: 'enriched',
            icp_fit: icpScore,
            industry: (d.categories || []).join('; ') || null,
            catalog_size: catalogSizeLabel(d.product_count),
            sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
            headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
            country: d.country || null,
            fit_reason: buildFitReason(d, icpScore),
            research_notes: [
              `Platform: ${d.platform || 'Unknown'}`,
              `Products: ${d.product_count || 'Unknown'}`,
              `Categories: ${(d.categories || []).join('; ') || 'Unknown'}`,
              `Country: ${d.country || 'Unknown'}`,
              `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
              `Rank: ${d.rank || 'Unknown'}`,
              `Est Monthly Sales: ${d.estimated_sales || 'Unknown'}`,
              `Plan: ${d.plan || 'Unknown'}`,
              `Created: ${d.created_at || 'Unknown'}`,
            ].filter(Boolean).join('\n'),
          }).eq('id', lead.id);

          if (updateError) {
            console.error(`Error updating ${lead.website}:`, updateError.message);
            failed++;
          } else {
            enriched++;
          }
        }

      } catch (batchError) {
        console.error(`Batch error:`, batchError.message);
        failed += batch.length;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));

      // Progress log every 10 batches
      if (batchNum % 10 === 0) {
        console.log(`📈 Progress: ${enriched} enriched, ${notFound} not found, ${failed} failed`);
      }
    }

    const summary = `StoreLeads bulk enrichment complete: ${enriched} enriched, ${notFound} not found, ${failed} failed out of ${allLeads.length} total`;
    console.log(`✅ ${summary}`);

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary,
      status: 'success'
    });

  } catch (error) {
    console.error('💥 Bulk enrichment error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary: `Bulk enrichment failed: ${error.message}`,
      status: 'failed'
    });
  }
};
