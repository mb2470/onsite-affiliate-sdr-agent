import { supabase } from '../supabaseClient';
import { resolveOrgId } from './orgService';

// Score and format contacts from raw database rows
const scoreContacts = (data) => {
  const contacts = (data || []).map(c => {
    const title = (c.title || '').toLowerCase();
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown';

    let matchLevel = 'Other';
    let matchEmoji = '⚪';
    let matchClass = 'other';
    let score = 0;

    if (title.match(/\b(cmo|chief marketing|vp market|head of market|director.*market|svp.*market)\b/)) {
      matchLevel = 'Marketing Leader'; matchEmoji = '🎯'; matchClass = 'high'; score = 100;
    } else if (title.match(/\b(ecommerce|e-commerce|digital|growth|head of growth|vp.*digital|director.*digital|director.*ecommerce)\b/)) {
      matchLevel = 'Digital/Ecommerce'; matchEmoji = '🎯'; matchClass = 'high'; score = 90;
    } else if (title.match(/\b(creator|influencer|ugc|partnership|affiliate|social media|community)\b/)) {
      matchLevel = 'Creator/Social'; matchEmoji = '🔥'; matchClass = 'hot'; score = 95;
    } else if (title.match(/\b(brand|content|communications|pr|public relations)\b/)) {
      matchLevel = 'Brand/Content'; matchEmoji = '🟢'; matchClass = 'medium'; score = 70;
    } else if (title.match(/\b(ceo|coo|founder|co-founder|president|owner|general manager)\b/)) {
      matchLevel = 'Executive'; matchEmoji = '👔'; matchClass = 'exec'; score = 60;
    } else if (title.match(/\b(manager|coordinator|specialist|analyst|associate)\b/)) {
      matchLevel = 'Mid-Level'; matchEmoji = '🔵'; matchClass = 'low'; score = 30;
    }

    return {
      name,
      title: c.title || 'Unknown Title',
      email: c.email,
      linkedin: c.linkedin_url,
      matchLevel, matchEmoji, matchClass, score,
      apolloStatus: c.apollo_email_status || null,
    };
  });

  contacts.sort((a, b) => b.score - a.score);
  return contacts;
};

// Find contacts for a lead — checks contact_database first, falls back to Apollo
export const findContacts = async (lead, orgId) => {
  const scopedOrgId = await resolveOrgId(orgId);
  const cleanDomain = lead.website.toLowerCase().replace(/^www\./, '');

  // Step 1: Check contact_database
  const { data, error } = await supabase
    .from('contact_database')
    .select('*')
    .eq('org_id', scopedOrgId)
    .or(`website.ilike.%${cleanDomain}%,email_domain.ilike.%${cleanDomain}%`)
    .order('title', { ascending: true })
    .limit(50);

  if (error) throw error;

  if (data && data.length > 0) {
    return scoreContacts(data);
  }

  // Step 2: No contacts found — try Apollo
  console.log(`📡 No contacts in database for ${cleanDomain}, trying Apollo...`);

  try {
    const res = await fetch('/.netlify/functions/apollo-find-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: cleanDomain, leadId: lead.id, org_id: scopedOrgId }),
    });

    const apolloData = await res.json();

    if (!res.ok || !apolloData.contacts?.length) {
      console.log(`Apollo returned no contacts for ${cleanDomain}`);
      return [];
    }

    console.log(`✅ Apollo found ${apolloData.contacts.length} contacts for ${cleanDomain}`);

    // Re-query contact_database now that Apollo wrote contacts there
    const { data: newData } = await supabase
      .from('contact_database')
      .select('*')
      .eq('org_id', scopedOrgId)
      .or(`website.ilike.%${cleanDomain}%,email_domain.ilike.%${cleanDomain}%`)
      .limit(50);

    return scoreContacts(newData);
  } catch (apolloErr) {
    console.error('Apollo fallback error:', apolloErr);
    return [];
  }
};

// Verify a list of contact emails through the waterfall (Apollo cached status → ELV)
export const verifyContactEmails = async (emails, orgId) => {
  try {
    const scopedOrgId = await resolveOrgId(orgId);
    const res = await fetch('/.netlify/functions/verify-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, org_id: scopedOrgId }),
    });

    if (!res.ok) {
      console.error('Verification endpoint error:', res.status);
      return {};
    }

    const { results } = await res.json();

    // Return as a map: email → { status, safe, source }
    const map = {};
    for (const r of results) {
      map[r.email] = { status: r.status, safe: r.safe, source: r.source };
    }
    return map;
  } catch (e) {
    console.error('Verification error:', e);
    return {};
  }
};
