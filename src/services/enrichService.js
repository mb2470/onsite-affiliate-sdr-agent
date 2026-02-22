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

const buildIcpContext = () => {
  if (!_icpContext) return '';
  const parts = [];
  if (_icpContext.industries?.length) parts.push(`Target Industries: ${_icpContext.industries.join(', ')}`);
  if (_icpContext.geography?.length) parts.push(`Target Geography: ${_icpContext.geography.join(', ')}`);
  if (_icpContext.company_size) parts.push(`Ideal Company Size: ${_icpContext.company_size}`);
  if (_icpContext.revenue_range) parts.push(`Ideal Revenue Range: ${_icpContext.revenue_range}`);
  if (_icpContext.primary_titles?.length) parts.push(`Target Decision Makers: ${_icpContext.primary_titles.join(', ')}`);
  if (_icpContext.core_problem) parts.push(`Core Problem We Solve: ${_icpContext.core_problem}`);
  if (_icpContext.elevator_pitch) parts.push(`Our Product: ${_icpContext.elevator_pitch}`);
  return parts.length > 0 ? `\n\nCUSTOM ICP CRITERIA (use these to adjust scoring):\n${parts.join('\n')}` : '';
};

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

// ═══ ICP SCORING (dynamic from ICP profile) ═══
const DEFAULT_TARGET_CATEGORIES = [
  'apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
  'home & garden', 'furniture', 'kitchen', 'decor', 'outdoor',
  'sporting', 'fitness', 'travel',
  'electronics', 'computers', 'phones',
];

const DEFAULT_GEOGRAPHY = ['US', 'CA', 'UNITED STATES', 'CANADA'];

// Module-level ICP profile cache (set from App.jsx via setIcpContext)
let _icpContext = null;

export const setIcpContext = (icpProfile) => {
  _icpContext = icpProfile;
};

function getTargetCategories() {
  if (_icpContext && _icpContext.industries && _icpContext.industries.length > 0) {
    // Build category keywords from ICP profile industries
    const keywords = [];
    for (const industry of _icpContext.industries) {
      // Split on common separators and add lowercase keywords
      const parts = industry.toLowerCase().split(/[&,/]+/).map(s => s.trim()).filter(Boolean);
      keywords.push(...parts);
    }
    return keywords.length > 0 ? keywords : DEFAULT_TARGET_CATEGORIES;
  }
  return DEFAULT_TARGET_CATEGORIES;
}

function getTargetGeography() {
  if (_icpContext && _icpContext.geography && _icpContext.geography.length > 0) {
    const geoKeywords = [];
    for (const geo of _icpContext.geography) {
      const g = geo.toUpperCase();
      geoKeywords.push(g);
      // Expand common shorthand
      if (g.includes('NORTH AMERICA')) { geoKeywords.push('US', 'CA', 'UNITED STATES', 'CANADA'); }
      if (g.includes('EMEA')) { geoKeywords.push('UK', 'UNITED KINGDOM', 'GERMANY', 'FRANCE', 'SPAIN', 'ITALY', 'NETHERLANDS'); }
      if (g.includes('GLOBAL')) { return null; } // null = accept all
    }
    return geoKeywords.length > 0 ? geoKeywords : DEFAULT_GEOGRAPHY;
  }
  return DEFAULT_GEOGRAPHY;
}

function scoreICP(productCount, estimatedSales, categories, country) {
  const targetCategories = getTargetCategories();
  const targetGeo = getTargetGeography();

  const factors = [];
  const fitReason = [];

  if (productCount >= 250) { factors.push('products'); fitReason.push(`Products: ${productCount}`); }
  if (estimatedSales >= 100000000) { factors.push('sales'); fitReason.push(`Sales: $${(estimatedSales / 100).toLocaleString()}/mo`); }

  const catText = (categories || []).join(' ').toLowerCase();
  if (targetCategories.some(c => catText.includes(c))) { factors.push('category'); fitReason.push(`Category match`); }

  const c = (country || '').toUpperCase();
  // If targetGeo is null, accept all geographies (global)
  const isTargetGeo = targetGeo === null || targetGeo.some(x => c.includes(x));

  let icp_fit;
  if (factors.length >= 3 && isTargetGeo) icp_fit = 'HIGH';
  else if (factors.length >= 2) icp_fit = 'MEDIUM';
  else icp_fit = 'LOW';

  return { icp_fit, fitReason: fitReason.join('; ') };
}

// ═══ STEP 1: Try StoreLeads ═══
async function tryStoreLeads(domain) {
  try {
    const res = await fetch(`/.netlify/functions/storeleads-single?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.domain) return null;

    const productCount = data.product_count || 0;
    const estimatedSales = data.estimated_sales || 0;
    const categories = data.categories || [];
    const country = data.country || '';

    const { icp_fit, fitReason } = scoreICP(productCount, estimatedSales, categories, country);

    return {
      source: 'storeleads',
      icp_fit,
      fit_reason: fitReason,
      industry: (categories[0] || '').replace(/^.*>/, '').trim() || null,
      catalog_size: productCount >= 250 ? `Large (${productCount})` : productCount >= 100 ? `Medium (${productCount})` : `Small (${productCount})`,
      country: country || null,
      city: data.city || null,
      state: data.state || null,
      platform: data.platform || null,
      product_count: productCount,
      store_rank: data.rank || null,
      estimated_sales: estimatedSales,
      headquarters: [data.city, data.state, data.country].filter(Boolean).join(', ') || null,
      research_notes: JSON.stringify({ source: 'storeleads', ...data }),
    };
  } catch (e) {
    console.log(`StoreLeads miss for ${domain}:`, e.message);
    return null;
  }
}

// ═══ STEP 2: Try Apollo Org Enrichment ═══
async function tryApollo(domain) {
  try {
    const res = await fetch(`/.netlify/functions/apollo-enrich-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.organization) return null;

    const org = data.organization;
    const revenue = org.annual_revenue || 0;
    const employees = org.estimated_num_employees || 0;
    const industry = (org.industry || '').toLowerCase();
    const keywords = (org.keywords || []).join(' ').toLowerCase();

    const factors = [];
    const fitReason = [];
    if (revenue >= 12000000) { factors.push('revenue'); fitReason.push(`Revenue: $${(revenue / 1000000).toFixed(1)}M/yr`); }
    if (TARGET_CATEGORIES.some(c => (industry + ' ' + keywords).includes(c))) { factors.push('category'); fitReason.push(`Industry: ${org.industry}`); }
    if (employees >= 50) { factors.push('size'); fitReason.push(`Employees: ${employees}`); }

    const c = (org.country || '').toUpperCase();
    const isUSCA = ['US', 'CA', 'UNITED STATES', 'CANADA'].some(x => c.includes(x));
    let icp_fit = factors.length >= 3 && isUSCA ? 'HIGH' : factors.length >= 2 ? 'MEDIUM' : 'LOW';

    return {
      source: 'apollo',
      icp_fit,
      fit_reason: fitReason.join('; '),
      industry: org.industry || null,
      country: org.country || null,
      city: org.city || null,
      state: org.state || null,
      headquarters: org.raw_address || null,
      estimated_sales: revenue || null,
      research_notes: JSON.stringify({ source: 'apollo', employees, revenue, industry: org.industry, keywords: org.keywords }),
    };
  } catch (e) {
    console.log(`Apollo miss for ${domain}:`, e.message);
    return null;
  }
}

// ═══ STEP 3: Fall back to Claude AI ═══
async function tryClaude(lead) {
  const icpContext = buildIcpContext();
  const response = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      useWebSearch: true,
      prompt: buildPrompt(lead.website),
      systemPrompt: SYSTEM_PROMPT + icpContext
    })
  });

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);

  const data = await response.json();
  let research = data.text || '';
  if (!research && data.content && Array.isArray(data.content)) {
    research = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  const parsed = {
    icp_fit: parseField(research, 'ICP Fit')?.toUpperCase() || null,
    industry: parseField(research, 'Industry'),
    catalog_size: parseField(research, 'Catalog Size'),
    sells_d2c: parseField(research, 'Sells D2C'),
    headquarters: parseField(research, 'Headquarters'),
    google_shopping: parseField(research, 'Google Shopping'),
    fit_reason: parseField(research, 'Fit Reason'),
    decision_makers: parseField(research, 'Decision Makers')?.replace(/[{}]/g, '').replace(/,/g, ';') || null,
    pain_points: parseField(research, 'Pain Points')?.replace(/[{}]/g, '').replace(/,/g, ';') || null,
  };

  return { source: 'claude', ...parsed, research_notes: research };
}

// ═══ WATERFALL ENRICH: StoreLeads → Apollo → Claude ═══
export const enrichLead = async (lead) => {
  const domain = lead.website.replace(/^www\./, '');
  let result = null;
  let source = '';

  // Step 1: StoreLeads (free, fast)
  result = await tryStoreLeads(domain);
  if (result) {
    source = 'storeleads';
    console.log(`✅ ${domain} enriched via StoreLeads → ${result.icp_fit}`);
  }

  // Step 2: Apollo (cheap, good company data)
  if (!result) {
    result = await tryApollo(domain);
    if (result) {
      source = 'apollo';
      console.log(`✅ ${domain} enriched via Apollo → ${result.icp_fit}`);
    }
  }

  // Step 3: Claude AI (expensive, most thorough)
  if (!result) {
    result = await tryClaude(lead);
    source = 'claude';
    console.log(`✅ ${domain} enriched via Claude AI → ${result.icp_fit}`);
  }

  // Save to Supabase
  const update = {
    research_notes: result.research_notes,
    icp_fit: result.icp_fit,
    industry: result.industry || null,
    catalog_size: result.catalog_size || null,
    sells_d2c: result.sells_d2c || null,
    headquarters: result.headquarters || null,
    google_shopping: result.google_shopping || null,
    fit_reason: result.fit_reason || null,
    decision_makers: result.decision_makers || null,
    pain_points: result.pain_points || null,
    country: result.country || null,
    city: result.city || null,
    state: result.state || null,
    platform: result.platform || null,
    product_count: result.product_count || null,
    store_rank: result.store_rank || null,
    estimated_sales: result.estimated_sales || null,
    status: 'enriched',
  };

  const { error } = await supabase.from('leads').update(update).eq('id', lead.id);
  if (error) throw error;

  await logActivity(
    'lead_enriched',
    lead.id,
    `Enriched ${lead.website} via ${source} — ICP: ${result.icp_fit || 'Unknown'} | ${result.industry || ''}`,
    'success'
  );

  return { ...lead, ...update };
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

    // Rate limit between calls
    if (i < leadIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  return results;
};
