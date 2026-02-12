// CSV Contact Matcher - Standalone version that calls Google Sheets API directly
// This avoids the complexity of calling another Netlify function

const { google } = require('googleapis');

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

// Get Google Sheets client
function getGoogleSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  
  return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
  // Add CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { website, spreadsheetId, leadRowIndex } = JSON.parse(event.body);

    console.log('Request received:', { website, spreadsheetId, leadRowIndex });

    if (!website) {
      throw new Error('Website is required');
    }

    if (!process.env.CONTACTS_SPREADSHEET_ID) {
      console.error('CONTACTS_SPREADSHEET_ID not set');
      throw new Error('CONTACTS_SPREADSHEET_ID environment variable not set. Upload your CSV to Google Sheets first.');
    }

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable not set.');
    }

    console.log(`Searching contact database for: ${website}`);
    const startTime = Date.now();

    // Get Google Sheets client
    const sheets = getGoogleSheetsClient();

    // Load contacts from Google Sheets
    console.log(`Reading from spreadsheet: ${process.env.CONTACTS_SPREADSHEET_ID}`);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.CONTACTS_SPREADSHEET_ID,
      range: 'Sheet1!A:F'
    });

    const rows = response.data.values || [];
    console.log(`Loaded ${rows.length} total rows from sheet`);

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

    console.log(`Parsed ${allContacts.length} contacts from database`);

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
        headers,
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
    let savedToSheets = false;
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

        await sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheetId,
          range: 'Contacts!A:J',
          valueInputOption: 'RAW',
          resource: {
            values: contactRows
          }
        });

        console.log(`Successfully wrote ${contacts.length} contacts to Contacts sheet`);
        savedToSheets = true;

        // Update lead row with contact count
        if (leadRowIndex) {
          const contactSummary = `${contacts.length} contacts found - see Contacts sheet`;
          await sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheetId,
            range: `Sheet1!H${leadRowIndex}`,
            valueInputOption: 'RAW',
            resource: {
              values: [[contactSummary]]
            }
          });
        }

      } catch (sheetsError) {
        console.error('Error writing contacts to Google Sheets:', sheetsError);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        contacts,
        total: matchingContacts.length,
        source: 'CSV Database',
        savedToSheets,
        searchTime: Date.now() - startTime
      })
    };

  } catch (error) {
    console.error('CSV contact search error:', error);
    console.error('Error stack:', error.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false,
        error: error.message || 'Failed to search contacts',
        details: error.stack
      })
    };
  }
};
