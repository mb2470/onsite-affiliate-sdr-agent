// CSV Contact Matcher - PRODUCTION VERSION
// Optimized for large datasets with timeout protection

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

// Extract recommended decision maker titles from research notes
function extractRecommendedTitles(researchNotes) {
  if (!researchNotes) return [];
  
  try {
    // Look for DECISION MAKERS section in research
    const decisionMakersMatch = researchNotes.match(/DECISION MAKERS[:\s]+([^\n]+(?:\n(?![\n])[^\n]+)*)/i);
    
    if (!decisionMakersMatch) return [];
    
    const decisionMakersText = decisionMakersMatch[1];
    
    // Extract titles from the text
    const titles = [];
    
    // Common patterns for decision maker titles
    const titlePatterns = [
      /Director of Influencer Marketing/gi,
      /VP Influencer Marketing/gi,
      /Head of Influencer/gi,
      /Director of Brand Marketing/gi,
      /VP Brand Marketing/gi,
      /Head of Brand/gi,
      /Director of E-?Commerce/gi,
      /VP E-?Commerce/gi,
      /Head of E-?Commerce/gi,
      /Director of Partnerships/gi,
      /VP Partnerships/gi,
      /Head of Partnerships/gi,
      /Director of Growth/gi,
      /VP Growth/gi,
      /Head of Growth/gi,
      /Director of Performance Marketing/gi,
      /VP Performance Marketing/gi,
      /Chief Marketing Officer/gi,
      /CMO/gi,
      /VP Marketing/gi,
      /Director of Marketing/gi,
      /Head of Marketing/gi
    ];
    
    titlePatterns.forEach(pattern => {
      const matches = decisionMakersText.match(pattern);
      if (matches) {
        matches.forEach(match => titles.push(match.toLowerCase()));
      }
    });
    
    return [...new Set(titles)]; // Remove duplicates
  } catch (error) {
    console.error('Error extracting recommended titles:', error);
    return [];
  }
}

// Score a contact based on how well their title matches research recommendations
function scoreContact(contact, recommendedTitles) {
  if (!contact.title) return 0;
  
  const contactTitle = contact.title.toLowerCase();
  let score = 0;
  
  // If we have specific recommendations from research, score based on those
  if (recommendedTitles && recommendedTitles.length > 0) {
    // Exact match with recommended title = 100 points
    if (recommendedTitles.some(rec => contactTitle === rec)) {
      score += 100;
    }
    // Partial match with recommended title = 50 points
    else if (recommendedTitles.some(rec => {
      const recBase = rec.replace(/^(director|vp|head|chief) of /i, '');
      const titleBase = contactTitle.replace(/^(director|vp|head|chief) of /i, '');
      return contactTitle.includes(recBase) || rec.includes(titleBase);
    })) {
      score += 50;
    }
  }
  
  // Score based on seniority level
  if (contactTitle.includes('chief') || contactTitle.includes('cmo')) {
    score += 40;
  } else if (contactTitle.includes('vp') || contactTitle.includes('vice president')) {
    score += 35;
  } else if (contactTitle.includes('head of')) {
    score += 30;
  } else if (contactTitle.includes('director')) {
    score += 25;
  } else if (contactTitle.includes('senior')) {
    score += 15;
  } else if (contactTitle.includes('manager')) {
    score += 10;
  }
  
  // Score based on ICP-relevant keywords
  const icpKeywords = [
    { keyword: 'influencer', points: 30 },
    { keyword: 'creator', points: 30 },
    { keyword: 'affiliate', points: 25 },
    { keyword: 'partnership', points: 25 },
    { keyword: 'brand marketing', points: 20 },
    { keyword: 'ecommerce', points: 20 },
    { keyword: 'e-commerce', points: 20 },
    { keyword: 'growth', points: 15 },
    { keyword: 'performance marketing', points: 15 },
    { keyword: 'digital marketing', points: 10 },
    { keyword: 'content marketing', points: 10 },
    { keyword: 'social media', points: 10 }
  ];
  
  icpKeywords.forEach(({ keyword, points }) => {
    if (contactTitle.includes(keyword)) {
      score += points;
    }
  });
  
  // Bonus for having an email
  if (contact.email && contact.email.trim()) {
    score += 5;
  }
  
  return score;
}

// Get reason for the score (to display to user)
function getMatchReason(contact, recommendedTitles) {
  if (!contact.title) return 'Has contact info';
  
  const contactTitle = contact.title.toLowerCase();
  const reasons = [];
  
  // Check if matches research recommendation
  if (recommendedTitles && recommendedTitles.length > 0) {
    const exactMatch = recommendedTitles.find(rec => contactTitle === rec);
    if (exactMatch) {
      reasons.push('🎯 Exact match from research');
    } else {
      const partialMatch = recommendedTitles.find(rec => {
        const recBase = rec.replace(/^(director|vp|head|chief) of /i, '');
        const titleBase = contactTitle.replace(/^(director|vp|head|chief) of /i, '');
        return contactTitle.includes(recBase) || rec.includes(titleBase);
      });
      if (partialMatch) {
        reasons.push('✓ Similar to research recommendation');
      }
    }
  }
  
  // Add seniority indicator
  if (contactTitle.includes('chief') || contactTitle.includes('cmo')) {
    reasons.push('C-level');
  } else if (contactTitle.includes('vp')) {
    reasons.push('VP-level');
  } else if (contactTitle.includes('head of')) {
    reasons.push('Head-level');
  } else if (contactTitle.includes('director')) {
    reasons.push('Director-level');
  }
  
  // Add ICP match
  const icpMatches = [];
  if (contactTitle.includes('influencer')) icpMatches.push('Influencer');
  if (contactTitle.includes('creator')) icpMatches.push('Creator');
  if (contactTitle.includes('affiliate')) icpMatches.push('Affiliate');
  if (contactTitle.includes('partnership')) icpMatches.push('Partnership');
  if (contactTitle.includes('brand marketing')) icpMatches.push('Brand Marketing');
  if (contactTitle.includes('ecommerce') || contactTitle.includes('e-commerce')) icpMatches.push('E-Commerce');
  if (contactTitle.includes('growth')) icpMatches.push('Growth');
  
  if (icpMatches.length > 0) {
    reasons.push(icpMatches.join(' + '));
  }
  
  return reasons.length > 0 ? reasons.join(' • ') : 'Relevant contact';
}

// Get user-friendly match level badge based on score
function getMatchLevel(score) {
  if (score >= 120) {
    return {
      level: 'Best Match',
      emoji: '🎯',
      class: 'match-best',
      description: 'Exact or very close match from research'
    };
  } else if (score >= 70) {
    return {
      level: 'Great Match',
      emoji: '⭐',
      class: 'match-great',
      description: 'Strong fit for ICP and seniority'
    };
  } else if (score >= 40) {
    return {
      level: 'Good Match',
      emoji: '✓',
      class: 'match-good',
      description: 'Relevant role and seniority'
    };
  } else {
    return {
      level: 'Possible Match',
      emoji: '•',
      class: 'match-possible',
      description: 'May be relevant'
    };
  }
}

// Get Google Sheets client
function getGoogleSheetsClient() {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    console.error('Error creating Google Sheets client:', error);
    throw new Error('Failed to create Google Sheets client. Check GOOGLE_SERVICE_ACCOUNT_KEY.');
  }
}

exports.handler = async (event, context) => {
  // Set timeout to 25 seconds (Netlify functions have 26s limit)
  context.callbackWaitsForEmptyEventLoop = false;
  
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
    const { website, spreadsheetId, leadRowIndex, researchNotes, offset = 0 } = JSON.parse(event.body);

    console.log('=== CSV Contact Search Request ===');
    console.log('Website:', website);
    console.log('Offset:', offset);
    console.log('Has research notes:', !!researchNotes);

    if (!website) {
      throw new Error('Website is required');
    }

    if (!process.env.CONTACTS_SPREADSHEET_ID) {
      console.error('CONTACTS_SPREADSHEET_ID not set');
      throw new Error('CONTACTS_SPREADSHEET_ID not set in environment variables');
    }

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set in environment variables');
    }

    const startTime = Date.now();

    // Extract recommended decision maker titles from research
    const recommendedTitles = extractRecommendedTitles(researchNotes);
    console.log('Recommended titles from research:', recommendedTitles);

    // Get Google Sheets client
    console.log('Creating Google Sheets client...');
    const sheets = getGoogleSheetsClient();

    // Load contacts from Google Sheets
    console.log(`Reading from spreadsheet: ${process.env.CONTACTS_SPREADSHEET_ID}`);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.CONTACTS_SPREADSHEET_ID,
      range: 'Sheet1!A:F'
    });

    const rows = response.data.values || [];
    console.log(`Loaded ${rows.length} total rows (including header)`);

    if (rows.length <= 1) {
      throw new Error('Contact database is empty or only has headers');
    }

    // Parse rows (skip header row)
    const allContacts = rows.slice(1)
      .filter(row => row && row.length >= 5) // Must have at least 5 columns
      .map(row => ({
        website: (row[0] || '').trim(),
        accountName: (row[1] || '').trim(),
        firstName: (row[2] || '').trim(),
        lastName: (row[3] || '').trim(),
        title: (row[4] || '').trim(),
        email: (row[5] || '').trim()
      }));

    console.log(`Parsed ${allContacts.length} contacts from database`);

    // Filter and score contacts
    const matchingContacts = allContacts
      .filter(contact => {
        // Must match the company domain
        if (!domainsMatch(website, contact.website)) return false;
        
        // Must have email
        if (!contact.email || contact.email.trim() === '') return false;
        
        // Must have title
        if (!contact.title || contact.title.trim() === '') return false;
        
        // MATCHING LOGIC: Contact must match in either EMAIL DOMAIN or ACCOUNT NAME
        
        // Extract search company name from domain (e.g., "temu" from "temu.com")
        const searchDomain = normalizeDomain(website);
        const searchCompanyName = searchDomain.replace(/\.(com|co\.uk|net|org|io|ai|app)$/, '').toLowerCase();
        
        // Check 1: Email domain matches
        const emailDomain = contact.email.toLowerCase().split('@')[1];
        if (emailDomain) {
          const normalizedEmailDomain = normalizeDomain(emailDomain);
          const emailBase = normalizedEmailDomain.replace(/\.(com|co\.uk|net|org|io|ai|app)$/, '');
          
          // If email domain matches, it's a match!
          if (normalizedEmailDomain === searchDomain || emailBase === searchCompanyName) {
            return true;
          }
        }
        
        // Check 2: Account Name contains company name
        if (contact.accountName && contact.accountName.trim()) {
          const accountNameLower = contact.accountName.toLowerCase();
          
          // Check if search company name appears in account name
          // For "temu.com" search, check if "temu" appears in account name
          if (accountNameLower.includes(searchCompanyName)) {
            return true;
          }
          
          // Also check if account name appears in search domain
          // For searching "J.Crew", account name "JCrew" should match
          const normalizedAccountName = accountNameLower
            .replace(/[^a-z0-9]/g, '') // Remove special chars
            .trim();
          
          const normalizedSearchName = searchCompanyName
            .replace(/[^a-z0-9]/g, '');
          
          if (normalizedAccountName && normalizedSearchName) {
            if (normalizedAccountName.includes(normalizedSearchName) || 
                normalizedSearchName.includes(normalizedAccountName)) {
              return true;
            }
          }
        }
        
        // No match found
        return false;
      })
      .map(contact => {
        const score = scoreContact(contact, recommendedTitles);
        const matchReason = getMatchReason(contact, recommendedTitles);
        return {
          ...contact,
          score,
          matchReason
        };
      })
      // Sort by score (highest first)
      .sort((a, b) => b.score - a.score);

    console.log(`Found ${matchingContacts.length} matching contacts`);
    console.log(`Time elapsed: ${Date.now() - startTime}ms`);

    if (matchingContacts.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          contacts: [],
          total: 0,
          hasMore: false,
          message: `No contacts found for ${website}`,
          searchTime: Date.now() - startTime
        })
      };
    }

    // Get the next 3 contacts based on offset
    const BATCH_SIZE = 3;
    const paginatedContacts = matchingContacts.slice(offset, offset + BATCH_SIZE);
    const hasMore = matchingContacts.length > (offset + BATCH_SIZE);

    // Transform to standard format
    const contacts = paginatedContacts.map((contact, index) => {
      const matchLevel = getMatchLevel(contact.score);
      return {
        id: `csv-${Date.now()}-${offset + index}`,
        name: `${contact.firstName} ${contact.lastName}`.trim() || contact.accountName || 'Unknown',
        firstName: contact.firstName,
        lastName: contact.lastName,
        title: contact.title,
        email: contact.email,
        emailStatus: 'database',
        linkedinUrl: null,
        photoUrl: null,
        organization: {
          name: contact.accountName,
          website: contact.website || website
        },
        score: contact.score,
        matchReason: contact.matchReason,
        matchLevel: matchLevel.level,
        matchEmoji: matchLevel.emoji,
        matchClass: matchLevel.class,
        matchDescription: matchLevel.description
      };
    });

    console.log(`Returning ${contacts.length} contacts (offset ${offset})`);
    console.log(`Total search time: ${Date.now() - startTime}ms`);

    // WRITE CONTACTS TO USER'S GOOGLE SHEETS (only on first batch)
    let savedToSheets = false;
    if (spreadsheetId && offset === 0 && contacts.length > 0) {
      try {
        console.log(`Writing top ${contacts.length} contacts to user's Contacts sheet...`);
        
        const contactRows = contacts.map(contact => [
          website,
          contact.name,
          contact.title,
          contact.email,
          'CSV Database',
          contact.matchReason,
          contact.organization?.name || '',
          'New',
          new Date().toISOString().split('T')[0],
          `${contact.matchLevel} (${contact.score})`
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
          const contactSummary = `${matchingContacts.length} contacts - top ${contacts.length} saved`;
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
        // Don't throw - just log and continue
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        contacts,
        total: matchingContacts.length,
        offset,
        hasMore,
        source: 'CSV Database (Smart Match)',
        savedToSheets,
        searchTime: Date.now() - startTime,
        recommendedTitles: recommendedTitles.length > 0 ? recommendedTitles : null
      })
    };

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false,
        error: error.message || 'Failed to search contacts',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};
