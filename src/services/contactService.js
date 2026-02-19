import { supabase } from '../supabaseClient';

// Find contacts for a lead from the contact_database
export const findContacts = async (lead) => {
  const cleanDomain = lead.website.toLowerCase().replace(/^www\./, '');

  // Search by website domain match
  const { data, error } = await supabase
    .from('contact_database')
    .select('*')
    .or(`website.ilike.%${cleanDomain}%,email_domain.ilike.%${cleanDomain}%`)
    .order('title', { ascending: true })
    .limit(50);

  if (error) throw error;

  // Score and sort contacts by title relevance
  const contacts = (data || []).map(c => {
    const title = (c.title || '').toLowerCase();
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown';

    // Score by title relevance for outreach
    let matchLevel = 'Other';
    let matchEmoji = '⚪';
    let matchClass = 'other';
    let score = 0;

    if (title.match(/\b(cmo|chief marketing|vp market|head of market|director.*market|svp.*market)\b/)) {
      matchLevel = 'Marketing Leader';
      matchEmoji = '🎯';
      matchClass = 'high';
      score = 100;
    } else if (title.match(/\b(ecommerce|e-commerce|digital|growth|head of growth|vp.*digital|director.*digital|director.*ecommerce)\b/)) {
      matchLevel = 'Digital/Ecommerce';
      matchEmoji = '🎯';
      matchClass = 'high';
      score = 90;
    } else if (title.match(/\b(creator|influencer|ugc|partnership|affiliate|social media|community)\b/)) {
      matchLevel = 'Creator/Social';
      matchEmoji = '🔥';
      matchClass = 'hot';
      score = 95;
    } else if (title.match(/\b(brand|content|communications|pr|public relations)\b/)) {
      matchLevel = 'Brand/Content';
      matchEmoji = '🟢';
      matchClass = 'medium';
      score = 70;
    } else if (title.match(/\b(ceo|coo|founder|co-founder|president|owner|general manager)\b/)) {
      matchLevel = 'Executive';
      matchEmoji = '👔';
      matchClass = 'exec';
      score = 60;
    } else if (title.match(/\b(manager|coordinator|specialist|analyst|associate)\b/)) {
      matchLevel = 'Mid-Level';
      matchEmoji = '🔵';
      matchClass = 'low';
      score = 30;
    }

    return {
      name,
      title: c.title || 'Unknown Title',
      email: c.email,
      linkedin: c.linkedin_url,
      matchLevel,
      matchEmoji,
      matchClass,
      score,
    };
  });

  // Sort by score descending (best matches first)
  contacts.sort((a, b) => b.score - a.score);

  return contacts;
};
