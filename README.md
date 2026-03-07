# AI SDR Agent (Onsite Affiliate)

Production-oriented SDR workflow for **lead intake, enrichment, contact discovery, verification, and outreach**.

This repository combines:
- A React/Vite operations UI (`src/`)
- Netlify Functions for enrichment + outreach APIs (`netlify/functions/`)
- Supabase for auth, multi-tenant data, and pipeline state (`supabase/`)
- Optional Python autonomous runner for scheduled batch sends + follow-ups (`agent/`)

---

## What the app does today

- Supports **multi-tenant organizations** with user-to-org mapping and org-scoped data access.  
- Ingests leads via single add, bulk add, CSV, and StoreLeads discovery pathways.  
- Runs an enrichment waterfall: **StoreLeads → Apollo org enrichment → Claude web research fallback**.  
- Scores lead ICP fit (`HIGH` / `MEDIUM` / `LOW`) using configurable thresholds from the ICP profile.  
- Finds contacts from internal `contact_database` first, then Apollo fallback discovery.  
- Uses a verification waterfall at send time: cached Apollo status + ELV where needed.  
- Sends outreach through Gmail API, records activity/outreach logs, and tracks replies/bounces/follow-ups.  
- Exposes monitoring and controls in the UI for manual + semi-autonomous workflows.

---

## High-level architecture

```text
React UI (Vite)
  ├─ Supabase Auth + RLS-scoped reads/writes
  ├─ Netlify Functions (serverless APIs)
  │   ├─ enrichment (storeleads/apollo/claude)
  │   ├─ contacts + verification
  │   ├─ gmail send / inbox / bounce / reply checks
  │   └─ smartlead + cloudflare integration endpoints
  └─ Supabase Postgres (leads, contacts, outreach logs, agent jobs, ICP profile)

Optional: Python agent/ai_sdr_agent.py for autonomous send windows and follow-ups.
```

Detailed visual flow lives in [`lead-workflow.mermaid`](./lead-workflow.mermaid).

---

## Repository layout

- `src/` — Frontend app (auth, lead views, enrichment workflows, outreach workflows, monitor).  
- `src/services/` — Frontend service layer for Supabase + function calls.  
- `netlify/functions/` — Serverless endpoints for enrichment, email, verification, discovery, and utilities.  
- `netlify/functions/lib/` — Shared helpers (CORS, ICP scoring, Apollo verification helpers, QA prompt).  
- `supabase/` — SQL schema + migrations for core SDR tables and multi-tenant support.  
- `agent/` — Python automation runner and supporting scripts.  
- `docs/` — Setup and migration notes.

-----

## Core pipeline tables (Supabase)

Primary tables used by the app:
- `organizations`, `user_organizations` (tenant mapping)
- `leads` (company-level funnel state)
- `contacts` and `contact_database` (discovered + imported contacts)
- `emails` and `outreach_log` (message content + delivery trail)
- `activity_log` (audit trail by action)
- `agent_jobs` (queued/background pipeline jobs)
- `icp_profiles`, `agent_settings` (org-level configuration)

See `supabase/schema.sql` for canonical definitions.

---

## Local development

### 1) Prerequisites

- Node.js 18+
- npm
- Supabase project (URL + keys)
- Netlify CLI (recommended for function routing)

### 2) Install

```bash
npm install
```

### 3) Environment variables

Create `.env` (or configure in Netlify) with at minimum:

```bash
# Frontend/Supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# AI / Enrichment
ANTHROPIC_API_KEY=
APOLLO_API_KEY=
STORELEADS_API_KEY=

# Email verification + send
EMAILLISTVERIFY_API_KEY=
GMAIL_OAUTH_CREDENTIALS=
GMAIL_FROM_EMAIL=

# Optional integrations
SMARTLEAD_API_KEY=
SMARTLEAD_WEBHOOK_SECRET=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
```

### 4) Run app + functions

```bash
npm run dev
```

For redirect/function parity with production, run through Netlify Dev if available:

```bash
netlify dev
```

### 5) Build

```bash
npm run build
```

---

## Python autonomous agent (optional)

The Python runner can execute send windows, follow-ups, bounce checks, and batch verification.

```bash
cd agent
pip install -r requirements.txt
python ai_sdr_agent.py status
python ai_sdr_agent.py auto
```

Use this when you want unattended cadence outside of the manual UI workflows.

---

## Operational notes

- Org scoping is expected everywhere (`org_id`) to keep tenants isolated.
- Contact verification is cached with timestamps to avoid repeated paid API calls.
- Bounced addresses are suppressed and cleaned from contact tables.
- Gmail OAuth credentials are required for live sends and inbox checks.
- Some legacy docs in this repo are historical; the source of truth is the code + schema in this branch.

---

## Related docs

- `lead-workflow.mermaid` — current end-to-end flow diagram
- `supabase/schema.sql` — baseline schema
- `docs/GMAIL_SETUP.md` — Gmail integration setup
- `APOLLO_SETUP.md` — Apollo setup notes
- `GOOGLE_SHEETS_GUIDE.md` / `PRIVATE_SHEETS_SETUP.md` — sheet integration options
