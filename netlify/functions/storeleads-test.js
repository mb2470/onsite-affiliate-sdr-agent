const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const STORELEADS_API_KEY = process.env.STORELEADS_API_KEY;
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 250;

exports.handler = async (event) => {
  console.log('🚀 Starting StoreLeads social/contact bulk fetch...');

  if (!STORELEADS_API_KEY) {
    console.error('STORELEADS_API_KEY not configured');
    return;
  }

  try {
    // Get enriched leads that don't have socials yet
    // First get all websites that already have socials
    const { data: existingSocials } = await supabase
      .from('lead_socials')
      .select('website');
    
    const hasSeocials = new Set((existingSocials || []).map(s => s.website.toLowerCase()));

    // Get all enriched leads
    let allLeads = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, website')
        .eq('status', 'enriched')
        .order('created_at', { ascending: true })
        .range(from, from + 999);

      if (error) throw error;
      if (data && data.length > 0) {
        // Filter out leads that already have socials
        const newLeads = data.filter(l => !hasSeocials.has(l.website.toLowerCase()));
        allLeads = [...allLeads, ...newLeads];
        from += 1000;
        if (data.length < 1000) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 Found ${allLeads.length} enriched leads needing social data`);

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary: `Started social/contact bulk fetch for ${allLeads.length} leads`,
      status: 'success'
    });

    let totalContacts = 0;
    let leadsWithContacts = 0;
    let leadsNoContacts = 0;
    let failed = 0;

    // Process in batches
    for (let i = 0; i < allLeads.length; i += BATCH_SIZE) {
      const batch = allLeads.slice(i, i + BATCH_SIZE);
      const domains = batch.map(l => l.website);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allLeads.length / BATCH_SIZE);

      console.log(`📦 Batch ${batchNum}/${totalBatches}: ${domains.length} domains`);

      try {
        // Use bulk domain endpoint with contacts field
        const response = await fetch('https://storeleads.app/json/api/v1/all/domain/bulk', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STORELEADS_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            domains,
            fields: 'name,contact_info'
          }),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After') || 10;
          console.log(`⏳ Rate limited, waiting ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          i -= BATCH_SIZE;
          continue;
        }

        if (!response.ok) {
          console.error(`❌ API error: ${response.status}`);
          failed += batch.length;
          continue;
        }

        const data = await response.json();
        const domainResults = data.domains || [];

        // Map results by domain name
        const resultMap = {};
        domainResults.forEach(d => {
          if (d.name) resultMap[d.name.toLowerCase().replace(/^www\./, '')] = d;
        });

        // Process each lead
        for (const lead of batch) {
          const cleanDomain = lead.website.toLowerCase().replace(/^www\./, '');
          const d = resultMap[cleanDomain];

          if (!d || !d.contact_info || d.contact_info.length === 0) {
            leadsNoContacts++;
            continue;
          }

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
            // Upsert to handle duplicates
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

      } catch (batchError) {
        console.error(`Batch error:`, batchError.message);
        failed += batch.length;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));

      if (batchNum % 10 === 0) {
        console.log(`📈 Progress: ${leadsWithContacts} leads with contacts, ${totalContacts} total contacts, ${leadsNoContacts} no contacts, ${failed} failed`);
      }
    }

    const summary = `Social bulk fetch complete: ${totalContacts} contacts from ${leadsWithContacts} leads (${leadsNoContacts} had no contacts, ${failed} failed)`;
    console.log(`✅ ${summary}`);

    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary,
      status: 'success'
    });

  } catch (error) {
    console.error('💥 Social bulk fetch error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'bulk_socials',
      summary: `Social bulk fetch failed: ${error.message}`,
      status: 'failed'
    });
  }
};
