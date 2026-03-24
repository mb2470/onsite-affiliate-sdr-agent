const { createClient } = require('@supabase/supabase-js');
const { classifyApolloStatus, backupTitlePivot } = require('./lib/apollo-verify');

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
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
 * Insert a contact into contact_database if it doesn't already exist.
 * Returns true if inserted, false if duplicate or error.
 */
async function insertContact(contact, orgId) {
  const { count } = await supabase
    .from('contact_database')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('email', contact.email);

  if (count > 0) return false;

  const { error } = await supabase
    .from('contact_database')
    .insert({
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      title: contact.title,
      linkedin_url: contact.linkedin_url,
      website: contact.website,
      account_name: contact.account_name,
      apollo_email_status: contact.apollo_email_status,
      apollo_verified_at: new Date().toISOString(),
      org_id: orgId,
    });

  if (error) {
    console.error(`  ⚠️ Insert error for ${contact.email}:`, error.message);
    return false;
  }
  return true;
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { domain, leadId, org_id } = JSON.parse(event.body || '{}');
    const orgId = org_id || event.headers['x-org-id'];
    if (!domain) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No domain provided' }) };
    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    const cleanDomain = domain.toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '');
    console.log(`🚀 Apollo contact search for: ${cleanDomain}`);

    // Step 1: Search for people at this company
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
    console.log(`Found ${searchData.people?.length || 0} people, ${people.length} with email`);

    if (people.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ domain: cleanDomain, contacts: [], creditsUsed: 1, message: 'No contacts with email found' }) };
    }

    // Step 2: Enrich top 3 to get actual emails + email_status
    const top3 = people.slice(0, 3);
    const enrichRes = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({ details: top3.map(p => ({ id: p.id })) }),
    });

    if (!enrichRes.ok) throw new Error(`Apollo enrich failed: ${enrichRes.status}`);
    const enrichData = await enrichRes.json();

    // Step 3: Triage by email_status (Opt 1 — verify during discovery)
    const contacts = [];
    const invalidContacts = [];
    const exhaustedTitles = [];

    for (const m of (enrichData.matches || [])) {
      if (!m.email) continue;

      const emailStatus = (m.email_status || 'unavailable').toLowerCase();
      const action = classifyApolloStatus(emailStatus);

      const contact = {
        first_name: m.first_name || '',
        last_name: m.last_name || '',
        email: m.email.toLowerCase(),
        title: m.title || '',
        linkedin_url: m.linkedin_url || '',
        website: cleanDomain,
        account_name: m.organization?.name || cleanDomain,
        apollo_email_status: emailStatus,
      };

      if (action === 'discard') {
        // Invalid — do NOT insert, track for title pivot
        console.log(`  🗑️ Discarding invalid: ${contact.email} (${emailStatus})`);
        invalidContacts.push(contact);
        if (contact.title) exhaustedTitles.push(contact.title);
      } else {
        // verified, extrapolated, catch_all, unavailable — insert with status
        console.log(`  ${action === 'send' ? '✅' : '⚠️'} ${contact.email} — ${emailStatus} (action: ${action})`);
        contacts.push(contact);
      }
    }

    // Step 4: Backup title pivot for invalid contacts (Opt 4)
    const pivotedContacts = [];
    if (invalidContacts.length > 0 && contacts.length === 0) {
      // Only pivot if we have NO usable contacts at all
      const pivoted = await backupTitlePivot(supabase, {
        domain: cleanDomain,
        exhaustedTitles,
        leadId,
      });

      if (pivoted && pivoted.email) {
        const pivotAction = classifyApolloStatus(pivoted.email_status);
        if (pivotAction !== 'discard') {
          const pivotContact = {
            first_name: pivoted.first_name,
            last_name: pivoted.last_name,
            email: pivoted.email,
            title: pivoted.title,
            linkedin_url: pivoted.linkedin_url || '',
            website: cleanDomain,
            account_name: pivoted.organization || cleanDomain,
            apollo_email_status: pivoted.email_status,
          };
          contacts.push(pivotContact);
          pivotedContacts.push(pivotContact);
          console.log(`  🔄 Pivoted to: ${pivotContact.email} (${pivotContact.title})`);
        }
      }
    }

    console.log(`✅ Triaged: ${contacts.length} usable, ${invalidContacts.length} invalid`);

    // Step 5: Write usable contacts to contact_database (skip duplicates)
    let added = 0;
    for (const contact of contacts) {
      if (await insertContact(contact, orgId)) {
        added++;
        console.log(`  + ${contact.first_name} ${contact.last_name} (${contact.email}) — ${contact.title} [${contact.apollo_email_status}]`);
      }
    }

    // Step 6: Update lead if leadId provided
    if (leadId && contacts.length > 0) {
      await supabase.from('leads').update({
        has_contacts: true,
        contact_name: `${contacts[0].first_name} ${contacts[0].last_name}`.trim(),
        contact_email: contacts[0].email,
      }).eq('id', leadId).eq('org_id', orgId);
    }

    // Log activity with triage details
    const triageSummary = [
      contacts.filter(c => c.apollo_email_status === 'verified').length > 0
        ? `${contacts.filter(c => c.apollo_email_status === 'verified').length} verified` : null,
      contacts.filter(c => ['extrapolated', 'catch_all', 'unavailable'].includes(c.apollo_email_status)).length > 0
        ? `${contacts.filter(c => ['extrapolated', 'catch_all', 'unavailable'].includes(c.apollo_email_status)).length} need ELV` : null,
      invalidContacts.length > 0 ? `${invalidContacts.length} invalid` : null,
      pivotedContacts.length > 0 ? `${pivotedContacts.length} pivoted` : null,
    ].filter(Boolean).join(', ');

    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'apollo_discovery',
      lead_id: leadId || null,
      summary: `Apollo found ${contacts.length} contacts for ${cleanDomain} (${triageSummary}): ${contacts.map(c => c.email).join(', ')}`,
      status: 'success',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        domain: cleanDomain,
        contacts,
        added,
        invalidCount: invalidContacts.length,
        pivotedCount: pivotedContacts.length,
        creditsUsed: 1 + top3.length + (pivotedContacts.length > 0 ? 2 : 0),
      }),
    };

  } catch (error) {
    console.error('💥 Apollo contact search error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
