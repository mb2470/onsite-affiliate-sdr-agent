/**
 * Shared ICP scoring configuration & logic.
 * All Netlify functions import from here so scoring thresholds
 * are driven by the active ICP profile in the database.
 *
 * Scoring is based on crawl-extracted firmographics and Apollo data.
 */

const DEFAULTS = {
  minAnnualRevenue: 12000000,      // $12M/year
  minEmployeeCount: 50,
  targetCategories: [
    'apparel', 'fashion', 'clothing', 'shoes', 'footwear', 'accessories',
    'home & garden', 'home furnish', 'furniture', 'kitchen', 'decor', 'bed & bath', 'laundry',
    'outdoor', 'sporting', 'sports', 'recreation', 'fitness', 'travel',
    'electronics', 'computers', 'consumer electronics', 'phones', 'networking',
  ],
  targetGeography: ['US', 'CA'],
  minIcpScoreForGold: 60,
};

/**
 * Fetch the active ICP profile's scoring config from Supabase.
 * Returns a config object with thresholds + target categories/geography.
 */
async function getIcpScoringConfig(supabase, orgId) {
  try {
    const { data, error } = await supabase
      .from('icp_profiles')
      .select('min_annual_revenue, min_employee_count, industries, geography')
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
    minAnnualRevenue: data.min_annual_revenue ?? DEFAULTS.minAnnualRevenue,
    minEmployeeCount: data.min_employee_count ?? DEFAULTS.minEmployeeCount,
    targetCategories,
    targetGeography,
    minIcpScoreForGold: DEFAULTS.minIcpScoreForGold,
  };
}

/**
 * Score a prospect from crawl-extracted firmographic data.
 * Returns { icp_fit: 'HIGH'|'MEDIUM'|'LOW', score: number, fitReason: string }
 *
 * Scoring factors (0-100 scale):
 *   - Industry match (20 pts)
 *   - Business model is D2C/B2C (15 pts)
 *   - Geography match (15 pts)
 *   - Employee range suggests scale (15 pts)
 *   - Revenue estimate meets threshold (15 pts)
 *   - Has website contacts (email/phone) (5 pts)
 *   - Has social presence (5 pts)
 *   - Website quality / content richness (10 pts)
 */
function scoreCrawlData(prospect, config) {
  let score = 0;
  const reasons = [];

  // Industry match (20 pts)
  const industry = (prospect.industry_primary || prospect.industry || '').toLowerCase();
  const keywords = (prospect.keywords || []).map(k => k.toLowerCase());
  const allIndustryText = [industry, ...keywords].join(' ');
  if (config.targetCategories.some(cat => allIndustryText.includes(cat))) {
    score += 20;
    reasons.push(`Industry: ${prospect.industry_primary || prospect.industry}`);
  }

  // Business model (15 pts)
  const bm = (prospect.business_model || '').toUpperCase();
  if (['D2C', 'B2C'].includes(bm)) {
    score += 15;
    reasons.push(`Business model: ${bm}`);
  } else if (bm === 'MARKETPLACE' || bm === 'OTHER') {
    score += 5;
  }

  // Geography match (15 pts)
  const hqCountry = (prospect.hq_country || prospect.country || '').toUpperCase();
  const hqCity = (prospect.hq_city || prospect.city || '').toUpperCase();
  const geoText = `${hqCity} ${hqCountry}`;
  if (config.targetGeography === null) {
    score += 15; // Global = accept all
    reasons.push('Geography: Global target');
  } else if (config.targetGeography.some(g => geoText.includes(g))) {
    score += 15;
    reasons.push(`Geography: ${hqCity || hqCountry}`);
  }

  // Employee range (15 pts)
  const empRange = prospect.employee_range || '';
  const empActual = prospect.employee_actual || 0;
  const empCount = empActual || parseEmployeeRange(empRange);
  if (empCount >= config.minEmployeeCount) {
    score += 15;
    reasons.push(`Employees: ${empActual || empRange}`);
  } else if (empCount > 0) {
    score += Math.round((empCount / config.minEmployeeCount) * 10);
  }

  // Revenue (15 pts)
  const revenue = prospect.revenue_annual || parseRevenueEstimate(prospect.revenue_estimate);
  if (revenue >= config.minAnnualRevenue) {
    score += 15;
    reasons.push(`Revenue: $${(revenue / 1000000).toFixed(1)}M/yr`);
  } else if (revenue > 0) {
    score += Math.round((revenue / config.minAnnualRevenue) * 10);
  }

  // Has contact info (5 pts)
  if (prospect.email || prospect.phone) {
    score += 5;
  }

  // Social presence (5 pts)
  const socials = prospect.social_urls || {};
  const hasSocials = prospect.linkedin_url || socials.facebook || socials.linkedin || socials.instagram;
  if (hasSocials) {
    score += 5;
  }

  // Website quality (10 pts) — based on confidence score from crawl
  const confidence = prospect.confidence_score || 0;
  score += Math.round(confidence * 10);

  // Cap at 100
  score = Math.min(score, 100);

  // Map to ICP fit level
  let icp_fit;
  if (score >= 70) icp_fit = 'HIGH';
  else if (score >= 40) icp_fit = 'MEDIUM';
  else icp_fit = 'LOW';

  return {
    icp_fit,
    score,
    fitReason: reasons.length > 0 ? reasons.join(' | ') : 'Insufficient data',
    readyForGold: score >= config.minIcpScoreForGold,
  };
}

/**
 * Score a prospect from Apollo org data.
 */
function scoreApollo(org, country, config) {
  const factors = [];
  const fitReason = [];

  const annualRevenue = org.annual_revenue || 0;
  if (annualRevenue >= config.minAnnualRevenue) {
    factors.push('revenue');
    fitReason.push(`Revenue: $${(annualRevenue / 1000000).toFixed(1)}M/yr`);
  }

  const industry = (org.industry || '').toLowerCase();
  const keywords = (org.keywords || []).map(k => k.toLowerCase());
  const allText = [industry, ...keywords].join(' ');
  if (config.targetCategories.some(cat => allText.includes(cat))) {
    factors.push('category');
    fitReason.push(`Industry: ${org.industry || 'target category'}`);
  }

  const employees = org.estimated_num_employees || 0;
  if (employees >= config.minEmployeeCount) {
    factors.push('size');
    fitReason.push(`Employees: ${employees}`);
  }

  const orgCountry = (country || org.country || '').toUpperCase();
  const isTargetGeo = config.targetGeography === null ||
    config.targetGeography.some(g => orgCountry.includes(g));

  const score = factors.length;
  let icp_fit;
  if (score >= 3 && isTargetGeo) icp_fit = 'HIGH';
  else if (score >= 2) icp_fit = 'MEDIUM';
  else icp_fit = 'LOW';

  return { icp_fit, fitReason: fitReason.join('; '), factors: score };
}

// ── Helpers ──

function parseEmployeeRange(range) {
  if (!range) return 0;
  const match = range.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (match) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2);
  const single = range.match(/(\d+)\+?/);
  return single ? parseInt(single[1]) : 0;
}

function parseRevenueEstimate(estimate) {
  if (!estimate) return 0;
  const lower = estimate.toLowerCase();
  const match = lower.match(/\$?([\d.]+)\s*(m|b|k)?/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2];
  if (unit === 'b') return num * 1000000000;
  if (unit === 'm') return num * 1000000;
  if (unit === 'k') return num * 1000;
  return num;
}

module.exports = {
  DEFAULTS,
  getIcpScoringConfig,
  scoreCrawlData,
  scoreApollo,
  parseEmployeeRange,
  parseRevenueEstimate,
};
