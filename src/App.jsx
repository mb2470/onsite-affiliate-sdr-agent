import { supabase } from '../supabaseClient';

// Get total lead count
export const getTotalLeadCount = async () => {
  const { count, error } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
};

// Search leads with server-side filtering and pagination
export const searchLeads = async ({
  search = '',
  status = 'all',
  icp = 'all',
  country = 'all',
  enrichedOnly = false,
  unenrichedOnly = false,
  page = 0,
  pageSize = 100
}) => {
  let query = supabase
    .from('leads')
    .select('*', { count: 'exact' });

  // Text search
  if (search && search.trim()) {
    query = query.or(
      `website.ilike.%${search.trim()}%,research_notes.ilike.%${search.trim()}%,industry.ilike.%${search.trim()}%`
    );
  }

  // Status filter
  if (unenrichedOnly) {
    query = query.neq('status', 'enriched').neq('status', 'contacted');
  } else if (enrichedOnly) {
    query = query.in('status', ['enriched', 'contacted']);
  } else if (status !== 'all') {
    query = query.eq('status', status);
  }

  // ICP filter
  if (icp !== 'all') {
    query = query.eq('icp_fit', icp);
  }

  // Country filter
  if (country !== 'all') {
    if (country === 'US/CA') {
      query = query.in('country', ['US (assumed)', 'US', 'Canada']);
    } else if (country === 'International') {
      query = query.not('country', 'in', '("US (assumed)","US","Canada","Unknown")');
      query = query.not('country', 'is', null);
    } else if (country === 'Unknown') {
      query = query.or('country.is.null,country.eq.Unknown');
    } else {
      query = query.eq('country', country);
    }
  }

  // Pagination
  const from = page * pageSize;
  const to = from + pageSize - 1;

  query = query
    .order('created_at', { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  return { leads: data || [], totalCount: count || 0 };
};

// Load enriched leads for manual outreach (with ICP sort)
export const searchEnrichedLeads = async ({ search = '', page = 0, pageSize = 50 }) => {
  let query = supabase
    .from('leads')
    .select('*', { count: 'exact' })
    .in('status', ['enriched', 'contacted']);

  if (search && search.trim()) {
    query = query.or(
      `website.ilike.%${search.trim()}%,research_notes.ilike.%${search.trim()}%,industry.ilike.%${search.trim()}%`
    );
  }

  const from = page * pageSize;
  const to = from + pageSize - 1;

  query = query
    .order('icp_fit', { ascending: true })
    .order('created_at', { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  return { leads: data || [], totalCount: count || 0 };
};

// Update lead status to contacted and record date
export const markLeadContacted = async (leadId) => {
  const { error } = await supabase
    .from('leads')
    .update({
      status: 'contacted',
      updated_at: new Date().toISOString()
    })
    .eq('id', leadId);

  if (error) throw error;
};

// Add single lead
export const addLead = async (website) => {
  const { data, error } = await supabase
    .from('leads')
    .insert([{ website: website.trim(), source: 'manual', status: 'new' }])
    .select();
  
  if (error) {
    if (error.code === '23505') throw new Error('This website already exists!');
    throw error;
  }
  return data;
};

// Bulk add leads (deduplicating)
export const bulkAddLeads = async (websites, source = 'bulk_add') => {
  const { data: existing } = await supabase
    .from('leads')
    .select('website')
    .in('website', websites);

  const existingSet = new Set(existing?.map(l => l.website) || []);
  const newWebsites = websites
    .filter(w => !existingSet.has(w))
    .map(w => ({ website: w, source, status: 'new' }));

  if (newWebsites.length === 0) return { added: 0, skipped: websites.length };

  const { error } = await supabase.from('leads').insert(newWebsites);
  if (error) throw error;

  return { added: newWebsites.length, skipped: websites.length - newWebsites.length };
};

// Log activity
export const logActivity = async (type, leadId, summary, status = 'success') => {
  await supabase.from('activity_log').insert({
    activity_type: type,
    lead_id: leadId,
    summary,
    status
  });
};
