const { corsHeaders } = require('./lib/cors');
const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;

exports.handler = async (event) => {
  const headers = corsHeaders(event);

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
        domain_url: store.domain_url || null,
        merchant_name: store.merchant_name || null,
        product_count: store.product_count || 0,
        estimated_sales: store.estimated_sales || 0,
        estimated_monthly_sales: store.estimated_monthly_sales || null,
        estimated_yearly_sales: store.estimated_yearly_sales || null,
        average_product_price: store.average_product_price || null,
        average_product_price_usd: store.average_product_price_usd || null,
        categories: store.categories || [],
        country: store.country || null,
        country_code: store.country_code || null,
        company_location: store.company_location || null,
        city: store.city || null,
        state: store.state || null,
        zip: store.zip || null,
        street_address: store.street_address || null,
        platform: store.platform || null,
        platform_domain: store.platform_domain || null,
        platform_rank: store.platform_rank || null,
        rank: store.rank || null,
        plan: store.plan || null,
        status: store.status || null,
        employee_count: store.employee_count || null,
        product_images: store.product_images || null,
        product_variants: store.product_variants || null,
        products_created_90: store.products_created_90 || null,
        emails: store.emails || [],
        phones: store.phones || [],
        facebook: store.facebook || null,
        instagram: store.instagram || null,
        linkedin_account: store.linkedin_account || null,
        pinterest: store.pinterest || null,
        pinterest_followers: store.pinterest_followers || null,
        tiktok: store.tiktok || null,
        tiktok_followers: store.tiktok_followers || null,
        twitter: store.twitter || null,
        twitter_followers: store.twitter_followers || null,
        youtube: store.youtube || null,
        youtube_followers: store.youtube_followers || null,
        created_at: store.created_at || store.created || null,
      }),
    };
  } catch (error) {
    console.error('StoreLeads error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
