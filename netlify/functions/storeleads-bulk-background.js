const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreStoreLeads, buildStoreLeadsFitReason, catalogSizeLabel, checkFastTrack } = require('./lib/icp-scoring');
const { resolveOrgId } = require('./lib/org-id');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 250;

// Background function — name must end with "-background" for Netlify
exports.handler = async (event) => {
  console.log('🚀 Starting StoreLeads bulk enrichment...');

  if (!STORELEADS_API_KEY) {
    console.error('STORELEADS_API_KEY not configured');
    return;
  }

  const orgId = await resolveOrgId(supabase);

  try {
    // Load scoring config from ICP profile
    const config = await getIcpScoringConfig(supabase);
    console.log(`📐 Scoring thresholds: products≥${config.minProductCount}, sales≥$${config.minMonthlySalesCents/100}/mo, categories: ${config.targetCategories.length} keywords`);

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
      status: 'success',
      org_id: orgId,
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

          let icpScore = scoreStoreLeads(d, config);
          let fitReason = buildStoreLeadsFitReason(d, config);

          // Opt 2: Fast-track check — technographic signals override to HIGH
          const { fastTrack, reason: ftReason } = checkFastTrack(d);
          if (fastTrack) {
            icpScore = 'HIGH';
            fitReason = ftReason;
            console.log(`  ⚡ Fast-tracked ${lead.website}: ${ftReason}`);
          }

          // Infer country from location if not set
          let inferredCountry = d.country || null;
          if (!inferredCountry && d.state) {
            const st = d.state.toLowerCase();
            const usStates = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
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
            catalog_size: catalogSizeLabel(d.product_count, config.minProductCount),
            sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
            headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
            country: inferredCountry,
            fit_reason: fitReason,
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
      status: 'success',
      org_id: orgId,
    });

  } catch (error) {
    console.error('💥 Bulk enrichment error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary: `Bulk enrichment failed: ${error.message}`,
      status: 'failed',
      org_id: orgId,
    });
  }
};
