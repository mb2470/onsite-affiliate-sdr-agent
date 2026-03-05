-- Super-admin support for organization-level variable management.
-- Run this migration in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS organization_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  key_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_org_env_vars_org_id ON organization_env_vars(org_id);

DROP TRIGGER IF EXISTS update_organization_env_vars_updated_at ON organization_env_vars;
CREATE TRIGGER update_organization_env_vars_updated_at
  BEFORE UPDATE ON organization_env_vars
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE organization_env_vars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view env vars for their organizations" ON organization_env_vars;
CREATE POLICY "Users can view env vars for their organizations"
  ON organization_env_vars FOR SELECT
  USING (org_id = ANY(get_user_org_ids()));

DROP POLICY IF EXISTS "Only service role can mutate organization env vars" ON organization_env_vars;
CREATE POLICY "Only service role can mutate organization env vars"
  ON organization_env_vars FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
