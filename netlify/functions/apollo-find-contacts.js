const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { domain, leadId } = JSON.parse(event.body || '{}');
    if (!domain) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No domain provided' }) };

    const cleanDomain = domain.toLowerCase().replace(/^www\./, '');
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

    // Step 2: Enrich top 3 to get actual emails
    const top3 = people.slice(0, 3);
    const enrichRes = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({ details: top3.map(p => ({ id: p.id })) }),
    });

    if (!enrichRes.ok) throw new Error(`Apollo enrich failed: ${enrichRes.status}`);
    const enrichData = await enrichRes.json();

    const contacts = (enrichData.matches || [])
      .filter(m => m.email && m.email_status === 'verified')
      .map(m => ({
        first_name: m.first_name || '',
        last_name: m.last_name || '',
        email: m.email.toLowerCase(),
        title: m.title || '',
        linkedin_url: m.linkedin_url || '',
        website: cleanDomain,
        account_name: m.organization?.name || cleanDomain,
      }));

    console.log(`✅ Enriched ${contacts.length} verified contacts`);

    // Step 3: Write to contact_database (skip duplicates)
    let added = 0;
    for (const contact of contacts) {
      // Check if email already exists
      const { count } = await supabase
        .from('contact_database')
        .select('*', { count: 'exact', head: true })
        .eq('email', contact.email);

      if (count === 0) {
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
          });

        if (!error) {
          added++;
          console.log(`  + ${contact.first_name} ${contact.last_name} (${contact.email}) — ${contact.title}`);
        } else {
          console.error(`  ⚠️ Insert error for ${contact.email}:`, error.message);
        }
      }
    }

    // Step 4: Update lead if leadId provided
    if (leadId && contacts.length > 0) {
      await supabase.from('leads').update({
        has_contacts: true,
        contact_name: `${contacts[0].first_name} ${contacts[0].last_name}`.trim(),
        contact_email: contacts[0].email,
      }).eq('id', leadId);
    }

    // Log activity
    await supabase.from('activity_log').insert({
      activity_type: 'apollo_discovery',
      lead_id: leadId || null,
      summary: `Apollo found ${contacts.length} contacts for ${cleanDomain}: ${contacts.map(c => c.email).join(', ')}`,
      status: 'success',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        domain: cleanDomain,
        contacts,
        added,
        creditsUsed: 1 + top3.length,
      }),
    };

  } catch (error) {
    console.error('💥 Apollo contact search error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
