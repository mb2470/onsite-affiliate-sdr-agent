-- Add use_prospect_db toggle to agent_settings.
-- When TRUE, the agent uses the prospects pipeline instead of the leads pipeline.
-- Default FALSE so existing deployments continue using leads.

ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS use_prospect_db BOOLEAN DEFAULT FALSE;
