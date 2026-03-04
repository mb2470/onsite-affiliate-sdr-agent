import { supabase } from '../supabaseClient';

let _cachedOrgId = null;

export const getCurrentOrgId = async () => {
  if (_cachedOrgId) return _cachedOrgId;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No authenticated user');

  const { data, error } = await supabase
    .from('user_organizations')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  if (error || !data?.org_id) {
    throw new Error('No organization found for current user');
  }

  _cachedOrgId = data.org_id;
  return _cachedOrgId;
};

export const clearCachedOrgId = () => {
  _cachedOrgId = null;
};

export const resolveOrgId = async (orgId) => orgId || getCurrentOrgId();
