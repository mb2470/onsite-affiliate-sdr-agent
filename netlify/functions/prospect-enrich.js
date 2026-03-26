/**
 * prospect-enrich.js — Gold Enrichment: Apollo contact discovery for high-ICP prospects.
 *
 * Only processes prospects with enrichment_status = 'ready_for_gold' (set by prospect-score).
 * Finds buyer contacts (names, emails, phones) via Apollo People Search,
 * inserts into prospect_contacts, and marks the prospect as gold_enriched.
 *
 * POST { org_id, prospect_id }          — gold-enrich a single prospect
 * POST { org_id, batch: true, limit: N } — gold-enrich up to N ready prospects (default 10)
 *
 * Returns { enriched, contacts_found, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

// Default buyer persona titles — can be overridden by ICP profile
const DEFAULT_TITLES = [
  'VP Marketing', 'Head of Marketing', 'Director of Marketing',
  'VP Ecommerce', 'Head of Ecommerce', 'Director of Ecommerce',
  'VP Digital', 'Head of Digital', 'Head of Growth',
  'CMO', 'Chief Marketing Officer',
  'VP Brand', 'Director of Brand', 'Head of Brand',
  'Director of Partnerships', 'Head of Partnerships',
  'CEO', 'Founder', 'Co-Founder', 'President',
];

/**
 * Get buyer persona titles from the org's ICP profile or use defaults.
 */
async function getBuyerTitles(orgId) {
  const { data } = await supabase
    .from('icp_profiles')
    .select('primary_titles')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (data && data.primary_titles && data.primary_titles.length > 0) {
    return data.primary_titles;
  }
  return DEFAULT_TITLES;
}

/**
 * Search Apollo for people at a given domain matching buyer persona titles.
 */
async function apolloPeopleSearch(domain, titles) {
  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
    body: JSON.stringify({
      q_organization_domains: domain,
      person_titles: titles,
      page: 1,
      per_page: 10,
    }),
  });

  if (!res.ok) {
    throw new Error(`Apollo People Search failed: ${res.status}`);
  }

  const data = await res.json();
  return data.people || [];
}

/**
 * Also call Apollo org enrich to get company-level data
 * and merge with existing crawl data.
 */
async function apolloOrgEnrich(domain) {
  try {
    const res = await fetch('https://api.apollo.io/api/v1/organizations/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({ domain }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.organization || null;
  } catch {
    return null;
  }
}

/**
 * Score a contact based on their title for buyer persona fit.
 */
function scoreContactTitle(title, buyerTitles) {
  if (!title) return { score: 0, level: 'Possible Match' };
  const t = title.toLowerCase();

  // C-suite
  if (/\b(cmo|ceo|cto|coo|cfo|chief)\b/.test(t)) return { score: 95, level: 'Best Match' };
  // VP level
  if (/\b(vp|vice president)\b/.test(t)) return { score: 85, level: 'Great Match' };
  // Director/Head
  if (/\b(director|head of)\b/.test(t)) return { score: 75, level: 'Great Match' };
  // Manager with relevant function
  if (/\b(manager|lead)\b/.test(t) && /\b(marketing|ecommerce|digital|growth|brand)\b/.test(t)) return { score: 60, level: 'Good Match' };
  // Founder
  if (/\b(founder|owner|president)\b/.test(t)) return { score: 90, level: 'Best Match' };

  return { score: 30, level: 'Possible Match' };
}

/**
 * Gold-enrich a single prospect:
 * 1. Apollo org enrich (merge firmographic data)
 * 2. Apollo people search (find buyer contacts)
 * 3. Insert contacts into prospect_contacts
 * 4. Mark prospect as gold_enriched
 */
async function goldEnrichProspect(prospect, orgId, buyerTitles) {
  const prospectId = prospect.id;
  const website = prospect.website;
  console.log(`Gold enriching ${website} (${prospectId})`);

  // Step 1: Apollo org enrich — fill in any gaps from crawl
  const apolloOrg = await apolloOrgEnrich(website);
  const orgUpdates = {};

  if (apolloOrg) {
    if (!prospect.employee_actual && apolloOrg.estimated_num_employees) {
      orgUpdates.employee_actual = apolloOrg.estimated_num_employees;
      const emp = apolloOrg.estimated_num_employees;
      if (emp <= 10) orgUpdates.employee_range = '1-10';
      else if (emp <= 50) orgUpdates.employee_range = '11-50';
      else if (emp <= 200) orgUpdates.employee_range = '51-200';
      else if (emp <= 500) orgUpdates.employee_range = '201-500';
      else if (emp <= 1000) orgUpdates.employee_range = '501-1000';
      else if (emp <= 5000) orgUpdates.employee_range = '1001-5000';
      else orgUpdates.employee_range = '5001+';
    }
    if (!prospect.revenue_annual && apolloOrg.annual_revenue) orgUpdates.revenue_annual = apolloOrg.annual_revenue;
    if (!prospect.hq_city && apolloOrg.city) orgUpdates.hq_city = apolloOrg.city;
    if (!prospect.hq_country && apolloOrg.country) orgUpdates.hq_country = apolloOrg.country.slice(0, 2).toUpperCase();
    if (!prospect.linkedin_url && apolloOrg.linkedin_url) orgUpdates.linkedin_url = apolloOrg.linkedin_url;
    if (apolloOrg.technology_names && apolloOrg.technology_names.length > 0) orgUpdates.technographics = apolloOrg.technology_names;
  }

  // Step 2: Apollo people search — find buyer contacts
  let contacts = [];
  try {
    contacts = await apolloPeopleSearch(website, buyerTitles);
  } catch (err) {
    console.error(`  Apollo People Search error for ${website}:`, err.message);
  }

  // Step 3: Insert contacts
  let contactsInserted = 0;
  for (const person of contacts) {
    if (!person.email) continue;

    const { score, level } = scoreContactTitle(person.title, buyerTitles);

    const { error } = await supabase
      .from('prospect_contacts')
      .upsert({
        prospect_id: prospectId,
        org_id: orgId,
        first_name: person.first_name || null,
        last_name: person.last_name || null,
        full_name: [person.first_name, person.last_name].filter(Boolean).join(' ') || person.name || 'Unknown',
        email: person.email,
        title: person.title || null,
        phone: person.phone_numbers?.[0]?.sanitized_number || null,
        linkedin_url: person.linkedin_url || null,
        match_score: score,
        match_level: level,
        source: 'apollo',
        apollo_email_status: person.email_status || null,
        apollo_verified_at: new Date().toISOString(),
      }, { onConflict: 'prospect_id,email' });

    if (!error) contactsInserted++;
  }

  // Step 4: Update prospect
  const prospectUpdate = {
    ...orgUpdates,
    enrichment_status: 'gold_enriched',
    enrichment_source: 'apollo',
    status: 'qualified',
    last_enriched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_metadata: {
      ...(prospect.source_metadata || {}),
      apollo_org: apolloOrg ? { name: apolloOrg.name, industry: apolloOrg.industry, employees: apolloOrg.estimated_num_employees } : null,
      apollo_contacts_found: contacts.length,
      apollo_enriched_at: new Date().toISOString(),
    },
  };

  const { error: updateError } = await supabase
    .from('prospects')
    .update(prospectUpdate)
    .eq('id', prospectId)
    .eq('org_id', orgId);

  if (updateError) {
    console.error(`  Prospect update error for ${website}:`, updateError.message);
    return { success: false, prospectId, error: updateError.message, contactsFound: 0 };
  }

  console.log(`  Gold enriched ${website}: ${contactsInserted} contacts inserted`);
  return { success: true, prospectId, contactsFound: contactsInserted };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };
    if (!APOLLO_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'APOLLO_API_KEY not configured' }) };

    // Get buyer titles from ICP profile
    const buyerTitles = await getBuyerTitles(orgId);

    let prospects = [];

    if (body.batch) {
      const limit = Math.min(body.limit || 10, 25);
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, employee_actual, employee_range, revenue_annual, hq_city, hq_country, linkedin_url, technographics, source_metadata')
        .eq('org_id', orgId)
        .eq('enrichment_status', 'ready_for_gold')
        .order('icp_fit_score', { ascending: false, nullsFirst: false })
        .limit(limit);

      if (error) throw error;
      prospects = data || [];
    } else if (body.prospect_id) {
      const { data, error } = await supabase
        .from('prospects')
        .select('id, website, company_name, employee_actual, employee_range, revenue_annual, hq_city, hq_country, linkedin_url, technographics, source_metadata')
        .eq('org_id', orgId)
        .eq('id', body.prospect_id)
        .single();

      if (error) throw error;
      if (data) prospects = [data];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide prospect_id or batch: true' }) };
    }

    if (prospects.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ enriched: 0, contacts_found: 0, errors: [], message: 'No prospects ready for gold enrichment' }) };
    }

    console.log(`Gold enriching ${prospects.length} prospects`);

    let enriched = 0;
    let totalContacts = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await goldEnrichProspect(prospect, orgId, buyerTitles);
      if (result.success) {
        enriched++;
        totalContacts += result.contactsFound;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_gold_enrich',
      summary: `Gold enrichment: ${enriched} prospects, ${totalContacts} contacts found, ${errors.length} errors`,
      status: errors.length === 0 ? 'success' : (enriched > 0 ? 'partial' : 'failed'),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ enriched, contacts_found: totalContacts, errors }),
    };

  } catch (error) {
    console.error('prospect-enrich error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
