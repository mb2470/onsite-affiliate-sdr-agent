/**
 * prospect-analyze.js — Analyst: Re-analyze prospects with raw_markdown to fill missing fields.
 *
 * Picks up prospects where crawl succeeded (has raw_markdown) but extraction
 * failed or left gaps. Uses Claude to extract additional data without re-crawling.
 *
 * POST { org_id, prospect_id }          — analyze a single prospect
 * POST { org_id, batch: true, limit: N } — analyze up to N prospects (default 10)
 *
 * Returns { analyzed, updated, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

/**
 * Call Claude to extract missing fields from existing raw_markdown.
 * Only asks for fields not already present on the prospect.
 */
async function analyzeProspect(prospect) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25000 });

  const md = (prospect.raw_markdown || '').slice(0, 10000);
  if (!md || md.length < 50) return null;

  // Build list of what's missing
  const missing = [];
  if (!prospect.company_name) missing.push('"company_name": "cleaned business name"');
  if (!prospect.industry_primary) missing.push('"industry_primary": "specific industry/vertical"');
  if (!prospect.business_model) missing.push('"business_model": "B2B|B2C|SaaS|D2C|Marketplace|Other"');
  if (!prospect.employee_range) missing.push('"employee_range": "e.g. 11-50, 51-200"');
  if (!prospect.email) missing.push('"email": "primary contact email"');
  if (!prospect.phone) missing.push('"phone": "primary phone number"');
  if (!prospect.hq_city) missing.push('"headquarters": "City, State/Country"');
  if (!prospect.extracted_services || prospect.extracted_services.length === 0) missing.push('"services": ["array of services/products"]');
  if (!prospect.extracted_contacts || prospect.extracted_contacts.length === 0) missing.push('"contact_names": [{"name": "full name", "title": "job title"}]');

  // If nothing is missing, skip
  if (missing.length === 0) return null;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a data extraction expert. Extract business information from website content. Return ONLY valid JSON, no markdown fences. Use null for anything not clearly present. Do NOT guess.',
    messages: [{
      role: 'user',
      content: `Extract the following MISSING fields for the company at ${prospect.website} from their website content.

Known data:
- Company: ${prospect.company_name || 'unknown'}
- Industry: ${prospect.industry_primary || 'unknown'}
- Business model: ${prospect.business_model || 'unknown'}

Return JSON with ONLY these fields (use null if not found):
{
  ${missing.join(',\n  ')}
}

Website content:
${md}`,
    }],
  });

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Process a single prospect — extract missing fields and update.
 */
async function processProspect(prospect, orgId) {
  const prospectId = prospect.id;
  const website = prospect.website;
  console.log(`Analyzing ${website} (${prospectId})`);

  let extracted;
  try {
    extracted = await analyzeProspect(prospect);
  } catch (err) {
    console.error(`  Extraction error for ${website}:`, err.message);
    await supabase.from('prospects')
      .update({ analysis_status: 'failed', analysis_attempted_at: new Date().toISOString() })
      .eq('id', prospectId)
      .eq('org_id', orgId);
    return { success: false, prospectId, error: err.message, fieldsAdded: 0 };
  }

  if (!extracted) {
    // Nothing missing or no content — mark as analyzed
    await supabase.from('prospects')
      .update({ analysis_status: 'analyzed', analysis_attempted_at: new Date().toISOString() })
      .eq('id', prospectId)
      .eq('org_id', orgId);
    return { success: true, prospectId, fieldsAdded: 0 };
  }

  // Only fill missing fields — never overwrite existing data
  const update = {
    analysis_status: 'analyzed',
    analysis_attempted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  let fieldsAdded = 0;

  if (!prospect.company_name && extracted.company_name) {
    update.company_name = extracted.company_name;
    fieldsAdded++;
  }
  if (!prospect.industry_primary && extracted.industry_primary) {
    update.industry_primary = extracted.industry_primary;
    fieldsAdded++;
  }
  if (!prospect.business_model && extracted.business_model) {
    update.business_model = extracted.business_model;
    fieldsAdded++;
  }
  if (!prospect.employee_range && extracted.employee_range) {
    update.employee_range = extracted.employee_range;
    fieldsAdded++;
  }
  if (!prospect.email && extracted.email) {
    update.email = extracted.email;
    fieldsAdded++;
  }
  if (!prospect.phone && extracted.phone) {
    update.phone = extracted.phone;
    fieldsAdded++;
  }
  if (!prospect.hq_city && extracted.headquarters) {
    update.hq_city = extracted.headquarters;
    fieldsAdded++;
  }
  if ((!prospect.extracted_services || prospect.extracted_services.length === 0) && extracted.services && extracted.services.length > 0) {
    update.extracted_services = extracted.services;
    fieldsAdded++;
  }
  if ((!prospect.extracted_contacts || prospect.extracted_contacts.length === 0) && extracted.contact_names && extracted.contact_names.length > 0) {
    update.extracted_contacts = extracted.contact_names;
    fieldsAdded++;
  }

  const { error: updateError } = await supabase
    .from('prospects')
    .update(update)
    .eq('id', prospectId)
    .eq('org_id', orgId);

  if (updateError) {
    console.error(`  Update error for ${website}:`, updateError.message);
    return { success: false, prospectId, error: updateError.message, fieldsAdded: 0 };
  }

  console.log(`  +${fieldsAdded} fields for ${website}`);
  return { success: true, prospectId, fieldsAdded };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    let prospects = [];

    if (body.batch) {
      // Batch mode: select prospects with raw_markdown but analysis_status = pending or failed
      const limit = Math.min(body.limit || 10, 25);
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, industry_primary, business_model, employee_range, email, phone, hq_city, extracted_services, extracted_contacts, raw_markdown')
        .eq('org_id', orgId)
        .not('raw_markdown', 'is', null)
        .or('analysis_status.eq.pending,analysis_status.eq.failed')
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) throw error;
      prospects = data || [];
    } else if (body.prospect_id) {
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, industry_primary, business_model, employee_range, email, phone, hq_city, extracted_services, extracted_contacts, raw_markdown')
        .eq('org_id', orgId)
        .eq('id', body.prospect_id)
        .single();

      if (error) throw error;
      if (data) prospects = [data];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide prospect_id or batch: true' }) };
    }

    if (prospects.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ analyzed: 0, updated: 0, errors: [], message: 'No prospects to analyze' }) };
    }

    console.log(`Analyzing ${prospects.length} prospects`);

    let analyzed = 0;
    let updated = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await processProspect(prospect, orgId);
      analyzed++;
      if (result.success) {
        if (result.fieldsAdded > 0) updated++;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_analyze',
      summary: `Analyzed ${analyzed} prospects, updated ${updated} with new data, ${errors.length} errors`,
      status: errors.length === 0 ? 'success' : (updated > 0 ? 'partial' : 'failed'),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ analyzed, updated, errors }),
    };

  } catch (error) {
    console.error('prospect-analyze error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
