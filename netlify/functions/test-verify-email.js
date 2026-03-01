const { corsHeaders } = require('./lib/cors');
const ELV_API_KEY = process.env.EMAILLISTVERIFY_API_KEY;

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    const testEmail = email || 'blossom@clarev.com';

    console.log(`🔑 API Key present: ${!!ELV_API_KEY}`);
    console.log(`🔑 Key starts with: ${ELV_API_KEY ? ELV_API_KEY.substring(0, 6) + '...' : 'NOT SET'}`);
    console.log(`📧 Testing: ${testEmail}`);

    if (!ELV_API_KEY) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'EMAILLISTVERIFY_API_KEY not set', keyPresent: false }) };
    }

    const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(ELV_API_KEY)}&email=${encodeURIComponent(testEmail)}&timeout=15`;
    const res = await fetch(url);
    const status = await res.text();

    console.log(`✅ Result: ${status}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ email: testEmail, status: status.trim(), keyPresent: true }),
    };

  } catch (error) {
    console.error('💥', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
