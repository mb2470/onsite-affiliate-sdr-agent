/**
 * Apollo Email Verification Endpoint
 *
 * Verifies contacts against Apollo's People Match API.
 * Used for manual re-verification of existing contacts.
 *
 * POST body: { contacts: [{ email, first_name, last_name }], leadId? }
 *
 * Returns contacts partitioned by action:
 *   - send:      Apollo-verified, safe to send immediately
 *   - verify:    Needs secondary ELV verification
 *   - catchall:  Catch-all domain, proceed with caution
 *   - discard:   Invalid, removed from pipeline
 *   - pivoted:   Replacement contacts found via backup title pivot
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyContactsBatch } = require('./lib/apollo-verify');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

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

    // Add pivoted contacts to contact_database
    for (const { pivoted } of results.pivoted) {
      if (!pivoted.email) continue;

      const { count } = await supabase
        .from('contact_database')
        .select('*', { count: 'exact', head: true })
        .eq('email', pivoted.email);

      if (count === 0) {
        await supabase.from('contact_database').insert({
          first_name: pivoted.first_name,
          last_name: pivoted.last_name,
          email: pivoted.email,
          title: pivoted.title,
          website: pivoted.organization || '',
          account_name: pivoted.organization || '',
          linkedin_url: pivoted.linkedin_url || null,
          apollo_email_status: pivoted.email_status || null,
          apollo_verified_at: new Date().toISOString(),
        });
        console.log(`✅ Added pivoted contact: ${pivoted.email} (${pivoted.title} at ${pivoted.organization})`);
      }
    }

    // Log activity
    if (leadId) {
      const summary = [
        results.send.length > 0 ? `${results.send.length} verified` : null,
        results.verify.length > 0 ? `${results.verify.length} need ELV` : null,
        results.catchall.length > 0 ? `${results.catchall.length} catch-all` : null,
        results.discard.length > 0 ? `${results.discard.length} invalid` : null,
        results.pivoted.length > 0 ? `${results.pivoted.length} pivoted` : null,
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
        pivoted: results.pivoted.map(r => ({
          old_email: r.original.email,
          new_email: r.pivoted.email,
          new_title: r.pivoted.title,
          new_org: r.pivoted.organization,
        })),
        totals: {
          send: results.send.length,
          verify: results.verify.length,
          catchall: results.catchall.length,
          discard: results.discard.length,
          pivoted: results.pivoted.length,
        },
      }),
    };

  } catch (error) {
    console.error('💥 Apollo verification error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
