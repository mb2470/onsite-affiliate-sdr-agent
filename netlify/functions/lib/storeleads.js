function normalizeDomain(domain = '') {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parseStoreLeadsPayload(payload) {
  const store = payload?.result || payload || {};
  const contactInfo = store.contact_info || {};

  return {
    domain: normalizeDomain(store.domain || store.name),
    company_name: toNullableText(store.company_name || store.store_name || store.title),
    name: toNullableText(store.name),
    title: toNullableText(store.title),
    description: toNullableText(store.description),
    keyword: toNullableText(store.keyword),
    platform: toNullableText(store.platform),
    plan: toNullableText(store.plan),
    rank: toNullableNumber(store.rank),
    product_count: toNullableNumber(store.product_count),
    estimated_sales: toNullableNumber(store.estimated_sales),
    city: toNullableText(store.city),
    state: toNullableText(store.state),
    country: toNullableText(store.country),
    currency: toNullableText(store.currency),
    language: toNullableText(store.language),
    timezone: toNullableText(store.timezone),
    phone: toNullableText(store.phone || contactInfo.phone),
    email: toNullableText(store.email || contactInfo.email),
    linkedin: toNullableText(store.linkedin || contactInfo.linkedin),
    facebook: toNullableText(store.facebook || contactInfo.facebook),
    instagram: toNullableText(store.instagram || contactInfo.instagram),
    tiktok: toNullableText(store.tiktok || contactInfo.tiktok),
    youtube: toNullableText(store.youtube || contactInfo.youtube),
    pinterest: toNullableText(store.pinterest || contactInfo.pinterest),
    twitter: toNullableText(store.twitter || contactInfo.twitter || contactInfo.x),
    contact_info: contactInfo,
    categories: Array.isArray(store.categories) ? store.categories : [],
    technologies: Array.isArray(store.technologies) ? store.technologies : [],
    apps: Array.isArray(store.apps) ? store.apps : [],
    first_seen_at: store.created_at || null,
    last_seen_at: new Date().toISOString(),
    raw_payload: store,
  };
}

async function upsertStoreLeadsRecord(supabase, orgId, payload) {
  const record = parseStoreLeadsPayload(payload);
  if (!record.domain) return null;

  const { error } = await supabase
    .from('storeleads')
    .upsert({
      org_id: orgId,
      ...record,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,domain' });

  if (error) throw error;
  return record;
}

module.exports = {
  normalizeDomain,
  parseStoreLeadsPayload,
  upsertStoreLeadsRecord,
};
