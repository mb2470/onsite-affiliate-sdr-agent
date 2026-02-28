/**
 * server.js — Express mount point for local development.
 *
 * Mounts the five route modules behind an `authenticate` middleware
 * that resolves org_id from the request (header, query, or session).
 *
 * Usage:
 *   npm install express          # one-time
 *   node server.js               # starts on PORT or 4000
 *
 * All route functions are pure async — no req/res coupling.
 * They can also be called directly from Netlify Functions.
 */

import express from "express";

// ── Route modules ───────────────────────────────────────────────────────────

import {
  getEmailSettings,
  updateEmailSettings,
  testCloudflareConnection,
  testSmartleadConnection,
} from "./routes/email-settings.js";

import {
  listDomains,
  getDomainStatus,
  searchDomains,
  purchaseDomain,
  provisionDns,
  verifyDns,
} from "./routes/email-domains.js";

import {
  listEmailAccounts,
  createEmailAccount,
  toggleWarmup,
  getWarmupStats,
  assignToCampaign,
} from "./routes/email-accounts.js";

import {
  listCampaigns,
  createCampaign,
  getCampaignDetail,
} from "./routes/email-campaigns.js";

import {
  listConversations,
  getInboxStats,
  getConversation,
  markAsRead,
} from "./routes/email-inbox.js";

// ── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── CORS ────────────────────────────────────────────────────────────────────

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Org-Id, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  next();
});
app.options("*", (_req, res) => res.sendStatus(200));

// ── Authenticate middleware ─────────────────────────────────────────────────
// Resolves org_id from X-Org-Id header, query param, or request body.
// In production this should validate a JWT / session token.

function authenticate(req, res, next) {
  const orgId =
    req.headers["x-org-id"] || req.query.org_id || req.body?.org_id;

  if (!orgId) {
    return res
      .status(401)
      .json({ error: "Missing org_id (X-Org-Id header, query param, or body)" });
  }

  req.orgId = orgId;
  next();
}

// ── Shared handler ──────────────────────────────────────────────────────────
// Wraps a pure async function: resolves to JSON, rejects to error response.

async function handle(res, promise) {
  try {
    res.json(await promise);
  } catch (err) {
    const status = err.status || 500;
    const payload = { error: err.message };
    if (err.details) payload.details = err.details;
    res.status(status).json(payload);
  }
}

// ── Email Settings ──────────────────────────────────────────────────────────

app.get("/api/email/settings", authenticate, (req, res) =>
  handle(res, getEmailSettings(req.orgId))
);
app.put("/api/email/settings", authenticate, (req, res) =>
  handle(res, updateEmailSettings(req.orgId, req.body))
);
app.post("/api/email/settings/test-cf", authenticate, (req, res) =>
  handle(res, testCloudflareConnection(req.orgId))
);
app.post("/api/email/settings/test-sl", authenticate, (req, res) =>
  handle(res, testSmartleadConnection(req.orgId))
);

// ── Domains ─────────────────────────────────────────────────────────────────

app.get("/api/email/domains", authenticate, (req, res) =>
  handle(res, listDomains(req.orgId))
);
app.get("/api/email/domains/:id", authenticate, (req, res) =>
  handle(res, getDomainStatus(req.orgId, req.params.id))
);
app.post("/api/email/domains/search", authenticate, (req, res) =>
  handle(res, searchDomains(req.orgId, req.body.query))
);
app.post("/api/email/domains/purchase", authenticate, (req, res) =>
  handle(res, purchaseDomain(req.orgId, req.body.domain, req.body.years))
);
app.post("/api/email/domains/:id/provision", authenticate, (req, res) =>
  handle(res, provisionDns(req.orgId, req.params.id, req.body.provider))
);
app.post("/api/email/domains/:id/verify", authenticate, (req, res) =>
  handle(res, verifyDns(req.orgId, req.params.id))
);

// ── Accounts ────────────────────────────────────────────────────────────────

app.get("/api/email/accounts", authenticate, (req, res) =>
  handle(res, listEmailAccounts(req.orgId))
);
app.post("/api/email/accounts", authenticate, (req, res) =>
  handle(res, createEmailAccount(req.orgId, req.body))
);
app.post("/api/email/accounts/:id/warmup", authenticate, (req, res) =>
  handle(res, toggleWarmup(req.orgId, req.params.id, req.body.enabled))
);
app.get("/api/email/accounts/:id/warmup", authenticate, (req, res) =>
  handle(res, getWarmupStats(req.orgId, req.params.id))
);
app.post("/api/email/accounts/:id/assign", authenticate, (req, res) =>
  handle(res, assignToCampaign(req.orgId, req.params.id, req.body.campaignId))
);

// ── Campaigns ───────────────────────────────────────────────────────────────

app.get("/api/email/campaigns", authenticate, (req, res) =>
  handle(res, listCampaigns(req.orgId))
);
app.post("/api/email/campaigns", authenticate, (req, res) =>
  handle(res, createCampaign(req.orgId, req.body.name))
);
app.get("/api/email/campaigns/:id", authenticate, (req, res) =>
  handle(res, getCampaignDetail(req.orgId, req.params.id))
);

// ── Inbox ───────────────────────────────────────────────────────────────────

app.get("/api/email/inbox", authenticate, (req, res) => {
  const { campaignId, page, limit } = req.query;
  handle(
    res,
    listConversations(req.orgId, {
      campaignId,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 25,
    })
  );
});
app.get("/api/email/inbox/stats", authenticate, (req, res) =>
  handle(res, getInboxStats(req.orgId))
);
app.get("/api/email/inbox/:id", authenticate, (req, res) =>
  handle(res, getConversation(req.orgId, req.params.id))
);
app.put("/api/email/inbox/:id/read", authenticate, (req, res) =>
  handle(res, markAsRead(req.orgId, req.params.id))
);

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Email API server listening on http://localhost:${PORT}`);
});
