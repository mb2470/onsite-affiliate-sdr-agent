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
  const estSales = domain.estimated_sales || 0; // in cents
  const country = (domain.country || '').toUpperCase();
  
  // Infer US/CA from country or location fields
  const state = (domain.state || '').toLowerCase();
  const city = (domain.city || '');
  // US states list for inference when country is missing
  const usStates = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','active'];
  const caProvinces = ['ab','bc','mb','nb','nl','ns','nt','nu','on','pe','qc','sk','yt','alberta','british columbia','manitoba','new brunswick','newfoundland','nova scotia','ontario','prince edward island','quebec','saskatchewan'];
  
  const isUS = country === 'US' || usStates.includes(state);
  const isCA = country === 'CA' || caProvinces.includes(state);
  const isUSCA = isUS || isCA;

  // Factor 1: Product Count (250+ = 1 point)
  const hasLargeCatalog = productCount >= 250 ? 1 : 0;

  // Factor 2: Estimated Sales ($50k+/month = 1 point, that's 5000000 cents)
  const hasGoodSales = estSales >= 5000000 ? 1 : 0;

  // Factor 3: Target Category (1 point)
  const targetPatterns = ['apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
    'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
    'electronics', 'computers', 'consumer electronics', 'phones', 'networking'];
  
  const isTargetCategory = categories.some(c => targetPatterns.some(t => c.includes(t))) ? 1 : 0;

  const score = hasLargeCatalog + hasGoodSales + isTargetCategory;

  if (!domain.name) return 'LOW'; // Not found

  // Must be US/CA AND 3/3 for HIGH
  if (isUSCA && score === 3) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  if (score === 1) return 'LOW';
  return 'LOW';
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
  const estSales = domain.estimated_sales || 0;
  const salesFormatted = estSales ? `$${Math.round(estSales / 100).toLocaleString()}/mo` : 'Unknown';

  const factors = [];
  
  // Check each factor
  const targetPatterns = ['apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
    'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
    'electronics', 'computers', 'consumer electronics', 'phones', 'networking'];
  const cats = (domain.categories || []).map(c => c.toLowerCase());
  const isTarget = cats.some(c => targetPatterns.some(t => c.includes(t)));

  if (products >= 250) factors.push(`✅ ${products} products`);
  else factors.push(`❌ ${products} products (<250)`);

  if (estSales >= 5000000) factors.push(`✅ ${salesFormatted} sales`);
  else factors.push(`❌ ${salesFormatted} sales`);

  if (isTarget) factors.push(`✅ ${categories}`);
  else factors.push(`❌ ${categories || 'no target category'}`);

  return factors.join(' | ');
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
            // Leave as 'new' — these need Claude enrichment or manual review
            continue;
          }

          const icpScore = scoreICP(d);
          
          // Infer country from location if not set
          let inferredCountry = d.country || null;
          if (!inferredCountry && d.state) {
            const st = d.state.toLowerCase();
            const usStates = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc','active',
              'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
            const caProvinces = ['ab','bc','mb','nb','nl','ns','nt','nu','on','pe','qc','sk','yt','alberta','british columbia','manitoba','new brunswick','newfoundland','nova scotia','ontario','prince edward island','quebec','saskatchewan'];
            if (usStates.includes(st)) inferredCountry = 'US';
            else if (caProvinces.includes(st)) inferredCountry = 'CA';
          }

          const estSales = d.estimated_sales || 0;
          const salesFormatted = estSales ? `$${Math.round(estSales / 100).toLocaleString()}/mo` : 'Unknown';

          const { error: updateError } = await supabase.from('leads').update({
            status: 'enriched',
            icp_fit: icpScore,
            industry: (d.categories || []).join('; ') || null,
            catalog_size: catalogSizeLabel(d.product_count),
            sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
            headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
            country: inferredCountry,
            fit_reason: buildFitReason(d, icpScore),
            research_notes: [
              `Platform: ${d.platform || 'Unknown'}`,
              `Products: ${d.product_count || 'Unknown'}`,
              `Categories: ${(d.categories || []).join('; ') || 'Unknown'}`,
              `Country: ${inferredCountry || 'Unknown'}`,
              `Location: ${[d.city, d.state].filter(Boolean).join(', ') || 'Unknown'}`,
              `Rank: ${d.rank || 'Unknown'}`,
              `Est Monthly Sales: ${salesFormatted}`,
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
