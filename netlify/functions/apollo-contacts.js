// FINAL CORRECT Apollo.io contacts function
// Based on your successful API test showing api_search works
// Replace /netlify/functions/apollo-contacts.js

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { website, titles, spreadsheetId, leadRowIndex } = JSON.parse(event.body);

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

    // Broader keyword-based filtering for better matches
    const relevantKeywords = [
      // PRIMARY: Influencer/Affiliate/Creator roles
      'influencer',
      'creator',
      'affiliate',
      'partnership',
      'brand advocate',
      
      // SECONDARY: E-commerce roles
      'ecommerce',
      'e-commerce',
      'digital commerce',
      'online retail',
      
      // TERTIARY: Marketing roles (with qualifiers to avoid too broad)
      'brand marketing',
      'content marketing',
      'social media',
      'digital marketing',
      'performance marketing',
      'growth marketing',
      
      // QUATERNARY: Relevant C-suite/VP
      'chief marketing',
      'vp marketing',
      'vp growth',
      'vp digital',
      'cmo'
    ];

    const filteredPeople = searchData.people.filter(person => {
      if (!person.has_email) return false;
      if (!person.title) return false;
      
      const titleLower = person.title.toLowerCase();
      
      // Check if title contains any relevant keywords
      return relevantKeywords.some(keyword => 
        titleLower.includes(keyword)
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
      ? filteredPeople.slice(0, 10)  // Enrich up to 10 matches (broader search = more results)
      : searchData.people.filter(p => p.has_email).slice(0, 5); // Fallback to first 5 with emails

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

    // WRITE CONTACTS TO GOOGLE SHEETS (if spreadsheetId provided)
    if (spreadsheetId && contacts.length > 0) {
      try {
        console.log(`Writing ${contacts.length} contacts to Google Sheets...`);
        
        // Prepare contact data for Contacts sheet
        const contactRows = contacts.map(contact => [
          website,                          // Company Website
          contact.name,                     // Contact Name
          contact.title,                    // Title
          contact.email,                    // Email
          contact.emailStatus,              // Email Status
          contact.linkedinUrl || '',        // LinkedIn
          contact.organization?.name || '', // Company Name
          'New',                           // Status
          new Date().toISOString().split('T')[0], // Date Found
          ''                               // Notes
        ]);

        // Write to Contacts sheet (create if doesn't exist)
        await fetch('/.netlify/functions/sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'append',
            spreadsheetId: spreadsheetId,
            range: 'Contacts!A:J',
            values: contactRows
          })
        });

        console.log(`Successfully wrote ${contacts.length} contacts to Contacts sheet`);

        // Also update the main Lead sheet with contact count
        if (leadRowIndex) {
          const contactSummary = `${contacts.length} contacts found - see Contacts sheet`;
          await fetch('/.netlify/functions/sheets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'write',
              spreadsheetId: spreadsheetId,
              range: `Sheet1!H${leadRowIndex}`,
              values: [[contactSummary]]
            })
          });
        }

      } catch (sheetsError) {
        console.error('Error writing contacts to Google Sheets:', sheetsError);
        // Don't fail the whole request if Sheets write fails
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        contacts,
        total: searchData.people.length,
        enriched: contacts.length,
        creditsUsed: 1 + contacts.length, // 1 for search + 1 per enrichment
        savedToSheets: spreadsheetId ? true : false
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
