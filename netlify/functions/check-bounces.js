const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

// Refresh OAuth access token using refresh token
async function getAccessToken() {
  const creds = JSON.parse(process.env.GMAIL_OAUTH_CREDENTIALS);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('Failed to refresh token: ' + JSON.stringify(data));
  return data.access_token;
}

// Gmail API helper
async function gmailGet(accessToken, endpoint) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Gmail API error: ${response.status}`);
  return response.json();
}

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.org_id || event.headers['x-org-id'] || event.headers['X-Org-Id'];
    if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: org_id' }) };

    const accessToken = await getAccessToken();

    // Search for bounce notifications from common Gmail bounce senders in last 30 days
    const bounceQuery = [
      'newer_than:30d',
      '(from:mailer-daemon OR from:postmaster OR from:mail delivery subsystem)',
      '(subject:"Delivery Status Notification (Failure)" OR subject:"Undelivered Mail Returned to Sender" OR subject:undeliverable OR subject:delivery)',
    ].join(' ');

    const searchRes = await gmailGet(accessToken,
      'messages?q=' + encodeURIComponent(bounceQuery) + '&maxResults=100'
    );

    const messages = searchRes.messages || [];
    console.log(`📧 Found ${messages.length} bounce notifications`);

    if (messages.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ bounces: 0, cleaned: 0, message: 'No bounces found' }),
      };
    }

    // Collect the sender's own email so we can exclude it from bounce results
    const senderEmail = (process.env.GMAIL_FROM_EMAIL || '').toLowerCase();
    let senderEmails = new Set();
    if (senderEmail) senderEmails.add(senderEmail);

    // Also pull org sender addresses from email_settings / email_accounts
    try {
      const { data: emailSettings } = await supabase
        .from('email_settings')
        .select('gmail_from_email')
        .eq('org_id', orgId)
        .single();
      if (emailSettings?.gmail_from_email) senderEmails.add(emailSettings.gmail_from_email.toLowerCase());
    } catch { /* ignore */ }
    try {
      const { data: emailAccounts } = await supabase
        .from('email_accounts')
        .select('email_address')
        .eq('org_id', orgId);
      for (const acct of (emailAccounts || [])) {
        if (acct.email_address) senderEmails.add(acct.email_address.toLowerCase());
      }
    } catch { /* ignore */ }

    // Map of email -> bounce date (from the Gmail message)
    let bounceMap = {};

    for (const msg of messages) {
      try {
        const detail = await gmailGet(accessToken, `messages/${msg.id}?format=full`);
        const body = getMessageBody(detail);

        // Get the actual date of the bounce message
        const dateHeader = (detail.payload?.headers || []).find(
          h => h.name.toLowerCase() === 'date'
        );
        const bounceDate = dateHeader ? new Date(dateHeader.value).toISOString() : new Date(parseInt(detail.internalDate)).toISOString();

        // Extract bounced email addresses — tighter patterns to avoid false positives
        // Each pattern captures the RECIPIENT address that failed delivery
        const emailPatterns = [
          /wasn'?t delivered to\s+(\S+@\S+\.\S+)/gi,
          /could not be delivered to\s+(\S+@\S+\.\S+)/gi,
          /delivery to the following recipient[s]? failed.*?(\S+@\S+\.\S+)/gi,
          /failed to deliver.*?to\s+(\S+@\S+\.\S+)/gi,
          /undeliverable.*?to[:\s]+(\S+@\S+\.\S+)/gi,
        ];

        const foundEmails = [];

        // Check X-Failed-Recipients header (most reliable)
        const failedHeader = (detail.payload?.headers || []).find(
          h => h.name.toLowerCase() === 'x-failed-recipients'
        );
        if (failedHeader) {
          // Header can contain multiple comma-separated addresses
          for (const addr of failedHeader.value.split(',')) {
            const cleaned = addr.trim().toLowerCase().replace(/[<>]/g, '');
            if (cleaned.includes('@')) foundEmails.push(cleaned);
          }
        }

        // Only fall back to body regex if X-Failed-Recipients wasn't found
        if (foundEmails.length === 0) {
          for (const pattern of emailPatterns) {
            let match;
            while ((match = pattern.exec(body)) !== null) {
              const email = match[1].replace(/[<>.,;'"()]/g, '').toLowerCase();
              if (email.includes('@') && !email.includes('mailer-daemon') && !email.includes('googlemail')) {
                foundEmails.push(email);
              }
            }
          }
        }

        // Store with the bounce date (keep earliest date per email)
        // Exclude sender's own addresses and common system addresses
        for (const email of foundEmails) {
          if (senderEmails.has(email)) continue;
          if (email.includes('postmaster@') || email.includes('noreply@')) continue;
          if (!bounceMap[email] || bounceDate < bounceMap[email]) {
            bounceMap[email] = bounceDate;
          }
        }

      } catch (msgErr) {
        console.error(`Error reading message ${msg.id}:`, msgErr.message);
      }
    }

    let bouncedEmails = Object.keys(bounceMap);
    console.log(`🚫 Bounced emails found: ${bouncedEmails.join(', ')}`);

    // Filter out bounces already processed — query bounced_email column directly (no regex)
    const { data: alreadyLogged } = await supabase
      .from('activity_log')
      .select('bounced_email')
      .eq('org_id', orgId)
      .eq('activity_type', 'email_bounced')
      .not('bounced_email', 'is', null);

    const alreadyProcessed = new Set(
      (alreadyLogged || []).map(a => (a.bounced_email || '').toLowerCase()).filter(Boolean)
    );

    const newBounces = bouncedEmails.filter(e => !alreadyProcessed.has(e));
    console.log(`📋 ${bouncedEmails.length} total bounces, ${newBounces.length} new (${bouncedEmails.length - newBounces.length} already processed)`);

    if (newBounces.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ bounces: bouncedEmails.length, new: 0, cleaned: 0, message: 'All bounces already processed', bouncedEmails: [] }),
      };
    }

    let cleaned = 0;
    let leadsReset = [];

    for (const email of newBounces) {
      const bounceDate = bounceMap[email] || new Date().toISOString();

      // 1. Mark only the most recent outreach_log row for this email as bounced.
      //    A bounce is one event — it corresponds to the last email sent to this address.
      const { data: latestRow } = await supabase
        .from('outreach_log')
        .select('id')
        .eq('org_id', orgId)
        .eq('contact_email', email)
        .order('sent_at', { ascending: false })
        .limit(1);

      if (latestRow && latestRow.length > 0) {
        await supabase
          .from('outreach_log')
          .update({ bounced: true, bounced_at: bounceDate })
          .eq('id', latestRow[0].id);
      }

      // 2. Stop any active campaign sequences for this email
      //    Find leads with this contact email and mark campaign_leads as bounced
      const { data: outreachRows } = await supabase
        .from('outreach_log')
        .select('lead_id, website')
        .eq('org_id', orgId)
        .eq('contact_email', email);

      const leadIds = [...new Set((outreachRows || []).map(r => r.lead_id).filter(Boolean))];

      if (leadIds.length > 0) {
        await supabase
          .from('campaign_leads')
          .update({ status: 'bounced' })
          .eq('org_id', orgId)
          .in('lead_id', leadIds)
          .eq('status', 'active');

        console.log(`🛑 Stopped ${leadIds.length} campaign sequence(s) for bounced address: ${email}`);
      }

      // 3. Remove from contact_database to prevent re-sending during discovery
      const { data: deleted } = await supabase
        .from('contact_database')
        .delete()
        .eq('org_id', orgId)
        .eq('email', email)
        .select('website');

      if (deleted && deleted.length > 0) {
        console.log(`🗑️ Removed ${email} from contact_database`);
        cleaned++;

        // Clear has_contacts flag on the lead if no other contacts remain
        for (const contact of deleted) {
          const website = (contact.website || '').replace(/^www\./, '').toLowerCase();
          if (!website) continue;

          const { count } = await supabase
            .from('contact_database')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .or(`website.ilike.%${website}%,email_domain.ilike.%${website}%`);

          if (count === 0) {
            await supabase
              .from('prospects')
              .update({ has_contacts: false, contact_name: null, contact_email: null })
              .eq('org_id', orgId)
              .ilike('website', `%${website}%`);
          }
        }
      }

      // 4. Reset lead status to 'enriched' if this was their only outreach contact
      if (outreachRows) {
        for (const o of outreachRows) {
          if (!o.website) continue;
          const { count } = await supabase
            .from('outreach_log')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('website', o.website)
            .neq('contact_email', email);

          if (count === 0) {
            await supabase
              .from('prospects')
              .update({ status: 'enriched' })
              .eq('org_id', orgId)
              .eq('website', o.website);
            leadsReset.push(o.website);
            console.log(`↩️ Reset ${o.website} to enriched`);
          }
        }
      }

      // 5. Log to activity_log — store email in dedicated column (not just summary text)
      await supabase.from('activity_log').insert({
        org_id: orgId,
        activity_type: 'email_bounced',
        bounced_email: email,
        summary: `Bounced: ${email} — removed from contacts`,
        status: 'failed',
        created_at: bounceDate,
      });
    }

    const summary = {
      bouncesFound: messages.length,
      bouncedEmails: newBounces,
      alreadyProcessed: bouncedEmails.length - newBounces.length,
      contactsRemoved: cleaned,
      leadsReset,
    };

    console.log(`✅ Bounce check complete:`, summary);

    return { statusCode: 200, headers, body: JSON.stringify(summary) };

  } catch (error) {
    console.error('💥 Bounce check error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

function getMessageBody(message) {
  let body = '';

  function extractParts(payload) {
    if (!payload) return;
    // Extract data from this part's body
    if (payload.body?.data) {
      const decoded = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      body += decoded + '\n';
    }
    // Recurse into sub-parts (handles deeply nested multipart/report bounces)
    if (payload.parts) {
      for (const part of payload.parts) {
        extractParts(part);
      }
    }
  }

  extractParts(message.payload);

  // Also include snippet as fallback — it contains the bounce summary
  if (message.snippet) {
    body += '\n' + message.snippet;
  }

  return body;
}
