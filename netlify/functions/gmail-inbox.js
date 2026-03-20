const { createClient } = require('@supabase/supabase-js');

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const { corsHeaders } = require('./lib/cors');

// Computed per-request in the handler; module-level so helpers can use respond().
let CORS_HEADERS = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  if (!str) return '';
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

// ── Gmail OAuth ──────────────────────────────────────────────────────────────

async function getGmailCreds(orgId) {
  const { data, error } = await supabase
    .from('email_settings')
    .select('gmail_oauth_credentials, gmail_from_email')
    .eq('org_id', orgId)
    .single();

  if (error || !data || !data.gmail_oauth_credentials) return null;

  const creds = data.gmail_oauth_credentials;
  const clientId = creds.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret || !creds.refresh_token) return null;

  return {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: creds.refresh_token,
    access_token: creds.access_token || null,
    gmail_email: data.gmail_from_email || creds.email || null,
  };
}

async function refreshAccessToken(orgId, creds) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new GmailAuthError('Gmail token refresh failed. Please re-authorize Gmail in Email Settings.');
  }

  // Persist new access_token into the JSONB
  const { data: existing } = await supabase
    .from('email_settings')
    .select('gmail_oauth_credentials')
    .eq('org_id', orgId)
    .single();

  if (existing?.gmail_oauth_credentials) {
    await supabase
      .from('email_settings')
      .update({
        gmail_oauth_credentials: {
          ...existing.gmail_oauth_credentials,
          access_token: data.access_token,
        },
      })
      .eq('org_id', orgId);
  }

  creds.access_token = data.access_token;
  return data.access_token;
}

class GmailAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

/**
 * Make an authenticated Gmail API request with auto-refresh on 401.
 */
async function gmailRequest(orgId, creds, method, path, body) {
  if (!creds.access_token) {
    await refreshAccessToken(orgId, creds);
  }

  async function doRequest() {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${creds.access_token}` },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(`${GMAIL_API}${path}`, opts);
  }

  let res = await doRequest();

  // Auto-refresh on 401
  if (res.status === 401) {
    await refreshAccessToken(orgId, creds);
    res = await doRequest();
  }

  if (res.status === 404) return null;

  if (res.status === 429) {
    throw new Error('Gmail rate limit exceeded. Try again shortly.');
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gmail API error: HTTP ${res.status} — ${errBody}`);
  }

  return res.json();
}

// ── MIME Parsing ─────────────────────────────────────────────────────────────

function getHeader(headers, name) {
  if (!headers) return null;
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function extractBodies(payload) {
  let textBody = null;
  let htmlBody = null;

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';

    if (mime === 'text/plain' && part.body?.data && !textBody) {
      textBody = base64UrlDecode(part.body.data);
    } else if (mime === 'text/html' && part.body?.data && !htmlBody) {
      htmlBody = base64UrlDecode(part.body.data);
    }

    if (part.parts) {
      for (const sub of part.parts) walk(sub);
    }
  }

  walk(payload);
  return { textBody, htmlBody };
}

function extractAttachments(payload) {
  const attachments = [];

  function walk(part) {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType,
        size: part.body.size || 0,
        attachment_id: part.body.attachmentId,
      });
    }
    if (part.parts) {
      for (const sub of part.parts) walk(sub);
    }
  }

  walk(payload);
  return attachments;
}

function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const { textBody, htmlBody } = extractBodies(msg.payload);

  return {
    gmail_message_id: msg.id,
    thread_id: msg.threadId,
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    body_text: textBody,
    body_html: htmlBody,
    snippet: msg.snippet || '',
    is_unread: (msg.labelIds || []).includes('UNREAD'),
    label_ids: msg.labelIds || [],
    headers: {
      message_id: getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
      in_reply_to: getHeader(headers, 'In-Reply-To'),
      references: getHeader(headers, 'References'),
    },
    attachments: extractAttachments(msg.payload),
    internal_date: msg.internalDate,
  };
}

// Extract just the email address from "Name <email@example.com>" format
function extractEmail(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).toLowerCase().trim();
}

// ── Org Email Addresses ──────────────────────────────────────────────────────

async function getOrgEmailAddresses(orgId) {
  const { data } = await supabase
    .from('email_accounts')
    .select('email_address')
    .eq('org_id', orgId);
  return new Set((data || []).map(a => a.email_address.toLowerCase()));
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function handleList(orgId, creds, body) {
  const query = body.query || 'in:inbox';
  const maxResults = Math.min(parseInt(body.max_results) || 25, 100);
  const pageToken = body.page_token || undefined;

  // List message IDs
  let path = `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;

  const listData = await gmailRequest(orgId, creds, 'GET', path);
  if (!listData || !listData.messages || listData.messages.length === 0) {
    return respond(200, { messages: [], next_page_token: null, result_size_estimate: 0 });
  }

  // If filtering by campaign, get that campaign's account emails
  let campaignEmails = null;
  if (body.campaign_id) {
    const { data: campaign } = await supabase
      .from('outreach_campaigns')
      .select('sending_account_ids')
      .eq('id', body.campaign_id)
      .eq('org_id', orgId)
      .single();

    if (campaign && campaign.sending_account_ids?.length > 0) {
      const { data: accts } = await supabase
        .from('email_accounts')
        .select('email_address')
        .in('id', campaign.sending_account_ids);
      campaignEmails = new Set((accts || []).map(a => a.email_address.toLowerCase()));
    }
  }

  // Fetch metadata for each message
  const messages = [];
  for (const item of listData.messages) {
    const msg = await gmailRequest(orgId, creds, 'GET',
      `/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
    );
    if (!msg) continue;

    const headers = msg.payload?.headers || [];
    const to = getHeader(headers, 'To');
    const from = getHeader(headers, 'From');

    // Campaign filter: skip if neither from nor to matches campaign accounts
    if (campaignEmails) {
      const toAddr = extractEmail(to);
      const fromAddr = extractEmail(from);
      if (!campaignEmails.has(toAddr) && !campaignEmails.has(fromAddr)) continue;
    }

    messages.push({
      gmail_message_id: msg.id,
      thread_id: msg.threadId,
      from: from,
      to: to,
      subject: getHeader(headers, 'Subject'),
      snippet: msg.snippet || '',
      date: getHeader(headers, 'Date'),
      is_unread: (msg.labelIds || []).includes('UNREAD'),
      label_ids: msg.labelIds || [],
    });
  }

  return respond(200, {
    messages,
    next_page_token: listData.nextPageToken || null,
    result_size_estimate: listData.resultSizeEstimate || 0,
  });
}

async function handleGet(orgId, creds, body) {
  const { message_id } = body;
  if (!message_id) return respond(400, { error: 'Missing required field: message_id' });

  const msg = await gmailRequest(orgId, creds, 'GET',
    `/users/me/messages/${message_id}?format=full`
  );

  if (!msg) return respond(404, { error: 'Message not found in Gmail.' });

  const parsed = parseGmailMessage(msg);

  // Mark matching conversation as read
  await supabase
    .from('email_conversations')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('gmail_message_id', message_id);

  return respond(200, parsed);
}

async function handleThread(orgId, creds, body) {
  const { thread_id } = body;
  if (!thread_id) return respond(400, { error: 'Missing required field: thread_id' });

  const threadData = await gmailRequest(orgId, creds, 'GET',
    `/users/me/threads/${thread_id}?format=full`
  );

  if (!threadData) return respond(404, { error: 'Thread not found in Gmail.' });

  const orgEmails = await getOrgEmailAddresses(orgId);

  // Also include the org's Gmail address
  const { data: settings } = await supabase
    .from('email_settings')
    .select('gmail_from_email')
    .eq('org_id', orgId)
    .single();
  if (settings?.gmail_from_email) orgEmails.add(settings.gmail_from_email.toLowerCase());

  // Parse each message and determine direction
  const messages = (threadData.messages || [])
    .sort((a, b) => parseInt(a.internalDate) - parseInt(b.internalDate))
    .map(msg => {
      const parsed = parseGmailMessage(msg);
      const fromAddr = extractEmail(parsed.from);
      parsed.direction = orgEmails.has(fromAddr) ? 'outbound' : 'inbound';
      return parsed;
    });

  // Cross-reference with email_conversations for conversation IDs
  const gmailIds = messages.map(m => m.gmail_message_id).filter(Boolean);
  if (gmailIds.length > 0) {
    const { data: convos } = await supabase
      .from('email_conversations')
      .select('id, gmail_message_id')
      .eq('org_id', orgId)
      .in('gmail_message_id', gmailIds);

    const convoMap = {};
    for (const c of (convos || [])) {
      convoMap[c.gmail_message_id] = c.id;
    }
    for (const m of messages) {
      m.conversation_id = convoMap[m.gmail_message_id] || null;
    }
  }

  const firstSubject = messages.length > 0 ? messages[0].subject : null;

  return respond(200, {
    thread_id,
    subject: firstSubject,
    message_count: messages.length,
    messages,
  });
}

async function handleReply(orgId, creds, body) {
  const { thread_id, in_reply_to, to, body_html, cc, from_account_id } = body;

  if (!thread_id) return respond(400, { error: 'Missing required field: thread_id' });
  if (!in_reply_to) return respond(400, { error: 'Missing required field: in_reply_to' });
  if (!to) return respond(400, { error: 'Missing required field: to' });
  if (!body_html) return respond(400, { error: 'Missing required field: body_html' });

  // Fetch the original message for threading headers
  const origMsg = await gmailRequest(orgId, creds, 'GET',
    `/users/me/messages/${in_reply_to}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Message-Id&metadataHeaders=Subject&metadataHeaders=References`
  );

  if (!origMsg) return respond(404, { error: 'Original message not found in Gmail.' });

  const origHeaders = origMsg.payload?.headers || [];
  const origMessageId = getHeader(origHeaders, 'Message-ID') || getHeader(origHeaders, 'Message-Id') || '';
  const origSubject = getHeader(origHeaders, 'Subject') || '';
  const origRefs = getHeader(origHeaders, 'References') || '';

  // Determine sender
  let fromEmail = creds.gmail_email;
  if (from_account_id) {
    const { data: acct } = await supabase
      .from('email_accounts')
      .select('email_address, display_name')
      .eq('id', from_account_id)
      .eq('org_id', orgId)
      .single();
    if (acct) fromEmail = acct.email_address;
  }

  if (!fromEmail) return respond(400, { error: 'No sender email configured. Set gmail_from_email in Email Settings.' });

  // Build subject line
  const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

  // Build References header
  const references = origRefs ? `${origRefs} ${origMessageId}` : origMessageId;

  // Build RFC 2822 MIME message
  const boundary = `boundary_${Date.now()}`;
  const rawLines = [
    `From: ${fromEmail}`,
    `To: ${to}`,
  ];
  if (cc) rawLines.push(`Cc: ${cc}`);
  rawLines.push(
    `Subject: ${subject}`,
    `In-Reply-To: ${origMessageId}`,
    `References: ${references}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body_html.replace(/<[^>]+>/g, ''), // crude HTML strip for plain text part
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    body_html,
    `--${boundary}--`,
  );

  const encodedRaw = base64UrlEncode(rawLines.join('\r\n'));

  // Send via Gmail API
  const sendResult = await gmailRequest(orgId, creds, 'POST',
    '/users/me/messages/send',
    { raw: encodedRaw, threadId: thread_id }
  );

  if (!sendResult) return respond(500, { error: 'Failed to send reply via Gmail.' });

  // Store outbound conversation
  const { data: conversation } = await supabase
    .from('email_conversations')
    .insert({
      org_id: orgId,
      from_email: fromEmail.toLowerCase(),
      to_email: to.toLowerCase(),
      subject,
      body_text: body_html.replace(/<[^>]+>/g, ''),
      body_html,
      direction: 'outbound',
      message_type: 'followup',
      gmail_message_id: sendResult.id,
      thread_id: sendResult.threadId || thread_id,
      is_read: true,
    })
    .select('id')
    .single();

  await supabase.from('activity_log').insert({
    org_id: orgId,
    activity_type: 'email_reply_sent',
    summary: `Reply sent from ${fromEmail} to ${to}`,
    status: 'success',
  });

  return respond(200, {
    gmail_message_id: sendResult.id,
    thread_id: sendResult.threadId || thread_id,
    conversation_id: conversation?.id || null,
    sent: true,
  });
}

async function handleSync(orgId, creds, body) {
  const maxResults = Math.min(parseInt(body.max_results) || 100, 200);

  // Default: 7 days ago
  const since = body.since
    ? new Date(body.since)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const afterEpoch = Math.floor(since.getTime() / 1000);

  // Get org's outreach email addresses for the query filter
  const orgEmails = await getOrgEmailAddresses(orgId);

  // Also include the org's Gmail sender address (may exist without email_accounts)
  const { data: syncSettings } = await supabase
    .from('email_settings')
    .select('gmail_from_email')
    .eq('org_id', orgId)
    .single();
  if (syncSettings?.gmail_from_email) orgEmails.add(syncSettings.gmail_from_email.toLowerCase());

  if (orgEmails.size === 0) {
    return respond(200, { synced: 0, skipped: 0, errors: 0, details: { new_inbound: 0, new_outbound: 0, already_exists: 0 } });
  }

  // Build Gmail query: messages from OR to any org address
  // Gmail syntax: {from:a} matches OR across brace groups, but
  // {from:a to:a} is AND within. Use explicit from:/to: with OR.
  const fromClauses = Array.from(orgEmails).map(e => `from:${e}`);
  const toClauses = Array.from(orgEmails).map(e => `to:${e}`);
  const query = `(${fromClauses.join(' OR ')} OR ${toClauses.join(' OR ')}) after:${afterEpoch}`;

  // Fetch message IDs
  let allMessageIds = [];
  let pageToken = null;
  do {
    let path = `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults - allMessageIds.length, 100)}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;

    const listData = await gmailRequest(orgId, creds, 'GET', path);
    if (!listData || !listData.messages) break;

    allMessageIds.push(...listData.messages.map(m => m.id));
    pageToken = listData.nextPageToken;
  } while (pageToken && allMessageIds.length < maxResults);

  // Check which gmail_message_ids already exist in email_conversations
  const { data: existing } = await supabase
    .from('email_conversations')
    .select('gmail_message_id')
    .eq('org_id', orgId)
    .in('gmail_message_id', allMessageIds.length > 0 ? allMessageIds : ['__none__']);

  const existingIds = new Set((existing || []).map(e => e.gmail_message_id));

  const details = { new_inbound: 0, new_outbound: 0, already_exists: 0 };
  let errors = 0;

  for (const msgId of allMessageIds) {
    if (existingIds.has(msgId)) {
      details.already_exists++;
      continue;
    }

    try {
      const msg = await gmailRequest(orgId, creds, 'GET', `/users/me/messages/${msgId}?format=full`);
      if (!msg) { errors++; continue; }

      const parsed = parseGmailMessage(msg);
      const fromAddr = extractEmail(parsed.from);
      const toAddr = extractEmail(parsed.to);
      const direction = orgEmails.has(fromAddr) ? 'outbound' : 'inbound';

      // Try to match campaign via account
      let campaignId = null;
      const relevantEmail = direction === 'outbound' ? fromAddr : toAddr;
      if (relevantEmail) {
        const { data: acct } = await supabase
          .from('email_accounts')
          .select('id')
          .eq('email_address', relevantEmail)
          .eq('org_id', orgId)
          .single();

        if (acct) {
          // Find a campaign that uses this account
          const { data: camps } = await supabase
            .from('outreach_campaigns')
            .select('id, sending_account_ids')
            .eq('org_id', orgId)
            .cs('sending_account_ids', `{${acct.id}}`);

          if (camps && camps.length > 0) campaignId = camps[0].id;
        }
      }

      await supabase
        .from('email_conversations')
        .insert({
          org_id: orgId,
          campaign_id: campaignId,
          from_email: fromAddr || parsed.from,
          to_email: toAddr || parsed.to,
          subject: parsed.subject,
          body_text: parsed.body_text,
          body_html: parsed.body_html,
          direction,
          message_type: direction === 'inbound' ? 'reply' : 'followup',
          gmail_message_id: msgId,
          thread_id: parsed.thread_id,
          message_id: parsed.headers.message_id,
          in_reply_to: parsed.headers.in_reply_to,
          is_read: !parsed.is_unread,
        });

      if (direction === 'inbound') details.new_inbound++;
      else details.new_outbound++;
    } catch (err) {
      console.error(`Sync error for message ${msgId}:`, err.message);
      errors++;
    }
  }

  return respond(200, {
    synced: details.new_inbound + details.new_outbound,
    skipped: details.already_exists,
    errors,
    details,
  });
}

async function handleStats(orgId, creds, body = {}) {
  // Total conversations from Supabase
  const { count: total } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);

  const { count: unread } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_read', false);

  // By direction
  const { count: inboundCount } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'inbound');

  const { count: outboundCount } = await supabase
    .from('email_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('direction', 'outbound');

  // By campaign with unread counts
  const { data: campaigns } = await supabase
    .from('outreach_campaigns')
    .select('id, name')
    .eq('org_id', orgId);

  const byCampaign = [];
  for (const camp of (campaigns || [])) {
    const { count: campTotal } = await supabase
      .from('email_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('campaign_id', camp.id);

    const { count: campUnread } = await supabase
      .from('email_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('campaign_id', camp.id)
      .eq('is_read', false);

    if (campTotal > 0) {
      byCampaign.push({
        campaign_id: camp.id,
        campaign_name: camp.name,
        count: campTotal || 0,
        unread: campUnread || 0,
      });
    }
  }

  // Live Gmail unread count (graceful failure)
  let gmailUnreadTotal = null;
  try {
    const labelData = await gmailRequest(orgId, creds, 'GET', '/users/me/labels/INBOX');
    if (labelData) gmailUnreadTotal = labelData.messagesUnread || 0;
  } catch {
    // Silently fail — live count is optional
  }

  const trailingDays = Number.isFinite(Number(body.trailing_days))
    ? Math.max(1, parseInt(body.trailing_days, 10))
    : 1;

  const tzOffsetMinutes = Number.isFinite(Number(body.tz_offset_minutes))
    ? parseInt(body.tz_offset_minutes, 10)
    : 0;

  // Gmail source-of-truth sent count for trailing window (local day bucket)
  let gmailSentTrailing = null;
  try {
    const offsetMs = tzOffsetMinutes * 60 * 1000;
    const localNow = new Date(Date.now() - offsetMs);
    localNow.setUTCHours(0, 0, 0, 0);
    localNow.setUTCDate(localNow.getUTCDate() - (trailingDays - 1));
    const startUtcMs = localNow.getTime() + offsetMs;
    const afterEpochSeconds = Math.floor(startUtcMs / 1000);

    const sentQuery = `in:sent after:${afterEpochSeconds}`;
    const sentData = await gmailRequest(
      orgId,
      creds,
      'GET',
      `/users/me/messages?q=${encodeURIComponent(sentQuery)}&maxResults=1`
    );
    if (sentData) gmailSentTrailing = sentData.resultSizeEstimate || 0;
  } catch {
    // Silently fail — live count is optional
  }

  // Bounce count from DB (activity_log) — one row per unique bounced email, accurate by design.
  // Gmail's resultSizeEstimate is unreliable and can wildly over-count.
  let gmailBouncesTrailing = null;
  try {
    const offsetMs = tzOffsetMinutes * 60 * 1000;
    const localNow = new Date(Date.now() - offsetMs);
    localNow.setUTCHours(0, 0, 0, 0);
    localNow.setUTCDate(localNow.getUTCDate() - (trailingDays - 1));
    const startUtcMs = localNow.getTime() + offsetMs;
    const trailingStartIso = new Date(startUtcMs).toISOString();

    const { count: bounceCount } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('activity_type', 'email_bounced')
      .gte('created_at', trailingStartIso);

    gmailBouncesTrailing = bounceCount || 0;
  } catch {
    // Silently fail — live count is optional
  }

  const gmailSentToday = trailingDays === 1 ? gmailSentTrailing : null;

  return respond(200, {
    total_conversations: total || 0,
    unread: unread || 0,
    by_campaign: byCampaign,
    by_direction: {
      inbound: inboundCount || 0,
      outbound: outboundCount || 0,
    },
    gmail_unread_total: gmailUnreadTotal,
    gmail_sent_today: gmailSentToday,
    gmail_sent_trailing: gmailSentTrailing,
    gmail_bounces_trailing: gmailBouncesTrailing,
    gmail_trailing_days: trailingDays,
    gmail_tz_offset_minutes: tzOffsetMinutes,
  });
}

async function handleMarkRead(orgId, creds, body) {
  const { message_id } = body;
  if (!message_id) return respond(400, { error: 'Missing required field: message_id' });

  // Remove UNREAD label in Gmail
  await gmailRequest(orgId, creds, 'POST',
    `/users/me/messages/${message_id}/modify`,
    { removeLabelIds: ['UNREAD'] }
  );

  // Mark local conversation as read
  await supabase
    .from('email_conversations')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('gmail_message_id', message_id);

  return respond(200, { success: true });
}

// ── Main Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  CORS_HEADERS = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(400, { error: 'Only POST requests are supported.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const orgId = body.org_id || event.headers['x-org-id'];
  const { action } = body;

  if (!orgId) return respond(400, { error: 'Missing required field: org_id' });
  if (!action) return respond(400, { error: 'Missing required field: action' });

  try {
    const creds = await getGmailCreds(orgId);
    if (!creds) {
      return respond(400, { error: 'Gmail not connected. Please authorize Gmail in Email Settings.' });
    }

    switch (action) {
      case 'list':
        return await handleList(orgId, creds, body);
      case 'get':
        return await handleGet(orgId, creds, body);
      case 'thread':
        return await handleThread(orgId, creds, body);
      case 'reply':
        return await handleReply(orgId, creds, body);
      case 'sync':
        return await handleSync(orgId, creds, body);
      case 'stats':
        return await handleStats(orgId, creds, body);
      case 'mark-read':
        return await handleMarkRead(orgId, creds, body);
      default:
        return respond(400, {
          error: `Unknown action: ${action}. Valid actions: list, get, thread, reply, sync, stats, mark-read`,
        });
    }
  } catch (error) {
    if (error.name === 'GmailAuthError') {
      return respond(401, { error: error.message });
    }
    console.error(`gmail-inbox error (action=${action}):`, error);
    return respond(500, { error: error.message });
  }
};
