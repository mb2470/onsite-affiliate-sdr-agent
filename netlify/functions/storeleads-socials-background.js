const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const RATE_LIMIT_MS = 220; // ~4.5 req/sec (Pro limit = 5/sec)

exports.handler = async (event) => {
  console.log('🚀 Starting StoreLeads social/contact fetch (single domain mode)...');

  if (!STORELEADS_API_KEY) {
    console.error('STORELEADS_API_KEY not configured');
    return;
  }

  try {
    // Get websites that already have socials
    const { data: existingSocials } = await supabase
      .from('lead_socials')
      .select('website');
    const hasSocials = new Set((existingSocials || []).map(s => s.website.toLowerCase()));

    // Get enriched leads only (ones StoreLeads found)
    let allLeads = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, website')
        .eq('status', 'enriched')
        .not('research_notes', 'is', null)
        .order('created_at', { ascending: true })
        .range(from, from + 999);

      if (error) throw error;
      if (data && data.length > 0) {
        const newLeads = data.filter(l => !hasSocials.has(l.website.toLowerCase()));
        allLeads = [...allLeads, ...newLeads];
        from += 1000;
        if (data.length < 1000) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 Found ${allLeads.length} leads needing social data`);

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary: `Started social fetch for ${allLeads.length} leads (single domain mode)`,
      status: 'success'
    });

    let totalContacts = 0;
    let leadsWithContacts = 0;
    let leadsNoContacts = 0;
    let failed = 0;

    for (let i = 0; i < allLeads.length; i++) {
      const lead = allLeads[i];
      const domain = lead.website.replace(/^www\./, '');

      try {
        const response = await fetch(
          `https://storeleads.app/json/api/v1/all/domain/${domain}?fields=name,contact_info`,
          { headers: { 'Authorization': `Bearer ${STORELEADS_API_KEY}` } }
        );

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '2');
          console.log(`⏳ Rate limited, waiting ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          i--; // retry
          continue;
        }

        if (!response.ok) {
          failed++;
          continue;
        }

        const data = await response.json();
        const d = data.domain;

        if (!d || !d.contact_info || d.contact_info.length === 0) {
          leadsNoContacts++;
        } else {
          leadsWithContacts++;
          const socialsToInsert = [];

          for (const contact of d.contact_info) {
            if (!contact.value || !contact.type) continue;

            socialsToInsert.push({
              lead_id: lead.id,
              website: lead.website,
              type: contact.type,
              value: contact.value,
              followers: contact.followers || null,
              following: contact.following || null,
              posts: contact.posts || null,
              likes: contact.likes || null,
              description: contact.description || null,
              source: 'storeleads',
            });
          }

          if (socialsToInsert.length > 0) {
            const { error: insertError } = await supabase
              .from('lead_socials')
              .upsert(socialsToInsert, { onConflict: 'website,type,value', ignoreDuplicates: true });

            if (insertError) {
              console.error(`Error inserting socials for ${lead.website}:`, insertError.message);
              failed++;
            } else {
              totalContacts += socialsToInsert.length;
            }
          }
        }

      } catch (err) {
        console.error(`Error fetching ${domain}:`, err.message);
        failed++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));

      // Log progress every 100 leads
      if ((i + 1) % 100 === 0) {
        console.log(`📈 Progress: ${i + 1}/${allLeads.length} — ${leadsWithContacts} with contacts, ${totalContacts} total, ${leadsNoContacts} empty, ${failed} failed`);
      }
    }

    const summary = `Social fetch complete: ${totalContacts} contacts from ${leadsWithContacts} leads (${leadsNoContacts} empty, ${failed} failed)`;
    console.log(`✅ ${summary}`);

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary,
      status: 'success'
    });

  } catch (error) {
    console.error('💥 Social fetch error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary: `Social fetch failed: ${error.message}`,
      status: 'failed'
    });
  }
};
