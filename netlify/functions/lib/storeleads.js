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

function extractFromContactInfo(contactInfoArray, type) {
  if (!Array.isArray(contactInfoArray)) return null;
  const entry = contactInfoArray.find(c => c.type === type);
  return entry ? entry.value : null;
}

function extractFollowers(contactInfoArray, type) {
  if (!Array.isArray(contactInfoArray)) return null;
  const entry = contactInfoArray.find(c => c.type === type);
  return entry ? (entry.followers || null) : null;
}

function extractAllFromContactInfo(contactInfoArray, type) {
  if (!Array.isArray(contactInfoArray)) return [];
  return contactInfoArray.filter(c => c.type === type).map(c => c.value);
}

function parseStoreLeadsPayload(payload) {
  const store = payload?.result || payload || {};
  const contactArr = Array.isArray(store.contact_info) ? store.contact_info : [];

  return {
    domain: normalizeDomain(store.domain || store.tld1 || store.name),
    company_name: toNullableText(store.company_name || store.store_name || store.title),
    name: toNullableText(store.name),
    title: toNullableText(store.title),
    description: toNullableText(store.description),
    keyword: toNullableText(store.keyword || store.keywords),
    platform: toNullableText(store.platform),
    plan: toNullableText(store.plan),
    rank: toNullableNumber(store.rank),
    product_count: toNullableNumber(store.product_count),
    estimated_sales: toNullableNumber(store.estimated_sales),
    city: toNullableText(store.city),
    state: toNullableText(store.state),
    country: toNullableText(store.country || store.country_code),
    currency: toNullableText(store.currency || store.currency_code),
    language: toNullableText(store.language || store.language_code),
    timezone: toNullableText(store.timezone),
    phone: toNullableText(store.phone || extractFromContactInfo(contactArr, 'phone')),
    email: toNullableText(store.email || extractFromContactInfo(contactArr, 'email')),
    linkedin: toNullableText(store.linkedin || extractFromContactInfo(contactArr, 'linkedin')),
    facebook: toNullableText(store.facebook || extractFromContactInfo(contactArr, 'facebook')),
    instagram: toNullableText(store.instagram || extractFromContactInfo(contactArr, 'instagram')),
    tiktok: toNullableText(store.tiktok || extractFromContactInfo(contactArr, 'tiktok')),
    youtube: toNullableText(store.youtube || extractFromContactInfo(contactArr, 'youtube')),
    pinterest: toNullableText(store.pinterest || extractFromContactInfo(contactArr, 'pinterest')),
    twitter: toNullableText(store.twitter || extractFromContactInfo(contactArr, 'twitter')),
    contact_info: contactArr,
    categories: Array.isArray(store.categories) ? store.categories : [],
    technologies: Array.isArray(store.technologies) ? store.technologies : [],
    apps: Array.isArray(store.apps) ? store.apps : [],
    first_seen_at: store.created_at || store.created || null,
    last_seen_at: new Date().toISOString(),
    raw_payload: store,

    // Extended fields — map API field names to DB columns
    average_product_price: toNullableNumber(store.average_product_price || store.avg_price),
    average_product_price_usd: toNullableNumber(store.average_product_price_usd || store.avg_price_usd),
    domain_url: toNullableText(store.domain_url || store.about_us || store.contact_page),
    merchant_name: toNullableText(store.merchant_name),
    employee_count: toNullableNumber(store.employee_count),
    status: toNullableText(store.status || store.state),
    street_address: toNullableText(store.street_address),
    zip: toNullableText(store.zip || store.postal_code),
    country_code: toNullableText(store.country_code),
    company_location: toNullableText(store.company_location || store.location),
    estimated_monthly_sales: toNullableNumber(store.estimated_monthly_sales || store.estimated_sales),
    estimated_yearly_sales: toNullableNumber(store.estimated_yearly_sales || store.estimated_sales_yearly),
    product_images: toNullableNumber(store.product_images),
    product_variants: toNullableNumber(store.product_variants || store.variant_count),
    products_created_90: toNullableNumber(store.products_created_90 || store.product_images_created_90),
    platform_domain: toNullableText(store.platform_domain),
    platform_rank: toNullableNumber(store.platform_rank),
    pinterest_followers: toNullableNumber(store.pinterest_followers || extractFollowers(contactArr, 'pinterest')),
    tiktok_followers: toNullableNumber(store.tiktok_followers || extractFollowers(contactArr, 'tiktok')),
    twitter_followers: toNullableNumber(store.twitter_followers || extractFollowers(contactArr, 'twitter')),
    youtube_followers: toNullableNumber(store.youtube_followers || extractFollowers(contactArr, 'youtube')),
    emails: extractAllFromContactInfo(contactArr, 'email'),
    phones: extractAllFromContactInfo(contactArr, 'phone'),
    linkedin_account: toNullableText(store.linkedin_account || extractFromContactInfo(contactArr, 'linkedin')),
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
