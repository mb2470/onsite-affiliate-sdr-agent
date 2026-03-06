const { createClient } = require('@supabase/supabase-js');

const SUPER_ADMIN_EMAIL = 'mike@onsiteaffiliates.com';
const VALID_ROLES = new Set(['owner', 'admin', 'member']);

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const getSupabaseAdmin = () => createClient(supabaseUrl, serviceKey);

const parseBody = (event) => {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return {};
  }
};

const getToken = (event) => {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length);
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase server environment variables missing' }) };
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const token = getToken(event);
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Missing bearer token' }) };

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }

    const requesterEmail = (authData.user.email || '').toLowerCase();
    if (requesterEmail !== SUPER_ADMIN_EMAIL) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Super admin access required' }) };
    }

    const body = parseBody(event);
    const { action } = body;

    if (action === 'list_orgs') {
      const { data, error } = await supabaseAdmin
        .from('organizations')
        .select('id, name, slug, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ organizations: data || [] }) };
    }

    if (action === 'create_org') {
      const name = (body.name || '').trim();
      const slug = (body.slug || '').trim().toLowerCase();
      if (!name || !slug) return { statusCode: 400, body: JSON.stringify({ error: 'name and slug are required' }) };

      const { data, error } = await supabaseAdmin
        .from('organizations')
        .insert({ name, slug })
        .select('id, name, slug')
        .single();
      if (error) throw error;

      return { statusCode: 200, body: JSON.stringify({ organization: data }) };
    }

    if (action === 'invite_user') {
      const email = (body.email || '').trim().toLowerCase();
      const role = VALID_ROLES.has(body.role) ? body.role : 'member';
      const orgId = body.orgId;
      if (!email || !orgId) return { statusCode: 400, body: JSON.stringify({ error: 'orgId and email are required' }) };

      const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations')
        .select('id, name, slug')
        .eq('id', orgId)
        .single();
      if (orgError || !org) return { statusCode: 404, body: JSON.stringify({ error: 'Organization not found' }) };

      let userId;
      const { data: usersResult, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) throw usersError;
      const existing = (usersResult.users || []).find((u) => (u.email || '').toLowerCase() === email);

      if (existing) {
        userId = existing.id;
      } else {
        const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
          redirectTo: process.env.URL,
        });
        if (inviteError) throw inviteError;
        userId = inviteData.user?.id;
      }

      if (!userId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed resolving user id for invite' }) };
      }

      const { error: membershipError } = await supabaseAdmin
        .from('user_organizations')
        .upsert({ user_id: userId, org_id: orgId, role }, { onConflict: 'user_id,org_id' });
      if (membershipError) throw membershipError;

      return { statusCode: 200, body: JSON.stringify({ email, role, org }) };
    }

    if (action === 'list_org_env') {
      const orgId = body.orgId;
      if (!orgId) return { statusCode: 400, body: JSON.stringify({ error: 'orgId is required' }) };

      const { data, error } = await supabaseAdmin
        .from('organization_env_vars')
        .select('id, key_name, updated_at')
        .eq('org_id', orgId)
        .order('updated_at', { ascending: false });
      if (error) throw error;

      return { statusCode: 200, body: JSON.stringify({ variables: data || [] }) };
    }

    if (action === 'upsert_org_env') {
      const orgId = body.orgId;
      const key = (body.key || '').trim();
      const value = `${body.value || ''}`;
      if (!orgId || !key || !value) return { statusCode: 400, body: JSON.stringify({ error: 'orgId, key, value are required' }) };

      const { error } = await supabaseAdmin
        .from('organization_env_vars')
        .upsert({ org_id: orgId, key_name: key, key_value: value }, { onConflict: 'org_id,key_name' });

      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Unexpected error' }),
    };
  }
};
