# Organization-level Secrets and Usage Segregation Strategy

## Problem
Netlify environment variables are global per deploy context, which makes it difficult to:
- assign different API keys per customer organization,
- isolate usage/costs per organization,
- rotate credentials independently.

## Recommended model
1. Keep truly platform-global secrets in Netlify env vars (Supabase service key, platform webhooks).
2. Store organization-specific runtime keys in Supabase (`organization_env_vars`).
3. Only server-side code (Netlify functions using service role) can read/write secret values.
4. Every outbound provider request should:
   - resolve `org_id`,
   - fetch org key/value for that provider,
   - emit usage record tagged with `org_id`.

## Data model
Use `organization_env_vars` with:
- `org_id`
- `key_name` (e.g., `APOLLO_API_KEY`, `OPENAI_API_KEY`)
- `key_value` (encrypted at rest if possible)

## Segregated bot/data usage
Create a lightweight usage ledger table (suggested):
- `org_usage_events(id, org_id, provider, metric_type, metric_value, metadata, created_at)`

Then for each function call:
- log tokens/credits/rows processed with `org_id`.
- build dashboards by `org_id` for billing + throttling.

## Guardrails
- Add per-org rate limits and monthly quotas in `agent_settings` or a dedicated `org_limits` table.
- Enforce limits server-side before running expensive workflows.
- Keep UI and row-level security scoped by org membership (already in place via `user_organizations`).
