# Multi-Tenant Migration Status Review

Date: 2026-03-03

## Executive Summary

Based on a codebase review, your migration appears to be:

- **Step 1 (DB schema): Implemented in SQL files**
- **Step 2 (RLS policies): Implemented in SQL files**
- **Step 3 (Frontend services org context): Partially implemented**
- **Step 4 (App org selector/switcher): Partially implemented**
- **Step 5 (Netlify functions org scoping): Partially implemented**
- **Step 6 (Python agent org scoping): Not implemented yet**

## Step-by-step assessment

### 1) DB Schema — ✅ Implemented (migration authored)

`supabase/add_multi_tenant.sql` creates:

- `organizations`
- `user_organizations`
- `org_id` columns on core data tables (`leads`, `contacts`, `emails`, `agent_jobs`, `icp_profiles`, `audit_log`, `contact_database`, `outreach_log`, `activity_log`, `agent_settings`)
- `get_user_org_ids()` helper function

Backfill scripts are also present:

- `supabase/backfill_step1_create_org.sql`
- `supabase/backfill_step2_core_tables.sql`
- `supabase/backfill_step3_optional_tables.sql`

### 2) RLS Policies — ✅ Implemented (migration authored)

`supabase/add_rls_policies.sql` drops permissive policies and replaces them with org-scoped policies using `org_id IN (SELECT get_user_org_ids())` across key tables.

### 3) Frontend Services — ⚠️ Partial

Some UI paths already resolve/pass org context, especially in `OutreachManager.jsx` and its downstream Netlify calls.

However, core services still run global queries without explicit org scoping in code, e.g.:

- `src/services/leadService.js`
- `src/services/contactService.js`
- many direct `supabase.from(...)` queries inside `src/App.jsx`

These may still work correctly under strict RLS for anon/auth client access, but they are not fully explicit and not yet aligned with your "pass org context through all queries" target.

### 4) App.jsx Org Selector/Switcher — ⚠️ Partial

There is org resolution in `OutreachManager.jsx` (first org for the user), but there is **no full app-level org switcher/context in `App.jsx`** and no org passed through app-wide service calls.

### 5) Netlify Functions — ⚠️ Partial

A newer group of functions is org-aware (e.g., `smartlead-email`, `cloudflare-domains`, `zoho-mail`, `gmail-inbox`) and requires/passes `org_id`.

But many existing functions that read/write Supabase are still not org-aware (examples):

- `apollo-find-contacts`
- `import-leads`
- `send-email`
- `verify-emails`
- several background enrichment/storeleads functions

So this step is in-progress, not complete.

### 6) Python Agent — ❌ Not started for org scoping

`agent/ai_sdr_agent.py` currently does not accept an `org_id` input or apply `org_id` filters in Supabase queries.

Given service-role usage, it can currently access cross-tenant data unless explicit org constraints are added in code.

## Recommended next milestone order

1. **Implement App-level org context**
   - Add an org provider in `App.jsx`.
   - Add org selector/switcher (if multi-org user).
   - Pass selected org to services/components.

2. **Refactor frontend service APIs to require `orgId`**
   - Update signatures in `leadService`, `contactService`, `emailService`, `exportService`, `enrichService`.
   - Add `.eq('org_id', orgId)` on all relevant CRUD calls.

3. **Standardize Netlify function contract**
   - Require `org_id` in request body/header for all functions that touch tenant data.
   - Add org filters on every Supabase query.

4. **Add Python agent org scoping**
   - Add CLI/env arg for org_id (`--org-id` / `ORG_ID`).
   - Enforce `.eq('org_id', org_id)` or equivalent filters on all table operations.

5. **Lock in with smoke checks**
   - Add a tenant-isolation test checklist (manual or scripted):
     - user A cannot see user B rows in frontend
     - function requests without org_id fail
     - agent run for org A does not touch org B rows

