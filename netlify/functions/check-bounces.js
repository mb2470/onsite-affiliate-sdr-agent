const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const accessToken = await getAccessToken();

    // Search for bounce notifications from mailer-daemon in last 7 days
    const searchRes = await gmailGet(accessToken, 
      'messages?q=' + encodeURIComponent('from:mailer-daemon@googlemail.com newer_than:7d') + '&maxResults=50'
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

        // Extract bounced email addresses
        const emailPatterns = [
          /wasn'?t delivered to\s+(\S+@\S+\.\S+)/gi,
          /delivery to.*?(\S+@\S+\.\S+).*?failed/gi,
          /rejected.*?(\S+@\S+\.\S+)/gi,
          /could not be delivered to\s+(\S+@\S+\.\S+)/gi,
          /address not found.*?(\S+@\S+\.\S+)/gi,
          /does not exist.*?(\S+@\S+\.\S+)/gi,
          /(\S+@\S+\.\S+).*?address not found/gi,
        ];

        const foundEmails = [];

        // Check X-Failed-Recipients header
        const failedHeader = (detail.payload?.headers || []).find(
          h => h.name.toLowerCase() === 'x-failed-recipients'
        );
        if (failedHeader) {
          foundEmails.push(failedHeader.value.trim().toLowerCase());
        }

        // Extract from body
        for (const pattern of emailPatterns) {
          let match;
          while ((match = pattern.exec(body)) !== null) {
            const email = match[1].replace(/[<>.,;'"()]/g, '').toLowerCase();
            if (email.includes('@') && !email.includes('mailer-daemon') && !email.includes('googlemail')) {
              foundEmails.push(email);
            }
          }
        }

        // Store with the bounce date (keep earliest date per email)
        for (const email of foundEmails) {
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

    // Filter out bounces we already processed (already logged in activity_log)
    const { data: alreadyLogged } = await supabase
      .from('activity_log')
      .select('summary')
      .eq('activity_type', 'email_bounced')
      .order('created_at', { ascending: false })
      .limit(200);

    const alreadyProcessed = new Set(
      (alreadyLogged || []).map(a => {
        const match = a.summary.match(/Bounced:\s+(\S+@\S+)/);
        return match ? match[1].toLowerCase() : '';
      }).filter(Boolean)
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
      // Remove from contact_database
      const { data: deleted } = await supabase
        .from('contact_database')
        .delete()
        .eq('email', email)
        .select('website');

      if (deleted && deleted.length > 0) {
        console.log(`🗑️ Removed ${email} from contact_database`);
        cleaned++;

        // Check if lead has remaining contacts
        for (const contact of deleted) {
          const website = (contact.website || '').replace(/^www\./, '').toLowerCase();
          if (!website) continue;

          const { count } = await supabase
            .from('contact_database')
            .select('*', { count: 'exact', head: true })
            .or(`website.ilike.%${website}%,email_domain.ilike.%${website}%`);

          if (count === 0) {
            await supabase
              .from('leads')
              .update({ has_contacts: false, contact_name: null, contact_email: null })
              .ilike('website', `%${website}%`);
          }
        }
      }

      // Reset lead if this was the only outreach
      const { data: outreach } = await supabase
        .from('outreach_log')
        .select('website')
        .eq('contact_email', email);

      if (outreach) {
        for (const o of outreach) {
          const { count } = await supabase
            .from('outreach_log')
            .select('*', { count: 'exact', head: true })
            .eq('website', o.website)
            .neq('contact_email', email);

          if (count === 0) {
            await supabase
              .from('leads')
              .update({ status: 'enriched' })
              .eq('website', o.website);
            leadsReset.push(o.website);
            console.log(`↩️ Reset ${o.website} to enriched`);
          }
        }
      }

      // Log activity with the actual bounce date (not today)
      await supabase.from('activity_log').insert({
        activity_type: 'email_bounced',
        summary: `Bounced: ${email} — removed from contacts`,
        status: 'failed',
        created_at: bounceMap[email] || new Date().toISOString(),
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
