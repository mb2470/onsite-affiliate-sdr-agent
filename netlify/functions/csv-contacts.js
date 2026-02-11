// CSV Contact Matcher - GOOGLE SHEETS VERSION
// Perfect for large CSVs (500k contacts)
// Replace /netlify/functions/apollo-contacts.js with this file

// Normalize domain for fuzzy matching
function normalizeDomain(url) {
  if (!url) return '';
  
  let domain = url.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^www[0-9]\./, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/:\d+$/, '')
    .trim();
  
  return domain;
}

// Check if two domains match (with fuzzy logic)
function domainsMatch(searchDomain, contactDomain) {
  const normalizedSearch = normalizeDomain(searchDomain);
  const normalizedContact = normalizeDomain(contactDomain);
  
  if (normalizedSearch === normalizedContact) return true;
  
  if (normalizedSearch.includes(normalizedContact) || normalizedContact.includes(normalizedSearch)) {
    return true;
  }
  
  const searchBase = normalizedSearch.replace(/\.(com|co\.uk|net|org|io)$/, '');
  const contactBase = normalizedContact.replace(/\.(com|co\.uk|net|org|io)$/, '');
  
  if (searchBase === contactBase) return true;
  
  return false;
}

// Filter contacts by relevant titles (ICP-focused)
function isRelevantTitle(title) {
  if (!title) return false;
  
  const titleLower = title.toLowerCase();
  
  const relevantKeywords = [
    'influencer', 'creator', 'affiliate', 'partnership', 'brand advocate', 'community',
    'ecommerce', 'e-commerce', 'digital commerce', 'online retail',
    'brand marketing', 'content marketing', 'social media', 'digital marketing',
    'performance marketing', 'growth marketing',
    'chief marketing', 'vp marketing', 'vp growth', 'vp digital', 'cmo',
    'vp brand', 'vp ecommerce', 'vp e-commerce'
  ];
  
  return relevantKeywords.some(keyword => titleLower.includes(keyword));
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { website, spreadsheetId, leadRowIndex } = JSON.parse(event.body);

    if (!website) {
      throw new Error('Website is required');
    }

    if (!process.env.CONTACTS_SPREADSHEET_ID) {
      throw new Error('CONTACTS_SPREADSHEET_ID environment variable not set. Upload your CSV to Google Sheets first.');
    }

    console.log(`Searching contact database for: ${website}`);
    const startTime = Date.now();

    // Load contacts from Google Sheets
    const response = await fetch('/.netlify/functions/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'read',
        spreadsheetId: process.env.CONTACTS_SPREADSHEET_ID,
        range: 'Sheet1!A:F'  // Assuming: website, account name, first name, last name, title, email
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to load contact database:', errorText);
      throw new Error('Failed to load contact database from Google Sheets');
    }

    const data = await response.json();
    const rows = data.values || [];

    if (rows.length === 0) {
      throw new Error('Contact database is empty');
    }

    // Parse rows directly (skip header row)
    const allContacts = rows.slice(1).map(row => ({
      website: row[0] || '',
      accountName: row[1] || '',
      firstName: row[2] || '',
      lastName: row[3] || '',
      title: row[4] || '',
      email: row[5] || ''
    }));

    console.log(`Loaded ${allContacts.length} contacts from database in ${Date.now() - startTime}ms`);

    // Filter contacts for this domain
    const matchingContacts = allContacts.filter(contact => {
      if (!domainsMatch(website, contact.website)) return false;
      if (!contact.email || contact.email.trim() === '') return false;
      if (!isRelevantTitle(contact.title)) return false;
      return true;
    });

    console.log(`Found ${matchingContacts.length} matching contacts with relevant titles`);

    if (matchingContacts.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          contacts: [],
          total: 0,
          message: `No contacts found for ${website} in database`,
          searchTime: Date.now() - startTime
        })
      };
    }

    // Transform to standard format and limit to 15 contacts
    const contacts = matchingContacts.slice(0, 15).map((contact, index) => ({
      id: `csv-${Date.now()}-${index}`,
      name: `${contact.firstName} ${contact.lastName}`.trim() || contact.accountName || 'Unknown',
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title || 'Unknown Title',
      email: contact.email,
      emailStatus: 'database',
      linkedinUrl: null,
      photoUrl: null,
      organization: {
        name: contact.accountName,
        website: contact.website || website
      }
    }));

    console.log(`Returning ${contacts.length} contacts in ${Date.now() - startTime}ms`);

    // WRITE CONTACTS TO USER'S GOOGLE SHEETS (if spreadsheetId provided)
    if (spreadsheetId && contacts.length > 0) {
      try {
        console.log(`Writing ${contacts.length} contacts to user's Google Sheets...`);
        
        const contactRows = contacts.map(contact => [
          website,
          contact.name,
          contact.title,
          contact.email,
          'CSV Database',
          '',
          contact.organization?.name || '',
          'New',
          new Date().toISOString().split('T')[0],
          ''
        ]);

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

        // Update lead row with contact count
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
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        contacts,
        total: matchingContacts.length,
        source: 'CSV Database',
        savedToSheets: spreadsheetId ? true : false,
        searchTime: Date.now() - startTime
      })
    };

  } catch (error) {
    console.error('CSV contact search error:', error);
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
