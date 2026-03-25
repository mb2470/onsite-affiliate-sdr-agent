import { supabase } from '../supabaseClient';
import { resolveOrgId } from './orgService';

const VALID_STATUSES = ['new', 'enriching', 'enriched', 'qualified', 'contacted', 'engaged', 'disqualified'];

/**
 * Fetch a paginated list of prospects with optional filters.
 * @param {string} orgId - Organization ID (resolved automatically if null)
 * @param {Object} filters
 * @param {string|string[]} [filters.status] - Filter by status (single or array)
 * @param {string} [filters.industry_primary] - Filter by primary industry
 * @param {string} [filters.business_model] - Filter by business model
 * @param {string} [filters.target_market] - Filter by target market
 * @param {string} [filters.employee_range] - Filter by employee range
 * @param {number} [filters.min_confidence] - Minimum confidence_score (0–1)
 * @param {string} [filters.search] - Text search on company_name, website, keywords
 * @param {string} [filters.orderBy='created_at'] - Column to order by
 * @param {boolean} [filters.ascending=false] - Sort direction
 * @param {number} [filters.limit=50] - Page size
 * @param {number} [filters.offset=0] - Offset for pagination
 * @returns {Promise<{prospects: Object[], totalCount: number}>}
 */
export const getProspects = async (orgId, filters = {}) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const {
    status,
    industry_primary,
    business_model,
    target_market,
    employee_range,
    min_confidence,
    search,
    orderBy = 'created_at',
    ascending = false,
    limit = 50,
    offset = 0,
  } = filters;

  let query = supabase
    .from('prospects')
    .select('*', { count: 'exact' })
    .eq('org_id', scopedOrgId);

  // Status filter — supports single string or array
  if (status) {
    if (Array.isArray(status)) {
      query = query.in('status', status);
    } else {
      query = query.eq('status', status);
    }
  }

  if (industry_primary) query = query.eq('industry_primary', industry_primary);
  if (business_model) query = query.eq('business_model', business_model);
  if (target_market) query = query.eq('target_market', target_market);
  if (employee_range) query = query.eq('employee_range', employee_range);
  if (min_confidence != null) query = query.gte('confidence_score', min_confidence);

  // Text search across company_name, website, and keywords (array cast to text)
  if (search && search.trim()) {
    const term = search.trim();
    query = query.or(
      `company_name.ilike.%${term}%,website.ilike.%${term}%,keywords.cs.{${term}}`
    );
  }

  query = query
    .order(orderBy, { ascending })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  return { prospects: data || [], totalCount: count || 0 };
};

/**
 * Fetch a single prospect by ID.
 * @param {string} orgId - Organization ID
 * @param {string} prospectId - Prospect UUID
 * @returns {Promise<Object>} The prospect row
 */
export const getProspect = async (orgId, prospectId) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('org_id', scopedOrgId)
    .eq('id', prospectId)
    .single();

  if (error) throw error;
  return data;
};

/**
 * Fetch a prospect with its related contacts, crawls, and search signals.
 * @param {string} orgId - Organization ID
 * @param {string} prospectId - Prospect UUID
 * @returns {Promise<{prospect: Object, contacts: Object[], crawls: Object[], signals: Object[]}>}
 */
export const getProspectWithRelations = async (orgId, prospectId) => {
  const scopedOrgId = await resolveOrgId(orgId);

  const [prospectRes, contactsRes, crawlsRes, signalsRes] = await Promise.all([
    supabase
      .from('prospects')
      .select('*')
      .eq('org_id', scopedOrgId)
      .eq('id', prospectId)
      .single(),
    supabase
      .from('prospect_contacts')
      .select('*')
      .eq('org_id', scopedOrgId)
      .eq('prospect_id', prospectId)
      .order('match_score', { ascending: false }),
    supabase
      .from('company_crawls')
      .select('*')
      .eq('prospect_id', prospectId)
      .order('crawled_at', { ascending: false }),
    supabase
      .from('search_signals')
      .select('*')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  if (prospectRes.error) throw prospectRes.error;

  return {
    prospect: prospectRes.data,
    contacts: contactsRes.data || [],
    crawls: crawlsRes.data || [],
    signals: signalsRes.data || [],
  };
};

/**
 * Fetch prospects ready for outreach: status='qualified' with high confidence.
 * Ordered by revenue_annual DESC so highest-value prospects come first.
 * @param {string} orgId - Organization ID
 * @param {number} [minConfidence=0.7] - Minimum confidence_score threshold
 * @param {number} [limit=50] - Max rows to return
 * @returns {Promise<Object[]>}
 */
export const getQualifiedProspects = async (orgId, minConfidence = 0.7, limit = 50) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('org_id', scopedOrgId)
    .eq('status', 'qualified')
    .gte('confidence_score', minConfidence)
    .order('revenue_annual', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
};

/**
 * Fetch stale prospects: enriched more than 90 days ago OR low confidence.
 * Useful for identifying prospects that need re-enrichment.
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object[]>}
 */
export const getStaleProspects = async (orgId) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('org_id', scopedOrgId)
    .or(`last_enriched_at.lt.${ninetyDaysAgo},confidence_score.lt.0.5`)
    .order('last_enriched_at', { ascending: true, nullsFirst: true });

  if (error) throw error;
  return data || [];
};

/**
 * Update a prospect's pipeline status with validation.
 * @param {string} orgId - Organization ID
 * @param {string} prospectId - Prospect UUID
 * @param {string} status - New status (must be a valid prospect status)
 * @returns {Promise<Object>} The updated prospect row
 */
export const updateProspectStatus = async (orgId, prospectId, status) => {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const scopedOrgId = await resolveOrgId(orgId);
  const { data, error } = await supabase
    .from('prospects')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('org_id', scopedOrgId)
    .eq('id', prospectId)
    .select()
    .single();

  if (error) throw error;
  return data;
};

/**
 * Fetch contacts for a specific prospect, ordered by match_score DESC.
 * @param {string} orgId - Organization ID
 * @param {string} prospectId - Prospect UUID
 * @returns {Promise<Object[]>}
 */
export const getProspectContacts = async (orgId, prospectId) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const { data, error } = await supabase
    .from('prospect_contacts')
    .select('*')
    .eq('org_id', scopedOrgId)
    .eq('prospect_id', prospectId)
    .order('match_score', { ascending: false });

  if (error) throw error;
  return data || [];
};

/**
 * Get crawl coverage stats: each prospect with its crawl page count.
 * Under-crawled prospects have fewer than 3 crawled pages.
 * @param {string} orgId - Organization ID
 * @returns {Promise<{prospects: Object[], underCrawledCount: number}>}
 */
export const getCrawlCoverage = async (orgId) => {
  const scopedOrgId = await resolveOrgId(orgId);

  // Fetch prospects with their crawl counts via a left join
  const { data, error } = await supabase
    .from('prospects')
    .select('id, company_name, website, status, company_crawls(count)')
    .eq('org_id', scopedOrgId);

  if (error) throw error;

  const prospects = (data || []).map((p) => ({
    id: p.id,
    company_name: p.company_name,
    website: p.website,
    status: p.status,
    crawl_count: p.company_crawls?.[0]?.count ?? 0,
  }));

  const underCrawledCount = prospects.filter((p) => p.crawl_count < 3).length;

  return { prospects, underCrawledCount };
};

/**
 * Dashboard stats: totals by status, average confidence, counts by industry and business_model.
 * Uses head:true count queries per CLAUDE.md standards to avoid pulling full rows.
 * @param {string} orgId - Organization ID
 * @returns {Promise<{byStatus: Object, avgConfidence: number|null, byIndustry: Object[], byBusinessModel: Object[]}>}
 */
export const getProspectStats = async (orgId) => {
  const scopedOrgId = await resolveOrgId(orgId);

  // Count by status — individual queries for accuracy (default limit is 1000)
  const statusCounts = {};
  const statusQueries = VALID_STATUSES.map(async (s) => {
    const { count, error } = await supabase
      .from('prospects')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', scopedOrgId)
      .eq('status', s);
    if (error) throw error;
    statusCounts[s] = count || 0;
  });

  // Average confidence — fetch only the column, compute client-side
  const confidenceQuery = supabase
    .from('prospects')
    .select('confidence_score')
    .eq('org_id', scopedOrgId)
    .not('confidence_score', 'is', null);

  // Industry breakdown
  const industryQuery = supabase
    .from('prospects')
    .select('industry_primary')
    .eq('org_id', scopedOrgId)
    .not('industry_primary', 'is', null);

  // Business model breakdown
  const businessModelQuery = supabase
    .from('prospects')
    .select('business_model')
    .eq('org_id', scopedOrgId)
    .not('business_model', 'is', null);

  const [, confRes, indRes, bmRes] = await Promise.all([
    Promise.all(statusQueries),
    confidenceQuery,
    industryQuery,
    businessModelQuery,
  ]);

  if (confRes.error) throw confRes.error;
  if (indRes.error) throw indRes.error;
  if (bmRes.error) throw bmRes.error;

  // Compute average confidence client-side
  const scores = (confRes.data || []).map((r) => r.confidence_score);
  const avgConfidence = scores.length
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : null;

  // Aggregate industry counts
  const industryCounts = {};
  (indRes.data || []).forEach((r) => {
    industryCounts[r.industry_primary] = (industryCounts[r.industry_primary] || 0) + 1;
  });
  const byIndustry = Object.entries(industryCounts)
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count);

  // Aggregate business model counts
  const bmCounts = {};
  (bmRes.data || []).forEach((r) => {
    bmCounts[r.business_model] = (bmCounts[r.business_model] || 0) + 1;
  });
  const byBusinessModel = Object.entries(bmCounts)
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);

  return {
    byStatus: statusCounts,
    avgConfidence,
    byIndustry,
    byBusinessModel,
  };
};

/**
 * Semantic similarity search over prospect embeddings using pgvector.
 * Calls a Supabase RPC function (to be created separately) that performs
 * cosine similarity search against the prospect_embeddings table.
 * @param {string} orgId - Organization ID
 * @param {number[]} queryEmbedding - Query vector (must match embedding dimensions)
 * @param {number} [threshold=0.75] - Minimum similarity score (0–1)
 * @param {number} [limit=20] - Max results
 * @returns {Promise<Object[]>} Matching prospects with similarity scores
 */
export const searchProspectsSemantic = async (orgId, queryEmbedding, threshold = 0.75, limit = 20) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const { data, error } = await supabase.rpc('match_prospects', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
    filter_org_id: scopedOrgId,
  });

  if (error) throw error;
  return data || [];
};
