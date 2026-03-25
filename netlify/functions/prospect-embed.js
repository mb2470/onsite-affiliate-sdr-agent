/**
 * prospect-embed.js — Generate embeddings for prospect crawl data and store
 * in prospect_embeddings for semantic search.
 *
 * POST { org_id, prospect_id }              — embed a single prospect's crawls
 * POST { org_id, batch: true, limit: 20 }   — embed up to N prospects that have
 *                                              crawls but no embeddings yet
 *
 * Returns { prospects_embedded, chunks_created, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_MIN = 500;
const CHUNK_MAX = 1000;
const CHUNK_OVERLAP = 100;

/**
 * Split text into overlapping chunks of CHUNK_MIN–CHUNK_MAX characters.
 * Prefers breaking on sentence boundaries (. ! ? \n) when possible.
 */
function chunkText(text) {
  if (!text || text.length === 0) return [];

  const chunks = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + CHUNK_MAX, text.length);

    // If we're not at the end, try to find a sentence boundary to break on
    if (end < text.length) {
      // Look for a sentence-ending character between CHUNK_MIN and CHUNK_MAX
      const window = text.slice(offset + CHUNK_MIN, end);
      const breakMatch = window.match(/.*[.!?\n]/);
      if (breakMatch) {
        end = offset + CHUNK_MIN + breakMatch[0].length;
      }
    }

    const chunk = text.slice(offset, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // Advance with overlap
    offset = end - CHUNK_OVERLAP;
    if (offset <= (end - CHUNK_MAX) || offset < 0) {
      offset = end; // safety: prevent infinite loop
    }
  }

  return chunks;
}

/**
 * Call OpenAI embeddings API for a batch of texts.
 * Returns array of embedding vectors in the same order as input.
 */
async function getEmbeddings(texts) {
  if (texts.length === 0) return [];

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI embeddings API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  // Sort by index to maintain input order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

/**
 * Process a single prospect: load crawls, chunk text, embed, store.
 * Returns { success, prospectId, chunksCreated, error? }
 */
async function embedProspect(prospect, orgId) {
  const prospectId = prospect.id;
  const website = prospect.website || prospect.company_name || prospectId;
  console.log(`🔮 Embedding ${website} (${prospectId})`);

  // Load all crawls for this prospect
  const { data: crawls, error: crawlError } = await supabase
    .from('company_crawls')
    .select('id, url_crawled, cleaned_text')
    .eq('prospect_id', prospectId)
    .order('crawled_at', { ascending: true });

  if (crawlError) {
    console.error(`  Crawl load error for ${website}:`, crawlError.message);
    return { success: false, prospectId, chunksCreated: 0, error: crawlError.message };
  }

  if (!crawls || crawls.length === 0) {
    console.log(`  ⚠️ No crawls found for ${website}`);
    return { success: false, prospectId, chunksCreated: 0, error: 'No crawls found' };
  }

  // Chunk all crawl texts
  const allChunks = []; // { crawlId, pageSource, chunkText, chunkIndex }
  for (const crawl of crawls) {
    const text = crawl.cleaned_text;
    if (!text || text.trim().length < 50) continue;

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        crawlId: crawl.id,
        pageSource: crawl.url_crawled || '',
        chunkText: chunks[i],
        chunkIndex: i,
      });
    }
  }

  if (allChunks.length === 0) {
    console.log(`  ⚠️ No embeddable content for ${website}`);
    return { success: false, prospectId, chunksCreated: 0, error: 'No embeddable content' };
  }

  console.log(`  📄 ${crawls.length} crawls → ${allChunks.length} chunks`);

  // Embed in batches of 100 (OpenAI limit is ~2048 inputs)
  const BATCH_SIZE = 100;
  let totalInserted = 0;

  for (let batchStart = 0; batchStart < allChunks.length; batchStart += BATCH_SIZE) {
    const batch = allChunks.slice(batchStart, batchStart + BATCH_SIZE);
    const texts = batch.map(c => c.chunkText);

    let embeddings;
    try {
      embeddings = await getEmbeddings(texts);
    } catch (err) {
      console.error(`  Embedding API error for ${website}:`, err.message);
      return {
        success: false,
        prospectId,
        chunksCreated: totalInserted,
        error: `Embedding failed at chunk ${batchStart}: ${err.message}`,
      };
    }

    // Build rows for insert
    const rows = batch.map((chunk, i) => ({
      prospect_id: prospectId,
      crawl_id: chunk.crawlId,
      chunk_text: chunk.chunkText,
      chunk_index: chunk.chunkIndex,
      page_source: chunk.pageSource,
      embedding: JSON.stringify(embeddings[i]),
    }));

    const { error: insertError } = await supabase
      .from('prospect_embeddings')
      .insert(rows);

    if (insertError) {
      console.error(`  Embedding insert error for ${website}:`, insertError.message);
      return {
        success: false,
        prospectId,
        chunksCreated: totalInserted,
        error: `Insert failed: ${insertError.message}`,
      };
    }

    totalInserted += rows.length;
  }

  console.log(`  ✅ Embedded ${website}: ${totalInserted} chunks`);
  return { success: true, prospectId, chunksCreated: totalInserted };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    }
    if (!OPENAI_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not configured' }) };
    }

    let prospects = [];

    if (body.batch) {
      // Batch mode: find prospects with crawls but no embeddings
      const limit = Math.min(body.limit || 20, 50);

      // Get prospects that have company_crawls
      const { data: crawled, error: crawlErr } = await supabase
        .from('company_crawls')
        .select('prospect_id');

      if (crawlErr) throw crawlErr;

      const crawledIds = [...new Set((crawled || []).map(c => c.prospect_id))];
      if (crawledIds.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ prospects_embedded: 0, chunks_created: 0, errors: [], message: 'No crawled prospects found' }) };
      }

      // Get prospects that already have embeddings
      const { data: embedded, error: embedErr } = await supabase
        .from('prospect_embeddings')
        .select('prospect_id');

      if (embedErr) throw embedErr;

      const embeddedIds = new Set((embedded || []).map(e => e.prospect_id));
      const needsEmbedding = crawledIds.filter(id => !embeddedIds.has(id));

      if (needsEmbedding.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ prospects_embedded: 0, chunks_created: 0, errors: [], message: 'All crawled prospects already embedded' }) };
      }

      // Fetch prospect details, filtered by org
      const idsToFetch = needsEmbedding.slice(0, limit);
      const { data: prospectData, error: fetchErr } = await supabase
        .from('prospects')
        .select('id, website, company_name')
        .eq('org_id', orgId)
        .in('id', idsToFetch);

      if (fetchErr) throw fetchErr;
      prospects = prospectData || [];

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
      return { statusCode: 200, headers, body: JSON.stringify({ prospects_embedded: 0, chunks_created: 0, errors: [], message: 'No prospects to embed' }) };
    }

    console.log(`🚀 Embedding ${prospects.length} prospects`);

    let prospectsEmbedded = 0;
    let totalChunks = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await embedProspect(prospect, orgId);
      if (result.success) {
        prospectsEmbedded++;
        totalChunks += result.chunksCreated;
      } else {
        totalChunks += result.chunksCreated;
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_embed',
      summary: `Embedded ${prospectsEmbedded} prospects, ${totalChunks} chunks, ${errors.length} errors`,
      status: errors.length === 0 ? 'success' : (prospectsEmbedded > 0 ? 'partial' : 'failed'),
    });

    console.log(`✅ Embedding complete: ${prospectsEmbedded} prospects, ${totalChunks} chunks, ${errors.length} errors`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ prospects_embedded: prospectsEmbedded, chunks_created: totalChunks, errors }),
    };

  } catch (error) {
    console.error('💥 prospect-embed error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
