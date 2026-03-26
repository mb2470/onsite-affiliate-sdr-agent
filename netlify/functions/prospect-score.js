/**
 * prospect-score.js — ICP Scoring: Score enriched prospects based on crawl-extracted data.
 *
 * Runs after the Researcher (crawl) and Analyst (extract) stages.
 * If the ICP score is high enough, marks the prospect as ready_for_gold
 * (Apollo contact discovery).
 *
 * POST { org_id, prospect_id }          — score a single prospect
 * POST { org_id, batch: true, limit: N } — score up to N un-scored prospects (default 25)
 *
 * Returns { scored, highFit, mediumFit, lowFit, readyForGold, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');
const { getIcpScoringConfig, scoreCrawlData } = require('./lib/icp-scoring');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

/**
 * Score a single prospect and update its ICP fit.
 */
async function scoreProspect(prospect, config, orgId) {
  const { icp_fit, score, fitReason, readyForGold } = scoreCrawlData(prospect, config);

  const update = {
    icp_fit_score: score,
    icp_fit: icp_fit,
    fit_reason: fitReason,
    updated_at: new Date().toISOString(),
  };

  // If score qualifies for gold enrichment, flag it
  if (readyForGold) {
    update.enrichment_status = 'ready_for_gold';
  }

  const { error } = await supabase
    .from('prospects')
    .update(update)
    .eq('id', prospect.id)
    .eq('org_id', orgId);

  if (error) {
    console.error(`  Score update error for ${prospect.website}:`, error.message);
    return { success: false, prospectId: prospect.id, error: error.message };
  }

  console.log(`  ${prospect.website}: ${icp_fit} (${score}/100) ${readyForGold ? '→ GOLD' : ''}`);
  return { success: true, prospectId: prospect.id, icp_fit, score, readyForGold };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    // Load ICP scoring config
    const config = await getIcpScoringConfig(supabase, orgId);
    if (!config) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No active ICP profile found. Set up your ICP profile first.' }) };
    }

    let prospects = [];

    if (body.batch) {
      // Batch mode: select enriched prospects that haven't been scored yet
      const limit = Math.min(body.limit || 25, 50);
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, industry_primary, industry_sub, business_model, target_market, employee_range, employee_actual, revenue_annual, revenue_estimate, hq_city, hq_country, country, city, email, phone, linkedin_url, social_urls, keywords, technographics, confidence_score, extracted_services, extracted_contacts')
        .eq('org_id', orgId)
        .eq('status', 'enriched')
        .is('icp_fit_score', null)
        .order('confidence_score', { ascending: false, nullsFirst: false })
        .limit(limit);

      if (error) throw error;
      prospects = data || [];
    } else if (body.prospect_id) {
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, industry_primary, industry_sub, business_model, target_market, employee_range, employee_actual, revenue_annual, revenue_estimate, hq_city, hq_country, country, city, email, phone, linkedin_url, social_urls, keywords, technographics, confidence_score, extracted_services, extracted_contacts')
        .eq('org_id', orgId)
        .eq('id', body.prospect_id)
        .single();

      if (error) throw error;
      if (data) prospects = [data];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide prospect_id or batch: true' }) };
    }

    if (prospects.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ scored: 0, message: 'No prospects to score' }) };
    }

    console.log(`Scoring ${prospects.length} prospects (thresholds: employees>=${config.minEmployeeCount}, revenue>=$${config.minAnnualRevenue/1000000}M)`);

    let scored = 0;
    let highFit = 0;
    let mediumFit = 0;
    let lowFit = 0;
    let readyForGoldCount = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await scoreProspect(prospect, config, orgId);
      if (result.success) {
        scored++;
        if (result.icp_fit === 'HIGH') highFit++;
        else if (result.icp_fit === 'MEDIUM') mediumFit++;
        else lowFit++;
        if (result.readyForGold) readyForGoldCount++;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_score',
      summary: `Scored ${scored} prospects: ${highFit} HIGH, ${mediumFit} MEDIUM, ${lowFit} LOW. ${readyForGoldCount} ready for gold enrichment.`,
      status: errors.length === 0 ? 'success' : 'partial',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ scored, highFit, mediumFit, lowFit, readyForGold: readyForGoldCount, errors }),
    };

  } catch (error) {
    console.error('prospect-score error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
