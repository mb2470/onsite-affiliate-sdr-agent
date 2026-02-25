-- ============================================
-- Backfill Step 1: Create org + link user
-- ============================================
-- Run this FIRST in the Supabase SQL Editor.
-- It is fast and should not time out.
-- ============================================

-- Increase timeout for this session just in case
SET statement_timeout = '120s';

-- 1. Create the default organization
INSERT INTO organizations (id, name, slug)
VALUES (
  gen_random_uuid(),
  'Onsite Affiliate',
  'onsite-affiliate'
)
ON CONFLICT (slug) DO NOTHING;

-- 2. Link the first user as owner
DO $$
DECLARE
  v_org_id UUID;
  v_user_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'onsite-affiliate';
  SELECT id INTO v_user_id FROM auth.users LIMIT 1;

  IF v_user_id IS NOT NULL AND v_org_id IS NOT NULL THEN
    INSERT INTO user_organizations (user_id, org_id, role)
    VALUES (v_user_id, v_org_id, 'owner')
    ON CONFLICT (user_id, org_id) DO NOTHING;
  END IF;
END $$;

-- Verify
SELECT o.id AS org_id, o.name, uo.user_id, uo.role
FROM organizations o
JOIN user_organizations uo ON uo.org_id = o.id
WHERE o.slug = 'onsite-affiliate';
