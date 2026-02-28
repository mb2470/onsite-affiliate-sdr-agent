/**
 * SmartleadService — Wrapper for the Smartlead.ai API
 *
 * Usage:
 *   const { SmartleadService, SmartleadApiError } = require('./lib/smartlead-api');
 *   const sl = new SmartleadService('your-api-key');
 *   const campaigns = await sl.listCampaigns();
 */

const SL_BASE = 'https://server.smartlead.ai/api/v1';

class SmartleadApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = 'SmartleadApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

class SmartleadService {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Smartlead API key is required');
    this.apiKey = apiKey;
  }

  /**
   * Make an authenticated request to the Smartlead API.
   * The api_key is always passed as a query parameter.
   */
  async _request(method, path, body = null) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${SL_BASE}${path}${separator}api_key=${encodeURIComponent(this.apiKey)}`;

    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      throw new SmartleadApiError(
        `Smartlead API error: HTTP ${res.status}`,
        res.status,
        data
      );
    }

    return data;
  }

  // ── Connection ───────────────────────────────────────────

  async testConnection() {
    try {
      await this._request('GET', '/campaigns');
      return { valid: true };
    } catch (err) {
      if (err.name === 'SmartleadApiError') {
        return { valid: false, error: err.message };
      }
      throw err;
    }
  }

  // ── Email Accounts ───────────────────────────────────────

  async addEmailAccount(account) {
    return this._request('POST', '/email-accounts/save', account);
  }

  async getEmailAccount(id) {
    return this._request('GET', `/email-accounts/${id}`);
  }

  async listEmailAccounts() {
    return this._request('GET', '/email-accounts');
  }

  async updateWarmup(id, enabled) {
    return this._request('POST', `/email-accounts/${id}/warmup`, {
      warmup_enabled: enabled,
    });
  }

  async getWarmupStats(id) {
    return this._request('GET', `/email-accounts/${id}/warmup-stats`);
  }

  async deleteEmailAccount(id) {
    return this._request('DELETE', `/email-accounts/${id}`);
  }

  // ── Campaigns ────────────────────────────────────────────

  async listCampaigns() {
    return this._request('GET', '/campaigns');
  }

  async createCampaign(name) {
    return this._request('POST', '/campaigns/create', { name });
  }

  async getCampaign(id) {
    return this._request('GET', `/campaigns/${id}`);
  }

  async getCampaignStats(id) {
    return this._request('GET', `/campaigns/${id}/statistics`);
  }

  async addEmailsToCampaign(campaignId, emailAccountIds) {
    return this._request('POST', `/campaigns/${campaignId}/email-accounts`, {
      email_account_ids: emailAccountIds,
    });
  }

  async removeEmailFromCampaign(campaignId, emailAccountId) {
    return this._request('DELETE', `/campaigns/${campaignId}/email-accounts/${emailAccountId}`);
  }
}

module.exports = { SmartleadService, SmartleadApiError };
