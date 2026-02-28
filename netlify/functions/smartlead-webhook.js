const { createClient } = require('@supabase/supabase-js');

// Use service role key (bypasses RLS) for server-side function
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Return 200 immediately — process asynchronously below
  // (Netlify Functions are synchronous, so we process in-line but return fast)

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
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
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing from_email or to_email' }) };
  }

  try {
    // 1. Look up the email account by to_email → determines org
    const { data: account } = await supabase
      .from('email_accounts')
      .select('id, org_id')
      .eq('email_address', to_email.toLowerCase())
      .single();

    if (!account) {
      console.error(`Webhook: no email account found for ${to_email}`);
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ received: true, matched: false }) };
    }

    const orgId = account.org_id;

    // 2. Validate webhook secret — reject if org has a secret configured
    //    and the request doesn't provide it or it doesn't match
    const queryParams = event.queryStringParameters || {};
    const { data: settingsForAuth } = await supabase
      .from('email_settings')
      .select('smartlead_webhook_secret')
      .eq('org_id', orgId)
      .single();

    if (settingsForAuth?.smartlead_webhook_secret) {
      if (!queryParams.secret || queryParams.secret !== settingsForAuth.smartlead_webhook_secret) {
        return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid webhook secret' }) };
      }
    }

    // 3. Match campaign by smartlead_campaign_id
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

    // 4. Create email_conversation
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
      console.error('Webhook: failed to insert conversation:', insertErr.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to store conversation' }) };
    }

    // 5. Atomically increment campaign's total_replied (race-safe)
    if (campaignId) {
      await supabase.rpc('increment_campaign_replies', { p_campaign_id: campaignId });
    }

    // 6. Forward to Gmail (if configured)
    await forwardToGmail(orgId, { from_email, to_email, subject, email_body });

    // 7. Log activity
    await supabase.from('activity_log').insert({
      org_id: orgId,
      activity_type: 'email_reply_received',
      summary: `Inbound reply from ${from_email} to ${to_email}${campaignId ? '' : ' (no campaign match)'}`,
      status: 'success',
    });

    console.log(`Webhook: stored reply from ${from_email} → ${to_email} (conversation: ${conversation.id})`);

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ received: true, conversation_id: conversation.id }) };
  } catch (error) {
    console.error('Webhook processing error:', error);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ received: true, error: error.message }) };
  }
};

/**
 * Forward an inbound reply to the merchant's Gmail inbox via OAuth.
 * Fails silently — Gmail forwarding is optional.
 */
async function forwardToGmail(orgId, { from_email, to_email, subject, email_body }) {
  try {
    const { data: settings } = await supabase
      .from('email_settings')
      .select('gmail_oauth_credentials, gmail_from_email')
      .eq('org_id', orgId)
      .single();

    if (!settings?.gmail_oauth_credentials) return;

    const creds = settings.gmail_oauth_credentials;
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) return;

    // Refresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return;

    // Build RFC 2822 message to insert into Gmail
    const targetEmail = settings.gmail_from_email || to_email;
    const raw = [
      `From: ${from_email}`,
      `To: ${targetEmail}`,
      `Subject: [Smartlead Reply] ${subject || '(no subject)'}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Reply from: ${from_email}`,
      `Original recipient: ${to_email}`,
      '---',
      email_body || '(empty body)',
    ].join('\r\n');

    const encodedRaw = Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Insert into Gmail (not send — just add to inbox)
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/import', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: encodedRaw,
        labelIds: ['INBOX', 'UNREAD'],
      }),
    });

    console.log(`Gmail: forwarded reply from ${from_email} to ${targetEmail}`);
  } catch (err) {
    console.error(`Gmail forwarding failed for org ${orgId}:`, err.message);
    // Fail silently — Gmail forwarding is optional
  }
}
