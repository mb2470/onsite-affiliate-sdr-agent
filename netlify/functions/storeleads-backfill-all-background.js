const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreStoreLeads, buildStoreLeadsFitReason, catalogSizeLabel, checkFastTrack } = require('./lib/icp-scoring');
const { resolveOrgId } = require('./lib/org-id');
const { upsertStoreLeadsRecord, normalizeDomain } = require('./lib/storeleads');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 250;

exports.handler = async () => {
  console.log('🧰 Starting one-time StoreLeads backfill for all lead websites...');

  if (!STORELEADS_API_KEY) {
    console.error('STORELEADS_API_KEY not configured');
    return;
  }

  const orgId = await resolveOrgId(supabase);

  try {
    const config = await getIcpScoringConfig(supabase);

    let allLeads = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, website, status')
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

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary: `Started one-time StoreLeads backfill for ${allLeads.length} lead websites`,
      status: 'success',
      org_id: orgId,
    });

    let enriched = 0;
    let cached = 0;
    let notFound = 0;
    let failed = 0;

    for (let i = 0; i < allLeads.length; i += BATCH_SIZE) {
      const batch = allLeads.slice(i, i + BATCH_SIZE);
      const domains = batch.map((l) => normalizeDomain(l.website)).filter(Boolean);

      const response = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STORELEADS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domains }),
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After') || 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        i -= BATCH_SIZE;
        continue;
      }

      if (!response.ok) {
        failed += batch.length;
        continue;
      }

      const payload = await response.json();
      const domainResults = payload.domains || [];
      const resultMap = {};
      domainResults.forEach((d) => {
        const key = normalizeDomain(d.domain || d.name);
        if (key) resultMap[key] = d;
      });

      for (const lead of batch) {
        const key = normalizeDomain(lead.website);
        const d = resultMap[key];

        if (!d) {
          notFound += 1;
          continue;
        }

        try {
          await upsertStoreLeadsRecord(supabase, orgId, { result: d });
          cached += 1;

          let icpScore = scoreStoreLeads(d, config);
          let fitReason = buildStoreLeadsFitReason(d, config);
          const { fastTrack, reason: ftReason } = checkFastTrack(d);
          if (fastTrack) {
            icpScore = 'HIGH';
            fitReason = ftReason;
          }

          const update = {
            icp_fit: icpScore,
            industry: (d.categories || []).join('; ') || null,
            catalog_size: catalogSizeLabel(d.product_count, config.minProductCount),
            sells_d2c: d.platform ? 'YES' : 'UNKNOWN',
            headquarters: [d.city, d.state, d.country].filter(Boolean).join(', ') || null,
            country: d.country || null,
            city: d.city || null,
            state: d.state || null,
            platform: d.platform || null,
            product_count: d.product_count || null,
            store_rank: d.rank || null,
            estimated_sales: d.estimated_sales || null,
            fit_reason: fitReason,
            research_notes: JSON.stringify({ source: 'storeleads', ...d }),
          };

          if (lead.status === 'new') {
            update.status = 'enriched';
          }

          const { error: updateError } = await supabase.from('leads').update(update).eq('id', lead.id);
          if (updateError) {
            failed += 1;
            continue;
          }

          enriched += 1;
        } catch (error) {
          console.error(`Failed processing ${lead.website}:`, error.message);
          failed += 1;
        }
      }

      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    const summary = `One-time StoreLeads backfill complete: ${cached} cached, ${enriched} leads updated, ${notFound} not found, ${failed} failed out of ${allLeads.length}`;
    console.log(summary);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary,
      status: 'success',
      org_id: orgId,
    });
  } catch (error) {
    console.error('Backfill failed:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_enrichment',
      summary: `One-time StoreLeads backfill failed: ${error.message}`,
      status: 'failed',
      org_id: orgId,
    });
  }
};
