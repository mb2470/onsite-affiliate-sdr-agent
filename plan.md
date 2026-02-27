# Refactor Plan: 4 Workflow Optimizations

## Summary of Changes

Match the codebase to the updated `lead-workflow.mermaid` by implementing these four optimizations:

1. **Flip Verification Waterfall** — Move Apollo email_status triage into contact discovery (not send time)
2. **Intent-Based Fast-Track** — Technographic signals skip Claude research → jump to HIGH
3. **Parallel Enrichment + Discovery** — StoreLeads Discovery leads fork enrichment + contacts concurrently
4. **Backup Title Pivot** — Replace double-check loop with automatic next-title search

---

## Optimization 1: Flip Verification Waterfall

**Problem**: Currently, `apollo-find-contacts.js` only inserts `verified` contacts (line 66 filter). All other statuses are silently dropped. Then at send time, `send-email.js` does live Apollo verification + ELV for every email. This is redundant and slow.

**Changes**:

### A. `netlify/functions/apollo-find-contacts.js`
- **Remove** the `email_status === 'verified'` filter on line 66
- **Instead**, triage by `email_status` during discovery:
  - `verified` → insert with `apollo_email_status: 'verified'` (no ELV needed)
  - `extrapolated` / `catch_all` / `unavailable` → insert with status, flag `needs_elv: true`
  - `invalid` → do NOT insert, trigger backup title pivot (Opt 4)
- Log the triage decision in the activity log

### B. `netlify/functions/apollo-contacts-background.js`
- Same triage logic as above (this is the batch version)
- Currently inserts all statuses but doesn't filter. Add the same triage: insert non-invalid, skip invalid → backup pivot

### C. `netlify/functions/send-email.js` — Simplify send-time verification
- **Remove** the full Apollo verification loop (lines 161-199) — contacts are already pre-verified
- **Instead**, check the cached `apollo_email_status` on the contact row:
  - `verified` → send immediately (skip ELV)
  - `extrapolated`/`catch_all`/`unavailable` → route to ELV (existing ELV logic stays)
  - `invalid` or missing → block (shouldn't happen if discovery triage works)
- This eliminates live Apollo API calls at send time, saving credits + latency

### D. `netlify/functions/lib/apollo-verify.js` — Keep but repurpose
- Keep the module for batch verification use cases (e.g., re-verification of stale contacts)
- The `verifyViaApollo()` function stays as-is for the batch verify endpoint
- `apollo-verify-contacts.js` endpoint stays as-is (used for manual re-verification)

### E. ELV Batch Verify — Only risky contacts
- In `agent/ai_sdr_agent.py` `batch-verify` command: add filter to skip contacts where `apollo_email_status = 'verified'`
- Only ELV-verify contacts with `extrapolated`, `catch_all`, or `unavailable` Apollo status

---

## Optimization 2: Intent-Based Fast-Track

**Problem**: All StoreLeads-enriched leads go through the same ICP scoring. Obvious winners (Shopify Plus, high-signal technographics) still get scored normally and may end up in the expensive Claude research path.

**Changes**:

### A. `netlify/functions/lib/icp-scoring.js` — Add `checkFastTrack()`
- New exported function: `checkFastTrack(storeLeadsData)`
- Returns `{ fastTrack: true/false, reason: string }`
- Checks for:
  - `plan` contains "Shopify Plus" or "Enterprise" → fast track
  - `platform` is "Shopify" + `product_count >= 500` + `estimated_sales >= 500000` (high-volume signal)
- Fast-tracked leads get `icp_fit: 'HIGH'` immediately, skip Claude research

### B. `src/services/enrichService.js` — Add fast-track check after StoreLeads
- After `tryStoreLeads()` returns data, call `checkFastTrack()` logic (inline, since frontend can't import CommonJS)
- If fast-tracked: set `icp_fit: 'HIGH'` directly, add `fit_reason: 'Fast-track: Shopify Plus'`
- Skip Apollo org enrichment and Claude research entirely

### C. `netlify/functions/storeleads-bulk-background.js` — Add fast-track in batch
- After scoring each domain, check `checkFastTrack()` before final ICP assignment
- If fast-tracked: override to HIGH regardless of normal scoring

### D. `netlify/functions/storeleads-discover.js` — Add fast-track in discovery
- Same pattern: check fast-track before normal scoring

---

## Optimization 3: Parallel Enrichment + Discovery

**Problem**: For StoreLeads Discovery leads (source: `storeleads_discovery`), the flow is sequential: enrich → score ICP → then find contacts. Contact discovery waits for enrichment to complete.

**Changes**:

### A. `netlify/functions/storeleads-discover.js`
- After inserting a new HIGH lead, immediately trigger contact discovery in parallel
- Use `Promise.allSettled()` to fire Apollo contact search alongside the next batch of enrichments
- Add a simple in-function contact search (reuse `searchApollo` + `enrichPeople` logic from `apollo-contacts-background.js`)

### B. `netlify/functions/storeleads-top500.js`
- Same pattern: after inserting HIGH leads, trigger Apollo contact search in parallel
- Already has a contact matching loop at the end (lines 132-161) — enhance it to also call Apollo for non-matched HIGH leads

### C. `src/services/contactService.js` — No changes needed
- The frontend `findContacts()` already does DB check → Apollo fallback
- Parallel discovery runs server-side in the background functions

---

## Optimization 4: Backup Title Pivot

**Problem**: The current "double-check loop" in `apollo-verify.js` re-searches the *same person* by name. If their email is invalid, it tries to find them at a new company. But the mermaid now says: pivot to the *next title* at the same company instead.

**Changes**:

### A. `netlify/functions/lib/apollo-verify.js` — Replace `apolloDoubleCheck()` with `backupTitlePivot()`
- **Remove**: `apolloDoubleCheck()` (searches same person by name)
- **Add**: `backupTitlePivot(supabase, { domain, exhaustedTitles, leadId })`
  - Takes the domain + list of already-tried titles
  - Searches Apollo for the next-best title at that domain:
    - Priority: Marketing Leader → Founder → Ecom Manager → Growth Lead → Brand/Content
  - If found with verified email → return new contact
  - If all titles exhausted → return null
- Update `verifyContactsBatch()` to call `backupTitlePivot()` instead of `apolloDoubleCheck()` on discard

### B. `netlify/functions/apollo-find-contacts.js` — Integrate title pivot on invalid
- When a contact has `email_status: 'invalid'`, don't just skip — call title pivot
- Pass the failed title to the exclusion list so the pivot tries the next one

### C. `netlify/functions/apollo-contacts-background.js` — Same integration
- On invalid email status, pivot to next title rather than moving on

### D. `netlify/functions/apollo-verify-contacts.js` — Update endpoint
- Replace `refreshed` results (from double-check) with `pivoted` results (from title pivot)
- Update response shape accordingly

---

## Files Changed (Summary)

| File | Opt | Change |
|------|-----|--------|
| `netlify/functions/lib/icp-scoring.js` | 2 | Add `checkFastTrack()` |
| `netlify/functions/lib/apollo-verify.js` | 1,4 | Replace `apolloDoubleCheck` with `backupTitlePivot`, keep verify functions |
| `netlify/functions/apollo-find-contacts.js` | 1,4 | Triage by email_status, integrate title pivot |
| `netlify/functions/apollo-contacts-background.js` | 1,3,4 | Triage + title pivot + parallel triggers |
| `netlify/functions/send-email.js` | 1 | Remove live Apollo calls, use cached status from DB |
| `netlify/functions/apollo-verify-contacts.js` | 4 | Replace refreshed with pivoted |
| `netlify/functions/storeleads-bulk-background.js` | 2 | Add fast-track check |
| `netlify/functions/storeleads-discover.js` | 2,3 | Fast-track + parallel contact discovery for HIGH leads |
| `netlify/functions/storeleads-top500.js` | 2,3 | Fast-track + parallel contact discovery for HIGH leads |
| `src/services/enrichService.js` | 2 | Add fast-track check after StoreLeads |

## Files NOT Changed
- `src/services/contactService.js` — No changes needed (already does DB → Apollo fallback)
- `src/services/exportService.js` — No changes needed (just calls send-email)
- `netlify/functions/storeleads-single.js` — Returns raw data, no scoring logic
- `agent/ai_sdr_agent.py` — Only the batch-verify filter for apollo_email_status='verified' skip

## Build Verification
- Run `npm run build` after all changes to verify no regressions
