/**
 * prospect-crawl.js — Researcher: Crawl prospect websites and extract firmographics via Claude.
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

// Pages to crawl — main site + common info pages
const CRAWL_PATHS = ['/', '/about', '/about-us', '/contact', '/pricing', '/careers'];
const CRAWL_TIMEOUT_MS = 8000;

/**
 * Strip nav, footer, script, style tags and collapse whitespace.
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
 * Extract emails and phone numbers from raw HTML using regex.
 * Ported from lead agent's fallback fetch pattern.
 */
function extractContactsFromHtml(html) {
  if (!html) return { emails: [], phones: [] };
  const emails = [...new Set((html.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])
    .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.gif')))];
  const phones = [...new Set(html.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [])];
  return { emails, phones };
}

/**
 * Extract social media URLs from raw HTML.
 */
function extractSocialUrls(html) {
  if (!html) return {};
  const socials = {};
  const fbMatch = html.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/i);
  if (fbMatch) socials.facebook = fbMatch[0];
  const liMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>]+/i);
  if (liMatch) socials.linkedin = liMatch[0];
  const igMatch = html.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i);
  if (igMatch) socials.instagram = igMatch[0];
  const twMatch = html.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/i);
  if (twMatch) socials.twitter = twMatch[0];
  return socials;
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
async function extractFirmographics(cleanedTexts, website, extractedContacts) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25000 });

  const combinedText = cleanedTexts.join('\n\n---PAGE BREAK---\n\n').slice(0, 12000);

  // Include any emails/phones found via regex as additional context
  let contactHint = '';
  if (extractedContacts.emails.length > 0 || extractedContacts.phones.length > 0) {
    contactHint = `\n\nContact info found on website: Emails: ${extractedContacts.emails.join(', ') || 'none'}, Phones: ${extractedContacts.phones.join(', ') || 'none'}`;
  }

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a data extraction assistant. Extract structured firmographic data from website content. Return ONLY valid JSON, no markdown fences.',
    messages: [{
      role: 'user',
      content: `Extract firmographic data for the company at ${website} from the following website content.${contactHint}

Return JSON with this exact structure:
{
  "company_name": "string or null",
  "industry_primary": "string or null",
  "industry_sub": "string or null",
  "business_model": "B2B" | "B2C" | "SaaS" | "Marketplace" | "D2C" | "Other" | null,
  "target_market": "Enterprise" | "Mid-Market" | "SMB" | "Consumer" | null,
  "employee_range": "string like '11-50' or '51-200' or null",
  "revenue_estimate": "string like '$1M-$5M' or null",
  "headquarters": "City, State/Country or null",
  "email": "primary contact email or null",
  "phone": "primary phone number or null",
  "services": ["array", "of", "services/products offered"],
  "keywords": ["array", "of", "relevant", "keywords"],
  "technographics": ["array", "of", "detected", "technologies"],
  "contact_names": [{"name": "string", "title": "string"}],
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
  console.log(`Crawling ${website} (${prospectId})`);

  // Set crawl status
  await supabase
    .from('prospects')
    .update({ status: 'enriching', crawl_status: 'crawling', crawl_attempted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', prospectId)
    .eq('org_id', orgId);

  const crawlResults = [];
  const cleanedTexts = [];
  const allRawHtml = [];
  const allExtractedContacts = { emails: [], phones: [] };
  let allSocialUrls = {};

  // Crawl each page path
  for (const pathSuffix of CRAWL_PATHS) {
    const url = `https://${website}${pathSuffix}`;
    const result = await crawlPage(url);

    if (result.html) {
      allRawHtml.push(result.html);

      // Extract contacts and socials from raw HTML
      const contacts = extractContactsFromHtml(result.html);
      allExtractedContacts.emails.push(...contacts.emails);
      allExtractedContacts.phones.push(...contacts.phones);
      const socials = extractSocialUrls(result.html);
      allSocialUrls = { ...allSocialUrls, ...socials };
    }

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

  // Deduplicate extracted contacts
  allExtractedContacts.emails = [...new Set(allExtractedContacts.emails)];
  allExtractedContacts.phones = [...new Set(allExtractedContacts.phones)];

  // Build raw_markdown from all crawled pages (for later re-analysis)
  const rawMarkdown = cleanedTexts.join('\n\n---\n\n').slice(0, 50000);

  // Extract firmographics via Claude if we got useful content
  if (cleanedTexts.length === 0) {
    console.log(`  No usable content for ${website}`);
    await supabase.from('prospects')
      .update({
        status: 'new',
        crawl_status: 'failed',
        raw_markdown: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', prospectId)
      .eq('org_id', orgId);
    return { success: false, prospectId, error: 'No crawlable content' };
  }

  let firmographics;
  try {
    firmographics = await extractFirmographics(cleanedTexts, website, allExtractedContacts);
  } catch (err) {
    console.error(`  Claude extraction error for ${website}:`, err.message);
    // Still save the raw markdown even if extraction fails — analyst can re-process
    await supabase.from('prospects')
      .update({
        status: 'new',
        crawl_status: 'crawled',
        analysis_status: 'pending',
        raw_markdown: rawMarkdown,
        social_urls: Object.keys(allSocialUrls).length > 0 ? allSocialUrls : null,
        updated_at: new Date().toISOString(),
      })
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
    crawl_status: 'crawled',
    analysis_status: 'analyzed',
    analysis_attempted_at: new Date().toISOString(),
    last_enriched_at: new Date().toISOString(),
    enrichment_source: 'crawl',
    confidence_score: confidenceScore,
    confidence_details: conf,
    raw_markdown: rawMarkdown,
    social_urls: Object.keys(allSocialUrls).length > 0 ? allSocialUrls : null,
    updated_at: new Date().toISOString(),
  };

  // Only fill fields that have data (don't overwrite existing)
  if (firmographics.company_name && !prospect.company_name) updateFields.company_name = firmographics.company_name;
  if (firmographics.industry_primary) updateFields.industry_primary = firmographics.industry_primary;
  if (firmographics.industry_sub) updateFields.industry_sub = firmographics.industry_sub;
  if (firmographics.business_model) updateFields.business_model = firmographics.business_model;
  if (firmographics.target_market) updateFields.target_market = firmographics.target_market;
  if (firmographics.employee_range) updateFields.employee_range = firmographics.employee_range;
  if (firmographics.headquarters) updateFields.hq_city = firmographics.headquarters;
  if (firmographics.keywords && firmographics.keywords.length > 0) updateFields.keywords = firmographics.keywords;
  if (firmographics.technographics && firmographics.technographics.length > 0) updateFields.technographics = firmographics.technographics;

  // Store extracted services and contacts from website
  if (firmographics.services && firmographics.services.length > 0) updateFields.extracted_services = firmographics.services;
  if (firmographics.contact_names && firmographics.contact_names.length > 0) updateFields.extracted_contacts = firmographics.contact_names;

  // Store email/phone from extraction or regex fallback
  const primaryEmail = firmographics.email || allExtractedContacts.emails[0] || null;
  const primaryPhone = firmographics.phone || allExtractedContacts.phones[0] || null;
  if (primaryEmail && !prospect.email) updateFields.email = primaryEmail;
  if (primaryPhone && !prospect.phone) updateFields.phone = primaryPhone;

  const { error: updateError } = await supabase
    .from('prospects')
    .update(updateFields)
    .eq('id', prospectId)
    .eq('org_id', orgId);

  if (updateError) {
    console.error(`  Prospect update error for ${website}:`, updateError.message);
    return { success: false, prospectId, error: updateError.message };
  }

  console.log(`  Enriched ${website}: ${firmographics.industry_primary || 'unknown industry'}, confidence=${confidenceScore}`);
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
        .select('id, website, company_name, email, phone')
        .eq('org_id', orgId)
        .or('crawl_status.eq.pending,crawl_status.is.null')
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) throw error;
      prospects = data || [];
    } else if (body.prospect_id) {
      // Single prospect mode
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, email, phone')
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

    console.log(`Crawling ${prospects.length} prospects`);

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

    console.log(`Crawl complete: ${crawled} crawled, ${enriched} enriched, ${errors.length} errors`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ crawled, enriched, errors }),
    };

  } catch (error) {
    console.error('prospect-crawl error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
