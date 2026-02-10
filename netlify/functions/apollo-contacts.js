// Netlify serverless function to search for contacts using Apollo.io API
// Finds decision makers at target companies with verified emails

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

    // Default titles to search for if not provided (based on ICP)
    const searchTitles = titles || [
      // Primary: Influencer/Affiliate Leaders
      'Director of Influencer Marketing',
      'Head of Partnerships',
      'Senior Manager of Affiliate Marketing',
      'Director of Brand Advocacy',
      'VP Influencer Marketing',
      'Manager Influencer Marketing',
      
      // Secondary: E-Commerce Leaders
      'VP of E-Commerce',
      'Director of E-Commerce',
      'Head of Digital Product',
      'VP Ecommerce',
      'Director Ecommerce',
      
      // Tertiary: Brand & Social Leaders
      'Director of Brand Marketing',
      'Head of Social Media',
      'Director of Content Strategy',
      'VP Brand Marketing',
      
      // Quaternary: Growth/Performance Leaders
      'VP of Growth',
      'Director of Performance Marketing',
      'Head of User Acquisition',
      'VP Growth Marketing'
    ];

    console.log(`Searching Apollo for contacts at: ${website}`);

    // Apollo.io API endpoint for people search
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        // Search parameters
        page: 1,
        per_page: 10,
        organization_domains: [website],
        person_titles: searchTitles,
        // Only return contacts with emails
        contact_email_status: ['verified', 'guessed'],
        // Prioritize verified emails
        sort_by_field: 'contact_email_status',
        sort_ascending: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Apollo API error:', response.status, errorText);
      throw new Error(`Apollo API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Transform Apollo response to simplified format
    const contacts = (data.people || []).map(person => ({
      id: person.id,
      name: person.name || 'Unknown',
      firstName: person.first_name || '',
      lastName: person.last_name || '',
      title: person.title || 'Unknown Title',
      email: person.email || null,
      emailStatus: person.email_status || 'unknown',
      linkedinUrl: person.linkedin_url || null,
      photoUrl: person.photo_url || null,
      organization: person.organization ? {
        name: person.organization.name,
        website: person.organization.website_url
      } : null
    })).filter(contact => contact.email); // Only return contacts with emails

    console.log(`Found ${contacts.length} contacts with emails`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts,
        total: data.pagination?.total_entries || contacts.length,
        creditsUsed: 1 // Apollo charges ~1 credit per search
      })
    };

  } catch (error) {
    console.error('Apollo.io API error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message || 'Failed to search contacts',
        details: error.toString()
      })
    };
  }
};
