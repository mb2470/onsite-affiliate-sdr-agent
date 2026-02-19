import { supabase } from '../supabaseClient';
import { logActivity } from './leadService';

const SYSTEM_PROMPT = `You are a B2B sales researcher for Onsite Affiliate. You have web search available — USE IT to look up the company website and check Google Shopping.

Return ONLY plain text in the exact format requested. No markdown, no code fences, no extra explanation.

WHAT ONSITE AFFILIATE DOES:
We help D2C ecommerce brands run performance-based creator/UGC programs on their own website. Brands get video content with no upfront costs — creators earn commissions on sales they drive.

ICP SCORING RULES (follow these EXACTLY):

HIGH FIT — ALL of these must be true:
1. Sells products D2C on their own website (having retail/wholesale channels too is FINE — Nike, Coach, Nordstrom all count as D2C because they sell on their own site)
2. Large product catalog (estimate 250+ products)
3. Primary category is one of: Fashion/Apparel, Home Goods, Outdoor/Lifestyle, Electronics
4. Headquartered in US or Canada
5. BONUS: If found on Google Shopping, this is a strong HIGH signal

MEDIUM FIT — has a D2C website BUT one or more:
- Catalog under 250 products in a target category
- Large catalog but in a non-target category (Beauty, Pet, Food, Health, Sports, Toys, etc.)
- Headquartered outside US/Canada

LOW FIT — any of these:
- No D2C ecommerce (B2B only, SaaS, services, marketplace-only seller with no own store)
- Brick-and-mortar only with no online store
- Non-profit, government, media company, blog
- No product sales at all

IMPORTANT EXAMPLES:
- Wayfair.com → HIGH (D2C ecommerce, huge Home Goods catalog, US-based)
- Nordstrom.com → HIGH (D2C ecommerce, huge Fashion catalog, US-based, sells on own site)
- Nike.com → HIGH (D2C ecommerce, large Fashion/Apparel catalog, US-based)
- Coach.com → HIGH (D2C ecommerce, large Fashion/Accessories catalog, US-based)
- A small Shopify jewelry store with 30 products → MEDIUM (D2C but small catalog)
- A UK-based home goods brand → MEDIUM (D2C but non-US/CA)
- A B2B industrial supplier → LOW (not D2C consumer)
- A SaaS company → LOW (no product sales)`;

const buildPrompt = (website) => `Research the company at ${website} for B2B sales qualification.

TASKS:
1. Visit or search for ${website} to understand what they sell
2. Search Google Shopping for "${website}" or their brand name to check if they list products there
3. Determine their headquarters location

Provide in this EXACT format (return ONLY plain text, no markdown code fences, no extra commentary):

Industry: [specific industry/vertical]
Catalog Size: [Small (<100 products) / Medium (100-250) / Large (250+)]
Sells D2C: [YES/NO - do they sell direct to consumer on their own website?]
Headquarters: [City, State/Country]
Google Shopping: [YES/NO/UNKNOWN - are their products listed on Google Shopping?]
ICP Fit: [HIGH/MEDIUM/LOW]
Fit Reason: [one sentence explaining why this score]
Decision Makers: [comma-separated likely titles e.g. CMO, VP Marketing, Head of Ecommerce]
Pain Points: [2-3 pain points related to creator content, UGC costs, or influencer spend]`;

// Parse a field from the enrichment response
const parseField = (text, fieldName) => {
  const match = text.match(new RegExp(`${fieldName}:\\s*(.+)`, 'i'));
  return match ? match[1].trim() : null;
};

// Enrich a single lead
export const enrichLead = async (lead) => {
  const response = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      useWebSearch: true,
      prompt: buildPrompt(lead.website),
      systemPrompt: SYSTEM_PROMPT
    })
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const data = await response.json();
  
  // Extract text (strips web search blocks)
  let research = data.text || '';
  if (!research && data.content && Array.isArray(data.content)) {
    research = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }

  // Parse all fields
  const parsed = {
    icp_fit: parseField(research, 'ICP Fit')?.toUpperCase() || null,
    industry: parseField(research, 'Industry'),
    catalog_size: parseField(research, 'Catalog Size'),
    sells_d2c: parseField(research, 'Sells D2C'),
    headquarters: parseField(research, 'Headquarters'),
    google_shopping: parseField(research, 'Google Shopping'),
    fit_reason: parseField(research, 'Fit Reason'),
    decision_makers: parseField(research, 'Decision Makers')?.replace(/[{}]/g, '') || null,
    pain_points: parseField(research, 'Pain Points')?.replace(/[{}]/g, '') || null,
  };

  // Save to Supabase — use individual set to avoid array parsing issues
  const { error } = await supabase
    .from('leads')
    .update({
      research_notes: research,
      icp_fit: parsed.icp_fit,
      industry: parsed.industry,
      catalog_size: parsed.catalog_size,
      sells_d2c: parsed.sells_d2c,
      headquarters: parsed.headquarters,
      google_shopping: parsed.google_shopping,
      fit_reason: parsed.fit_reason,
      decision_makers: parsed.decision_makers,
      pain_points: parsed.pain_points,
      status: 'enriched'
    })
    .eq('id', lead.id);

  if (error) throw error;

  // Log activity
  await logActivity(
    'lead_enriched',
    lead.id,
    `Enriched ${lead.website} — ICP: ${parsed.icp_fit || 'Unknown'} | ${parsed.industry || ''} | D2C: ${parsed.sells_d2c || '?'} | Catalog: ${parsed.catalog_size || '?'} | GShop: ${parsed.google_shopping || '?'}`,
    'success'
  );

  return { ...lead, ...parsed, research_notes: research, status: 'enriched' };
};

// Enrich multiple leads with progress callback
export const enrichLeads = async (leadIds, allLeads, onProgress) => {
  const results = { success: [], failed: [] };

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const lead = allLeads.find(l => l.id === leadId);
    if (!lead) continue;

    try {
      const enriched = await enrichLead(lead);
      results.success.push(enriched);
      if (onProgress) onProgress(i + 1, leadIds.length, lead.website, 'success', enriched);
    } catch (error) {
      console.error(`❌ Error enriching ${lead.website}:`, error);
      results.failed.push({ lead, error: error.message });
      
      await logActivity(
        'lead_enriched',
        leadId,
        `Failed to enrich ${lead.website}: ${error.message}`,
        'failed'
      );
      
      if (onProgress) onProgress(i + 1, leadIds.length, lead.website, 'failed', null);
    }

    // Rate limit between calls (web search needs more time)
    if (i < leadIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  return results;
};
