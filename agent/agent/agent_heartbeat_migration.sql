-- Add heartbeat column to agent_settings table for monitoring

ALTER TABLE agent_settings 
ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;

-- Add comment
COMMENT ON COLUMN agent_settings.last_heartbeat IS 'Last time the autonomous agent checked in (heartbeat)';

-- Create index for faster heartbeat checks
CREATE INDEX IF NOT EXISTS idx_agent_settings_heartbeat ON agent_settings(last_heartbeat);

-- Add agent_processed column to leads table
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS agent_processed BOOLEAN DEFAULT FALSE;

-- Add index
CREATE INDEX IF NOT EXISTS idx_leads_agent_processed ON leads(agent_processed, status, icp_fit);

-- Create view for agent monitoring
CREATE OR REPLACE VIEW agent_health AS
SELECT 
  agent_enabled,
  auto_send,
  max_emails_per_day,
  emails_sent_today,
  last_heartbeat,
  CASE 
    WHEN last_heartbeat IS NULL THEN 'never_ran'
    WHEN last_heartbeat > NOW() - INTERVAL '2 minutes' THEN 'healthy'
    WHEN last_heartbeat > NOW() - INTERVAL '5 minutes' THEN 'warning'
    ELSE 'offline'
  END as health_status,
  EXTRACT(EPOCH FROM (NOW() - last_heartbeat))/60 as minutes_since_heartbeat
FROM agent_settings;

-- Sample query to check agent health
-- SELECT * FROM agent_health;
