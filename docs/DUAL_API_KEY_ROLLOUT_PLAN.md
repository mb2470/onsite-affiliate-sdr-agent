# Dual API Key Rollout Plan

## Goal

Add a dual-key provisioning flow so the SDK and integrations do not share one all-purpose key:

- `frontend_events_key`
  - scopes: `["write_events"]`
  - intended for browser-exposed SDK usage only
- `backend_api_key`
  - scopes: `["write_events", "write_orders", "manage.brands"]`
  - intended for trusted server/backend usage only

The frontend key must never be able to write orders or brand settings. The backend key may write events, write orders, and update brand-level portal settings.

## Why This Change

Frontend-distributed keys are public by default. That means the only safe browser key is a narrowly scoped ingestion key. Order writes must stay on a trusted server path.

## Current Repo Status

This repo already has partial control-plane scaffolding, but the key model is not complete yet:

- [`netlify/functions/manage.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/netlify/functions/manage.js)
  - ACP wrapper exists
- [`control_plane/adapters/index.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/control_plane/adapters/index.js)
  - adapter reads `org_id` from `api_keys`
- [`migrations/1772840955961_add_control_plane_tables.sql`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/migrations/1772840955961_add_control_plane_tables.sql)
  - draft `api_keys` table currently uses `tenant_id`
- [`control_plane/domain-pack.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/control_plane/domain-pack.js)
  - domain actions are still empty

Before any provisioning work, the table schema and adapters need to agree on the same tenant column and scope model.

## Reference Implementation

The closest working reference is the sibling repo:

- [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/manage/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/manage/index.ts)
- [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/integrations-shopify-install/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/integrations-shopify-install/index.ts)

That repo already uses:

- one `api_keys` row per key
- hashed key storage
- a `scopes` array on each key
- action-to-scope enforcement at the API layer

## Proposed Design

### 1. Key storage

Use one row per issued key in `api_keys`, tied to one org.

Minimum fields:

- `id`
- `org_id` or `tenant_id` (pick one and use it consistently)
- `prefix`
- `key_hash`
- `name`
- `scopes`
- `status`
- `rate_limit_per_minute`
- `last_used_at`
- `created_at`
- optional `metadata`

Suggested key names:

- `frontend_events`
- `backend_api`

### 2. Provisioning response

Provisioning should return two keys in one response:

```json
{
  "org_id": "uuid",
  "frontend_api_key": "ock_...",
  "backend_api_key": "ock_...",
  "api_key": "ock_..."
}
```

Notes:

- `frontend_api_key` is used by the browser SDK
- `backend_api_key` is used by the Shopify app or other trusted backend
- `api_key` can temporarily alias the backend key for backward compatibility if any consumer still expects a single key
- avoid the old `backend_orders_key` label because the backend key is expected to do more than orders once the Shopify admin starts managing creator landing-page settings

### 3. Scope model

Initial scope set for this rollout:

- `write_events`
- `write_orders`
- `manage.brands`

Required mapping:

- SDK/browser event ingestion endpoints require `write_events`
- order ingestion endpoints require `write_orders`
- creator portal / brand landing-page settings writes require `manage.brands`

### 4. Security posture

Frontend key controls:

- only `write_events`
- lower rate limit than backend key
- no read scopes
- no order scope
- optional domain/origin allowlist later if needed

Backend key controls:

- `write_events`, `write_orders`, and `manage.brands`
- stored only server-side

## Creator Landing Page Integration

The sibling `onsite-affiliate` repo already exposes a brand landing-page settings endpoint:

- [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts)

That endpoint supports:

- public `GET` by `brand_slug` for the creator-facing `/join/:brandSlug` page
- authenticated `POST` requiring `manage.brands` for writes

Current editable fields in that system:

- `logo_url`
- `primary_color`
- `accent_color`
- `headline`
- `description`
- `cta_text`
- `custom_css`

This means the new backend key process should be designed to support not only order sync but also Shopify-admin-driven landing-page customization.

## Planned Work

### Phase 1. Normalize the key schema

Tasks:

- update `api_keys` schema so the tenant/org foreign key is consistent across migration, adapters, and runtime code
- add operational fields needed for managed keys
- decide whether to keep `tenant_id` or rename to `org_id`

Deliverable:

- a single, internally consistent key table contract

### Phase 2. Add dual-key provisioning

Tasks:

- create or extend a trusted provisioning endpoint
- create two keys for the same org during provisioning
- return both keys once in the response
- ensure the backend key includes `manage.brands` so the Shopify app can save creator landing-page settings through a trusted server path

Deliverable:

- install/provision response with `frontend_api_key` and `backend_api_key`

### Phase 3. Enforce scopes at the API layer

Tasks:

- add domain actions or endpoint guards for:
  - events write
  - orders write
- brand settings / creator portal settings write
- reject order writes from frontend key with `403`
- reject brand-settings writes from frontend key with `403`

Deliverable:

- permission boundaries enforced in runtime, not only by convention

### Phase 4. Consumer wiring

Tasks:

- update frontend SDK integration to use only `frontend_api_key`
- update backend/shop integration to store and use `backend_api_key`
- allow the trusted backend key to manage creator landing-page settings through the OCE/OA portal settings write endpoint
- keep temporary backward compatibility where needed

Deliverable:

- split consumers with no browser exposure of the backend key

### Phase 5. Verification

Required checks:

- frontend key can write events
- frontend key cannot write orders
- frontend key cannot update creator portal settings
- backend key can write events
- backend key can write orders
- backend key can update creator portal settings
- revoked key fails
- provisioning returns two distinct keys for the same org

## Likely Files To Change

- [`migrations/1772840955961_add_control_plane_tables.sql`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/migrations/1772840955961_add_control_plane_tables.sql)
- [`control_plane/adapters/index.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/control_plane/adapters/index.js)
- [`control_plane/domain-pack.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/control_plane/domain-pack.js)
- [`netlify/functions/manage.js`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/netlify/functions/manage.js)
- possible new provisioning endpoint under [`netlify/functions`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/netlify/functions)
- docs describing provisioning and key usage

## Rollout Notes

- Do not let the SDK request or mint keys directly.
- Do not expose the backend key in client-rendered HTML, browser storage, or public config.
- Do not expose `manage.brands` capability to browser code.
- Keep the first rollout additive and backward compatible.
- Remove the legacy single-key response only after downstream consumers are migrated.

## Status

Documentation only. No runtime implementation has been started in this repo yet.
