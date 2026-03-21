const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const parseBody = (event) => {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return {};
  }
};

const resolveOrg = async (supabaseAdmin, identifier) => {
  if (!identifier) return null;
  let query = supabaseAdmin.from('organizations').select('id, name, slug').eq('slug', identifier).limit(1);
  let { data } = await query;
  if (data?.[0]) return data[0];

  query = supabaseAdmin.from('organizations').select('id, name, slug').eq('id', identifier).limit(1);
  ({ data } = await query);
  return data?.[0] || null;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Supabase env missing' }) };
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey);

  try {
    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.queryStringParameters || {});
      const action = params.get('action');
      if (action !== 'get_org') {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unsupported action' }) };
      }

      const org = await resolveOrg(supabaseAdmin, (params.get('org') || '').trim());
      if (!org) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Organization not found' }) };
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ organization: org }) };
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      const org = await resolveOrg(supabaseAdmin, (body.org || '').trim());
      if (!org) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Organization not found' }) };
      }

      const payload = {
        org_id: org.id,
        is_active: true,
        elevator_pitch: body.elevator_pitch || '',
        core_problem: body.core_problem || '',
        uvp_1: body.uvp_1 || '',
        industries: body.industries || [],
        company_size: body.company_size || '',
        geography: body.geography || [],
        revenue_range: body.revenue_range || '',
        primary_titles: body.primary_titles || [],
        success_metrics: body.success_metrics || '',
        sender_name: body.sender_name || '',
        sender_url: body.sender_url || '',
        email_tone: body.email_tone || '',
        social_proof: body.social_proof || '',
        perfect_fit_narrative: body.perfect_fit_narrative || '',
      };

      const { data, error } = await supabaseAdmin.from('icp_profiles').insert(payload).select('id').single();
      if (error) throw error;
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, id: data.id }) };
    }

    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message || 'Unexpected error' }) };
  }
};
