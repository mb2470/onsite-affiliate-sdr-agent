/**
 * prospect-reenrich.js — Re-enrichment scheduler for the prospect pipeline.
 *
 * Implements the re-enrichment schedule from the Prospect Database spec (section 6):
 *   - Stale data (last_enriched_at > 90 days): queued for re-crawl
 *   - Low confidence (confidence_score < 0.5): queued for data provider enrichment
 *   - EXCLUDES prospects with status 'contacted' or 'engaged' (active outreach lock)
 *
 * POST { org_id, dry_run: true }  — preview what would be re-enriched (no mutations)
 * POST { org_id, dry_run: false } — execute re-enrichment (set status=enriching, trigger pipelines)
 *
 * Returns { stale_recrawl, low_confidence_enrich, skipped_contacted, prospects? (dry_run only) }
 *
 * Recommended cron schedule: daily at 02:00 UTC
 *   curl -X POST https://your-site/.netlify/functions/prospect-reenrich \
 *     -H 'Content-Type: application/json' \
 *     -d '{"org_id":"...","dry_run":false}'
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const STALE_THRESHOLD_DAYS = 90;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const ACTIVE_OUTREACH_STATUSES = ['contacted', 'engaged'];

/**
 * Find prospects that need re-enrichment.
 * Returns { stale, lowConfidence, skippedContacted }.
 */
async function findReenrichCandidates(orgId) {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Stale data: last_enriched_at older than 90 days OR null
  // Excludes contacted/engaged and already-enriching
  const { data: staleData, error: staleErr } = await supabase
    .from('prospects')
    .select('id, website, company_name, status, confidence_score, last_enriched_at')
    .eq('org_id', orgId)
    .not('status', 'in', `(${ACTIVE_OUTREACH_STATUSES.join(',')})`)
    .neq('status', 'enriching')
    .neq('status', 'disqualified')
    .or(`last_enriched_at.lt.${staleCutoff},last_enriched_at.is.null`)
    .order('last_enriched_at', { ascending: true, nullsFirst: true })
    .limit(100);

  if (staleErr) throw staleErr;

  // Low confidence: confidence_score < 0.5
  // Excludes contacted/engaged and already-enriching
  // Also excludes prospects already in the stale list
  const { data: lowConfData, error: lowConfErr } = await supabase
    .from('prospects')
    .select('id, website, company_name, status, confidence_score, last_enriched_at')
    .eq('org_id', orgId)
    .not('status', 'in', `(${ACTIVE_OUTREACH_STATUSES.join(',')})`)
    .neq('status', 'enriching')
    .neq('status', 'disqualified')
    .lt('confidence_score', LOW_CONFIDENCE_THRESHOLD)
    .order('confidence_score', { ascending: true })
    .limit(100);

  if (lowConfErr) throw lowConfErr;

  const staleIds = new Set((staleData || []).map(p => p.id));
  // Remove duplicates — if a prospect is both stale AND low confidence, stale wins (re-crawl first)
  const lowConfOnly = (lowConfData || []).filter(p => !staleIds.has(p.id));

  // Count how many were skipped due to active outreach
  const { count: skippedCount, error: skipErr } = await supabase
    .from('prospects')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('status', ACTIVE_OUTREACH_STATUSES)
    .or(`last_enriched_at.lt.${staleCutoff},last_enriched_at.is.null,confidence_score.lt.${LOW_CONFIDENCE_THRESHOLD}`);

  if (skipErr) throw skipErr;

  return {
    stale: staleData || [],
    lowConfidence: lowConfOnly,
    skippedContacted: skippedCount || 0,
  };
}

/**
 * Trigger re-crawl for a batch of prospects by calling prospect-crawl internally.
 * Sets status to 'enriching' first, then kicks off crawls.
 */
async function triggerRecrawl(prospects, orgId) {
  if (prospects.length === 0) return { processed: 0, errors: [] };

  const ids = prospects.map(p => p.id);
  const errors = [];

  // Set all to enriching
  const { error: updateErr } = await supabase
    .from('prospects')
    .update({ status: 'enriching', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .in('id', ids);

  if (updateErr) {
    console.error('Failed to set enriching status for re-crawl:', updateErr.message);
    return { processed: 0, errors: [{ type: 'status_update', error: updateErr.message }] };
  }

  // Delete old crawls so prospect-crawl doesn't skip them
  for (const prospect of prospects) {
    try {
      await supabase
        .from('company_crawls')
        .delete()
        .eq('prospect_id', prospect.id);
    } catch (e) {
      console.error(`Failed to clear old crawls for ${prospect.website}:`, e.message);
    }
  }

  // Trigger prospect-crawl for each prospect
  const baseUrl = process.env.URL || 'http://localhost:8888';
  for (const prospect of prospects) {
    try {
      const res = await fetch(`${baseUrl}/.netlify/functions/prospect-crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, prospect_id: prospect.id }),
      });

      if (!res.ok) {
        const body = await res.text();
        errors.push({ prospect_id: prospect.id, website: prospect.website, error: `crawl ${res.status}: ${body}` });
      } else {
        console.log(`  Re-crawled ${prospect.website}`);
      }
    } catch (e) {
      errors.push({ prospect_id: prospect.id, website: prospect.website, error: e.message });
    }
  }

  return { processed: prospects.length - errors.length, errors };
}

/**
 * Trigger data provider enrichment for low-confidence prospects.
 * Sets status to 'enriching' first, then kicks off enrichment.
 */
async function triggerEnrichment(prospects, orgId) {
  if (prospects.length === 0) return { processed: 0, errors: [] };

  const ids = prospects.map(p => p.id);
  const errors = [];

  // Set all to enriching
  const { error: updateErr } = await supabase
    .from('prospects')
    .update({ status: 'enriching', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .in('id', ids);

  if (updateErr) {
    console.error('Failed to set enriching status for enrichment:', updateErr.message);
    return { processed: 0, errors: [{ type: 'status_update', error: updateErr.message }] };
  }

  // Trigger prospect-enrich for each prospect
  const baseUrl = process.env.URL || 'http://localhost:8888';
  for (const prospect of prospects) {
    try {
      const res = await fetch(`${baseUrl}/.netlify/functions/prospect-enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, prospect_id: prospect.id }),
      });

      if (!res.ok) {
        const body = await res.text();
        errors.push({ prospect_id: prospect.id, website: prospect.website, error: `enrich ${res.status}: ${body}` });
      } else {
        console.log(`  Re-enriched ${prospect.website}`);
      }
    } catch (e) {
      errors.push({ prospect_id: prospect.id, website: prospect.website, error: e.message });
    }
  }

  return { processed: prospects.length - errors.length, errors };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];
    const dryRun = body.dry_run !== false; // default to true for safety

    if (!orgId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    }

    console.log(`🔄 Re-enrichment check for org ${orgId} (dry_run=${dryRun})`);

    const { stale, lowConfidence, skippedContacted } = await findReenrichCandidates(orgId);

    console.log(`  Stale (>90d): ${stale.length}, Low confidence (<0.5): ${lowConfidence.length}, Skipped (active outreach): ${skippedContacted}`);

    if (dryRun) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          dry_run: true,
          stale_recrawl: stale.length,
          low_confidence_enrich: lowConfidence.length,
          skipped_contacted: skippedContacted,
          prospects: {
            stale: stale.map(p => ({
              id: p.id, website: p.website, company_name: p.company_name,
              status: p.status, confidence_score: p.confidence_score,
              last_enriched_at: p.last_enriched_at,
              reason: p.last_enriched_at ? `Last enriched ${Math.floor((Date.now() - new Date(p.last_enriched_at).getTime()) / (24*60*60*1000))}d ago` : 'Never enriched',
            })),
            low_confidence: lowConfidence.map(p => ({
              id: p.id, website: p.website, company_name: p.company_name,
              status: p.status, confidence_score: p.confidence_score,
              last_enriched_at: p.last_enriched_at,
              reason: `Confidence ${(p.confidence_score || 0).toFixed(2)} < ${LOW_CONFIDENCE_THRESHOLD}`,
            })),
          },
        }),
      };
    }

    // Execute re-enrichment
    const allErrors = [];

    const crawlResult = await triggerRecrawl(stale, orgId);
    allErrors.push(...crawlResult.errors);

    const enrichResult = await triggerEnrichment(lowConfidence, orgId);
    allErrors.push(...enrichResult.errors);

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_reenrich',
      summary: `Re-enrichment: ${crawlResult.processed} re-crawled, ${enrichResult.processed} re-enriched, ${skippedContacted} skipped (active outreach), ${allErrors.length} errors`,
      status: allErrors.length === 0 ? 'success' : (crawlResult.processed + enrichResult.processed > 0 ? 'partial' : 'failed'),
    });

    console.log(`✅ Re-enrichment complete: ${crawlResult.processed} re-crawled, ${enrichResult.processed} re-enriched`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        dry_run: false,
        stale_recrawl: crawlResult.processed,
        low_confidence_enrich: enrichResult.processed,
        skipped_contacted: skippedContacted,
        errors: allErrors.length > 0 ? allErrors : undefined,
      }),
    };

  } catch (error) {
    console.error('💥 prospect-reenrich error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
