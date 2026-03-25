/**
 * prospect-search.js — Bronze layer: Serper search and ingest into prospects/search_signals.
 *
 * POST { org_id, search_queries: [{ query, type }] }
 * Returns { created, existing, signals_stored }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Normalize a URL to a bare domain for deduplication against prospects.website.
 * e.g. "https://www.example.com/about?q=1" → "example.com"
 */
function normalizeDomain(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let domain = url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')
      .replace(/[?#].*$/, '')
      .trim();
    // Skip non-domain results (e.g. google.com, youtube.com)
    if (!domain || domain.includes('google.') || domain.includes('youtube.')) return null;
    return domain;
  } catch {
    return null;
  }
}

/**
 * Extract a company name from a search result title.
 * Strips common suffixes like " - Home", " | Official Site", etc.
 */
function extractCompanyName(title) {
  if (!title) return 'Unknown';
  return title
    .split(/\s*[-|–—]\s*/)[0]
    .replace(/\s*(Home|Official Site|Website|LinkedIn|Facebook)$/i, '')
    .trim() || 'Unknown';
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { org_id, search_queries } = JSON.parse(event.body || '{}');
    const orgId = org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    if (!search_queries || !Array.isArray(search_queries) || search_queries.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: search_queries (array of { query, type })' }) };
    }
    if (!SERPER_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'SERPER_API_KEY not configured' }) };
    }

    let created = 0;
    let existing = 0;
    let signalsStored = 0;
    const errors = [];

    for (const { query, type } of search_queries) {
      if (!query) continue;

      // Call Serper Google Search API
      let serperData;
      try {
        const serperRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': SERPER_API_KEY,
          },
          body: JSON.stringify({ q: query, num: 10 }),
        });

        if (!serperRes.ok) throw new Error(`Serper API error: ${serperRes.status}`);
        serperData = await serperRes.json();
      } catch (err) {
        console.error(`Serper query failed for "${query}":`, err.message);
        errors.push({ query, error: err.message });
        continue;
      }

      const organicResults = serperData.organic || [];

      // Store the full search signal
      const { error: signalError } = await supabase
        .from('search_signals')
        .insert({
          search_query: query,
          source_platform: 'google',
          search_type: type || 'company_discovery',
          raw_response: serperData,
          result_position: null,
          result_snippet: null,
        });

      if (signalError) {
        console.error(`Signal insert error for "${query}":`, signalError.message);
      } else {
        signalsStored++;
      }

      // Process each organic result
      for (let i = 0; i < organicResults.length; i++) {
        const result = organicResults[i];
        const domain = normalizeDomain(result.link);
        if (!domain) continue;

        // Check if prospect already exists for this org + domain
        const { count, error: countError } = await supabase
          .from('prospects')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('website', domain);

        if (countError) {
          console.error(`Prospect lookup error for ${domain}:`, countError.message);
          continue;
        }

        let prospectId;

        if (count > 0) {
          // Already exists — fetch id for signal linking
          existing++;
          const { data: existingProspect } = await supabase
            .from('prospects')
            .select('id')
            .eq('org_id', orgId)
            .eq('website', domain)
            .single();
          prospectId = existingProspect?.id;
        } else {
          // Create new prospect with minimal fields
          const { data: newProspect, error: insertError } = await supabase
            .from('prospects')
            .insert({
              org_id: orgId,
              website: domain,
              website_raw: result.link,
              company_name: extractCompanyName(result.title),
              status: 'new',
              source_metadata: {
                source: 'serper_search',
                search_query: query,
                search_type: type || 'company_discovery',
                result_position: i + 1,
              },
            })
            .select('id')
            .single();

          if (insertError) {
            // Could be a race condition duplicate — treat as existing
            if (insertError.code === '23505') {
              existing++;
              const { data: raceProspect } = await supabase
                .from('prospects')
                .select('id')
                .eq('org_id', orgId)
                .eq('website', domain)
                .single();
              prospectId = raceProspect?.id;
            } else {
              console.error(`Prospect insert error for ${domain}:`, insertError.message);
              continue;
            }
          } else {
            created++;
            prospectId = newProspect?.id;
          }
        }

        // Store per-result search signal linked to prospect
        if (prospectId) {
          await supabase.from('search_signals').insert({
            prospect_id: prospectId,
            search_query: query,
            source_platform: 'google',
            search_type: type || 'company_discovery',
            raw_response: result,
            result_position: i + 1,
            result_snippet: result.snippet || null,
          });
          signalsStored++;
        }
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_search',
      summary: `Serper search: ${search_queries.length} queries, ${created} prospects created, ${existing} existing, ${signalsStored} signals stored`,
      status: errors.length > 0 ? 'partial' : 'success',
    });

    console.log(`✅ Prospect search complete: ${created} created, ${existing} existing, ${signalsStored} signals`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ created, existing, signals_stored: signalsStored, errors }),
    };

  } catch (error) {
    console.error('💥 prospect-search error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
