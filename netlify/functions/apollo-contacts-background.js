const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

// Target titles for SDR outreach — ordered by priority
const TARGET_TITLES = [
  'influencer', 'creator', 'ugc', 'affiliate', 'partnership',
  'marketing', 'brand', 'ecommerce', 'e-commerce', 'digital',
  'growth', 'content', 'social media',
  'cmo', 'vp marketing', 'head of marketing', 'director of marketing',
  'vp ecommerce', 'head of ecommerce', 'director of ecommerce',
  'vp digital', 'head of digital', 'head of growth',
  'ceo', 'founder', 'co-founder', 'president', 'owner',
];

async function searchApollo(domain) {
  const response = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      q_organization_domains_list: [domain],
      person_titles: [
        'VP Marketing', 'Head of Marketing', 'Director of Marketing',
        'VP Ecommerce', 'Head of Ecommerce', 'Director of Ecommerce',
        'VP Digital', 'Head of Digital', 'Head of Growth',
        'CMO', 'Chief Marketing Officer',
        'VP Brand', 'Director of Brand', 'Head of Brand',
        'Director of Partnerships', 'Head of Partnerships',
        'Director of Content', 'Head of Content',
        'CEO', 'Founder', 'Co-Founder', 'President',
      ],
      per_page: 25,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Apollo search failed (${response.status}): ${err}`);
  }

  return await response.json();
}

async function enrichPeople(personIds) {
  const response = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      details: personIds.map(id => ({ id })),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Apollo enrich failed (${response.status}): ${err}`);
  }

  return await response.json();
}

function scoreTitleRelevance(title) {
  const t = (title || '').toLowerCase();
  for (let i = 0; i < TARGET_TITLES.length; i++) {
    if (t.includes(TARGET_TITLES[i])) return 100 - i;
  }
  return 0;
}

exports.handler = async (event, context) => {
  console.log('🔍 Starting Apollo contact discovery for HIGH leads without contacts...');

  if (!APOLLO_API_KEY) {
    console.error('❌ APOLLO_API_KEY not set');
    return;
  }

  try {
    // Get HIGH leads with no contacts
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, website')
      .eq('icp_fit', 'HIGH')
      .eq('has_contacts', false)
      .eq('status', 'enriched')
      .order('created_at', { ascending: true })
      .limit(15); // ~15 leads × 6 credits = ~90 credits (stay under 100/month)

    if (error) throw error;

    if (!leads || leads.length === 0) {
      console.log('📭 No HIGH leads without contacts to process.');
      return;
    }

    console.log(`📋 Processing ${leads.length} HIGH leads via Apollo\n`);

    let totalFound = 0;
    let totalCreditsUsed = 0;

    for (const lead of leads) {
      const domain = lead.website.replace(/^www\./, '');
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`🔍 Searching: ${domain}`);

      try {
        // Step 1: Search (1 credit)
        const searchResult = await searchApollo(domain);
        totalCreditsUsed += 1;

        const people = searchResult.people || [];
        console.log(`  Found ${people.length} people`);

        if (people.length === 0) {
          console.log(`  ❌ No results from Apollo`);
          continue;
        }

        // Filter to people with email, sort by title relevance
        const withEmail = people
          .filter(p => p.has_email)
          .map(p => ({ ...p, _score: scoreTitleRelevance(p.title) }))
          .sort((a, b) => b._score - a._score)
          .slice(0, 5); // Enrich top 5 max

        if (withEmail.length === 0) {
          console.log(`  ❌ No people with emails found`);
          continue;
        }

        console.log(`  📧 ${withEmail.length} have emails, enriching...`);

        // Step 2: Enrich (1 credit per person)
        const enrichResult = await enrichPeople(withEmail.map(p => p.id));
        totalCreditsUsed += withEmail.length;

        const matches = enrichResult.matches || [];
        let addedForLead = 0;

        for (const match of matches) {
          if (!match.email) continue;

          // Check if email already exists in contact_database
          const { data: existing } = await supabase
            .from('contact_database')
            .select('id')
            .eq('email', match.email.toLowerCase())
            .limit(1);

          if (existing && existing.length > 0) {
            console.log(`  ⏭️  ${match.email} already in database`);
            continue;
          }

          // Add to contact_database
          const { error: insertErr } = await supabase.from('contact_database').insert({
            first_name: match.first_name || null,
            last_name: match.last_name || null,
            email: match.email.toLowerCase(),
            title: match.title || null,
            website: domain,
            email_domain: domain,
            account_name: match.organization?.name || domain,
            source: 'apollo',
            linkedin_url: match.linkedin_url || null,
          });

          if (insertErr) {
            console.error(`  ⚠️ Insert error for ${match.email}: ${insertErr.message}`);
          } else {
            console.log(`  ✅ Added: ${match.first_name} ${match.last_name} — ${match.title} — ${match.email} (${match.email_status || 'unknown'})`);
            addedForLead++;
          }
        }

        // Update lead with contact info
        if (addedForLead > 0) {
          const bestMatch = matches.find(m => m.email);
          await supabase.from('leads').update({
            has_contacts: true,
            contact_name: bestMatch ? `${bestMatch.first_name || ''} ${bestMatch.last_name || ''}`.trim() : null,
            contact_email: bestMatch?.email || null,
          }).eq('id', lead.id);

          totalFound += addedForLead;
          console.log(`  🎯 ${addedForLead} contacts added for ${domain}`);
        } else {
          console.log(`  ❌ No new contacts to add for ${domain}`);
        }

        // Rate limit between companies
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.error(`  ❌ Error processing ${domain}: ${err.message}`);
      }
    }

    const summary = `Apollo discovery: ${totalFound} contacts found across ${leads.length} leads (~${totalCreditsUsed} credits used)`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ ${summary}`);
    console.log(`${'='.repeat(60)}`);

    await supabase.from('activity_log').insert({
      activity_type: 'apollo_discovery',
      summary,
      status: 'success',
    });

  } catch (error) {
    console.error('💥 Apollo discovery error:', error);
    await supabase.from('activity_log').insert({
      activity_type: 'apollo_discovery',
      summary: `Apollo discovery failed: ${error.message}`,
      status: 'failed',
    });
  }
};
