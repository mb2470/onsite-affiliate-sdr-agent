# Metrics & Data Flow Reference

> **Keep this file updated** whenever metrics calculations, database writes, or dashboard queries change.
> AI assistants should reference this file when answering questions about how metrics work.

---

## Database Tables (Source of Truth)

### `outreach_log` — Every email sent
The **primary record** of all emails sent. Both the Netlify `send-email.js` function and the Python agent write here. **This is the single source of truth for all email sent counts across all dashboards.**

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
| `gmail_message_id` | text | Gmail API message ID (set by both send-email.js and Python agent) |
| `gmail_thread_id` | text | Gmail thread ID (for threading follow-ups) |
| `rfc_message_id` | text | RFC 2822 Message-ID header (for In-Reply-To) |
| `parent_outreach_id` | uuid | Links follow-ups back to the initial outreach row |
| `replied` | boolean | Whether the prospect replied |
| `replied_at` | timestamptz | When the reply was detected (set by `check-replies.js`) |
| `bounced` | boolean | Whether this email bounced (set by `check-bounces.js`). DEFAULT FALSE |

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
| `bounced_email` | text | The bounced email address (only for `email_bounced` type). Replaces regex parsing of `summary` |
| `created_at` | timestamptz | When the event occurred |

**Activity types used for metrics:**
| `activity_type` | Meaning | Written by |
|-----------------|---------|------------|
| `email_sent` | Email sent via Gmail | `send-email.js`, Python agent |
| `email_exported` | Email exported via Gmail (legacy) | `exportService.js` |
| `email_reply` | Real reply detected from a prospect | `check-replies.js` |
| `email_unsubscribed` | Opt-out / unsubscribe request detected | `check-replies.js` |
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

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `website` | text | Company website (unique per org) |
| `company_name` | text | Company name |
| `industry` | text | Industry |
| `icp_fit` | text | `'HIGH'`, `'MEDIUM'`, or `'LOW'` |
| `status` | text | Pipeline status (see above) |
| `enrichment_status` | text | `'pending'`, `'in_progress'`, `'completed'`, `'failed'` |
| `has_contacts` | boolean | Whether contacts have been found |
| `contact_name` | text | Primary contact name (denormalized) |
| `contact_email` | text | Primary contact email (denormalized) |
| `source` | text | Lead source (default `'manual'`) |
| `metadata` | jsonb | Extensible metadata |

### `contact_database` — CSV-imported contacts for matching
Contacts imported from CSV or discovered via Apollo. Used for domain-based matching during sends.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `website` | text | Company website |
| `account_name` | text | Company name |
| `first_name` | text | Contact first name |
| `last_name` | text | Contact last name |
| `title` | text | Job title |
| `email` | text | Email address (globally unique) |
| `linkedin_url` | text | LinkedIn profile URL |
| `email_domain` | text | Generated: domain part of email |
| `apollo_email_status` | text | Apollo verification status |
| `apollo_verified_at` | timestamptz | When Apollo verification was done |
| `elv_status` | text | EmailListVerify status |
| `elv_verified_at` | timestamptz | When ELV verification was done |

### `contacts` — Lead-associated contacts with verification caching
Contacts linked to specific leads. Stores both Apollo and ELV verification results.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `lead_id` | uuid | FK to `leads` |
| `email` | text | Email address (unique per lead) |
| `full_name` | text | Full name |
| `title` | text | Job title |
| `match_score` | int | Contact relevance score |
| `match_level` | text | `'Best Match'`, `'Great Match'`, `'Good Match'`, `'Possible Match'` |
| `elv_status` | text | ELV verification status (cached 30 days) |
| `elv_verified_at` | timestamptz | When ELV verification was done |
| `apollo_email_status` | text | Apollo verification status |
| `apollo_verified_at` | timestamptz | When Apollo verification was done |

### `agent_settings` — Per-org agent configuration
Controls the Python agent's behavior. One row per org.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | | Primary key |
| `org_id` | uuid | | Multi-tenant org identifier |
| `agent_enabled` | boolean | false | Master on/off switch |
| `auto_send` | boolean | false | If false, emails are drafted for review |
| `max_emails_per_day` | int | 20 | Global daily cap (all senders combined) |
| `min_minutes_between_emails` | int | 10 | Minimum wait between consecutive sends |
| `send_hour_start` | int | 9 | Start of send window (US/Eastern) |
| `send_hour_end` | int | 17 | End of send window (US/Eastern) |
| `send_days` | int[] | [1,2,3,4,5] | ISO weekday numbers (Mon=1 through Sun=7) |
| `allowed_icp_fits` | text[] | ['HIGH'] | Which ICP tiers to contact |
| `max_contacts_per_lead_per_day` | int | 1 | Limits per-company sends per day |
| `last_heartbeat` | timestamptz | | Last agent heartbeat timestamp |

Created automatically when an org is set up. The Python agent reads this on each cycle.

### `email_accounts` — Sender account tracking
Tracks per-sender daily usage for multi-sender rotation.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `org_id` | uuid | Multi-tenant org identifier |
| `domain_id` | uuid | FK to `email_domains` |
| `email_address` | text | Sender email (globally unique) |
| `display_name` | text | Sender display name |
| `daily_send_limit` | int | Max emails per day for this account (default 30) |
| `current_daily_sent` | int | How many sent today (resets daily) |
| `status` | text | `'pending'`, `'warming'`, `'ready'`, `'active'`, `'paused'`, `'disabled'`, `'failed'` |

### `emails` table — NOT used for metrics
This is a legacy table. **Do not query it for metrics.** All email metrics come from `outreach_log`.

### `daily_stats` table — NOT used
This table may not exist or be populated. **Do not query it.** Use `outreach_log` instead.

---

## Where Data Is Written

### Path 1: Netlify `send-email.js` (frontend sends)
**File:** `netlify/functions/send-email.js`

When an email is sent from the web UI:
1. **Verifies email** — Apollo People Match API, then EmailListVerify (ELV) waterfall
2. **Sends via Gmail** — Using OAuth credentials
3. **Writes `outreach_log`** — One row per recipient, includes `org_id` and `gmail_message_id`
4. **Updates `leads`** — Sets `status = 'contacted'`, `has_contacts = true`
5. **Writes `activity_log`** — `activity_type = 'email_sent'` with `org_id`
6. **Increments `email_accounts.current_daily_sent`**

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

### Path 3: `check-replies.js` (reply + unsubscribe detection)
**File:** `netlify/functions/check-replies.js`

Triggered manually via the "Check Replies" button or by the Python agent:
1. **Queries `outreach_log`** — Paginates up to 5000 rows (batches of 1000)
2. **Searches Gmail** — `from:{contact_email} newer_than:30d` in batches of 10
3. **Filters auto-responders** — OOO, vacation, delivery failure patterns
4. **Detects unsubscribes** — Patterns like "remove me", "unsubscribe", "stop emailing", "opt out"
5. **Deduplicates** — Skips emails already in `activity_log` as `email_reply` or `email_unsubscribed`
6. **For real replies:**
   - Writes `activity_log` — `activity_type = 'email_reply'`
   - Updates `outreach_log` — Sets `replied_at`
   - Updates `leads` — Sets `status = 'replied'`
7. **For unsubscribe requests:**
   - Writes `activity_log` — `activity_type = 'email_unsubscribed'`
   - Updates `outreach_log` — Sets `replied_at` (prevents follow-ups)
   - Does NOT count as a reply in response rate calculations

### Path 4: `check-bounces.js` (bounce detection)
**File:** `netlify/functions/check-bounces.js`

Triggered manually or by the Python agent:
1. **Searches Gmail** — For bounce/delivery failure notifications
2. **Deduplicates** — Skips bounces already logged (uses `bounced_email` column, falls back to regex on `summary`)
3. **Removes contact** from `contact_database`
4. **Marks outreach as bounced** — Sets `outreach_log.bounced = true` for matching rows
5. **Resets lead** to `status = 'enriched'` if no other outreach exists
6. **Writes `activity_log`** — `activity_type = 'email_bounced'`, `status = 'failed'`, `bounced_email = '{email}'`

---

## How Each Metric Is Calculated

### Emails Sent (lifetime)
**Displayed in:** App.jsx header bar
**State:** `emailsSent`
**Calculation:**
```
COUNT(outreach_log) WHERE org_id = X AND (bounced IS NULL OR bounced = FALSE)
```
Uses the structured `bounced` boolean column — no regex parsing needed.

### Contacted — Leads & Contacts
**Displayed in:** App.jsx header bar ("Contacted" section)
**State:** `outreachStats.uniqueLeads`, `outreachStats.uniqueContacts`
**Calculation:**
```
1. Paginate ALL outreach_log rows (org_id scoped, 1000 per page)
2. Filter out rows where bounced = true
3. uniqueLeads = COUNT(DISTINCT lead_id or website)
4. uniqueContacts = COUNT(DISTINCT contact_email)
```

### Response Rate — Leads & Contacts
**Displayed in:** App.jsx header bar ("Response Rate" section)
**State:** Derived from `outreachStats`
**Calculation:**
```
Lead response rate  = repliedLeads / uniqueLeads * 100
Contact response rate = repliedContacts / uniqueContacts * 100
```
Where `repliedLeads` / `repliedContacts` are the unique leads/contacts from outreach_log rows where `replied_at IS NOT NULL`, **excluding unsubscribe requests** (contacts with `email_unsubscribed` activity type are filtered out).

### Sequence Breakdown (Initial / FU#1 / FU#2)
**Displayed in:** App.jsx header bar (below Response Rate, when data exists)
**State:** `outreachStats.initialSent/Replied`, `outreachStats.fu1Sent/Replied`, `outreachStats.fu2Sent/Replied`
**Calculation:**
```
For each followup_number (0, 1, 2):
  sent = COUNT(outreach_log) WHERE followup_number = N AND bounced != true
  replied = COUNT where replied_at IS NOT NULL AND contact NOT in unsubscribed set
  rate = replied / sent * 100
```

### Verification Stats
**Displayed in:** App.jsx header bar ("Verification" section, shown when data exists)
**State:** `verificationStats`
**Calculation:**
```
total   = COUNT(activity_log) WHERE activity_type = 'email_verified' AND org_id = X
blocked = COUNT(activity_log) WHERE activity_type = 'email_verified' AND summary ILIKE '%Blocked%'
passed  = total - blocked
passRate = passed / total * 100
```

### Opt-outs
**Displayed in:** App.jsx header bar ("Opt-outs" section, shown when > 0)
**State:** `outreachStats.unsubscribes`
**Calculation:** Count of distinct contacts with `email_unsubscribed` activity type.

### Deliverability (trailing 7 days)
**Displayed in:** App.jsx header bar ("Deliverability (7d)" section)
**State:** `deliverabilityStats`
**Calculation:**
```
sent     = COUNT(outreach_log) WHERE sent_at >= 7 days ago AND org_id = X
bounced  = COUNT(outreach_log) WHERE bounced = true AND sent_at >= 7 days ago AND org_id = X
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

### Emails Today (Agent Monitor + Agent Dashboard)
**Displayed in:** AgentMonitor.jsx top stats, AgentDashboard.jsx stats grid
**State:** `stats.emailsToday` / `stats.emails_sent`
**Calculation:**
```
COUNT(outreach_log) WHERE sent_at >= today midnight AND org_id = X
```
**Note:** All dashboards now consistently use `outreach_log` for sent counts.

### Replies Today (Agent Monitor)
**Displayed in:** AgentMonitor.jsx top stats
**State:** `stats.repliesToday`
**Calculation:**
```
COUNT(activity_log) WHERE activity_type = 'email_reply'
  AND created_at >= today midnight AND org_id = X
```

### Performance by Date Range (Agent Monitor)
**Displayed in:** AgentMonitor.jsx "Performance" card (today / 7 days / 30 days / custom)
**State:** `rangeStats`
**Calculation:**
```
sent    = COUNT(outreach_log) WHERE sent_at BETWEEN start AND end AND org_id = X
replies = COUNT(activity_log) WHERE activity_type = 'email_reply' BETWEEN start AND end
bounces = COUNT(activity_log) WHERE activity_type = 'email_bounced' BETWEEN start AND end
replyRate = replies / sent * 100

Sequence breakdown (per followup_number 0, 1, 2):
  sent    = COUNT(outreach_log) WHERE followup_number = N AND sent_at BETWEEN range
  replied = COUNT(outreach_log) WHERE followup_number = N AND replied_at IS NOT NULL AND sent_at BETWEEN range
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
- Follow-up metrics (sent/replied per step) are surfaced in App.jsx and AgentMonitor.jsx

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
     │ + bounced    │ │ contacted│ │ bounce, etc. │
     │ tracking     │ │ replied  │ │ + bounced_   │
     │              │ │          │ │   email col  │
     └──────┬───────┘ └──────────┘ └──────┬───────┘
            │                              │
            ▼                              ▼
     ┌──────────────┐              ┌──────────────┐
     │check-replies │              │check-bounces │
     │              │              │              │
     │ Scan Gmail → │              │ Scan Gmail → │
     │ Classify:    │              │ Log bounce   │
     │  reply vs    │              │ Set bounced  │
     │  unsubscribe │              │  on outreach │
     │ Update       │              │ Remove contact│
     │ replied_at   │              │ Reset lead   │
     │ + lead status│              │              │
     └──────────────┘              └──────────────┘

              │                              │
              ▼                              ▼
     ┌─────────────────────────────────────────────┐
     │              FRONTEND DASHBOARDS            │
     │                                             │
     │  App.jsx header:                            │
     │    - Emails Sent (outreach_log, bounced=F)  │
     │    - Contacted Leads/Contacts (outreach_log)│
     │    - Response Rate (excl. unsubscribes)     │
     │    - Sequence Breakdown (FU#0/1/2 rates)    │
     │    - Deliverability 7d (outreach_log)       │
     │    - Verification pass/fail rate            │
     │    - Opt-out count                          │
     │                                             │
     │  AgentMonitor.jsx:                          │
     │    - Emails Today (outreach_log count)      │
     │    - Replies Today (activity_log count)     │
     │    - Performance by date range              │
     │    - Sequence breakdown per range           │
     │                                             │
     │  AgentDashboard.jsx:                        │
     │    - Today stats (outreach_log for sent)    │
     │    - Remaining today (max - sent)           │
     │    - Verify pass rate                       │
     │    - Recent activity feed                   │
     └─────────────────────────────────────────────┘
```

---

## Error / Retry Semantics

### What happens when Gmail API fails mid-send? (`send-email.js`)
The Gmail API call happens **before** any database writes. If it fails:
- `outreach_log` row is NOT written
- `activity_log` row is NOT written
- `leads` status is NOT updated
- The function returns a 500 error — **clean failure, no partial state**

### What happens when Gmail succeeds but Supabase writes fail?
If the Gmail API returns success but a subsequent Supabase write fails:
- The email was actually sent but NOT tracked in the database
- **This is a known risk.** The `gmail_message_id` stored on successful writes can be used for manual reconciliation
- The `activity_log` insert is independent of the `outreach_log` insert — either could fail independently
- Mitigation: Both writes are in the same try/catch block, so a failure in `outreach_log.insert()` will prevent the `activity_log.insert()` from running

### Python agent error handling
The Python agent has similar partial-write risks. If the Gmail send succeeds but Supabase is unreachable, the email goes out but isn't tracked. The agent logs errors to stdout but does not have a retry queue for failed database writes.

---

## Known Gaps

### Open tracking
Email open rates are **not implemented**. The legacy `emails` table has `opened`/`opened_at` columns but they are never populated. Implementing open tracking would require a tracking pixel service, which is not feasible with plain-text Gmail sends (the current sending format). This would require switching to HTML emails with an embedded pixel hosted on a tracking domain.

### Reply detection time window
`check-replies.js` searches Gmail with `newer_than:30d`. Replies to emails older than 30 days will not be detected. The outreach_log pagination now supports up to 5000 rows, but the Gmail search window is the practical limit.

---

## Critical Implementation Notes

1. **All queries must filter by `org_id`** — This is a multi-tenant system. Rows without `org_id` are invisible to the frontend dashboards.

2. **`outreach_log` is the single source of truth for all sent email counts** — All dashboards (App.jsx, AgentMonitor, AgentDashboard) now consistently use `outreach_log` for sent counts. Never use `activity_log` for sent counts. Never use the `emails` or `daily_stats` tables.

3. **Supabase default limit is 1000 rows** — Use `{ count: 'exact', head: true }` for accurate counts, or paginate with `.range()` when fetching actual rows.

4. **Bounce detection uses structured columns** — `activity_log.bounced_email` stores the email address directly. `outreach_log.bounced` is a boolean flag. These replace the old regex-on-summary approach. The `summary` field is still written for human readability but is no longer parsed for metrics.

5. **Unsubscribes are tracked separately** — `check-replies.js` detects opt-out patterns and logs them as `email_unsubscribed` instead of `email_reply`. Response rate calculations exclude unsubscribed contacts.

6. **Reply detection paginates up to 5000 rows** — `check-replies.js` fetches outreach_log in batches of 1000, up to a 5000-row safety cap. Gmail search is limited to `newer_than:30d`.

7. **`sent_at` column has DEFAULT NOW()** — Fixed via `supabase/fix_outreach_sent_at.sql`. Both the Python agent and `send-email.js` also set `sent_at` explicitly.

8. **Migration required** — Run `supabase/add_data_integrity_columns.sql` to add the `bounced_email` and `bounced` columns. The migration includes backfill logic for existing data.
