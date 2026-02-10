// FINAL CORRECT Apollo.io contacts function
// Based on your successful API test showing api_search works

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { website, titles } = JSON.parse(event.body);

    if (!process.env.APOLLO_API_KEY) {
      throw new Error('APOLLO_API_KEY environment variable not set');
    }

    if (!website) {
      throw new Error('Website is required');
    }

    console.log(`Searching Apollo for contacts at: ${website}`);

    // STEP 1: Search for people using EXACT format from your working test
    const searchResponse = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'x-api-key': process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        page: 1,
        per_page: 25,
        // Use the website domain to filter
        q_organization_domains: website
      })
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error('Apollo search error:', searchResponse.status, errorText);
      
      if (searchResponse.status === 401) {
        throw new Error('Invalid Apollo API key');
      }
      if (searchResponse.status === 403) {
        throw new Error('Apollo API access forbidden. Verify your plan includes API access.');
      }
      
      throw new Error(`Apollo API error ${searchResponse.status}: ${errorText}`);
    }

    const searchData = await searchResponse.json();

    if (!searchData.people || searchData.people.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          contacts: [],
          total: 0,
          message: `No contacts found at ${website}`
        })
      };
    }

    console.log(`Found ${searchData.people.length} people, filtering for relevant titles...`);

    // Filter for relevant titles (case-insensitive)
    const relevantTitles = [
      'director of influencer marketing',
      'head of partnerships',
      'vp influencer marketing',
      'director of e-commerce',
      'vp of e-commerce',
      'director of brand marketing',
      'head of social media',
      'vp of growth',
      'director of performance marketing',
      'head of digital',
      'vp marketing',
      'director of marketing',
      'manager influencer marketing',
      'manager affiliate marketing'
    ];

    const filteredPeople = searchData.people.filter(person => {
      if (!person.has_email) return false;
      if (!person.title) return false;
      
      const titleLower = person.title.toLowerCase();
      return relevantTitles.some(relevantTitle => 
        titleLower.includes(relevantTitle)
      );
    });

    console.log(`Filtered to ${filteredPeople.length} people with relevant titles and emails`);

    if (filteredPeople.length === 0) {
      // Return all people with emails even if titles don't match
      const peopleWithEmails = searchData.people
        .filter(p => p.has_email)
        .slice(0, 10);
      
      console.log(`No title matches, returning ${peopleWithEmails.length} people with emails`);
    }

    const peopleToEnrich = filteredPeople.length > 0 
      ? filteredPeople.slice(0, 5)  // Use filtered if we have them
      : searchData.people.filter(p => p.has_email).slice(0, 5); // Otherwise use first 5 with emails

    if (peopleToEnrich.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          contacts: [],
          total: searchData.people.length,
          message: 'Found people but none have email addresses'
        })
      };
    }

    // STEP 2: Enrich to get actual emails and full names
    const enrichResponse = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        details: peopleToEnrich.map(person => ({ id: person.id }))
      })
    });

    if (!enrichResponse.ok) {
      const errorText = await enrichResponse.text();
      console.error('Apollo enrich error:', enrichResponse.status, errorText);
      
      // Return basic info without emails if enrichment fails
      const basicContacts = peopleToEnrich.map(person => ({
        id: person.id,
        name: `${person.first_name} ${person.last_name_obfuscated || ''}`.trim(),
        firstName: person.first_name,
        lastName: person.last_name_obfuscated || '***',
        title: person.title || 'Unknown',
        email: null,
        emailStatus: 'enrichment_required',
        organization: {
          name: person.organization?.name || '',
          website: website
        },
        note: 'Email available - enrichment failed. May need higher Apollo plan.'
      }));

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          contacts: basicContacts,
          total: searchData.people.length,
          message: 'Found contacts but could not retrieve emails. Check Apollo plan.'
        })
      };
    }

    const enrichData = await enrichResponse.json();

    // Transform enriched contacts
    const contacts = (enrichData.matches || [])
      .filter(person => person.email) // Only return those with actual emails
      .map(person => ({
        id: person.id,
        name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
        firstName: person.first_name || '',
        lastName: person.last_name || '',
        title: person.title || '',
        email: person.email,
        emailStatus: person.email_status || 'unknown',
        linkedinUrl: person.linkedin_url || null,
        photoUrl: person.photo_url || null,
        organization: {
          name: person.organization?.name || '',
          website: person.organization?.primary_domain || website
        }
      }));

    console.log(`Successfully enriched ${contacts.length} contacts with emails`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        contacts,
        total: searchData.people.length,
        enriched: contacts.length,
        creditsUsed: 1 + contacts.length // 1 for search + 1 per enrichment
      })
    };

  } catch (error) {
    console.error('Apollo.io API error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false,
        error: error.message || 'Failed to search contacts'
      })
    };
  }
};
