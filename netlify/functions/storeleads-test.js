exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

  try {
    // Test single domain lookup without fields filter
    const response = await fetch('https://storeleads.app/json/api/v1/all/domain/www.fashionnova.com', {
      headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` },
    });

    const data = await response.json();
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: response.status,
        hasContactInfo: !!(data.domain && data.domain.contact_info),
        contactInfoCount: data.domain?.contact_info?.length || 0,
        sampleContactInfo: (data.domain?.contact_info || []).slice(0, 10),
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
