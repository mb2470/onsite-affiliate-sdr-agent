const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-org-id',
};

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

const DEFAULT_SPEC = (requestText) => `# Task
${requestText}

# Business goal
Improve implementation quality and turnaround for this requested change.

# Scope
- In scope:
  - Implement the requested behavior.
  - Keep existing flows working.
- Out of scope:
  - Large unrelated refactors.

# Repository context
- Frontend: src/ (React/Vite)
- Backend: netlify/functions/ (Netlify Functions)
- DB: supabase/ (schema + migrations)

# Constraints
- Preserve multi-tenant org isolation (org_id).
- Keep CORS + OPTIONS handling where applicable.
- No secrets in source code.

# Acceptance criteria
- [ ] Requested behavior is implemented.
- [ ] No regressions in existing flow.
- [ ] Errors are handled with clear user-facing messages.

# Test plan
- Manual verification of the changed flow.
- Build/lint checks pass.
`;

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeDraft(input, requestText) {
  const type = input?.type;
  const priority = input?.priority;

  return {
    title: typeof input?.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 140)
      : `Dev request: ${requestText.slice(0, 110)}`,
    type: type === 'bug' || type === 'feature' || type === 'task' ? type : 'feature',
    priority: priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'critical'
      ? priority
      : 'medium',
    spec: typeof input?.spec === 'string' && input.spec.trim()
      ? input.spec.trim()
      : DEFAULT_SPEC(requestText),
  };
}

async function draftRequestWithClaude(requestText, apiKey) {
  const systemPrompt = `You convert a user feature/bug request into a structured engineering request.
Return JSON only with keys: title, type, priority, spec.
Rules:
- type must be one of: bug, feature, task
- priority must be one of: low, medium, high, critical
- spec must use this markdown structure:
  # Task
  # Business goal
  # Scope
  # Repository context
  # Constraints
  # Files likely involved
  # Acceptance criteria
  # Test plan
- Keep practical and implementation-ready.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: requestText }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude draft failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
  const parsed = safeParseJson(text);
  return sanitizeDraft(parsed, requestText);
}

function getBearerToken(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim() || null;
}

async function fetchAuthenticatedUser(token) {
  const { data: { user }, error } = await createClient(supabaseUrl, anonKey || serviceKey)
    .auth.getUser(token);

  if (error || !user?.id) {
    throw new Error('Invalid auth token');
  }

  return { id: user.id, email: user.email };
}

async function resolveAuthorizedOrgId(userId, requestedOrgId) {
  let query = supabase
    .from('user_organizations')
    .select('org_id')
    .eq('user_id', userId)
    .limit(1);

  if (requestedOrgId) {
    query = query.eq('org_id', requestedOrgId);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Org authorization lookup failed: ${error.message}`);

  const resolvedOrgId = data?.[0]?.org_id;
  if (!resolvedOrgId) {
    throw new Error(requestedOrgId
      ? 'Authenticated user is not a member of the specified org_id'
      : 'Authenticated user does not belong to any organization');
  }

  return resolvedOrgId;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!supabaseUrl || !serviceKey) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Supabase server environment variables missing' }) };
    }

    const { message, org_id, user_email } = JSON.parse(event.body || '{}');
    if (!message || !message.trim()) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'message is required' }) };
    }

    const token = getBearerToken(event.headers || {});
    if (!token) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing bearer token' }) };
    }

    const authUser = await fetchAuthenticatedUser(token);
    const requestedOrgId = event.headers['x-org-id'] || org_id || null;
    const authorizedOrgId = await resolveAuthorizedOrgId(authUser.id, requestedOrgId);

    const draft = anthropicApiKey
      ? await draftRequestWithClaude(message.trim(), anthropicApiKey)
      : sanitizeDraft(null, message.trim());

    const row = {
      title: draft.title,
      type: draft.type,
      spec: draft.spec,
      priority: draft.priority,
      status: 'pending',
      requested_by: authUser.email || user_email || 'chat_assistant',
      org_id: authorizedOrgId,
    };

    const { data, error } = await supabase
      .from('dev_requests')
      .insert([row])
      .select();

    if (error) throw new Error(`Insert dev request failed: ${error.message}`);

    const inserted = data?.[0] || null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        request_id: inserted?.id || null,
        request: inserted,
        draft,
        message: `Dev request submitted. Track it with ID: ${inserted?.id || 'unknown'}`,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unexpected error',
      }),
    };
  }
};
