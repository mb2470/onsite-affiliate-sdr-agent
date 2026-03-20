# Metrics & Data Flow Reference

> **Keep this file updated** whenever metrics calculations, database writes, or dashboard queries change.
> AI assistants should reference this file when answering questions about how metrics work.

---

## Database Tables (Source of Truth)

### `outreach_log` — Every email sent
The **primary record** of all emails sent. Both the Netlify `send-email.js` function and the Python agent write here.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `lead_id` | uuid | FK to `leads` |
| `website` | text | Company website (denormalized from lead) |
| `contact_email` | text | Recipient email address |
| `contact_name` | text | Recipient name |
| `email_subject` | text | Subject line sent |
| `email_body` | text | Email body sent |
| `sent_at` | timestamptz | When the email was sent (DEFAULT NOW()) |
| `followup_number` | int | 0 = initial, 1 = first follow-up, 2 = second follow-up |
| `gmail_message_id` | text | Gmail API message ID |
| `gmail_thread_id` | text | Gmail thread ID (for threading follow-ups) |
| `rfc_message_id` | text | RFC 2822 Message-ID header (for In-Reply-To) |
| `parent_outreach_id` | uuid | Links follow-ups back to the initial outreach row |
| `replied` | boolean | Whether the prospect replied |
| `replied_at` | timestamptz | When the reply was detected (set by `check-replies.js`) |

### `activity_log` — Audit trail for all events
Every significant action (email sent, reply detected, bounce, enrichment, etc.) gets a row here.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `activity_type` | text | Event type (see below) |
| `lead_id` | uuid | Associated lead (nullable) |
| `summary` | text | Human-readable description |
| `status` | text | `'success'` or `'failed'` |
| `created_at` | timestamptz | When the event occurred |

**Activity types used for metrics:**
| `activity_type` | Meaning | Written by |
|-----------------|---------|------------|
| `email_sent` | Email sent via Gmail | `send-email.js`, Python agent |
| `email_exported` | Email exported via Gmail (legacy) | `exportService.js` |
| `email_reply` | Reply detected from a prospect | `check-replies.js` |
| `email_bounced` | Bounce detected from Gmail | `check-bounces.js` |
| `email_failed` | Send attempt failed | `send-email.js`, Python agent |
| `email_verified` | Email address verification result | `send-email.js`, Python agent |
| `followup_sent` | Follow-up email sent | Python agent |
| `lead_enriched` | Lead data enriched | Various enrichment flows |
| `contacts_found` | Contacts discovered for a lead | Contact matching flows |

### `leads` — Lead status tracking
The `status` field tracks where a lead is in the pipeline:
- `new` — Just imported, not enriched
- `enriched` — Enriched with ICP data + has contacts available
- `contacted` — At least one email sent
- `replied` — Prospect replied to an outreach email

### `email_accounts` — Sender account tracking
Tracks per-sender daily usage for multi-sender rotation.

| Column | Type | Description |
|--------|------|-------------|
| `email_address` | text | Sender email (e.g., sam@onsiteaffiliate.com) |
| `daily_send_limit` | int | Max emails per day for this account |
| `current_daily_sent` | int | How many sent today (resets daily) |
| `status` | text | `'active'`, `'ready'`, `'warming'` |

### `emails` table — NOT used for metrics
This is a legacy table. **Do not query it for metrics.** All email metrics come from `outreach_log`.

### `daily_stats` table — NOT used
This table may not exist or be populated. **Do not query it.**

### `email_reporting_daily` — DEPRECATED / DROPPED
This table was a write-only rollup that no dashboard ever consumed. It has been dropped.
All email metrics come from `outreach_log` + `activity_log` directly.

---

## Where Data Is Written

### Path 1: Netlify `send-email.js` (frontend sends)
**File:** `netlify/functions/send-email.js`

When an email is sent from the web UI:
1. **Verifies email** — Apollo People Match API, then EmailListVerify (ELV) waterfall
2. **Sends via Gmail** — Using OAuth credentials
3. **Writes `outreach_log`** — One row per recipient, includes `org_id` (line ~569)
4. **Updates `leads`** — Sets `status = 'contacted'`, `has_contacts = true` (line ~592)
5. **Writes `activity_log`** — `activity_type = 'email_sent'` with `org_id` (line ~600)
6. **Increments `email_accounts.current_daily_sent`** (line ~586)

### Path 2: Python agent `ai_sdr_agent.py` (autonomous sends)
**File:** `agent/ai_sdr_agent.py`

When the agent sends an initial email (`_send_one()`, line ~1071):
1. **Finds contacts** from `contact_database` by domain match
2. **Verifies email** — Apollo, then ELV waterfall
3. **Generates email** via Claude (claude-sonnet-4-20250514)
4. **Sends via Gmail** API
5. **Writes `outreach_log`** — Includes `org_id` via `_resolve_org_id()` (line ~1184)
6. **Updates `leads`** — Sets `status = 'contacted'` (line ~1199)
7. **Writes `activity_log`** — Via `_log('email_sent', ...)` which includes `org_id` (line ~884)
8. **Increments `email_accounts.current_daily_sent`** via `_record_sender_success()` (line ~1011)

When the agent sends a follow-up (`process_followups()`, line ~1590):
1. **Queries `outreach_log`** for candidates due for follow-up (3 days for FU#1, 5 days for FU#2)
2. **Generates follow-up** via Claude with specific follow-up system prompts
3. **Sends as Gmail reply** (threaded using `gmail_thread_id` and `In-Reply-To` header)
4. **Writes `outreach_log`** — With `followup_number` (1 or 2), `parent_outreach_id`, and `org_id` (line ~1672)
5. **Writes `activity_log`** — `activity_type = 'followup_sent'` with `org_id`

### Path 3: `check-replies.js` (reply detection)
**File:** `netlify/functions/check-replies.js`

Triggered manually via the "Check Replies" button or by the Python agent:
1. **Queries `outreach_log`** — Gets last 500 sent emails (scoped by `org_id`)
2. **Searches Gmail** — `from:{contact_email} newer_than:30d` in batches of 10
3. **Filters auto-responders** — OOO, vacation, delivery failure patterns
4. **Deduplicates** — Skips emails already in `activity_log` as `email_reply`
5. **Writes `activity_log`** — `activity_type = 'email_reply'` with `org_id` (line ~245)
6. **Updates `outreach_log`** — Sets `replied_at` on matching rows (line ~254)
7. **Updates `leads`** — Sets `status = 'replied'` (line ~261)

### Path 4: `check-bounces.js` (bounce detection)
**File:** `netlify/functions/check-bounces.js`

Triggered manually or by the Python agent:
1. **Searches Gmail** — For bounce/delivery failure notifications
2. **Deduplicates** — Skips bounces already logged in `activity_log`
3. **Removes contact** from `contact_database` (line ~166)
4. **Resets lead** to `status = 'enriched'` if no other outreach exists (line ~216)
5. **Writes `activity_log`** — `activity_type = 'email_bounced'`, `status = 'failed'` with `org_id` (line ~227)

---

## How Each Metric Is Calculated

### Emails Sent (lifetime)
**Displayed in:** App.jsx header bar
**State:** `emailsSent`
**Calculation:** (App.jsx line ~280)
```
Total outreach_log rows (org_id scoped)
  MINUS outreach_log rows where contact_email is in the bounced set
```
The bounced set is built by parsing `activity_log` rows where `activity_type = 'email_bounced'`, extracting the email from the `summary` field via regex: `/Bounced:\s+(\S+@\S+)/i`

### Contacted — Leads & Contacts
**Displayed in:** App.jsx header bar ("Contacted" section)
**State:** `outreachStats.uniqueLeads`, `outreachStats.uniqueContacts`
**Calculation:** (App.jsx line ~317)
```
1. Paginate ALL outreach_log rows (org_id scoped, 1000 per page)
2. Build bounced email set (same as above)
3. Filter out rows where contact_email is bounced
4. uniqueLeads = COUNT(DISTINCT lead_id or website)
5. uniqueContacts = COUNT(DISTINCT contact_email)
```

### Response Rate — Leads & Contacts
**Displayed in:** App.jsx header bar ("Response Rate" section)
**State:** Derived from `outreachStats`
**Calculation:** (App.jsx line ~1345)
```
Lead response rate  = repliedLeads / uniqueLeads * 100
Contact response rate = repliedContacts / uniqueContacts * 100
```
Where `repliedLeads` / `repliedContacts` are the unique leads/contacts from outreach_log rows where `replied_at IS NOT NULL` (after filtering out bounced).

### Deliverability (trailing 7 days)
**Displayed in:** App.jsx header bar ("Deliverability (7d)" section)
**State:** `deliverabilityStats`
**Calculation:** (App.jsx line ~376)
```
sent     = COUNT(outreach_log) WHERE sent_at >= 7 days ago AND org_id = X
bounced  = COUNT(activity_log) WHERE activity_type = 'email_bounced'
             AND created_at >= 7 days ago AND org_id = X
delivered = sent - MIN(bounced, sent)
percent   = delivered / sent * 100
```

### Pipeline Stats (Contacted / % Contacted)
**Displayed in:** App.jsx Pipeline view
**State:** `pipelineStats`
**Calculation:** (App.jsx line ~899)
```
totalWithContacts = COUNT(leads) WHERE has_contacts = true AND org_id = X
contacted = COUNT(leads WHERE status = 'contacted') + COUNT(leads WHERE status = 'replied')
pctContacted = contacted / totalWithContacts * 100
```

### Emails Today (Agent Monitor)
**Displayed in:** AgentMonitor.jsx top stats
**State:** `stats.emailsToday`
**Calculation:** (AgentMonitor.jsx `loadData`)
```
COUNT(activity_log) WHERE activity_type IN ('email_sent', 'email_exported')
  AND created_at >= today midnight AND org_id = X
```

### Replies Today (Agent Monitor)
**Displayed in:** AgentMonitor.jsx top stats
**State:** `stats.repliesToday`
**Calculation:** (AgentMonitor.jsx `loadData`)
```
COUNT(activity_log) WHERE activity_type = 'email_reply'
  AND created_at >= today midnight AND org_id = X
```

### Performance by Date Range (Agent Monitor)
**Displayed in:** AgentMonitor.jsx "Performance" card (today / 7 days / 30 days / custom)
**State:** `rangeStats`
**Calculation:** (AgentMonitor.jsx `loadRangeStats`)
```
sent    = COUNT(activity_log) WHERE activity_type IN ('email_sent', 'email_exported')
            AND created_at BETWEEN start AND end AND org_id = X
replies = COUNT(activity_log) WHERE activity_type = 'email_reply'
            AND created_at BETWEEN start AND end AND org_id = X
bounces = COUNT(activity_log) WHERE activity_type = 'email_bounced'
            AND created_at BETWEEN start AND end AND org_id = X
replyRate = replies / sent * 100
```

### Daily Limit Enforcement
**Checked by:** `send-email.js` (line ~322) and Python agent `_get_remaining_today()` (line ~918)
**Calculation:**
```
sentToday = COUNT(outreach_log) WHERE sent_at >= today midnight AND org_id = X
remaining = agent_settings.max_emails_per_day - sentToday
```
**Note:** The Netlify function also enforces per-sender limits from `email_accounts.daily_send_limit`.

---

## Agent Guardrails

These are the rules the Python agent (`ai_sdr_agent.py`) operates within, controlled via `agent_settings`:

| Setting | Column | Default | Description |
|---------|--------|---------|-------------|
| Agent enabled | `agent_enabled` | false | Master on/off switch |
| Auto-send | `auto_send` | false | If false, emails are drafted for review |
| Max emails/day | `max_emails_per_day` | 20 | Global daily cap (all senders combined) |
| Min gap between sends | `min_minutes_between_emails` | 10 | Minimum wait between consecutive sends |
| Send hours (EST) | `send_hour_start` / `send_hour_end` | 9-17 | Only sends during these hours (US/Eastern) |
| Send days | `send_days` | [1,2,3,4,5] | Mon-Fri only (ISO weekday numbers) |
| Allowed ICP fits | `allowed_icp_fits` | ['HIGH'] | Which ICP tiers to contact |
| Max contacts per lead/day | `max_contacts_per_lead_per_day` | 1 | Limits per-company sends per day |

### Email Verification Waterfall
Before any email is sent, it goes through a two-step verification:
1. **Apollo People Match API** — Returns `verified`, `extrapolated`, `catch_all`, `unavailable`, or `invalid`
   - `verified` → Send immediately
   - `invalid` → Discard and remove from `contact_database`
   - All others → Route to step 2
2. **EmailListVerify (ELV)** — Returns detailed status
   - Safe: `ok`, `ok_for_all`, `accept_all` → Send
   - Unsafe: `invalid`, `email_disabled`, `dead_server`, `syntax_error` → Block
   - Verification results cached for 30 days on `contacts` and `contact_database` tables

### Follow-Up Sequence
- **Follow-up #1:** 3 days after initial email, under 60 words, gentle nudge
- **Follow-up #2:** 5 days after follow-up #1, under 70 words, new perspective
- Follow-ups are threaded as Gmail replies (same thread)
- No follow-up sent if prospect already replied (`replied_at IS NOT NULL`)

### Messaging Rules (enforced via Claude system prompt)
- Always say "onsite commissions" (never "performance commissions")
- Always say "creators review products" and "creator UGC"
- Never say "Tap into Amazon's creators" or generic greetings like "Hey there"
- Always address by first name: "Hey {firstName} -"
- Initial emails: under 90 words
- Signature: "Sam Reid / OnsiteAffiliate.com"

---

## Data Flow Diagram

```
                    ┌──────────────────────┐
                    │  Web UI (App.jsx)    │
                    │  sends email         │
                    └──────┬───────────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │  send-email.js        │
               │  (Netlify Function)   │
               │                       │
               │  1. Verify (Apollo→ELV)│
               │  2. Send via Gmail    │
               │  3. Write outreach_log│
               │  4. Write activity_log│
               │  5. Update leads      │
               └───────────────────────┘

                    ┌──────────────────────┐
                    │  Python Agent        │
                    │  (ai_sdr_agent.py)   │
                    │                       │
                    │  1. Pick lead (HIGH)  │
                    │  2. Find contacts     │
                    │  3. Verify (Apollo→ELV)│
                    │  4. Generate (Claude) │
                    │  5. Send via Gmail    │
                    │  6. Write outreach_log│
                    │  7. Write activity_log│
                    │  8. Update leads      │
                    │  9. Process follow-ups│
                    └──────────────────────┘

                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │ outreach_log │ │  leads   │ │ activity_log │
     │              │ │          │ │              │
     │ Every email  │ │ status:  │ │ Every event: │
     │ sent + reply │ │ enriched │ │ sent, reply, │
     │ tracking     │ │ contacted│ │ bounce, etc. │
     │              │ │ replied  │ │              │
     └──────┬───────┘ └──────────┘ └──────┬───────┘
            │                              │
            ▼                              ▼
     ┌──────────────┐              ┌──────────────┐
     │check-replies │              │check-bounces │
     │              │              │              │
     │ Scan Gmail → │              │ Scan Gmail → │
     │ Update       │              │ Log bounce   │
     │ replied_at   │              │ Remove contact│
     │ + lead status│              │ Reset lead   │
     └──────────────┘              └──────────────┘

              │                              │
              ▼                              ▼
     ┌─────────────────────────────────────────────┐
     │              FRONTEND DASHBOARDS            │
     │                                             │
     │  App.jsx header:                            │
     │    - Emails Sent (outreach_log - bounced)   │
     │    - Contacted Leads/Contacts (outreach_log)│
     │    - Response Rate (replied_at / total)     │
     │    - Deliverability 7d (sent - bounced)     │
     │                                             │
     │  AgentMonitor.jsx:                          │
     │    - Emails Today (activity_log count)      │
     │    - Replies Today (activity_log count)     │
     │    - Performance by date range              │
     │                                             │
     └─────────────────────────────────────────────┘
```

---

## Critical Implementation Notes

1. **All queries must filter by `org_id`** — This is a multi-tenant system. Rows without `org_id` are invisible to the frontend dashboards.

2. **`outreach_log` is the source of truth for all email metrics.** Never use the `emails` table, `daily_stats` table, or `email_reporting_daily` table (all deprecated/dropped).

   Deliverability on the main dashboard follows the same pattern for trailing windows: live Gmail sent + bounce-proxy counts first, then `outreach_log` fallback if Gmail stats are unavailable.

3. **Supabase default limit is 1000 rows** — Use `{ count: 'exact', head: true }` for accurate counts, or paginate with `.range()` when fetching actual rows.

4. **Bounce detection uses regex on `activity_log.summary`** — The format is: `Bounced: email@example.com — removed from contacts`. If this format changes, the bounce-exclusion logic in App.jsx will break.

5. **Reply detection has a 500-row limit** — `check-replies.js` only queries the 500 most recent outreach rows and searches Gmail with `newer_than:30d`. Older emails won't get reply detection.

6. **`sent_at` column has DEFAULT NOW()** — Fixed via `supabase/fix_outreach_sent_at.sql`. Both the Python agent and `send-email.js` also set `sent_at` explicitly.
