const { createClient } = require('@supabase/supabase-js');
const { classifyApolloStatus, backupTitlePivot } = require('./lib/apollo-verify');

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
      .limit(125);

    if (error) throw error;

    if (!leads || leads.length === 0) {
      console.log('📭 No HIGH leads without contacts to process.');
      return;
    }

    console.log(`📋 Processing ${leads.length} HIGH leads via Apollo\n`);

    let totalFound = 0;
    let totalInvalid = 0;
    let totalPivoted = 0;
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
          .slice(0, 3);

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
        const exhaustedTitles = [];
        let allInvalid = true;

        // Step 3: Triage by email_status (Opt 1)
        for (const match of matches) {
          if (!match.email) continue;

          const apolloStatus = (match.email_status || 'unavailable').toLowerCase();
          const action = classifyApolloStatus(apolloStatus);

          if (action === 'discard') {
            // Invalid — do NOT insert
            console.log(`  🗑️ Discarding invalid: ${match.email} (${apolloStatus})`);
            totalInvalid++;
            if (match.title) exhaustedTitles.push(match.title);
            continue;
          }

          allInvalid = false;

          // Check if email already exists
          const { data: existing } = await supabase
            .from('contact_database')
            .select('id')
            .eq('email', match.email.toLowerCase())
            .limit(1);

          if (existing && existing.length > 0) {
            console.log(`  ⏭️  ${match.email} already in database`);
            addedForLead++; // Count as "found" even if duplicate
            continue;
          }

          // Insert with actual Apollo status
          const { error: insertErr } = await supabase.from('contact_database').insert({
            first_name: match.first_name || null,
            last_name: match.last_name || null,
            email: match.email.toLowerCase(),
            title: match.title || null,
            website: domain,
            account_name: match.organization?.name || domain,
            linkedin_url: match.linkedin_url || null,
            apollo_email_status: apolloStatus,
            apollo_verified_at: new Date().toISOString(),
          });

          if (insertErr) {
            console.error(`  ⚠️ Insert error for ${match.email}: ${insertErr.message}`);
          } else {
            console.log(`  ✅ Added: ${match.first_name} ${match.last_name} — ${match.title} — ${match.email} (apollo: ${apolloStatus})`);
            addedForLead++;
          }
        }

        // Step 4: Backup title pivot if ALL contacts were invalid (Opt 4)
        if (allInvalid && matches.length > 0) {
          console.log(`  🔄 All contacts invalid for ${domain}, trying title pivot...`);
          const pivoted = await backupTitlePivot(supabase, {
            domain,
            exhaustedTitles,
            leadId: lead.id,
          });

          if (pivoted && pivoted.email) {
            const pivotAction = classifyApolloStatus(pivoted.email_status);
            if (pivotAction !== 'discard') {
              totalCreditsUsed += 2; // search + enrich
              const { error: pivotErr } = await supabase.from('contact_database').insert({
                first_name: pivoted.first_name || null,
                last_name: pivoted.last_name || null,
                email: pivoted.email,
                title: pivoted.title || null,
                website: domain,
                account_name: pivoted.organization || domain,
                linkedin_url: pivoted.linkedin_url || null,
                apollo_email_status: pivoted.email_status,
                apollo_verified_at: new Date().toISOString(),
              });

              if (!pivotErr) {
                addedForLead++;
                totalPivoted++;
                console.log(`  🔄 Pivoted: ${pivoted.email} (${pivoted.title}) [${pivoted.email_status}]`);
              }
            }
          }
        }

        // Update lead with contact info
        if (addedForLead > 0) {
          const bestMatch = matches.find(m => m.email && classifyApolloStatus((m.email_status || '').toLowerCase()) !== 'discard');
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

    const summary = `Apollo discovery: ${totalFound} contacts found across ${leads.length} leads (~${totalCreditsUsed} credits, ${totalInvalid} invalid, ${totalPivoted} pivoted)`;
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
