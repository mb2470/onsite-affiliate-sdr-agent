-- Dev requests table: tracks development tasks submitted by the in-app AI assistant
-- to be picked up by a Claude Code agent runner.

CREATE TABLE IF NOT EXISTS dev_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'feature' CHECK (type IN ('bug', 'feature', 'task')),
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  branch_name TEXT,
  result_summary TEXT,
  error_message TEXT,
  files_changed TEXT[],
  requested_by TEXT DEFAULT 'chat_assistant',
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for polling new requests
CREATE INDEX IF NOT EXISTS idx_dev_requests_status ON dev_requests(status);
CREATE INDEX IF NOT EXISTS idx_dev_requests_org_id ON dev_requests(org_id);

-- RLS policies
ALTER TABLE dev_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org dev requests"
  ON dev_requests FOR SELECT
  USING (org_id = auth.uid()::uuid OR org_id IN (
    SELECT id FROM organizations WHERE id = org_id
  ));

CREATE POLICY "Service role full access to dev_requests"
  ON dev_requests FOR ALL
  USING (true)
  WITH CHECK (true);
