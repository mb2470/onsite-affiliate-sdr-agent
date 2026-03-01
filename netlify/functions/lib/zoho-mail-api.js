/**
 * ZohoMailService — Wrapper for the Zoho Mail Organization Admin API
 *
 * Handles OAuth token refresh and provides methods for:
 * - Domain management (add, verify, list)
 * - User/mailbox creation
 * - Email forwarding configuration
 * - IMAP access enabling
 *
 * Usage:
 *   const { ZohoMailService, ZohoMailApiError } = require('./lib/zoho-mail-api');
 *   const zoho = new ZohoMailService({
 *     clientId: '...',
 *     clientSecret: '...',
 *     refreshToken: '...',
 *     orgId: '...',          // zoid
 *     accountsDomain: 'https://accounts.zoho.com',  // optional, regional
 *     mailDomain: 'https://mail.zoho.com',           // optional, regional
 *   });
 *   const domains = await zoho.listDomains();
 */

class ZohoMailApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = 'ZohoMailApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

class ZohoMailService {
  constructor({ clientId, clientSecret, refreshToken, orgId, accountsDomain, mailDomain }) {
    if (!clientId) throw new Error('Zoho client_id is required');
    if (!clientSecret) throw new Error('Zoho client_secret is required');
    if (!refreshToken) throw new Error('Zoho refresh_token is required');
    if (!orgId) throw new Error('Zoho org_id (zoid) is required');

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.orgId = orgId;
    this.accountsDomain = accountsDomain || 'https://accounts.zoho.com';
    this.mailDomain = mailDomain || 'https://mail.zoho.com';

    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  // ── OAuth Token Management ──────────────────────────────────────────────

  async _ensureAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - 60000) {
      return this._accessToken;
    }

    const url = `${this.accountsDomain}/oauth/v2/token`;
    const params = new URLSearchParams({
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new ZohoMailApiError(
        `Zoho OAuth token refresh failed: ${data.error || 'unknown error'}`,
        res.status,
        data
      );
    }

    if (!data.access_token) {
      throw new ZohoMailApiError(
        'Zoho OAuth returned 200 but no access_token in response',
        200,
        data
      );
    }

    this._accessToken = data.access_token;
    this._tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this._accessToken;
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   * Returns { access_token, refresh_token, expires_in } on success.
   */
  async exchangeAuthCode(code) {
    const url = `${this.accountsDomain}/oauth/v2/token`;
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new ZohoMailApiError(
        `Zoho auth code exchange failed: ${data.error || 'unknown error'}`,
        res.status,
        data
      );
    }

    return data;
  }

  // ── HTTP Helper ─────────────────────────────────────────────────────────

  async _request(method, path, body = null) {
    const token = await this._ensureAccessToken();
    const url = `${this.mailDomain}${path}`;

    const opts = {
      method,
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (body && method !== 'GET') {
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
      throw new ZohoMailApiError(
        `Zoho Mail API error: HTTP ${res.status}`,
        res.status,
        data
      );
    }

    return data;
  }

  // ── Connection Test ─────────────────────────────────────────────────────

  async testConnection() {
    // Step 1: Refresh the access token
    let tokenOk = false;
    try {
      await this._ensureAccessToken();
      tokenOk = true;
    } catch (err) {
      return {
        valid: false,
        error: err.message,
        details: err.responseBody || null,
        debug: { step: 'token_refresh', tokenOk: false },
      };
    }

    // Step 2: Use /domains endpoint — it matches the ZohoMail.organization.domains.ALL
    // scope that users are instructed to create.
    try {
      const data = await this._request('GET', `/api/organization/${this.orgId}/domains`);
      const domains = data?.data?.map(d => d.domainName) || [];
      return { valid: true, domains };
    } catch (err) {
      const domainErr = {
        status: err.statusCode,
        body: err.responseBody || null,
        url: `/api/organization/${this.orgId}/domains`,
      };

      // Step 3: If the domains call failed, try an endpoint that doesn't need ZOID
      // to determine if the issue is the token or the ZOID.
      if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404) {
        // A 403 on the /domains endpoint can mean EITHER:
        //   a) The ZOID is correct but the token lacks ZohoMail.organization.domains.ALL scope
        //   b) The ZOID is wrong and Zoho returns 403 instead of 404
        // We distinguish these by checking the error body for scope/permission keywords
        // and by checking whether /api/accounts also succeeds.
        const domainBody = err.responseBody || {};
        const domainBodyStr = JSON.stringify(domainBody).toLowerCase();
        const looksLikeScopeError = err.statusCode === 403 && (
          domainBodyStr.includes('scope') ||
          domainBodyStr.includes('permission') ||
          domainBodyStr.includes('insufficient') ||
          domainBodyStr.includes('not authorized') ||
          domainBodyStr.includes('forbidden')
        );

        try {
          await this._request('GET', '/api/accounts');
          // Token works for /api/accounts. Now decide: scope issue or wrong ZOID?
          if (looksLikeScopeError) {
            return {
              valid: false,
              error: `OAuth token works but lacks permission for organization domains (HTTP 403). `
                + 'Re-generate your refresh token with scope: ZohoMail.organization.domains.ALL',
              auth_ok: true,
              scope_issue: true,
              debug: { step: 'missing_domain_scope', tokenOk, domainErr },
            };
          }
          // 403 without scope keywords, or 401/404 — ZOID is wrong
          return {
            valid: false,
            error: `OAuth credentials are valid, but Organization ID "${this.orgId}" was rejected by Zoho (HTTP ${err.statusCode}). `
              + 'The ZOID is not your User ID — find it in the Zoho Mail Admin Console URL (mail.zoho.com).',
            auth_ok: true,
            debug: { step: 'zoid_wrong', tokenOk, domainErr },
          };
        } catch (acctErr) {
          // Both failed — token scopes may be insufficient
          return {
            valid: false,
            error: `Zoho rejected both API calls (HTTP ${err.statusCode}). `
              + 'Your refresh token may lack the required scopes. '
              + 'Re-generate it with scopes: ZohoMail.organization.domains.ALL,ZohoMail.organization.accounts.ALL',
            debug: {
              step: 'both_failed',
              tokenOk,
              domainErr,
              accountsErr: { status: acctErr.statusCode, body: acctErr.responseBody || null },
            },
          };
        }
      }
      return {
        valid: false,
        error: err.message,
        details: err.responseBody || null,
        debug: { step: 'domains_call', tokenOk, domainErr },
      };
    }
  }

  // ── Domain Management ───────────────────────────────────────────────────

  async listDomains() {
    return this._request('GET', `/api/organization/${this.orgId}/domains`);
  }

  async addDomain(domainName) {
    return this._request('POST', `/api/organization/${this.orgId}/domains`, {
      domainName,
    });
  }

  async verifyDomain(domainName, method = 'verifyDomainByTXT') {
    return this._request('PUT', `/api/organization/${this.orgId}/domains/${encodeURIComponent(domainName)}`, {
      mode: method,
    });
  }

  // ── User / Mailbox Management ───────────────────────────────────────────

  async addUser({ emailAddress, password, firstName, lastName, displayName }) {
    return this._request('POST', `/api/organization/${this.orgId}/accounts`, {
      primaryEmailAddress: emailAddress,
      password,
      firstName: firstName || emailAddress.split('@')[0],
      lastName: lastName || '',
      displayName: displayName || firstName || emailAddress.split('@')[0],
    });
  }

  async listUsers() {
    return this._request('GET', `/api/organization/${this.orgId}/accounts`);
  }

  async getUserDetails(accountId) {
    return this._request('GET', `/api/organization/${this.orgId}/accounts/${accountId}`);
  }

  // ── Email Forwarding ───────────────────────────────────────────────────

  async addEmailForwarding(accountId, zuid, forwardToEmail) {
    return this._request('PUT', `/api/organization/${this.orgId}/accounts/${accountId}`, {
      zuid,
      mode: 'addMailForward',
      mailForward: [{ mailForwardTo: forwardToEmail }],
    });
  }

  async enableEmailForwarding(accountId, zuid) {
    return this._request('PUT', `/api/organization/${this.orgId}/accounts/${accountId}`, {
      zuid,
      mode: 'enableMailForward',
    });
  }

  // ── IMAP / POP Access ──────────────────────────────────────────────────

  async enableImap(accountId, zuid) {
    return this._request('PUT', `/api/organization/${this.orgId}/accounts/${accountId}`, {
      zuid,
      mode: 'updateIMAPStatus',
      imapAccessEnabled: 'true',
    });
  }

  async disableImap(accountId, zuid) {
    return this._request('PUT', `/api/organization/${this.orgId}/accounts/${accountId}`, {
      zuid,
      mode: 'updateIMAPStatus',
      imapAccessEnabled: 'false',
    });
  }

  // ── Full Mailbox Provisioning (convenience) ────────────────────────────

  /**
   * Provision a complete mailbox:
   * 1. Create the user account
   * 2. Enable IMAP access
   * 3. Set up email forwarding (if forwardTo provided)
   *
   * Returns { user, imapEnabled, forwardingConfigured }
   */
  async provisionMailbox({ emailAddress, password, firstName, lastName, displayName, forwardTo }) {
    // Step 1: Create user
    const userResult = await this.addUser({
      emailAddress,
      password,
      firstName,
      lastName,
      displayName,
    });

    const accountId = userResult?.data?.accountId || userResult?.data?.zuid;
    const zuid = userResult?.data?.zuid;

    if (!accountId || !zuid) {
      throw new ZohoMailApiError(
        'User created but could not extract accountId/zuid from response',
        200,
        userResult
      );
    }

    // Step 2: Enable IMAP
    let imapEnabled = false;
    try {
      await this.enableImap(accountId, zuid);
      imapEnabled = true;
    } catch (err) {
      console.error('Failed to enable IMAP for new mailbox:', err.message);
    }

    // Step 3: Configure forwarding
    let forwardingConfigured = false;
    if (forwardTo) {
      try {
        await this.addEmailForwarding(accountId, zuid, forwardTo);
        await this.enableEmailForwarding(accountId, zuid);
        forwardingConfigured = true;
      } catch (err) {
        console.error('Failed to configure forwarding for new mailbox:', err.message);
      }
    }

    return {
      user: userResult.data,
      accountId,
      zuid,
      imapEnabled,
      forwardingConfigured,
    };
  }
}

module.exports = { ZohoMailService, ZohoMailApiError };
