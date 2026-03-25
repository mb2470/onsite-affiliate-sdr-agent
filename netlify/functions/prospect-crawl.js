/**
 * prospect-crawl.js — Silver layer: Crawl prospect websites and extract firmographics via Claude.
 *
 * POST { org_id, prospect_id }          — crawl a single prospect
 * POST { org_id, batch: true, limit: N } — crawl up to N un-crawled prospects (default 10)
 *
 * Returns { crawled, enriched, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const CRAWL_PATHS = ['/', '/about', '/pricing', '/careers'];
const CRAWL_TIMEOUT_MS = 8000;

/**
 * Strip nav, footer, script, style tags and collapse whitespace.
 * Basic regex cleanup — good enough for firmographic extraction.
 */
function cleanHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract <meta name="description" content="..."> from raw HTML.
 */
function extractMetaDescription(html) {
  if (!html) return null;
  const match = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  return match ? match[1].trim() : null;
}

/**
 * Crawl a single URL with timeout. Returns { url, html, status } or error object.
 */
async function crawlPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OnsiteBot/1.0; +https://onsiteaffiliate.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    const html = await res.text();
    return { url, html, status: res.status };
  } catch (err) {
    return { url, html: null, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Claude to extract firmographics from concatenated page text.
 * Returns parsed JSON with confidence scores per field.
 */
async function extractFirmographics(cleanedTexts, website) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25000 });

  const combinedText = cleanedTexts.join('\n\n---PAGE BREAK---\n\n').slice(0, 12000);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a data extraction assistant. Extract structured firmographic data from website content. Return ONLY valid JSON, no markdown fences.',
    messages: [{
      role: 'user',
      content: `Extract firmographic data for the company at ${website} from the following website content.

Return JSON with this exact structure:
{
  "industry_primary": "string or null",
  "industry_sub": "string or null",
  "business_model": "B2B" | "B2C" | "SaaS" | "Marketplace" | "D2C" | "Other" | null,
  "target_market": "Enterprise" | "Mid-Market" | "SMB" | "Consumer" | null,
  "employee_range": "string like '11-50' or '51-200' or null",
  "revenue_estimate": "string like '$1M-$5M' or null",
  "keywords": ["array", "of", "relevant", "keywords"],
  "technographics": ["array", "of", "detected", "technologies"],
  "confidence": {
    "industry_primary": 0.0 to 1.0,
    "business_model": 0.0 to 1.0,
    "target_market": 0.0 to 1.0,
    "employee_range": 0.0 to 1.0,
    "revenue_estimate": 0.0 to 1.0,
    "overall": 0.0 to 1.0
  }
}

Website content:
${combinedText}`,
    }],
  });

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Strip markdown fences if present despite instructions
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Crawl and enrich a single prospect. Returns { success, prospectId, error? }.
 */
async function processProspect(prospect, orgId) {
  const prospectId = prospect.id;
  const website = prospect.website;
  console.log(`🕷️ Crawling ${website} (${prospectId})`);

  // Set status to enriching
  await supabase
    .from('prospects')
    .update({ status: 'enriching', updated_at: new Date().toISOString() })
    .eq('id', prospectId)
    .eq('org_id', orgId);

  const crawlResults = [];
  const cleanedTexts = [];

  // Crawl each page path
  for (const path of CRAWL_PATHS) {
    const url = `https://${website}${path}`;
    const result = await crawlPage(url);

    const cleanedText = cleanHtml(result.html);
    const metaDesc = extractMetaDescription(result.html);
    const wordCount = cleanedText ? cleanedText.split(/\s+/).length : 0;

    // Store crawl in company_crawls
    const { error: crawlError } = await supabase
      .from('company_crawls')
      .insert({
        prospect_id: prospectId,
        url_crawled: url,
        raw_markdown: result.html ? result.html.slice(0, 500000) : null,
        cleaned_text: cleanedText ? cleanedText.slice(0, 100000) : null,
        meta_description: metaDesc,
        word_count: wordCount,
        http_status: result.status,
        crawled_at: new Date().toISOString(),
      });

    if (crawlError) {
      console.error(`  Crawl insert error for ${url}:`, crawlError.message);
    }

    crawlResults.push({ url, status: result.status, wordCount });

    if (cleanedText && wordCount > 20) {
      cleanedTexts.push(cleanedText);
    }
  }

  // Extract firmographics via Claude if we got useful content
  if (cleanedTexts.length === 0) {
    console.log(`  ⚠️ No usable content for ${website}`);
    await supabase.from('prospects')
      .update({ status: 'new', updated_at: new Date().toISOString() })
      .eq('id', prospectId)
      .eq('org_id', orgId);
    return { success: false, prospectId, error: 'No crawlable content' };
  }

  let firmographics;
  try {
    firmographics = await extractFirmographics(cleanedTexts, website);
  } catch (err) {
    console.error(`  Claude extraction error for ${website}:`, err.message);
    await supabase.from('prospects')
      .update({ status: 'new', updated_at: new Date().toISOString() })
      .eq('id', prospectId)
      .eq('org_id', orgId);
    return { success: false, prospectId, error: `Extraction failed: ${err.message}` };
  }

  // Calculate weighted confidence score
  const conf = firmographics.confidence || {};
  const weights = { industry_primary: 0.25, business_model: 0.25, target_market: 0.2, employee_range: 0.15, revenue_estimate: 0.15 };
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [field, weight] of Object.entries(weights)) {
    if (conf[field] != null) {
      weightedSum += conf[field] * weight;
      weightTotal += weight;
    }
  }
  const confidenceScore = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null;

  // Update prospect with extracted data
  const updateFields = {
    status: 'enriched',
    last_enriched_at: new Date().toISOString(),
    enrichment_source: 'crawl',
    confidence_score: confidenceScore,
    confidence_details: conf,
    updated_at: new Date().toISOString(),
  };

  if (firmographics.industry_primary) updateFields.industry_primary = firmographics.industry_primary;
  if (firmographics.industry_sub) updateFields.industry_sub = firmographics.industry_sub;
  if (firmographics.business_model) updateFields.business_model = firmographics.business_model;
  if (firmographics.target_market) updateFields.target_market = firmographics.target_market;
  if (firmographics.employee_range) updateFields.employee_range = firmographics.employee_range;
  if (firmographics.keywords && firmographics.keywords.length > 0) updateFields.keywords = firmographics.keywords;
  if (firmographics.technographics && firmographics.technographics.length > 0) updateFields.technographics = firmographics.technographics;

  const { error: updateError } = await supabase
    .from('prospects')
    .update(updateFields)
    .eq('id', prospectId)
    .eq('org_id', orgId);

  if (updateError) {
    console.error(`  Prospect update error for ${website}:`, updateError.message);
    return { success: false, prospectId, error: updateError.message };
  }

  console.log(`  ✅ Enriched ${website}: ${firmographics.industry_primary || 'unknown industry'}, confidence=${confidenceScore}`);
  return { success: true, prospectId, confidenceScore };
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
      // Batch mode: select un-crawled prospects
      const limit = Math.min(body.limit || 10, 25);
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name')
        .eq('org_id', orgId)
        .eq('status', 'new')
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) throw error;

      // Filter out prospects that already have crawls
      if (data && data.length > 0) {
        const ids = data.map(p => p.id);
        const { data: crawled } = await supabase
          .from('company_crawls')
          .select('prospect_id')
          .in('prospect_id', ids);

        const crawledSet = new Set((crawled || []).map(c => c.prospect_id));
        prospects = data.filter(p => !crawledSet.has(p.id));
      }
    } else if (body.prospect_id) {
      // Single prospect mode
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name')
        .eq('org_id', orgId)
        .eq('id', body.prospect_id)
        .single();

      if (error) throw error;
      if (data) prospects = [data];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide prospect_id or batch: true' }) };
    }

    if (prospects.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ crawled: 0, enriched: 0, errors: [], message: 'No prospects to crawl' }) };
    }

    console.log(`🚀 Crawling ${prospects.length} prospects`);

    let crawled = 0;
    let enriched = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await processProspect(prospect, orgId);
      crawled++;
      if (result.success) {
        enriched++;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_crawl',
      summary: `Crawled ${crawled} prospects, enriched ${enriched}, ${errors.length} errors`,
      status: errors.length === 0 ? 'success' : (enriched > 0 ? 'partial' : 'failed'),
    });

    console.log(`✅ Crawl complete: ${crawled} crawled, ${enriched} enriched, ${errors.length} errors`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ crawled, enriched, errors }),
    };

  } catch (error) {
    console.error('💥 prospect-crawl error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
