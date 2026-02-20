const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { domain } = JSON.parse(event.body);
    if (!domain) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No domain provided' }) };

    console.log(`🔍 Testing Apollo for: ${domain}`);

    // Step 1: Search
    const searchRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({
        organization_domains: [domain],
        person_titles: ['Marketing', 'Influencer', 'Creator', 'Affiliate', 'Partnership',
          'Ecommerce', 'E-Commerce', 'Digital', 'Growth', 'Brand', 'Content', 'Social Media',
          'CMO', 'CEO', 'Founder'],
        per_page: 25,
      }),
    });

    if (!searchRes.ok) throw new Error(`Search failed: ${searchRes.status} ${await searchRes.text()}`);
    const searchData = await searchRes.json();

    const people = (searchData.people || []).map(p => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      title: p.title,
      has_email: p.has_email,
    }));

    // Step 2: Enrich top 3 with emails (to save credits for testing)
    const withEmail = people.filter(p => p.has_email).slice(0, 3);
    let enriched = [];

    if (withEmail.length > 0) {
      const enrichRes = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
        body: JSON.stringify({ details: withEmail.map(p => ({ id: p.id })) }),
      });

      if (enrichRes.ok) {
        const enrichData = await enrichRes.json();
        enriched = (enrichData.matches || []).map(m => ({
          first_name: m.first_name,
          last_name: m.last_name,
          email: m.email,
          email_status: m.email_status,
          title: m.title,
          linkedin_url: m.linkedin_url,
        }));
      }
    }

    const result = {
      domain,
      search_results: people.length,
      with_email: withEmail.length,
      credits_used: 1 + withEmail.length,
      people_found: people.slice(0, 10),
      enriched_contacts: enriched,
    };

    console.log(`✅ Found ${people.length} people, enriched ${enriched.length}`);

    return { statusCode: 200, headers, body: JSON.stringify(result, null, 2) };

  } catch (error) {
    console.error('💥', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
