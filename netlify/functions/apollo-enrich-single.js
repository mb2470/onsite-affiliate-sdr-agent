const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { domain } = JSON.parse(event.body || '{}');
  if (!domain) return { statusCode: 400, headers, body: JSON.stringify({ error: 'domain required' }) };
  if (!APOLLO_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'APOLLO_API_KEY not set' }) };

  try {
    const res = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': APOLLO_API_KEY,
      },
    });

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `Apollo ${res.status}` }) };
    }

    const data = await res.json();

    if (!data.organization) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found', organization: null }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ organization: data.organization }),
    };
  } catch (error) {
    console.error('Apollo enrich error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
