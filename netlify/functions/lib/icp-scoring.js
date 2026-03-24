/**
 * Shared ICP scoring configuration & logic.
 * All Netlify functions import from here so scoring thresholds
 * are driven by the active ICP profile in the database.
 */

const DEFAULTS = {
  minProductCount: 250,
  minMonthlySalesCents: 100000000, // $1M in cents (StoreLeads uses cents)
  minAnnualRevenue: 12000000,      // $12M/year (Apollo)
  minEmployeeCount: 50,
  targetCategories: [
    'apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
    'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
    'electronics', 'computers', 'consumer electronics', 'phones', 'networking',
  ],
  targetGeography: ['US', 'CA'],
};

/**
 * Fetch the active ICP profile's scoring config from Supabase.
 * Returns a config object with thresholds + target categories/geography.
 */
async function getIcpScoringConfig(supabase, orgId) {
  try {
    const { data, error } = await supabase
      .from('icp_profiles')
      .select('min_product_count, min_monthly_sales, min_annual_revenue, min_employee_count, industries, geography')
      .eq('is_active', true)
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      console.log(`ICP profile not found for org ${orgId}, skipping scoring`);
      return null;
    }

    // Build target categories from ICP industries
    let targetCategories = DEFAULTS.targetCategories;
    if (data.industries && data.industries.length > 0) {
      const keywords = [];
      for (const industry of data.industries) {
        const parts = industry.toLowerCase().split(/[&,/]+/).map(s => s.trim()).filter(Boolean);
        keywords.push(...parts);
      }
      if (keywords.length > 0) targetCategories = keywords;
    }

    // Build target geography from ICP geography
    let targetGeography = DEFAULTS.targetGeography;
    if (data.geography && data.geography.length > 0) {
      const geoKeywords = [];
      for (const geo of data.geography) {
        const g = geo.toUpperCase();
        geoKeywords.push(g);
        if (g.includes('NORTH AMERICA')) geoKeywords.push('US', 'CA', 'UNITED STATES', 'CANADA');
        if (g.includes('EMEA')) geoKeywords.push('UK', 'UNITED KINGDOM', 'GERMANY', 'FRANCE', 'SPAIN', 'ITALY', 'NETHERLANDS');
        if (g.includes('GLOBAL')) return buildConfig(data, targetCategories, null);
      }
      if (geoKeywords.length > 0) targetGeography = geoKeywords;
    }

    return buildConfig(data, targetCategories, targetGeography);
  } catch (e) {
    console.error('Error fetching ICP scoring config:', e.message);
    return null;
  }
}

function buildConfig(data, targetCategories, targetGeography) {
  return {
    minProductCount: data.min_product_count ?? DEFAULTS.minProductCount,
    // Convert from dollars (stored in DB) to cents (StoreLeads format)
    minMonthlySalesCents: (data.min_monthly_sales ?? 1000000) * 100,
    minAnnualRevenue: data.min_annual_revenue ?? DEFAULTS.minAnnualRevenue,
    minEmployeeCount: data.min_employee_count ?? DEFAULTS.minEmployeeCount,
    targetCategories,
    targetGeography,
  };
}

/**
 * Score a lead from StoreLeads data using ICP config.
 */
function scoreStoreLeads(d, config) {
  const categories = (d.categories || []).map(c => c.toLowerCase());
  const productCount = d.product_count || 0;
  const estSales = d.estimated_sales || 0; // in cents
  const country = (d.country || '').toUpperCase();

  const isTarget = categories.some(c => config.targetCategories.some(t => c.includes(t))) ? 1 : 0;
  const hasLargeCatalog = productCount >= config.minProductCount ? 1 : 0;
  const hasGoodSales = estSales >= config.minMonthlySalesCents ? 1 : 0;

  const score = hasLargeCatalog + hasGoodSales + isTarget;

  // Geography check
  const isTargetGeo = config.targetGeography === null ||
    config.targetGeography.some(g => country.includes(g));

  if (isTargetGeo && score === 3) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Score a lead from Apollo org data using ICP config.
 */
function scoreApollo(org, country, config) {
  const factors = [];
  const fitReason = [];

  // Revenue factor
  const annualRevenue = org.annual_revenue || 0;
  if (annualRevenue >= config.minAnnualRevenue) {
    factors.push('revenue');
    fitReason.push(`Revenue: $${(annualRevenue / 1000000).toFixed(1)}M/yr`);
  }

  // Category factor
  const industry = (org.industry || '').toLowerCase();
  const keywords = (org.keywords || []).map(k => k.toLowerCase());
  const allText = [industry, ...keywords].join(' ');
  if (config.targetCategories.some(cat => allText.includes(cat))) {
    factors.push('category');
    fitReason.push(`Industry: ${org.industry || 'target category'}`);
  }

  // Size factor
  const employees = org.estimated_num_employees || 0;
  if (employees >= config.minEmployeeCount) {
    factors.push('size');
    fitReason.push(`Employees: ${employees}`);
  }

  // Geography check
  const orgCountry = (country || org.country || '').toUpperCase();
  const isTargetGeo = config.targetGeography === null ||
    config.targetGeography.some(g => orgCountry.includes(g)) ||
    ['US (ASSUMED)'].some(c => orgCountry.includes(c));

  const score = factors.length;
  let icp_fit;
  if (score >= 3 && isTargetGeo) icp_fit = 'HIGH';
  else if (score >= 2) icp_fit = 'MEDIUM';
  else icp_fit = 'LOW';

  return { icp_fit, fitReason: fitReason.join('; '), factors: score };
}

/**
 * Build a human-readable fit reason string for StoreLeads data.
 */
function buildStoreLeadsFitReason(d, config) {
  const productCount = d.product_count || 0;
  const estSales = d.estimated_sales || 0;
  const categories = d.categories || [];
  const salesFormatted = estSales ? `$${Math.round(estSales / 100).toLocaleString()}/mo` : 'Unknown';

  const cats = categories.map(c => c.toLowerCase());
  const isTarget = cats.some(c => config.targetCategories.some(t => c.includes(t)));

  const factors = [];
  factors.push(productCount >= config.minProductCount
    ? `✅ ${productCount} products`
    : `❌ ${productCount} products (<${config.minProductCount})`);
  factors.push(estSales >= config.minMonthlySalesCents
    ? `✅ ${salesFormatted} sales`
    : `❌ ${salesFormatted} sales`);
  factors.push(isTarget
    ? `✅ ${categories.join(', ')}`
    : `❌ ${categories.join(', ') || 'no target category'}`);

  return factors.join(' | ');
}

function catalogSizeLabel(count, minProductCount) {
  if (!count) return 'Unknown';
  const mid = Math.round(minProductCount * 0.4); // ~100 for default 250
  if (count < mid) return `Small (${count} products)`;
  if (count < minProductCount) return `Medium (${count} products)`;
  return `Large (${count} products)`;
}

/**
 * Check if StoreLeads data indicates a fast-track HIGH lead.
 * Technographic signals (Shopify Plus, enterprise plans, high-volume stores)
 * can skip expensive Claude research and go straight to HIGH.
 *
 * @param {Object} d - StoreLeads domain data (must include plan, platform, product_count, estimated_sales)
 * @returns {{ fastTrack: boolean, reason: string }}
 */
function checkFastTrack(d) {
  const plan = (d.plan || '').toLowerCase();
  const platform = (d.platform || '').toLowerCase();
  const productCount = d.product_count || 0;
  const estSales = d.estimated_sales || 0; // in cents

  // Shopify Plus or Enterprise plan — strong signal
  if (plan.includes('shopify plus') || plan.includes('enterprise')) {
    return { fastTrack: true, reason: `Fast-track: ${d.plan} plan` };
  }

  // High-volume Shopify store (500+ products AND $5k+/mo sales)
  if (platform.includes('shopify') && productCount >= 500 && estSales >= 50000000) {
    return { fastTrack: true, reason: `Fast-track: High-volume Shopify (${productCount} products, $${Math.round(estSales / 100).toLocaleString()}/mo)` };
  }

  return { fastTrack: false, reason: '' };
}

module.exports = {
  DEFAULTS,
  getIcpScoringConfig,
  scoreStoreLeads,
  scoreApollo,
  buildStoreLeadsFitReason,
  catalogSizeLabel,
  checkFastTrack,
};
