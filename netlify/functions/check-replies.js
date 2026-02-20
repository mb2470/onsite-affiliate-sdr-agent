const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

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
  if (!data.access_token) throw new Error('Failed to refresh token');
  return data.access_token;
}

async function gmailGet(accessToken, endpoint) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Gmail API error: ${response.status}`);
  return response.json();
}

// Auto-responder detection patterns
const AUTO_RESPONDER_PATTERNS = [
  /out of (the )?office/i,
  /auto[- ]?reply/i,
  /auto[- ]?respond/i,
  /automatic reply/i,
  /away from (my )?(the )?office/i,
  /on (annual |vacation |holiday )?leave/i,
  /i('m| am) (currently )?(out|away|on leave|on vacation|on holiday|traveling|travelling)/i,
  /this is an automated/i,
  /do not reply/i,
  /no[- ]?reply/i,
  /unsubscribe/i,
  /delivery (status )?notification/i,
  /mailer[- ]?daemon/i,
  /postmaster/i,
  /mail delivery (failed|subsystem|error)/i,
  /this mailbox is not monitored/i,
  /i will be returning on/i,
  /thank you for (your |reaching|contacting)/i,  // generic auto-ack
  /we('ve| have) received your (email|message|inquiry)/i,
  /will (get back|respond|reply) (to you )?(as soon as|within|shortly)/i,
];

const AUTO_RESPONDER_HEADERS = [
  'x-autoresponse',
  'x-autoreply', 
  'auto-submitted',
  'x-auto-response-suppress',
];

function isAutoResponder(message, body) {
  // Check headers
  const headers = message.payload?.headers || [];
  
  for (const h of headers) {
    const name = h.name.toLowerCase();
    
    // Known auto-responder headers
    if (AUTO_RESPONDER_HEADERS.includes(name)) return true;
    
    // Precedence: bulk or auto-reply
    if (name === 'precedence' && ['bulk', 'auto_reply', 'junk'].includes(h.value.toLowerCase())) return true;
    
    // X-Auto-Response-Suppress
    if (name === 'x-auto-response-suppress' && h.value.toLowerCase() !== 'none') return true;
  }

  // Check subject for auto-reply indicators
  const subject = (headers.find(h => h.name.toLowerCase() === 'subject')?.value || '').toLowerCase();
  if (subject.includes('out of office') || subject.includes('automatic reply') || 
      subject.includes('auto-reply') || subject.includes('autoreply') ||
      subject.includes('delivery status') || subject.includes('undeliverable')) {
    return true;
  }

  // Check body patterns (first 500 chars to avoid false positives deep in thread)
  const bodyStart = (body || '').substring(0, 500);
  for (const pattern of AUTO_RESPONDER_PATTERNS) {
    if (pattern.test(bodyStart)) return true;
  }

  return false;
}

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const accessToken = await getAccessToken();
    const fromEmail = process.env.GMAIL_FROM_EMAIL || '';

    // Get all emails we've sent from outreach_log
    const { data: outreachLog } = await supabase
      .from('outreach_log')
      .select('contact_email, website, email_subject, sent_at')
      .order('sent_at', { ascending: false })
      .limit(500);

    if (!outreachLog || outreachLog.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ replies: [], newReplies: 0, autoResponders: 0 }) };
    }

    // Get already-logged replies to skip
    const { data: alreadyLogged } = await supabase
      .from('activity_log')
      .select('summary')
      .eq('activity_type', 'email_reply')
      .limit(500);

    const alreadyProcessed = new Set(
      (alreadyLogged || []).map(a => {
        const match = a.summary.match(/from\s+(\S+@\S+)/i);
        return match ? match[1].toLowerCase() : '';
      }).filter(Boolean)
    );

    // Search Gmail for replies - look for emails in inbox from our contacts
    const contactEmails = [...new Set(outreachLog.map(o => o.contact_email.toLowerCase()))];
    
    let allReplies = [];
    let autoResponders = 0;

    // Search in batches to avoid query length limits
    const batchSize = 10;
    for (let i = 0; i < contactEmails.length; i += batchSize) {
      const batch = contactEmails.slice(i, i + batchSize);
      const query = batch.map(e => `from:${e}`).join(' OR ');
      
      try {
        const searchRes = await gmailGet(accessToken,
          'messages?q=' + encodeURIComponent(`(${query}) newer_than:30d -from:${fromEmail}`) + '&maxResults=50'
        );

        const messages = searchRes.messages || [];
        
        for (const msg of messages) {
          try {
            const detail = await gmailGet(accessToken, `messages/${msg.id}?format=full`);
            const msgHeaders = detail.payload?.headers || [];
            const fromHeader = msgHeaders.find(h => h.name.toLowerCase() === 'from')?.value || '';
            const subject = msgHeaders.find(h => h.name.toLowerCase() === 'subject')?.value || '';
            const date = msgHeaders.find(h => h.name.toLowerCase() === 'date')?.value || '';
            
            // Extract email from From header
            const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/(\S+@\S+)/);
            const replyEmail = emailMatch ? emailMatch[1].toLowerCase() : '';
            
            if (!replyEmail || !contactEmails.includes(replyEmail)) continue;
            
            const body = getMessageBody(detail);
            
            // Check if auto-responder
            if (isAutoResponder(detail, body)) {
              autoResponders++;
              console.log(`🤖 Auto-responder from ${replyEmail}: "${subject.substring(0, 50)}"`);
              continue;
            }

            // Skip already processed
            if (alreadyProcessed.has(replyEmail)) continue;

            // Find the matching outreach
            const outreach = outreachLog.find(o => o.contact_email.toLowerCase() === replyEmail);
            
            allReplies.push({
              from: replyEmail,
              fromName: fromHeader.replace(/<[^>]+>/, '').trim(),
              subject,
              date,
              website: outreach?.website || '',
              snippet: (body || '').substring(0, 200).replace(/\n/g, ' ').trim(),
              messageId: msg.id,
            });

          } catch (msgErr) {
            console.error(`Error reading message ${msg.id}:`, msgErr.message);
          }
        }
      } catch (searchErr) {
        console.error(`Search batch error:`, searchErr.message);
      }

      // Rate limit
      if (i + batchSize < contactEmails.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Dedup by email
    const seen = new Set();
    allReplies = allReplies.filter(r => {
      if (seen.has(r.from)) return false;
      seen.add(r.from);
      return true;
    });

    console.log(`📬 Found ${allReplies.length} real replies, ${autoResponders} auto-responders filtered`);

    // Log new replies to activity_log and update outreach_log
    for (const reply of allReplies) {
      await supabase.from('activity_log').insert({
        activity_type: 'email_reply',
        summary: `Reply from ${reply.from} at ${reply.website}: "${reply.subject.substring(0, 60)}"`,
        status: 'success',
      });

      // Mark in outreach_log
      await supabase
        .from('outreach_log')
        .update({ replied_at: new Date().toISOString() })
        .eq('contact_email', reply.from)
        .is('replied_at', null);

      // Update lead status
      if (reply.website) {
        await supabase
          .from('leads')
          .update({ status: 'replied' })
          .eq('website', reply.website);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        replies: allReplies,
        newReplies: allReplies.length,
        autoResponders,
        totalContacts: contactEmails.length,
      }),
    };

  } catch (error) {
    console.error('💥 Reply check error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
