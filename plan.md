# Data Integrity Improvement Plan

## Overview
Address missing metrics, data integrity concerns, and structural documentation gaps across the SDR platform.

---

## Phase 1: Data Integrity Fixes (Code Changes)

### 1A. Add `bounced_email` column to `activity_log` — Fix fragile bounce detection
**Problem:** Bounce detection relies on regex parsing of `activity_log.summary` text (`/Bounced:\s+(\S+@\S+)/i`). If format changes, bounce exclusion silently breaks.

**Changes:**
- **New migration** `supabase/add_data_integrity_columns.sql`: Add `bounced_email TEXT` column to `activity_log` with index
- **`check-bounces.js`** (~line 227): Write `bounced_email` field alongside `summary` when inserting bounce records
- **`send-email.js`** (`isPermanentlySuppressed`): Query `bounced_email` column directly instead of `ilike` on `summary`
- **`App.jsx`** (~lines 287-300, 339-352): Replace regex parsing with direct query on `bounced_email` column
- **`METRICS.md`**: Update bounce detection documentation

### 1B. Add `bounced` boolean to `outreach_log` — Direct bounce flag
**Problem:** No direct way to know if an outreach row bounced without cross-referencing activity_log.

**Changes:**
- **New migration** (same file): Add `bounced BOOLEAN DEFAULT FALSE` to `outreach_log` with index
- **`check-bounces.js`**: Set `bounced = true` on matching `outreach_log` rows when bounce detected
- **`App.jsx`**: Simplify "Emails Sent" calculation — `COUNT WHERE bounced != true` instead of building bounced email sets

### 1C. Paginate reply detection — Fix 500-row ceiling
**Problem:** `check-replies.js` only checks last 500 outreach rows. Orgs past ~500 sends lose reply attribution for older emails.

**Changes:**
- **`check-replies.js`** (~line 135-141): Replace `limit(500)` with cursor-based pagination using `sent_at` ranges. Process in batches of 500, but iterate until done (with a max of 5000 rows as a safety cap).
- **`check-replies.js`** (~line 148-159): Also paginate the `alreadyLogged` dedup query

### 1D. Add `email_unsubscribed` activity type — Track opt-outs separately
**Problem:** Unsubscribe/opt-out replies are counted as regular replies, inflating response rate.

**Changes:**
- **`check-replies.js`**: Add unsubscribe detection patterns (e.g., "unsubscribe", "remove me", "stop emailing", "opt out", "take me off"). When detected, log as `email_unsubscribed` instead of `email_reply`.
- **`App.jsx`**: Exclude `email_unsubscribed` from reply counts in response rate calculation
- **`METRICS.md`**: Document new activity type

### 1E. Sent count reconciliation — Fix outreach_log vs activity_log inconsistency
**Problem:** "Emails Sent" in App.jsx uses `outreach_log`, but "Emails Today" in AgentMonitor uses `activity_log`. If one write fails, numbers diverge.

**Changes:**
- **`send-email.js`** (~lines 569-580): Add `gmail_message_id` to the outreach_log insert (currently missing for frontend sends).
- **`AgentMonitor.jsx`**: Switch "Emails Today" to use `outreach_log` with `sent_at >= todayStart` instead of `activity_log`, making all email count metrics consistent. (`AgentDashboard.jsx` has been removed — it was dead code.)
- **`METRICS.md`**: Document that `outreach_log` is the single source of truth for all sent email counts.

---

## Phase 2: Missing Metrics (New Features)

### 2A. Contact verification pass/fail dashboard metric
**Problem:** Verification outcomes exist in activity_log but aren't surfaced on dashboards.

**Changes:**
- **`App.jsx`** (in `loadGlobalData`): Add queries to count `email_verified` activity entries. Count total verifications and use bounced_email + blocked statuses to derive pass/fail rates. Surface as a "Verification" stat in the header bar.
### 2B. Follow-up metrics on frontend
**Problem:** Follow-up data exists in `outreach_log.followup_number` but dashboards don't surface follow-up-specific stats.

**Changes:**
- **`AgentMonitor.jsx`** (in `loadRangeStats`): Add queries that break down sent/replied by `followup_number` from `outreach_log`. Show FU#0 (initial) vs FU#1 vs FU#2 reply rates.
- **`App.jsx`**: In the outreach stats section, show follow-up breakdown (initial sent, FU#1 sent, FU#2 sent, with reply rates per step).

### 2C. Document open tracking as a known gap
**Problem:** No open tracking exists. The legacy `emails` table has `opened`/`opened_at` columns but they're never populated.

**Changes:**
- **`METRICS.md`**: Add "Known Gaps" section documenting that open tracking is not implemented. Note that implementing it would require a tracking pixel service (not feasible with plain-text Gmail sends).

---

## Phase 3: Documentation (METRICS.md Updates)

### 3A. Add missing table schemas
- Document `contact_database` full schema (already in schema.sql but not referenced in METRICS.md)
- Document `agent_settings` table shape (columns, org_id scoping, defaults, who creates it)
- Document `contacts` table schema (especially verification caching columns)

### 3B. Document error/retry semantics
- What happens when Gmail API fails mid-send in `send-email.js` (outreach_log not written, activity_log not written — clean failure because Gmail send happens first)
- What happens when Gmail succeeds but Supabase write fails (email sent but not tracked — document as a known risk; gmail_message_id can be used for manual reconciliation)
- Document that the Python agent has similar partial-write risks

### 3C. Document all activity types comprehensively
- Add `email_unsubscribed` (new)
- Document `followup_sent` processing details
- Note which activity types feed which metrics

---

## File Change Summary

| File | Change Type | Description |
|------|------------|-------------|
| `supabase/add_data_integrity_columns.sql` | **New** | Migration: `bounced_email` on activity_log, `bounced` on outreach_log |
| `netlify/functions/check-bounces.js` | Edit | Write `bounced_email` column; set `outreach_log.bounced` flag |
| `netlify/functions/check-replies.js` | Edit | Paginate past 500-row limit; detect unsubscribes |
| `netlify/functions/send-email.js` | Edit | Use `bounced_email` column for suppression; add `gmail_message_id` to outreach_log |
| `src/App.jsx` | Edit | Use `bounced`/`bounced_email` columns; add verification & follow-up stats; exclude unsubscribes |
| `src/AgentMonitor.jsx` | Edit | Switch to `outreach_log` for sent counts; add follow-up breakdown |
| `METRICS.md` | Edit | Document all schema gaps, error semantics, known gaps, new activity types |
