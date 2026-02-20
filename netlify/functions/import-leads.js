const { createClient } = require('@supabase/supabase-js');

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
    const { leads } = JSON.parse(event.body);

    // Get all existing websites
    let existing = new Set();
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data } = await supabase.from('leads').select('website').range(from, from + 999);
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

      const { error } = await supabase.from('leads').insert({
        website: clean,
        status: 'new',
        source: 'csv_import',
        industry: lead.industry || null,
        country: lead.country || null,
        sells_d2c: lead.sells_d2c || null,
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
