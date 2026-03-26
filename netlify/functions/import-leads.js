const { createClient } = require('@supabase/supabase-js');
const { resolveOrgId } = require('./lib/org-id');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body);
    const { leads } = body;
    const orgId = await resolveOrgId(supabase, body.org_id);

    // Get all existing websites
    let existing = new Set();
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data } = await supabase.from('prospects').select('website').range(from, from + 999);
      if (data && data.length > 0) {
        data.forEach(l => existing.add(l.website.toLowerCase().replace(/^www\./, '')));
        from += 1000;
        if (data.length < 1000) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`📊 ${existing.size} existing leads in database`);

    let added = 0;
    let skipped = 0;

    for (const lead of leads) {
      const clean = lead.website.toLowerCase().replace(/^www\./, '');
      if (existing.has(clean)) {
        skipped++;
        continue;
      }

      // Build metadata from extra fields not in schema
      const metadata = {};
      if (lead.email) metadata.email = lead.email;
      if (lead.address) metadata.address = lead.address;
      if (lead.phone) metadata.phone = lead.phone;
      if (lead.facebook_url) metadata.facebook_url = lead.facebook_url;
      if (lead.linkedin_url) metadata.linkedin_url = lead.linkedin_url;
      if (lead.services) metadata.services = lead.services;
      if (lead.verticals) metadata.verticals = lead.verticals;

      const { error } = await supabase.from('prospects').insert({
        website: clean,
        status: 'new',
        source: 'csv_import',
        company_name: lead.company_name || lead.organization_name || null,
        industry_primary: lead.industry || lead.category || lead.verticals || null,
        city: lead.city || null,
        hq_country: lead.country || null,
        sells_d2c: lead.sells_d2c || null,
        org_id: orgId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });

      if (error) {
        console.error(`Error adding ${clean}:`, error.message);
      } else {
        added++;
        existing.add(clean);
      }
    }

    const summary = { total: leads.length, added, skipped };
    console.log(`✅ Import complete:`, summary);

    return { statusCode: 200, headers, body: JSON.stringify(summary) };

  } catch (error) {
    console.error('💥 Import error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
