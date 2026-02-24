const { createClient } = require('@supabase/supabase-js');
const { getIcpScoringConfig, scoreApollo } = require('./lib/icp-scoring');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

async function enrichBatch(domains) {
  const response = await fetch('https://api.apollo.io/api/v1/organizations/bulk_enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': APOLLO_API_KEY,
    },
    body: JSON.stringify({ domains }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Apollo bulk org enrich failed (${response.status}): ${err}`);
  }

  return await response.json();
}

exports.handler = async (event, context) => {
  console.log('🏢 Starting Apollo organization enrichment for unenriched leads...');

  if (!APOLLO_API_KEY) {
    console.error('❌ APOLLO_API_KEY not set');
    return;
  }

  try {
    // Load scoring config from ICP profile
    const config = await getIcpScoringConfig(supabase);
    console.log(`📐 Scoring thresholds: revenue≥$${config.minAnnualRevenue/1000000}M/yr, employees≥${config.minEmployeeCount}, categories: ${config.targetCategories.length} keywords`);

    // Get leads that StoreLeads couldn't enrich (status = 'new')
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, website, country')
      .eq('status', 'new')
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) throw error;

    if (!leads || leads.length === 0) {
      console.log('📭 No unenriched leads to process.');
      return;
    }

    console.log(`📋 Processing ${leads.length} unenriched leads via Apollo Org Enrichment\n`);

    let enriched = 0;
    let notFound = 0;
    let highCount = 0;
    let medCount = 0;
    let lowCount = 0;

    // Process in batches of 10 (Apollo bulk limit)
    for (let i = 0; i < leads.length; i += 10) {
      const batch = leads.slice(i, i + 10);
      const domains = batch.map(l => l.website.replace(/^www\./, ''));

      console.log(`\n📦 Batch ${Math.floor(i / 10) + 1}/${Math.ceil(leads.length / 10)} — ${domains.length} domains`);

      try {
        const result = await enrichBatch(domains);
        const orgs = result.organizations || [];

        // Map orgs by domain for easy lookup
        const orgMap = {};
        for (const org of orgs) {
          if (org && org.primary_domain) {
            orgMap[org.primary_domain.toLowerCase()] = org;
          }
          // Also try website_url
          if (org && org.website_url) {
            const d = org.website_url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
            orgMap[d.toLowerCase()] = org;
          }
        }

        for (const lead of batch) {
          const domain = lead.website.replace(/^www\./, '').toLowerCase();
          const org = orgMap[domain];

          if (!org) {
            notFound++;
            continue;
          }

          // Score ICP using shared config
          const { icp_fit, fitReason, factors } = scoreApollo(org, lead.country, config);

          if (icp_fit === 'HIGH') highCount++;
          else if (icp_fit === 'MEDIUM') medCount++;
          else lowCount++;

          // Build update
          const update = {
            status: 'enriched',
            icp_fit,
            fit_reason: fitReason || null,
            industry: org.industry || null,
            country: org.country || lead.country || null,
            city: org.city || null,
            state: org.state || null,
            headquarters: org.raw_address || null,
            estimated_sales: org.annual_revenue || null,
            research_notes: JSON.stringify({
              source: 'apollo',
              employees: org.estimated_num_employees,
              revenue: org.annual_revenue,
              founded_year: org.founded_year,
              industry: org.industry,
              keywords: org.keywords,
              phone: org.phone,
              linkedin_url: org.linkedin_url,
            }),
          };

          const { error: updateErr } = await supabase
            .from('leads')
            .update(update)
            .eq('id', lead.id);

          if (updateErr) {
            console.error(`  ⚠️ Update error for ${domain}: ${updateErr.message}`);
          } else {
            enriched++;
            if (factors >= 2) {
              console.log(`  ✅ ${domain} → ${icp_fit} (${fitReason})`);
            }
          }
        }

        // Rate limit between batches
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        console.error(`  ❌ Batch error: ${err.message}`);
      }

      // Log progress every 10 batches
      if ((i / 10) % 10 === 9) {
        console.log(`\n📊 Progress: ${enriched} enriched, ${notFound} not found, ${highCount} HIGH, ${medCount} MED, ${lowCount} LOW`);
      }
    }

    const summary = `Apollo org enrichment: ${enriched} enriched (${highCount} HIGH, ${medCount} MED, ${lowCount} LOW), ${notFound} not found out of ${leads.length} leads`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ ${summary}`);
    console.log(`${'='.repeat(60)}`);

    await supabase.from('activity_log').insert({
      activity_type: 'apollo_org_enrichment',
      summary,
      status: 'success',
    });

  } catch (error) {
    console.error('💥 Apollo org enrichment error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'apollo_org_enrichment',
      summary: `Apollo org enrichment failed: ${error.message}`,
      status: 'failed',
    });
  }
};
