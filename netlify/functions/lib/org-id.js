/**
 * Resolve org_id for server-side functions.
 *
 * Priority:
 *   1. Explicit org_id from request body / caller
 *   2. First org from agent_settings (always has org_id)
 *   3. First row from organizations table (single-tenant fallback)
 *
 * Usage:
 *   const { resolveOrgId } = require('./lib/org-id');
 *   const orgId = await resolveOrgId(supabase, bodyOrgId);
 */

async function resolveOrgId(supabase, explicitOrgId) {
  if (explicitOrgId) return explicitOrgId;

  // Try agent_settings first (always has org_id)
  const { data: settings } = await supabase
    .from('agent_settings')
    .select('org_id')
    .limit(1)
    .single();
  if (settings?.org_id) return settings.org_id;

  // Fallback: first org
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .limit(1)
    .single();
  return org?.id || null;
}

module.exports = { resolveOrgId };
