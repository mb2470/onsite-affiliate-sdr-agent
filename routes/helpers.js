import { createClient } from "@supabase/supabase-js";

// ── Supabase (service role — bypasses RLS) ──────────────────────────────────

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── Cloudflare Service ──────────────────────────────────────────────────────

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareService {
  constructor(apiToken, accountId) {
    if (!apiToken) throw new Error("Cloudflare API token is required");
    if (!accountId) throw new Error("Cloudflare account ID is required");
    this.apiToken = apiToken;
    this.accountId = accountId;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async _request(method, path, body = null) {
    const opts = { method, headers: this._headers() };
    if (body && method !== "GET") opts.body = JSON.stringify(body);
    const res = await fetch(`${CF_API_BASE}${path}`, opts);
    const data = await res.json();
    return data;
  }

  async verifyToken() {
    return this._request("GET", "/user/tokens/verify");
  }

  async searchDomains(query) {
    return this._request(
      "GET",
      `/accounts/${this.accountId}/registrar/domains/search?query=${encodeURIComponent(query)}`
    );
  }

  async purchaseDomain(domain, contactInfo, years = 1) {
    return this._request(
      "POST",
      `/accounts/${this.accountId}/registrar/domains`,
      {
        name: domain,
        years,
        registrant: contactInfo,
      }
    );
  }

  async getZoneId(domain) {
    const data = await this._request(
      "GET",
      `/zones?name=${encodeURIComponent(domain)}&account.id=${this.accountId}`
    );
    if (data.success && data.result && data.result.length > 0) {
      return data.result[0].id;
    }
    return null;
  }

  async createZone(domain) {
    const data = await this._request("POST", "/zones", {
      name: domain,
      account: { id: this.accountId },
      type: "full",
    });
    if (data.success && data.result) return data.result.id;
    return null;
  }

  async createDnsRecord(zoneId, record) {
    return this._request("POST", `/zones/${zoneId}/dns_records`, record);
  }

  async listDnsRecords(zoneId) {
    return this._request(
      "GET",
      `/zones/${zoneId}/dns_records?per_page=100`
    );
  }

  async provisionColdEmailDns(zoneId, domain, provider) {
    const mxRecords = provider?.mxRecords || [
      { content: "mx.zoho.com", priority: 10 },
      { content: "mx2.zoho.com", priority: 20 },
      { content: "mx3.zoho.com", priority: 50 },
    ];
    const spfInclude = provider?.spfInclude || "zoho.com";
    const dkimRecords = provider?.dkimRecords || [];

    const results = { mx: [], spf: null, dkim: [], dmarc: null, errors: [] };

    // MX records
    for (const mx of mxRecords) {
      const data = await this.createDnsRecord(zoneId, {
        type: "MX",
        name: domain,
        content: mx.content,
        priority: mx.priority,
        ttl: 3600,
      });
      if (data.success) results.mx.push(data.result);
      else results.errors.push({ record: mx, errors: data.errors });
    }

    // SPF record
    const spfData = await this.createDnsRecord(zoneId, {
      type: "TXT",
      name: domain,
      content: `v=spf1 include:${spfInclude} -all`,
      ttl: 3600,
    });
    if (spfData.success) results.spf = spfData.result;
    else results.errors.push({ record: "SPF", errors: spfData.errors });

    // DMARC record
    const dmarcData = await this.createDnsRecord(zoneId, {
      type: "TXT",
      name: `_dmarc.${domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
      ttl: 3600,
    });
    if (dmarcData.success) results.dmarc = dmarcData.result;
    else results.errors.push({ record: "DMARC", errors: dmarcData.errors });

    // DKIM records
    for (const dkim of dkimRecords) {
      const data = await this.createDnsRecord(zoneId, {
        type: dkim.type || "TXT",
        name: dkim.name,
        content: dkim.content,
        ttl: 3600,
      });
      if (data.success) results.dkim.push(data.result);
      else results.errors.push({ record: dkim, errors: data.errors });
    }

    return results;
  }

  async verifyDnsRecords(zoneId, domain) {
    const data = await this.listDnsRecords(zoneId);
    if (!data.success) return null;

    const records = data.result || [];
    return {
      mx: records.some((r) => r.type === "MX"),
      spf: records.some(
        (r) => r.type === "TXT" && r.content.startsWith("v=spf1")
      ),
      dkim: records.some(
        (r) =>
          (r.type === "TXT" || r.type === "CNAME") &&
          r.name.includes("._domainkey.")
      ),
      dmarc: records.some(
        (r) => r.type === "TXT" && r.name.startsWith("_dmarc.")
      ),
    };
  }
}

// ── Smartlead Service ───────────────────────────────────────────────────────

const SL_BASE = "https://server.smartlead.ai/api/v1";

export class SmartleadService {
  constructor(apiKey) {
    if (!apiKey) throw new Error("Smartlead API key is required");
    this.apiKey = apiKey;
  }

  async _request(method, path, body = null) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${SL_BASE}${path}${separator}api_key=${encodeURIComponent(this.apiKey)}`;
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body && method !== "GET") opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`Smartlead API error: HTTP ${res.status}`);
      err.statusCode = res.status;
      err.responseBody = data;
      throw err;
    }
    return data;
  }

  async testConnection() {
    try {
      await this._request("GET", "/campaigns");
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  async addEmailAccount(account) {
    return this._request("POST", "/email-accounts/save", account);
  }

  async updateWarmup(id, enabled) {
    return this._request("POST", `/email-accounts/${id}/warmup`, {
      warmup_enabled: enabled,
    });
  }

  async getWarmupStats(id) {
    return this._request("GET", `/email-accounts/${id}/warmup-stats`);
  }

  async listCampaigns() {
    return this._request("GET", "/campaigns");
  }

  async createCampaign(name) {
    return this._request("POST", "/campaigns/create", { name });
  }

  async getCampaignStats(id) {
    return this._request("GET", `/campaigns/${id}/statistics`);
  }

  async addEmailsToCampaign(campaignId, emailAccountIds) {
    return this._request("POST", `/campaigns/${campaignId}/email-accounts`, {
      email_account_ids: emailAccountIds,
    });
  }
}

// ── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Mask a token for display — show first 6 + last 4 chars.
 */
export function maskToken(token) {
  if (!token) return "";
  if (token.length <= 12) return "\u2022".repeat(token.length);
  return (
    token.slice(0, 6) + "\u2022".repeat(20) + token.slice(-4)
  );
}

/**
 * Load email_settings for an org and instantiate API clients.
 * Throws if no settings row exists.
 */
export async function getServiceClients(orgId) {
  const { data: settings, error } = await supabase
    .from("email_settings")
    .select("*")
    .eq("org_id", orgId)
    .single();

  if (error || !settings) {
    const err = new Error("Email settings not configured");
    err.status = 404;
    throw err;
  }

  const clients = { settings };

  if (settings.cloudflare_api_token && settings.cloudflare_account_id) {
    clients.cloudflare = new CloudflareService(
      settings.cloudflare_api_token,
      settings.cloudflare_account_id
    );
  }

  if (settings.smartlead_api_key) {
    clients.smartlead = new SmartleadService(settings.smartlead_api_key);
  }

  return clients;
}
