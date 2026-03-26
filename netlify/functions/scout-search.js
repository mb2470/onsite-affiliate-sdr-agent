/**
 * scout-search.js — Scout: Prospect sourcing via Serper (Google Search + Maps).
 *
 * Multi-tenant prospect discovery. Reads the org's scout_profiles config,
 * searches for businesses matching target categories in target geographies,
 * pre-qualifies via Claude, and inserts new prospects with source='scout'.
 *
 * POST { org_id, scout_profile_id }                — run a specific scout profile
 * POST { org_id, city, state, categories, limit }  — ad-hoc search
 *
 * Returns { searched, found, added, skipped, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Common directory/listing sites to exclude
const DEFAULT_BLACKLIST = [
  'yelp.com', 'yellowpages.com', 'tripadvisor.com', 'bbb.org',
  'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com',
  'tiktok.com', 'youtube.com', 'pinterest.com', 'reddit.com',
  'wikipedia.org', 'craigslist.org', 'indeed.com', 'glassdoor.com',
  'nextdoor.com', 'angi.com', 'angieslist.com', 'homeadvisor.com',
  'thumbtack.com', 'mapquest.com', 'manta.com', 'chamberofcommerce.com',
  'bloomberg.com', 'zoominfo.com', 'dnb.com', 'hoovers.com',
  'apple.com', 'google.com', 'bing.com',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch from Serper API (Google Search or Maps).
 */
async function serperFetch(type, query, num, page = 1) {
  const endpoint = type === 'maps'
    ? 'https://google.serper.dev/maps'
    : 'https://google.serper.dev/search';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num, page, gl: 'us', hl: 'en' }),
  });

  if (!res.ok) return {};
  return await res.json();
}

/**
 * Search Serper for businesses matching a category in a city.
 * Paginated web search + Google Maps.
 */
async function searchCategory(category, city, state, searchDepth, includeMaps, blacklist) {
  const query = `${category} in ${city}, ${state}`;
  const results = [];

  // Web search — paginate up to searchDepth pages
  for (let page = 1; page <= searchDepth; page++) {
    const webResults = await serperFetch('search', query, 30, page);
    if (webResults.organic) {
      for (const r of webResults.organic) {
        results.push({
          title: r.title,
          url: r.link,
          snippet: r.snippet || '',
          source: 'organic',
        });
      }
    }
    // Local pack from page 1
    if (page === 1 && webResults.places) {
      for (const p of webResults.places) {
        if (p.website) {
          results.push({
            title: p.title,
            url: p.website,
            snippet: p.address || '',
            phone: p.phoneNumber || '',
            address: p.address || '',
            source: 'places',
          });
        }
      }
    }
    if (!webResults.organic || webResults.organic.length < 10) break;
    await sleep(400);
  }

  // Google Maps search
  if (includeMaps) {
    const mapsResults = await serperFetch('maps', query, 40);
    if (mapsResults.places) {
      for (const p of mapsResults.places) {
        if (p.website) {
          results.push({
            title: p.title,
            url: p.website,
            snippet: p.address || '',
            phone: p.phoneNumber || '',
            address: p.address || '',
            source: 'maps',
          });
        }
      }
    }
  }

  // Filter blacklisted domains
  return results.filter(r => {
    if (!r.url) return false;
    try {
      const hostname = new URL(r.url).hostname.toLowerCase();
      return !blacklist.some(b => hostname === b || hostname.endsWith('.' + b));
    } catch { return false; }
  });
}

/**
 * Extract domain from URL for dedup.
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

/**
 * Pre-qualify a search result using Claude to filter directories/listings.
 */
async function preQualifyBatch(results) {
  if (results.length === 0) return results;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15000 });

  const listing = results.map((r, i) => `${i + 1}. "${r.title}" — ${r.url} — ${r.snippet}`).join('\n');

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a URL classifier. Determine which URLs are real individual businesses vs. directories, listing sites, blogs, or news articles. Return ONLY valid JSON.',
    messages: [{
      role: 'user',
      content: `Classify each URL. Return a JSON array of indices (1-based) that are REAL individual businesses (not directories, aggregators, or listing pages).

${listing}

Return: {"businesses": [1, 3, 5]}`,
    }],
  });

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    const indices = new Set(parsed.businesses || []);
    return results.filter((_, i) => indices.has(i + 1));
  } catch {
    // If parsing fails, return all results
    return results;
  }
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    if (!SERPER_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SERPER_API_KEY not configured' }) };

    let cities = [];
    let categories = [];
    let blacklist = DEFAULT_BLACKLIST;
    let searchDepth = 3;
    let includeMaps = true;

    if (body.scout_profile_id) {
      // Load scout profile from DB
      const { data: profile, error } = await supabase
        .from('scout_profiles')
        .select('*')
        .eq('id', body.scout_profile_id)
        .eq('org_id', orgId)
        .single();

      if (error || !profile) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Scout profile not found' }) };
      }

      cities = profile.target_geographies || [];
      categories = profile.target_categories || [];
      blacklist = [...DEFAULT_BLACKLIST, ...(profile.blacklisted_domains || [])];
      searchDepth = profile.search_depth || 3;
      includeMaps = profile.include_maps !== false;

      // Update last_run_at
      await supabase.from('scout_profiles').update({ last_run_at: new Date().toISOString() }).eq('id', profile.id);
    } else if (body.city && body.state) {
      // Ad-hoc search
      cities = [{ city: body.city, state: body.state }];
      categories = body.categories || ['businesses'];
      searchDepth = body.search_depth || 2;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide scout_profile_id or city+state' }) };
    }

    // Load existing domains in this org for dedup
    const { data: existingProspects } = await supabase
      .from('prospects')
      .select('website')
      .eq('org_id', orgId);

    const existingDomains = new Set((existingProspects || []).map(p => p.website?.toLowerCase().replace(/^www\./, '')));

    let totalSearched = 0;
    let totalFound = 0;
    let totalAdded = 0;
    let totalSkipped = 0;
    const errors = [];

    // Limit to prevent Netlify timeout (26s)
    const maxCities = Math.min(cities.length, 3);
    const maxCategories = Math.min(categories.length, 5);

    for (let ci = 0; ci < maxCities; ci++) {
      const geo = cities[ci];
      const city = geo.city;
      const state = geo.state;

      const seenDomains = new Set();

      for (let ki = 0; ki < maxCategories; ki++) {
        const category = categories[ki];
        totalSearched++;

        try {
          const results = await searchCategory(category, city, state, searchDepth, includeMaps, blacklist);

          // Deduplicate by domain
          const unique = [];
          for (const r of results) {
            const domain = extractDomain(r.url);
            if (domain && !seenDomains.has(domain) && !existingDomains.has(domain)) {
              seenDomains.add(domain);
              unique.push({ ...r, domain });
            }
          }

          totalFound += unique.length;

          // Pre-qualify via Claude (filter directories)
          const qualified = await preQualifyBatch(unique);

          // Insert as new prospects
          for (const r of qualified) {
            const { error: insertError } = await supabase
              .from('prospects')
              .insert({
                org_id: orgId,
                website: r.domain,
                company_name: r.title || null,
                phone: r.phone || null,
                hq_city: city,
                source: 'scout',
                scout_query: `${category} in ${city}, ${state}`,
                status: 'new',
                crawl_status: 'pending',
                analysis_status: 'pending',
              });

            if (!insertError) {
              totalAdded++;
              existingDomains.add(r.domain); // prevent dups in same run
            } else {
              totalSkipped++;
            }
          }
        } catch (err) {
          errors.push({ city, category, error: err.message });
        }

        await sleep(500); // Rate limit between category searches
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'scout_search',
      summary: `Scout: ${totalSearched} searches, ${totalFound} found, ${totalAdded} added, ${totalSkipped} skipped`,
      status: errors.length === 0 ? 'success' : 'partial',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        searched: totalSearched,
        found: totalFound,
        added: totalAdded,
        skipped: totalSkipped,
        errors,
        message: cities.length > maxCities || categories.length > maxCategories
          ? `Processed ${maxCities}/${cities.length} cities and ${maxCategories}/${categories.length} categories. Use the Python agent for full runs.`
          : undefined,
      }),
    };

  } catch (error) {
    console.error('scout-search error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
