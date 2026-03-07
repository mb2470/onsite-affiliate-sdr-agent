/**
 * dev-agent.js — API for the Claude Code agent runner.
 *
 * Endpoints (via ?action=...):
 *   GET  ?action=poll           → Returns next pending dev request
 *   POST ?action=claim&id=...   → Mark a request as in_progress
 *   POST ?action=complete       → Mark a request as completed/failed with results
 *   GET  ?action=status&id=...  → Get request status (public)
 */

const { createClient } = require('@supabase/supabase-js');
const { corsHeaders } = require('./lib/cors');

let supabase;

function getSupabaseClient() {
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and service role key are required');
  }

  supabase = createClient(supabaseUrl, supabaseKey);
  return supabase;
}

// Simple bearer token auth for the runner
function authenticateRunner(event) {
  const authHeader = event.headers?.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const expected = process.env.DEV_AGENT_SECRET;
  if (!expected) return false;
  return token === expected;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    const client = getSupabaseClient();

    // Public endpoint: check status
    if (action === 'status' && event.httpMethod === 'GET') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const { data, error } = await client
        .from('dev_requests')
        .select('id, title, type, status, priority, branch_name, result_summary, created_at, started_at, completed_at')
        .eq('id', id)
        .limit(1)
        .single();

      if (error) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ request: data }) };
    }

    // All other actions require runner auth
    if (!authenticateRunner(event)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Poll: get next pending request
    if (action === 'poll' && event.httpMethod === 'GET') {
      const { data, error } = await client
        .from('dev_requests')
        .select('*')
        .eq('status', 'pending')
        .order('priority', { ascending: true }) // critical first (alphabetical: critical < high < low < medium)
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      if (error || !data) {
        return { statusCode: 200, headers, body: JSON.stringify({ request: null, message: 'No pending requests' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ request: data }) };
    }

    // Claim: mark as in_progress
    if (action === 'claim' && event.httpMethod === 'POST') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const { data, error } = await client
        .from('dev_requests')
        .update({
          status: 'in_progress',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select();

      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
      if (!data?.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Request already claimed or not found' }) };

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, request: data[0] }) };
    }

    // Complete: mark as completed or failed
    if (action === 'complete' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { id, status, result_summary, error_message, branch_name, files_changed } = body;

      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };
      if (!['completed', 'failed'].includes(status)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'status must be completed or failed' }) };
      }

      const updates = {
        status,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (result_summary) updates.result_summary = result_summary;
      if (error_message) updates.error_message = error_message;
      if (branch_name) updates.branch_name = branch_name;
      if (files_changed) updates.files_changed = files_changed;

      const { data, error } = await client
        .from('dev_requests')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, request: data?.[0] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  } catch (err) {
    console.error('dev-agent error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
