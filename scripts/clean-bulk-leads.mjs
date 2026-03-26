#!/usr/bin/env node
/**
 * Clean up bulk-uploaded leads that were pasted in "company_name: website" format.
 *
 * These leads have the full string (e.g. "peanut: teampeanut.com") stored as the
 * website field. This script:
 *   1. Fetches all leads for the given org
 *   2. Detects the "name: domain" pattern in the website field
 *   3. Extracts the real website and sets company_name
 *   4. Deduplicates against existing clean leads
 *   5. Updates (or deletes duplicates) in the database
 *
 * Usage:
 *   node scripts/clean-bulk-leads.mjs [--dry-run]
 *
 * Env vars required:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 */

import { createClient } from '@supabase/supabase-js';

const ORG_ID = '55bddb7f-855c-4f4b-8afe-1696c909f641';
const DRY_RUN = process.argv.includes('--dry-run');

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing env vars: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

function normalizeWebsite(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[?#].*$/, '');
}

/**
 * Detect "company_name: website" pattern.
 * Returns { companyName, website } or null if not matching.
 */
function parseNameColonWebsite(value) {
  // Match: "some name: some.domain" — colon followed by space(s) and a domain
  const match = value.match(/^(.+?):\s+(\S+\.\S+)$/);
  if (!match) return null;

  const companyName = match[1].trim();
  const website = normalizeWebsite(match[2]);

  // Sanity check: the website part should look like a domain
  if (!website || !website.includes('.')) return null;

  return { companyName, website };
}

async function fetchAllLeads() {
  const allLeads = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, website, company_name, status')
      .eq('org_id', ORG_ID)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching leads:', error.message);
      process.exit(1);
    }

    allLeads.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allLeads;
}

async function main() {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Cleaning leads for org ${ORG_ID}\n`);

  const leads = await fetchAllLeads();
  console.log(`Total leads in org: ${leads.length}`);

  // Build a set of existing clean websites for dedup
  const cleanWebsites = new Map(); // website -> lead id
  const dirtyLeads = [];

  for (const lead of leads) {
    const parsed = parseNameColonWebsite(lead.website);
    if (parsed) {
      dirtyLeads.push({ ...lead, parsed });
    } else {
      cleanWebsites.set(lead.website, lead.id);
    }
  }

  console.log(`Dirty leads (name: website format): ${dirtyLeads.length}`);
  console.log(`Clean leads: ${cleanWebsites.size}\n`);

  if (dirtyLeads.length === 0) {
    console.log('Nothing to clean!');
    return;
  }

  const toUpdate = [];
  const toDelete = []; // duplicates that already exist as clean leads

  for (const lead of dirtyLeads) {
    const { companyName, website } = lead.parsed;

    if (cleanWebsites.has(website)) {
      // A clean version already exists — this dirty one is a duplicate
      toDelete.push({ id: lead.id, website: lead.website, cleanWebsite: website });
    } else {
      // Check if another dirty lead already claimed this website
      const alreadyClaimed = toUpdate.find(u => u.website === website);
      if (alreadyClaimed) {
        toDelete.push({ id: lead.id, website: lead.website, cleanWebsite: website });
      } else {
        toUpdate.push({
          id: lead.id,
          oldWebsite: lead.website,
          website,
          companyName,
        });
        cleanWebsites.set(website, lead.id);
      }
    }
  }

  console.log(`Will update: ${toUpdate.length}`);
  console.log(`Will delete (duplicates): ${toDelete.length}\n`);

  // Show preview
  console.log('--- Updates ---');
  for (const u of toUpdate.slice(0, 20)) {
    console.log(`  "${u.oldWebsite}" → website="${u.website}", company_name="${u.companyName}"`);
  }
  if (toUpdate.length > 20) console.log(`  ... and ${toUpdate.length - 20} more`);

  if (toDelete.length > 0) {
    console.log('\n--- Deletions (duplicates) ---');
    for (const d of toDelete.slice(0, 20)) {
      console.log(`  "${d.website}" (dirty entry "${d.id}" — clean version exists)`);
    }
    if (toDelete.length > 20) console.log(`  ... and ${toDelete.length - 20} more`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes made.');
    return;
  }

  // Apply updates in batches
  let updated = 0;
  for (const u of toUpdate) {
    const { error } = await supabase
      .from('prospects')
      .update({ website: u.website, company_name: u.companyName })
      .eq('id', u.id);

    if (error) {
      console.error(`  Failed to update ${u.id}: ${error.message}`);
    } else {
      updated++;
    }
  }
  console.log(`\nUpdated: ${updated}/${toUpdate.length}`);

  // Delete duplicates
  if (toDelete.length > 0) {
    const deleteIds = toDelete.map(d => d.id);
    for (let i = 0; i < deleteIds.length; i += 100) {
      const batch = deleteIds.slice(i, i + 100);
      const { error } = await supabase
        .from('prospects')
        .delete()
        .in('id', batch);

      if (error) {
        console.error(`  Failed to delete batch: ${error.message}`);
      }
    }
    console.log(`Deleted: ${toDelete.length} duplicates`);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
