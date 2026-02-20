const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const domain = event.queryStringParameters?.domain;
  if (!domain) return { statusCode: 400, headers, body: JSON.stringify({ error: 'domain required' }) };
  if (!STORELEADS_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STORELEADS_API_KEY not set' }) };

  try {
    const res = await fetch(`https://storeleads.app/json/api/v1/all/domain/${encodeURIComponent(domain)}`, {
      headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` },
    });

    if (!res.ok) {
      if (res.status === 404) return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `StoreLeads ${res.status}` }) };
    }

    const data = await res.json();
    const store = data.result || data;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        domain: store.domain,
        product_count: store.product_count || 0,
        estimated_sales: store.estimated_sales || 0,
        categories: store.categories || [],
        country: store.country || null,
        city: store.city || null,
        state: store.state || null,
        platform: store.platform || null,
        rank: store.rank || null,
        plan: store.plan || null,
        created_at: store.created_at || null,
      }),
    };
  } catch (error) {
    console.error('StoreLeads error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
