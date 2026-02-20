const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

function getGmailClient() {
  const creds = JSON.parse(process.env.GMAIL_OAUTH_CREDENTIALS);
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret
  );
  oauth2Client.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
    token_type: creds.token_type,
    expiry_date: creds.expiry_date,
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const gmail = getGmailClient();

    // Search for bounce notifications from mailer-daemon in last 7 days
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:mailer-daemon@googlemail.com newer_than:7d',
      maxResults: 50,
    });

    const messages = res.data.messages || [];
    console.log(`📧 Found ${messages.length} bounce notifications`);

    if (messages.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ bounces: 0, cleaned: 0, message: 'No bounces found' }),
      };
    }

    let bouncedEmails = [];

    for (const msg of messages) {
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const body = getMessageBody(detail.data);
        
        // Extract bounced email addresses from the bounce message
        // Common patterns: "wasn't delivered to email@domain.com"
        // "Delivery to the following recipient failed permanently: email@domain.com"
        // "The email account that you tried to reach does not exist"
        const emailPatterns = [
          /wasn't delivered to\s+(\S+@\S+\.\S+)/gi,
          /delivery to.*?(\S+@\S+\.\S+).*?failed/gi,
          /rejected.*?(\S+@\S+\.\S+)/gi,
          /could not be delivered to\s+(\S+@\S+\.\S+)/gi,
          /Address not found.*?(\S+@\S+\.\S+)/gi,
        ];

        // Also check headers for X-Failed-Recipients
        const failedHeader = (detail.data.payload?.headers || []).find(
          h => h.name.toLowerCase() === 'x-failed-recipients'
        );
        if (failedHeader) {
          bouncedEmails.push(failedHeader.value.trim().toLowerCase());
        }

        // Extract from body
        for (const pattern of emailPatterns) {
          let match;
          while ((match = pattern.exec(body)) !== null) {
            const email = match[1].replace(/[<>]/g, '').toLowerCase();
            if (email.includes('@') && !email.includes('mailer-daemon')) {
              bouncedEmails.push(email);
            }
          }
        }

        // Also try to find email in To header of original message
        const toHeader = (detail.data.payload?.headers || []).find(
          h => h.name.toLowerCase() === 'to'
        );

      } catch (msgErr) {
        console.error(`Error reading message ${msg.id}:`, msgErr.message);
      }
    }

    // Deduplicate
    bouncedEmails = [...new Set(bouncedEmails)];
    console.log(`🚫 Bounced emails found: ${bouncedEmails.join(', ')}`);

    let cleaned = 0;
    let leadsReset = [];

    for (const email of bouncedEmails) {
      // Remove from contact_database
      const { data: deleted } = await supabase
        .from('contact_database')
        .delete()
        .eq('email', email)
        .select('website');

      if (deleted && deleted.length > 0) {
        console.log(`🗑️ Removed ${email} from contact_database`);
        cleaned++;

        // Check if the lead has any remaining contacts
        for (const contact of deleted) {
          const website = contact.website?.replace(/^www\./, '').toLowerCase();
          if (!website) continue;

          const { count } = await supabase
            .from('contact_database')
            .select('*', { count: 'exact', head: true })
            .or(`website.ilike.%${website}%,email_domain.ilike.%${website}%`);

          // If no more contacts, update the lead
          if (count === 0) {
            await supabase
              .from('leads')
              .update({ has_contacts: false, contact_name: null, contact_email: null })
              .ilike('website', `%${website}%`);
          }
        }
      }

      // Reset lead status from contacted back to enriched if the only contact bounced
      const { data: outreach } = await supabase
        .from('outreach_log')
        .select('website')
        .eq('contact_email', email);

      if (outreach) {
        for (const o of outreach) {
          // Check if there are other successful outreaches for this website
          const { count } = await supabase
            .from('outreach_log')
            .select('*', { count: 'exact', head: true })
            .eq('website', o.website)
            .neq('contact_email', email);

          if (count === 0) {
            // No other contacts were emailed — reset lead
            await supabase
              .from('leads')
              .update({ status: 'enriched' })
              .eq('website', o.website);
            leadsReset.push(o.website);
            console.log(`↩️ Reset ${o.website} to enriched`);
          }
        }
      }

      // Mark outreach as bounced
      await supabase
        .from('outreach_log')
        .update({ email_subject: '[BOUNCED] ' + email })
        .eq('contact_email', email);

      // Log activity
      await supabase.from('activity_log').insert({
        activity_type: 'email_bounced',
        summary: `Bounced: ${email} — removed from contacts`,
        status: 'failed',
      });
    }

    const summary = {
      bouncesFound: messages.length,
      bouncedEmails,
      contactsRemoved: cleaned,
      leadsReset,
    };

    console.log(`✅ Bounce check complete:`, summary);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(summary),
    };

  } catch (error) {
    console.error('💥 Bounce check error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

function getMessageBody(message) {
  let body = '';
  
  if (message.payload?.body?.data) {
    body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
  }
  
  if (message.payload?.parts) {
    for (const part of message.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        for (const subpart of part.parts) {
          if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
            body += Buffer.from(subpart.body.data, 'base64').toString('utf-8');
          }
        }
      }
    }
  }

  return body;
}
