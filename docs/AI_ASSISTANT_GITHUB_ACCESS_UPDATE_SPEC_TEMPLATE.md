# AI Assistant GitHub Access + Update Spec Template

This guide answers two practical questions for this repository:

1. Can you give an AI assistant access to GitHub so it can answer questions more accurately?
2. How should you write a spec/prompt so the assistant can implement safe, high-quality updates?

---

## 1) Giving your AI assistant GitHub access

Yes — and for this repo, the safest approach is **read-only by default** with tightly scoped permissions.

### Recommended access levels

- **Read-only (best default)**
  - Access to repository code, pull requests, issues, and commit history.
  - Lets the assistant answer architecture and change-history questions more accurately.
  - No direct pushes.

- **Read + PR write (optional for automation)**
  - Assistant can open branches/PRs but not merge.
  - Keep human review required.

- **Admin/write-all (not recommended)**
  - Avoid unless absolutely necessary.

### Practical setup options

- **GitHub App** (preferred)
  - Install app on this repo/org.
  - Grant minimum scopes:
    - `Contents: Read`
    - `Pull requests: Read/Write` (only if you want AI-created PRs)
    - `Issues: Read`
    - `Metadata: Read`
  - Restrict to selected repositories.

- **Fine-grained PAT**
  - Create token scoped only to this repository.
  - Prefer read-only first.
  - Set expiration and rotate regularly.

### Security guardrails

- Never share broad classic PATs.
- Use short-lived credentials where possible.
- Require branch protection + PR review before merge.
- Log all AI-triggered actions.
- Keep secrets in env vars / secret manager, never in prompts.

---

## 2) Spec template for prompting code updates

Use this template to request implementation work consistently.

## Copy/paste prompt template

```md
# Task
[One-paragraph description of desired change]

# Business goal
[Why this matters, what user/system outcome should improve]

# Scope
- In scope:
  - [list]
- Out of scope:
  - [list]

# Repository context
- Frontend: `src/` (React/Vite)
- Backend: `netlify/functions/` (CommonJS serverless functions)
- DB: `supabase/` (schema + migrations)
- Optional automation: `agent/` (Python)

# Constraints
- Preserve multi-tenant org isolation (`org_id`) across reads/writes.
- Netlify functions must keep CORS + OPTIONS handling.
- No secrets in source code.
- Frontend should use existing service layer patterns in `src/services/`.

# Files likely involved
- [path 1]
- [path 2]
- [path 3]

# API/data contract changes
- Request/response updates:
  - [details]
- Schema changes:
  - [details + migration requirements]

# Acceptance criteria
- [ ] Functional requirement 1
- [ ] Functional requirement 2
- [ ] Handles edge case X
- [ ] No regressions in existing flow Y

# Test plan
- Unit/integration checks:
  - [commands]
- Manual validation:
  - [steps]

# Non-functional requirements
- Performance: [target]
- Observability/logging: [required logs/metrics]
- Security/privacy: [requirements]

# Deliverables
- Code changes
- Migration (if needed)
- Short summary of changed files and rationale
- Risks + follow-up recommendations
```

---

## 3) Repo-specific “good prompt” example

```md
Implement Optimization 1 (Flip Verification Waterfall) from `plan.md`.

Scope:
- Update `netlify/functions/apollo-find-contacts.js` to triage by `email_status` during discovery.
- Update `netlify/functions/send-email.js` to rely on cached `apollo_email_status` and only run ELV for risky statuses.
- Keep `netlify/functions/apollo-verify-contacts.js` behavior unchanged.

Constraints:
- Keep existing response shapes unless explicitly noted.
- Preserve org scoping and activity logging.
- Do not add new dependencies.

Acceptance criteria:
- Discovery inserts verified + risky statuses; invalid is excluded.
- Send path skips live Apollo verification for already verified contacts.
- Existing send flow still logs to `outreach_log`.

Validation:
- Run `npm run build`.
- Provide a concise test summary and any known limitations.
```

---

## 4) Tips for best results

- Give the assistant explicit file paths and constraints.
- Provide acceptance criteria as checkboxes.
- Separate “must have” from “nice to have”.
- Ask for a brief implementation plan before coding when scope is large.
