const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-org-id',
};

type Draft = {
  title: string;
  type: 'bug' | 'feature' | 'task';
  priority: 'low' | 'medium' | 'high' | 'critical';
  spec: string;
};

const DEFAULT_SPEC = (requestText: string) => `# Task
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

const safeParseJson = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text);
  } catch {
    // Claude may wrap with prose/code fences; extract first JSON object.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const sanitizeDraft = (input: Record<string, unknown> | null, requestText: string): Draft => {
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
};

async function draftRequestWithClaude(requestText: string, apiKey: string): Promise<Draft> {
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

  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
  const parsed = safeParseJson(text);
  return sanitizeDraft(parsed, requestText);
}

async function insertDevRequest(row: Record<string, unknown>, supabaseUrl: string, serviceKey: string) {
  const res = await fetch(`${supabaseUrl}/rest/v1/dev_requests`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Insert dev request failed: ${res.status} ${errorText}`);
  }

  const rows = await res.json() as Array<Record<string, unknown>>;
  return rows?.[0] || null;
}

export default async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: JSON_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: JSON_HEADERS });
  }

  try {
    const { message, org_id, user_email } = await request.json() as { message?: string; org_id?: string; user_email?: string };
    if (!message || !message.trim()) {
      return new Response(JSON.stringify({ error: 'message is required' }), { status: 400, headers: JSON_HEADERS });
    }

    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
    const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL') || Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY');

    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Supabase server environment variables missing' }), { status: 500, headers: JSON_HEADERS });
    }

    const draft = anthropicApiKey
      ? await draftRequestWithClaude(message.trim(), anthropicApiKey)
      : sanitizeDraft(null, message.trim());

    const row: Record<string, unknown> = {
      title: draft.title,
      type: draft.type,
      spec: draft.spec,
      priority: draft.priority,
      status: 'pending',
      requested_by: user_email || 'chat_assistant_edge',
    };

    if (org_id) row.org_id = org_id;

    const inserted = await insertDevRequest(row, supabaseUrl, serviceKey);

    return new Response(JSON.stringify({
      success: true,
      request_id: inserted?.id || null,
      request: inserted,
      draft,
      message: `Dev request submitted. Track it with ID: ${inserted?.id || 'unknown'}`,
    }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unexpected error',
    }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
