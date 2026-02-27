# AI SDR Agent — Development Standards

## Project Overview
Multi-tenant SDR automation platform: React 18 frontend, Supabase backend, Netlify Functions serverless API, Claude AI for enrichment/email generation, Gmail API for sending.

## Key Architecture Rules
- **Multi-tenant**: All data tables have `org_id`. Server-side functions use service role key (bypasses RLS). Frontend uses anon key with RLS.
- **Email data lives in `outreach_log`**: The `send-email.js` function writes to `outreach_log`, not the `emails` table. Always query `outreach_log` for email stats.
- **Netlify Functions are CommonJS**: Use `require()` not `import`. Frontend is ESM.
- **Supabase count queries**: Use `{ count: 'exact', head: true }` for counts. Default limit is 1000 rows — use individual filtered count queries for accurate stats.

## QA Pipeline

After completing ANY code change:
1. Run `npm run build` — fix all failures
2. Self-review your diff for bugs, security issues, and edge cases
3. If the QA pipeline provides feedback, address ALL critical issues before resubmitting

### Two-Agent QA Loop
- **Builder**: Claude Code writes/modifies code
- **Reviewer**: Separate Claude API call with QA-focused prompt reviews the diff
- Issues get fed back to the Builder for fixes
- Max 3 retries, then escalate to human

### Running QA locally
```bash
node scripts/qa-pipeline.mjs "your task description"
```

### QA API endpoint
```
POST /.netlify/functions/qa-review
{ "diff": "...", "context": "..." }
```

## Code Standards
- All Netlify functions must have CORS headers and OPTIONS handling
- All user inputs must be validated and sanitized
- No secrets or API keys in code — use env vars
- All Supabase queries in server-side functions should use service role key
- All Supabase queries in frontend use anon key (RLS-protected)
- Error responses must include meaningful messages

## When Receiving QA Feedback
- Address critical issues first, then warnings
- Don't just fix the symptom — fix the root cause
- If you disagree with feedback, explain why in a comment

## Environment Variables
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Public anon key (frontend)
- `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY` — Service role key (server-side)
- `ANTHROPIC_API_KEY` — Claude API key
- `GMAIL_OAUTH_CREDENTIALS` — Gmail OAuth JSON
- `GMAIL_FROM_EMAIL` — Sender email address
- `EMAILLISTVERIFY_API_KEY` — Email verification API
