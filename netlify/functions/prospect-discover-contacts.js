/**
 * prospect-discover-contacts.js — Discover contacts for qualified prospects.
 *
 * POST { org_id, prospect_id }           — discover contacts for a single prospect
 * POST { org_id, batch: true, limit: N } — discover contacts for up to N qualified prospects (default 10)
 *
 * Contact discovery flow:
 *   1. Check contact_database by matching website/email_domain
 *   2. If none found, call Apollo mixed_people search + bulk_match
 *   3. Insert discovered contacts into prospect_contacts (not the old contacts table)
 *
 * Returns { processed, contacts_found, errors }
 */
const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');
const { classifyApolloStatus } = require('./lib/apollo-verify');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

const TITLES = [
  'VP Marketing', 'Head of Marketing', 'Director of Marketing',
  'VP Ecommerce', 'Head of Ecommerce', 'Director of Ecommerce',
  'VP Digital', 'Head of Digital', 'Head of Growth',
  'CMO', 'Chief Marketing Officer',
  'VP Brand', 'Director of Brand', 'Head of Brand',
  'Director of Partnerships', 'Head of Partnerships',
  'Director of Content', 'Head of Content',
  'CEO', 'Founder', 'Co-Founder', 'President',
];

/**
 * Score a contact title using the same logic as contactService.js.
 * Returns { match_score, match_level, match_reason }.
 */
function scoreTitle(title) {
  const t = (title || '').toLowerCase();

  if (t.match(/\b(cmo|chief marketing|vp market|head of market|director.*market|svp.*market)\b/)) {
    return { match_score: 100, match_level: 'Best Match', match_reason: 'Marketing Leader' };
  }
  if (t.match(/\b(creator|influencer|ugc|partnership|affiliate|social media|community)\b/)) {
    return { match_score: 95, match_level: 'Best Match', match_reason: 'Creator/Social' };
  }
  if (t.match(/\b(ecommerce|e-commerce|digital|growth|head of growth|vp.*digital|director.*digital|director.*ecommerce)\b/)) {
    return { match_score: 90, match_level: 'Great Match', match_reason: 'Digital/Ecommerce' };
  }
  if (t.match(/\b(brand|content|communications|pr|public relations)\b/)) {
    return { match_score: 70, match_level: 'Good Match', match_reason: 'Brand/Content' };
  }
  if (t.match(/\b(ceo|coo|founder|co-founder|president|owner|general manager)\b/)) {
    return { match_score: 60, match_level: 'Good Match', match_reason: 'Executive' };
  }
  if (t.match(/\b(manager|coordinator|specialist|analyst|associate)\b/)) {
    return { match_score: 30, match_level: 'Possible Match', match_reason: 'Mid-Level' };
  }
  return { match_score: 10, match_level: 'Possible Match', match_reason: 'Other' };
}

/**
 * Discover contacts for a single prospect.
 * 1. Check contact_database by domain
 * 2. If none, call Apollo
 * 3. Insert into prospect_contacts
 */
async function discoverContactsForProspect(prospect, orgId) {
  const website = prospect.website;
  const cleanDomain = website.toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '');
  console.log(`🔍 Discovering contacts for ${cleanDomain} (prospect ${prospect.id})`);

  // Check if prospect already has contacts
  const { count: existingCount } = await supabase
    .from('prospect_contacts')
    .select('*', { count: 'exact', head: true })
    .eq('prospect_id', prospect.id)
    .eq('org_id', orgId);

  if (existingCount > 0) {
    console.log(`  ⏭️ Already has ${existingCount} contacts, skipping`);
    return { success: true, prospectId: prospect.id, contacts_found: existingCount, skipped: true };
  }

  let contacts = [];

  // Step 1: Check contact_database for existing contacts
  const { data: dbContacts } = await supabase
    .from('contact_database')
    .select('*')
    .eq('org_id', orgId)
    .or(`website.eq.${cleanDomain},website.eq.www.${cleanDomain},email_domain.eq.${cleanDomain}`)
    .limit(50);

  if (dbContacts && dbContacts.length > 0) {
    console.log(`  📋 Found ${dbContacts.length} contacts in contact_database`);
    contacts = dbContacts.map(c => ({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      email: c.email,
      title: c.title || '',
      linkedin_url: c.linkedin_url || '',
      apollo_email_status: c.apollo_email_status || null,
      source: 'contact_database',
    }));
  }

  // Step 2: If no contacts in DB, try Apollo
  if (contacts.length === 0 && APOLLO_API_KEY) {
    console.log(`  📡 No contacts in database, trying Apollo...`);
    try {
      // Search for people at this company
      const searchRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
        body: JSON.stringify({
          q_organization_domains_list: [cleanDomain],
          person_titles: TITLES,
          per_page: 25,
        }),
      });

      if (!searchRes.ok) throw new Error(`Apollo search failed: ${searchRes.status}`);
      const searchData = await searchRes.json();
      const people = (searchData.people || []).filter(p => p.has_email);

      if (people.length > 0) {
        // Enrich top 3 to get actual emails
        const top3 = people.slice(0, 3);
        const enrichRes = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
          body: JSON.stringify({ details: top3.map(p => ({ id: p.id })) }),
        });

        if (!enrichRes.ok) throw new Error(`Apollo enrich failed: ${enrichRes.status}`);
        const enrichData = await enrichRes.json();

        for (const m of (enrichData.matches || [])) {
          if (!m.email) continue;
          const emailStatus = (m.email_status || 'unavailable').toLowerCase();
          const action = classifyApolloStatus(emailStatus);

          if (action === 'discard') {
            console.log(`  🗑️ Discarding invalid: ${m.email} (${emailStatus})`);
            continue;
          }

          contacts.push({
            first_name: m.first_name || '',
            last_name: m.last_name || '',
            email: m.email.toLowerCase(),
            title: m.title || '',
            linkedin_url: m.linkedin_url || '',
            apollo_email_status: emailStatus,
            source: 'apollo',
          });
        }
        console.log(`  ✅ Apollo found ${contacts.length} usable contacts`);
      } else {
        console.log(`  ⚠️ Apollo found no people with email for ${cleanDomain}`);
      }
    } catch (err) {
      console.error(`  Apollo discovery error for ${cleanDomain}:`, err.message);
      return { success: false, prospectId: prospect.id, error: err.message };
    }
  }

  if (contacts.length === 0) {
    console.log(`  ⚠️ No contacts found for ${cleanDomain}`);
    return { success: true, prospectId: prospect.id, contacts_found: 0 };
  }

  // Step 3: Insert into prospect_contacts
  let inserted = 0;
  for (const c of contacts) {
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown';
    const scoring = scoreTitle(c.title);

    const { error } = await supabase
      .from('prospect_contacts')
      .upsert({
        org_id: orgId,
        prospect_id: prospect.id,
        first_name: c.first_name,
        last_name: c.last_name,
        full_name: fullName,
        email: c.email,
        title: c.title,
        company_name: prospect.company_name || cleanDomain,
        company_website: cleanDomain,
        match_score: scoring.match_score,
        match_level: scoring.match_level,
        match_reason: scoring.match_reason,
        linkedin_url: c.linkedin_url || null,
        apollo_email_status: c.apollo_email_status || null,
        apollo_verified_at: c.apollo_email_status ? new Date().toISOString() : null,
        source: c.source || 'apollo',
      }, { onConflict: 'prospect_id,email' });

    if (error) {
      console.error(`  ⚠️ Insert error for ${c.email}:`, error.message);
    } else {
      inserted++;
    }
  }

  console.log(`  ✅ Inserted ${inserted} contacts for ${cleanDomain}`);
  return { success: true, prospectId: prospect.id, contacts_found: inserted };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'];

    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    let prospects = [];

    if (body.batch) {
      // Batch mode: qualified prospects without contacts
      const limit = Math.min(body.limit || 10, 50);

      // Get qualified prospects
      const { data: qualifiedProspects, error } = await supabase
        .from('prospects')
        .select('id, website, company_name')
        .eq('org_id', orgId)
        .in('status', ['qualified', 'contacted'])
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Filter to those without contacts
      for (const p of (qualifiedProspects || [])) {
        const { count } = await supabase
          .from('prospect_contacts')
          .select('*', { count: 'exact', head: true })
          .eq('prospect_id', p.id);

        if (count === 0) prospects.push(p);
        if (prospects.length >= limit) break;
      }
    } else if (body.prospect_id) {
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
      return { statusCode: 200, headers, body: JSON.stringify({ processed: 0, contacts_found: 0, errors: [], message: 'No prospects need contact discovery' }) };
    }

    console.log(`🚀 Discovering contacts for ${prospects.length} prospects`);

    let processed = 0;
    let totalContacts = 0;
    const errors = [];

    for (const prospect of prospects) {
      const result = await discoverContactsForProspect(prospect, orgId);
      if (result.success) {
        processed++;
        totalContacts += result.contacts_found || 0;
      } else {
        errors.push({ prospect_id: result.prospectId, error: result.error });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'prospect_contact_discovery',
      summary: `Contact discovery: ${totalContacts} contacts found for ${processed} prospects, ${errors.length} errors`,
      status: errors.length === 0 ? 'success' : (processed > 0 ? 'partial' : 'failed'),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ processed, contacts_found: totalContacts, errors }),
    };

  } catch (error) {
    console.error('💥 prospect-discover-contacts error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
