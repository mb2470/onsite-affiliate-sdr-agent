const { createClient } = require('@supabase/supabase-js');

// Use service role key (bypasses RLS) for server-side function
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/**
 * Build an RFC 2822 message and return it as a base64url-encoded string
 * suitable for the Gmail messages/import endpoint.
 */
function buildRawMessage({ from, to, subject, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject || '(no subject)'}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    body || '',
  ];
  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Smartlead Reply Webhook
 *
 * Receives inbound email replies from Smartlead and stores them
 * as email_conversations. Optionally forwards to the merchant's
 * Gmail inbox via OAuth.
 *
 * Setup in Smartlead:
 *   URL: https://your-site.netlify.app/.netlify/functions/smartlead-webhook?secret=YOUR_SECRET
 *   Event: Reply received
 *
 * Webhook payload:
 *   { from_email, to_email, email_body, email_body_html, subject,
 *     campaign_name, campaign_id, lead_id }
 */
exports.handler = async (event) => {
  // ── 1. Method gate ──────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  // ── 2. Parse & validate JSON ────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const {
    from_email,
    to_email,
    email_body,
    email_body_html,
    subject,
    campaign_id: smartleadCampaignId,
    lead_id: smartleadLeadId,
  } = payload;

  if (!from_email || !to_email) {
    return respond(400, { error: 'Missing from_email or to_email' });
  }

  try {
    // ── 3. Resolve tenant via to_email ──────────────────────────────────
    const { data: account } = await supabase
      .from('email_accounts')
      .select('id, org_id')
      .eq('email_address', to_email.toLowerCase())
      .single();

    if (!account) {
      console.error(`[Webhook] No email account found for ${to_email}`);
      return respond(200, { received: true, matched: false });
    }

    const orgId = account.org_id;

    // ── 4. Validate webhook secret ──────────────────────────────────────
    // Per-tenant secret (from email_settings) takes priority, then global
    // env var. If neither is configured, reject — deny by default.
    const { data: settings } = await supabase
      .from('email_settings')
      .select('smartlead_webhook_secret')
      .eq('org_id', orgId)
      .single();

    const tenantSecret = settings?.smartlead_webhook_secret;
    const globalSecret = process.env.SMARTLEAD_WEBHOOK_SECRET;
    const expectedSecret = tenantSecret || globalSecret;

    if (!expectedSecret) {
      console.error(`[Webhook] No webhook secret configured for org ${orgId}`);
      return respond(401, { error: 'Webhook secret not configured' });
    }

    const queryParams = event.queryStringParameters || {};
    if (!queryParams.secret || queryParams.secret !== expectedSecret) {
      return respond(401, { error: 'Invalid webhook secret' });
    }

    // ── 5. Resolve campaign by smartlead_campaign_id ────────────────────
    let campaignId = null;
    if (smartleadCampaignId) {
      const { data: campaign } = await supabase
        .from('outreach_campaigns')
        .select('id')
        .eq('org_id', orgId)
        .eq('smartlead_campaign_id', smartleadCampaignId.toString())
        .single();
      if (campaign) campaignId = campaign.id;
    }

    // ── 6. INSERT into email_conversations ──────────────────────────────
    const { data: conversation, error: insertErr } = await supabase
      .from('email_conversations')
      .insert({
        org_id: orgId,
        campaign_id: campaignId,
        account_id: account.id,
        from_email: from_email.toLowerCase(),
        to_email: to_email.toLowerCase(),
        subject: subject || null,
        body_text: email_body || null,
        body_html: email_body_html || null,
        direction: 'inbound',
        message_type: 'reply',
        smartlead_message_id: smartleadLeadId?.toString() || null,
        raw_payload: payload,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[Webhook] Failed to insert conversation:', insertErr.message);
      // Return 200 to prevent Smartlead from retrying (retries create duplicates)
      return respond(200, { received: true, error: 'Failed to store conversation: ' + insertErr.message });
    }

    // ── 7. Increment campaign reply counter (atomic) ────────────────────
    if (campaignId) {
      await supabase.rpc('increment_campaign_replies', { p_campaign_id: campaignId });
    }

    // ── 8. Forward to Gmail (optional, fail-silent) ─────────────────────
    const gmailMessageId = await forwardToGmail(orgId, {
      from_email,
      to_email,
      subject,
      email_body,
      email_body_html,
    });

    // Store gmail_message_id on the conversation row if forwarding succeeded
    if (gmailMessageId) {
      await supabase
        .from('email_conversations')
        .update({ gmail_message_id: gmailMessageId })
        .eq('id', conversation.id);
    }

    console.log(`[Webhook] Stored reply from ${from_email} → ${to_email} (conversation: ${conversation.id})`);

    // ── 9. Return success ───────────────────────────────────────────────
    return respond(200, { received: true, conversation_id: conversation.id });
  } catch (error) {
    console.error('[Webhook] Processing error:', error);
    // Always 200 — Smartlead retries on non-2xx, which would create duplicates
    return respond(200, { received: true, error: error.message });
  }
};

/**
 * Forward an inbound reply to the merchant's Gmail inbox via OAuth.
 * Fails silently — Gmail forwarding is optional.
 *
 * @returns {string|null} gmail_message_id if forwarding succeeded, null otherwise
 */
async function forwardToGmail(orgId, { from_email, to_email, subject, email_body, email_body_html }) {
  try {
    const { data: settings } = await supabase
      .from('email_settings')
      .select('gmail_oauth_credentials, gmail_from_email')
      .eq('org_id', orgId)
      .single();

    if (!settings?.gmail_oauth_credentials) return null;

    const creds = settings.gmail_oauth_credentials;
    const clientId = creds.client_id || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !creds.refresh_token) return null;

    // Refresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token || creds.access_token;
    if (!accessToken) return null;

    // Persist refreshed access token if it changed
    if (tokenData.access_token && tokenData.access_token !== creds.access_token) {
      await supabase
        .from('email_settings')
        .update({
          gmail_oauth_credentials: {
            ...creds,
            access_token: tokenData.access_token,
          },
        })
        .eq('org_id', orgId);
    }

    // Build RFC 2822 message (HTML) and import into Gmail
    const targetEmail = settings.gmail_from_email || to_email;
    const raw = buildRawMessage({
      from: from_email,
      to: targetEmail,
      subject: `[Smartlead Reply] ${subject || '(no subject)'}`,
      body: email_body_html || email_body || '',
    });

    const importRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/import',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw, labelIds: ['INBOX', 'UNREAD'] }),
      }
    );

    const importData = await importRes.json();

    if (importData?.id) {
      console.log(`[Webhook] Gmail: forwarded reply from ${from_email} to ${targetEmail} (${importData.id})`);
      return importData.id;
    }

    return null;
  } catch (gmailErr) {
    console.error(`[Webhook] Gmail forward failed for org ${orgId}:`, gmailErr.message);
    return null;
  }
}
