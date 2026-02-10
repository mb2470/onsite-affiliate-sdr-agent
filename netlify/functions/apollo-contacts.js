// UPDATED Apollo.io contacts function - Fixed for Apollo Basic Plan API
// Replace your existing /netlify/functions/apollo-contacts.js with this

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
      // Growth/Performance Leaders
      'VP of Growth',
      'Director of Performance Marketing',
      'Head of User Acquisition',
      'VP Growth Marketing'
    ];

    console.log(`Searching Apollo for contacts at: ${website}`);

    // Apollo.io API endpoint - using correct v1 endpoint
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        // Required parameters
        api_key: process.env.APOLLO_API_KEY, // Apollo sometimes needs this in body too
        page: 1,
        per_page: 10,
        
        // Search filters
        organization_domains: [website],
        person_titles: searchTitles,
        
        // Email requirements - only return contacts with emails
        contact_email_status: ['verified', 'guessed', 'likely'],
        
        // Sort by email status (verified first)
        sort_by_field: 'contact_email_status',
        sort_ascending: false
      })
    });

    // Check for errors
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('Apollo API error:', response.status, errorData);
      
      // Provide helpful error messages
      if (response.status === 403) {
        throw new Error('Apollo API key is invalid or lacks permissions. Check your API key in Netlify settings.');
      }
      if (response.status === 422) {
        throw new Error('Invalid search parameters. This might be an API plan limitation.');
      }
      if (response.status === 429) {
        throw new Error('Apollo API rate limit exceeded. Wait a few minutes and try again.');
      }
      
      throw new Error(`Apollo API error ${response.status}: ${errorData.error || 'Unknown error'}`);
    }

    const data = await response.json();

    // Check if we got valid data
    if (!data.people || !Array.isArray(data.people)) {
      console.error('Unexpected Apollo response format:', data);
      throw new Error('Apollo API returned unexpected response format');
    }

    // Transform Apollo response to simplified format
    const contacts = data.people
      .filter(person => person.email) // Only contacts with emails
      .map(person => ({
        id: person.id,
        name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown',
        firstName: person.first_name || '',
        lastName: person.last_name || '',
        title: person.title || 'Unknown Title',
        email: person.email,
        emailStatus: person.email_status || 'unknown',
        linkedinUrl: person.linkedin_url || null,
        photoUrl: person.photo_url || null,
        organization: person.organization ? {
          name: person.organization.name || '',
          website: person.organization.website_url || ''
        } : null
      }));

    console.log(`Found ${contacts.length} contacts with emails out of ${data.people.length} total people`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
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
        success: false,
        error: error.message || 'Failed to search contacts',
        details: error.toString()
      })
    };
  }
};
