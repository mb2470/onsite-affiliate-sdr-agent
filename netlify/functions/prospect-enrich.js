/**
 * prospect-enrich.js — Gold promotion: Apollo enrichment for low-confidence prospects.
 *
 * POST { org_id, prospect_id }          — enrich a single prospect
 * POST { org_id, batch: true, limit: N } — enrich up to N low-confidence prospects (default 10)
 *
 * Returns { qualified, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

/**
 * Call Apollo org enrichment API to get firmographic data for a domain.
 * Returns the raw Apollo response or null on failure.
 */
async function apolloOrgEnrich(domain) {
  const enrichRes = await fetch('https://api.apollo.io/api/v1/organizations/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
    body: JSON.stringify({ domain }),
  });

  if (!enrichRes.ok) {
    throw new Error(`Apollo org enrich failed: ${enrichRes.status}`);
  }

  return enrichRes.json();
}

/**
 * Map Apollo org data to prospect fields, only overriding where Apollo has
 * higher-confidence data than existing crawl data.
 */
function mapApolloToProspect(apolloOrg, existingConfidence) {
  const updates = {};
  const conf = existingConfidence || {};

  // Apollo industry → industry_primary (override if crawl confidence < 0.7)
  if (apolloOrg.industry && (!conf.industry_primary || conf.industry_primary < 0.7)) {
    updates.industry_primary = apolloOrg.industry;
  }

  // Apollo sub-industry
  if (apolloOrg.industry_tag_name) {
    updates.industry_sub = apolloOrg.industry_tag_name;
  }

  // Employee count — Apollo is authoritative
  if (apolloOrg.estimated_num_employees) {
    updates.employee_actual = apolloOrg.estimated_num_employees;
    // Map to range buckets
    const emp = apolloOrg.estimated_num_employees;
    if (emp <= 10) updates.employee_range = '1-10';
    else if (emp <= 50) updates.employee_range = '11-50';
    else if (emp <= 200) updates.employee_range = '51-200';
    else if (emp <= 500) updates.employee_range = '201-500';
    else if (emp <= 1000) updates.employee_range = '501-1000';
    else if (emp <= 5000) updates.employee_range = '1001-5000';
    else updates.employee_range = '5001+';
  }

  // Revenue — Apollo is authoritative
  if (apolloOrg.annual_revenue) {
    updates.revenue_annual = apolloOrg.annual_revenue;
  }

  // Funding
  if (apolloOrg.total_funding) {
    updates.total_funding = apolloOrg.total_funding;
  }
  if (apolloOrg.latest_funding_stage) {
    updates.funding_stage = apolloOrg.latest_funding_stage;
  }
  if (apolloOrg.latest_funding_round_date) {
    updates.last_funding_date = apolloOrg.latest_funding_round_date;
  }

  // Geo
  if (apolloOrg.city) updates.hq_city = apolloOrg.city;
  if (apolloOrg.country) updates.hq_country = apolloOrg.country.slice(0, 2).toUpperCase();

  // LinkedIn
  if (apolloOrg.linkedin_url) updates.linkedin_url = apolloOrg.linkedin_url;

  // Technologies — merge with existing
  if (apolloOrg.technology_names && apolloOrg.technology_names.length > 0) {
    updates.technographics = apolloOrg.technology_names;
  }

  // Keywords from Apollo tags
  if (apolloOrg.keywords && apolloOrg.keywords.length > 0) {
    updates.keywords = apolloOrg.keywords;
  }

  // Company name — only if more complete
  if (apolloOrg.name) updates.company_name = apolloOrg.name;

  // Phone / email
  if (apolloOrg.phone) updates.phone = apolloOrg.phone;

  // Public company flag
  if (apolloOrg.publicly_traded_symbol) updates.is_public = true;

  return updates;
}

/**
 * Enrich a single prospect via Apollo. Returns { success, prospectId, error? }.
 */
async function enrichProspect(prospect, orgId) {
  const prospectId = prospect.id;
  const website = prospect.website;
  console.log(`🔬 Apollo enriching ${website} (${prospectId})`);

  let apolloData;
  try {
    apolloData = await apolloOrgEnrich(website);
  } catch (err) {
    console.error(`  Apollo API error for ${website}:`, err.message);
    return { success: false, prospectId, error: err.message };
  }

  const apolloOrg = apolloData.organization;
  if (!apolloOrg) {
    console.log(`  ⚠️ No Apollo data for ${website}`);
    return { success: false, prospectId, error: 'No organization data from Apollo' };
  }

  // Map Apollo fields, respecting existing confidence
  const existingConfidence = prospect.confidence_details || {};
  const updates = mapApolloToProspect(apolloOrg, existingConfidence);

  // Merge Apollo raw response into source_metadata
  const existingMeta = prospect.source_metadata || {};
  updates.source_metadata = {
    ...existingMeta,
    apollo_org_enrich: apolloData,
    apollo_enriched_at: new Date().toISOString(),
  };

  // Update confidence — Apollo data is high confidence
  const apolloConfidence = {
    ...(existingConfidence),
    industry_primary: updates.industry_primary ? 0.9 : (existingConfidence.industry_primary || 0),
    employee_range: updates.employee_actual ? 0.95 : (existingConfidence.employee_range || 0),
    revenue_estimate: updates.revenue_annual ? 0.9 : (existingConfidence.revenue_estimate || 0),
    overall: 0.85,
  };

  updates.confidence_score = apolloConfidence.overall;
  updates.confidence_details = apolloConfidence;
  updates.status = 'qualified';
  updates.enrichment_source = 'apollo';
  updates.last_enriched_at = new Date().toISOString();
  updates.updated_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from('prospects')
    .update(updates)
    .eq('id', prospectId)
    .eq('org_id', orgId);

  if (updateError) {
    console.error(`  Prospect update error for ${website}:`, updateError.message);
    return { success: false, prospectId, error: updateError.message };
  }

  console.log(`  ✅ Qualified ${website}: ${updates.industry_primary || prospect.industry_primary}, employees=${updates.employee_actual || 'unknown'}`);
  return { success: true, prospectId };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    if (!APOLLO_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'APOLLO_API_KEY not configured' }) };

    let prospects = [];

    if (body.batch) {
      // Batch mode: select enriched prospects with low confidence
      const limit = Math.min(body.limit || 10, 25);
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, confidence_score, confidence_details, source_metadata, industry_primary')
        .eq('org_id', orgId)
        .eq('status', 'enriched')
        .lt('confidence_score', 0.7)
        .order('confidence_score', { ascending: true })
        .limit(limit);

      if (error) throw error;
      prospects = data || [];
    } else if (body.prospect_id) {
      // Single prospect mode
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, confidence_score, confidence_details, source_metadata, industry_primary')
        .eq('org_id', orgId)
        .eq('id', body.prospect_id)
        .single();

      if (error) throw error;
      if (data) prospects = [data];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide prospect_id or batch: true' }) };
    }

    if (prospects.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ qualified: 0, errors: [], message: 'No prospects to enrich' }) };
    }

    console.log(`🚀 Apollo enriching ${prospects.length} prospects`);

    let qualified = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await enrichProspect(prospect, orgId);
      if (result.success) {
        qualified++;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_enrich',
      summary: `Apollo enrichment: ${qualified} qualified, ${errors.length} errors out of ${prospects.length} prospects`,
      status: errors.length === 0 ? 'success' : (qualified > 0 ? 'partial' : 'failed'),
    });

    console.log(`✅ Enrichment complete: ${qualified} qualified, ${errors.length} errors`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ qualified, errors }),
    };

  } catch (error) {
    console.error('💥 prospect-enrich error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
