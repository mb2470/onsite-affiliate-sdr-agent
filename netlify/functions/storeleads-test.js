exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

  try {
    // Test single domain lookup (not bulk)
    const response = await fetch('https://storeleads.app/json/api/v1/all/domain/www.fashionnova.com?fields=name,contacts', {
      headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` },
    });

    const data = await response.json();
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: response.status,
        hasContacts: !!(data.domain && data.domain.contacts),
        contactCount: data.domain?.contacts?.length || 0,
        sampleContacts: (data.domain?.contacts || []).slice(0, 5),
        keys: Object.keys(data.domain || {}),
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
