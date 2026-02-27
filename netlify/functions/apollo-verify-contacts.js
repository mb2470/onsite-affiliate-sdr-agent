/**
 * Apollo Email Verification Endpoint
 *
 * Verifies contacts against Apollo's People Match API before sending.
 * This is the "Apollo verification step" in the email waterfall:
 *
 *   1. Find contacts (contact_database or Apollo discovery)
 *   2. ➡️ Apollo People Match verification (this function)
 *   3. ELV verification (for extrapolated/unknown statuses)
 *   4. Send email
 *
 * POST body: { contacts: [{ email, first_name, last_name }], leadId? }
 *
 * Returns contacts partitioned by action:
 *   - send:      Apollo-verified, safe to send immediately
 *   - verify:    Needs secondary ELV verification
 *   - catchall:  Catch-all domain, proceed with caution
 *   - discard:   Invalid, removed from pipeline
 *   - refreshed: Replacement contacts found via double-check
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyContactsBatch } = require('./lib/apollo-verify');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { contacts, leadId } = JSON.parse(event.body || '{}');

    if (!contacts || contacts.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No contacts provided' }) };
    }

    console.log(`🔶 Apollo verification for ${contacts.length} contacts${leadId ? ` (lead: ${leadId})` : ''}`);

    const results = await verifyContactsBatch(supabase, contacts, { leadId });

    // Delete invalid emails from contact_database
    for (const discarded of results.discard) {
      console.log(`🗑️ Removing Apollo-invalid email ${discarded.email} from contact_database`);
      await supabase.from('contact_database').delete().eq('email', discarded.email);
    }

    // Add refreshed contacts to contact_database
    for (const { refreshed } of results.refreshed) {
      if (!refreshed.email) continue;

      const { count } = await supabase
        .from('contact_database')
        .select('*', { count: 'exact', head: true })
        .eq('email', refreshed.email);

      if (count === 0) {
        await supabase.from('contact_database').insert({
          first_name: refreshed.first_name,
          last_name: refreshed.last_name,
          email: refreshed.email,
          title: refreshed.title,
          website: refreshed.organization || '',
          account_name: refreshed.organization || '',
          linkedin_url: refreshed.linkedin_url || null,
        });
        console.log(`✅ Added refreshed contact: ${refreshed.email} (${refreshed.title} at ${refreshed.organization})`);
      }
    }

    // Log activity
    if (leadId) {
      const summary = [
        results.send.length > 0 ? `${results.send.length} verified` : null,
        results.verify.length > 0 ? `${results.verify.length} need ELV` : null,
        results.catchall.length > 0 ? `${results.catchall.length} catch-all` : null,
        results.discard.length > 0 ? `${results.discard.length} invalid` : null,
        results.refreshed.length > 0 ? `${results.refreshed.length} refreshed` : null,
      ].filter(Boolean).join(', ');

      await supabase.from('activity_log').insert({
        activity_type: 'apollo_verification',
        lead_id: leadId,
        summary: `Apollo verification: ${summary}`,
        status: 'success',
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        send: results.send.map(c => c.email),
        verify: results.verify.map(c => c.email),
        catchall: results.catchall.map(c => c.email),
        discard: results.discard.map(c => c.email),
        refreshed: results.refreshed.map(r => ({
          old_email: r.original.email,
          new_email: r.refreshed.email,
          new_title: r.refreshed.title,
          new_org: r.refreshed.organization,
        })),
        totals: {
          send: results.send.length,
          verify: results.verify.length,
          catchall: results.catchall.length,
          discard: results.discard.length,
          refreshed: results.refreshed.length,
        },
      }),
    };

  } catch (error) {
    console.error('💥 Apollo verification error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
