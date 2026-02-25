const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const ELV_API_KEY = process.env.EMAILLISTVERIFY_API_KEY;

// Valid statuses from EmailListVerify that are safe to send
const SAFE_STATUSES = ['ok', 'ok_for_all', 'accept_all'];
const BAD_STATUSES = ['invalid', 'email_disabled', 'dead_server', 'syntax_error'];

// Verification is valid for 30 days
const VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Check if a contact already has a valid (non-expired) verification cached
 * in the contacts table. Returns the cached result or null.
 */
async function getCachedVerification(email) {
  const { data } = await supabase
    .from('contacts')
    .select('elv_status, elv_verified_at')
    .eq('email', email)
    .not('elv_status', 'is', null)
    .not('elv_verified_at', 'is', null)
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0];
  const verifiedAt = new Date(row.elv_verified_at);
  const age = Date.now() - verifiedAt.getTime();

  if (age > VERIFICATION_MAX_AGE_MS) {
    console.log(`📧 Cached verification for ${email} expired (${Math.round(age / 86400000)}d old)`);
    return null; // Expired — needs re-verification
  }

  const safe = SAFE_STATUSES.includes(row.elv_status);
  console.log(`📧 Using cached verification for ${email}: ${row.elv_status} (${Math.round(age / 86400000)}d old)`);
  return { email, status: row.elv_status, safe, cached: true, verifiedAt: row.elv_verified_at };
}

/**
 * Save verification result to both contacts and contact_database tables.
 */
async function saveVerification(email, status) {
  const now = new Date().toISOString();

  // Update all matching rows in contacts table
  await supabase
    .from('contacts')
    .update({ elv_status: status, elv_verified_at: now })
    .eq('email', email);

  // Also cache on contact_database
  await supabase
    .from('contact_database')
    .update({ elv_status: status, elv_verified_at: now })
    .eq('email', email);
}

async function verifyEmail(email) {
  // 1. Check for a valid cached verification first
  const cached = await getCachedVerification(email);
  if (cached) return cached;

  // 2. No valid cache — do a live verification
  if (!ELV_API_KEY) {
    console.log(`⚠️ No EMAILLISTVERIFY_API_KEY set, skipping verification for ${email}`);
    return { email, status: 'skipped', safe: true };
  }

  try {
    const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(ELV_API_KEY)}&email=${encodeURIComponent(email)}&timeout=15`;
    const res = await fetch(url);
    const status = (await res.text()).trim().toLowerCase();

    console.log(`📧 Verify ${email}: ${status}`);

    const safe = SAFE_STATUSES.includes(status);

    if (!safe && BAD_STATUSES.includes(status)) {
      // Remove invalid email from contact_database
      console.log(`🗑️ Removing invalid email ${email} from contact_database`);
      await supabase.from('contact_database').delete().eq('email', email);
    }

    // Cache the result for future lookups (even bad statuses, so we don't re-check)
    await saveVerification(email, status);

    return { email, status, safe, cached: false, verifiedAt: new Date().toISOString() };
  } catch (e) {
    console.error(`⚠️ Verify error for ${email}: ${e.message}`);
    // On error don't cache — let it retry next time.
    // But also don't block sending.
    return { email, status: 'error', safe: true };
  }
}

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

function buildRawEmail({ to, bcc, subject, body, fromEmail, fromName }) {
  const lines = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
  ];
  
  if (bcc && bcc.length > 0) {
    lines.push(`Bcc: ${bcc.join(', ')}`);
  }
  
  lines.push(`Subject: ${subject}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { to, bcc, subject, body, leadId, website, contactDetails } = JSON.parse(event.body);

    if (!to && (!bcc || bcc.length === 0)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No recipients' }) };
    }

    // Verify all recipient emails before sending
    const allEmails = [...(to ? [to] : []), ...(bcc || [])];
    const verifyResults = await Promise.all(allEmails.map(e => verifyEmail(e)));

    const safeEmails = verifyResults.filter(r => r.safe).map(r => r.email);
    const blockedEmails = verifyResults.filter(r => !r.safe);

    // Log verification results to activity log
    const freshlyVerified = verifyResults.filter(r => r.safe && !r.cached && r.status !== 'skipped' && r.status !== 'error');
    if (freshlyVerified.length > 0 && leadId) {
      await supabase.from('activity_log').insert({
        activity_type: 'email_verified',
        lead_id: leadId,
        summary: `Verified: ${freshlyVerified.map(r => `${r.email} (${r.status})`).join(', ')}`,
        status: 'success',
      });
    }

    if (blockedEmails.length > 0) {
      console.log(`🚫 Blocked ${blockedEmails.length} invalid emails: ${blockedEmails.map(r => `${r.email} (${r.status})`).join(', ')}`);
    }

    if (safeEmails.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `All emails failed verification: ${blockedEmails.map(r => `${r.email} (${r.status})`).join(', ')}`,
          blocked: blockedEmails,
        }),
      };
    }

    const fromEmail = process.env.GMAIL_FROM_EMAIL || 'sam@onsiteaffiliate.com';
    const fromName = 'Sam Reid';

    const accessToken = await getAccessToken();

    const raw = buildRawEmail({
      to: safeEmails[0],
      bcc: safeEmails.slice(1),
      subject,
      body,
      fromEmail,
      fromName,
    });

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      throw new Error(`Gmail send failed: ${JSON.stringify(err)}`);
    }

    const sendData = await sendRes.json();
    console.log(`✅ Email sent to ${safeEmails.join(', ')} (message ID: ${sendData.id})`);

    // Log outreach for verified recipients only
    const outreachRows = safeEmails.map(email => {
      const contact = (contactDetails || []).find(c => c.email === email);
      return {
        lead_id: leadId,
        website: website || '',
        contact_email: email,
        contact_name: contact?.name || null,
        email_subject: subject,
        email_body: body,
      };
    });

    await supabase.from('outreach_log').insert(outreachRows);

    if (leadId) {
      // Get the first contact's details for the lead card
      const firstContact = outreachRows[0] || {};
      
      await supabase.from('leads').update({
        status: 'contacted',
        has_contacts: true,
        contact_name: firstContact.contact_name || null,
        contact_email: firstContact.contact_email || null,
        updated_at: new Date().toISOString(),
      }).eq('id', leadId);

      await supabase.from('activity_log').insert({
        activity_type: 'email_sent',
        lead_id: leadId,
        summary: `Email sent to ${safeEmails.join(', ')}${blockedEmails.length ? ` (${blockedEmails.length} blocked)` : ''}`,
        status: 'success',
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        messageId: sendData.id,
        recipients: safeEmails,
        blocked: blockedEmails,
      }),
    };

  } catch (error) {
    console.error('💥 Send email error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
