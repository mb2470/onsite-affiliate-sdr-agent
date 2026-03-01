import {
  supabase,
  maskToken,
  getServiceClients,
  CloudflareService,
} from "./helpers.js";

// ── Allowed fields for update (whitelist) ───────────────────────────────────

const ALLOWED_FIELDS = [
  "cloudflare_account_id",
  "cloudflare_api_token",
  "smartlead_api_key",
  "whois_first_name",
  "whois_last_name",
  "whois_address1",
  "whois_city",
  "whois_state",
  "whois_zip",
  "whois_country",
  "whois_phone",
  "whois_email",
];

// WHOIS fields are stored in metadata.whois (existing schema convention)
const WHOIS_FIELD_MAP = {
  whois_first_name: "first_name",
  whois_last_name: "last_name",
  whois_address1: "address",
  whois_city: "city",
  whois_state: "state",
  whois_zip: "zip",
  whois_country: "country",
  whois_phone: "phone",
  whois_email: "email",
};

// ── getEmailSettings ────────────────────────────────────────────────────────

export async function getEmailSettings(orgId) {
  let { data: settings, error } = await supabase
    .from("email_settings")
    .select("*")
    .eq("org_id", orgId)
    .single();

  // Auto-create a default row if none exists
  if (error || !settings) {
    const { data: inserted, error: insertErr } = await supabase
      .from("email_settings")
      .insert({ org_id: orgId })
      .select()
      .single();

    if (insertErr) {
      // Might race with another insert — try reading again
      const { data: retry } = await supabase
        .from("email_settings")
        .select("*")
        .eq("org_id", orgId)
        .single();
      settings = retry;
    } else {
      settings = inserted;
    }

    if (!settings) {
      const err = new Error("Failed to create default email settings");
      err.status = 500;
      throw err;
    }
  }

  const whois = settings.metadata?.whois || {};

  return {
    id: settings.id,
    org_id: settings.org_id,
    cloudflare_account_id: settings.cloudflare_account_id || "",
    cloudflare_api_token: maskToken(settings.cloudflare_api_token),
    smartlead_api_key: maskToken(settings.smartlead_api_key),
    gmail_access_token: undefined,
    gmail_refresh_token: undefined,
    gmail_email: settings.gmail_from_email || "",
    whois_first_name: whois.first_name || "",
    whois_last_name: whois.last_name || "",
    whois_address1: whois.address || "",
    whois_city: whois.city || "",
    whois_state: whois.state || "",
    whois_zip: whois.zip || "",
    whois_country: whois.country || "US",
    whois_phone: whois.phone || "",
    whois_email: whois.email || "",
    has_cloudflare: !!(
      settings.cloudflare_api_token && settings.cloudflare_account_id
    ),
    has_smartlead: !!settings.smartlead_api_key,
    has_gmail: !!(
      settings.gmail_oauth_credentials || settings.gmail_from_email
    ),
  };
}

// ── updateEmailSettings ─────────────────────────────────────────────────────

export async function updateEmailSettings(orgId, updates) {
  // Only allow whitelisted fields
  const dbUpdates = {};
  const whoisUpdates = {};
  let hasWhois = false;

  for (const key of Object.keys(updates)) {
    if (!ALLOWED_FIELDS.includes(key)) continue;

    if (key in WHOIS_FIELD_MAP) {
      whoisUpdates[WHOIS_FIELD_MAP[key]] = updates[key];
      hasWhois = true;
    } else {
      dbUpdates[key] = updates[key];
    }
  }

  if (Object.keys(dbUpdates).length === 0 && !hasWhois) {
    const err = new Error("No valid fields to update");
    err.status = 400;
    throw err;
  }

  // Merge WHOIS into metadata.whois
  if (hasWhois) {
    const { data: existing } = await supabase
      .from("email_settings")
      .select("metadata")
      .eq("org_id", orgId)
      .single();

    const existingMeta = existing?.metadata || {};
    const existingWhois = existingMeta.whois || {};
    dbUpdates.metadata = {
      ...existingMeta,
      whois: { ...existingWhois, ...whoisUpdates },
    };
  }

  const { data, error } = await supabase
    .from("email_settings")
    .upsert({ org_id: orgId, ...dbUpdates }, { onConflict: "org_id" })
    .select()
    .single();

  if (error) {
    const err = new Error("Failed to update settings: " + error.message);
    err.status = 500;
    throw err;
  }

  return { success: true, settings: await getEmailSettings(orgId) };
}

// ── testCloudflareConnection ────────────────────────────────────────────────

export async function testCloudflareConnection(orgId) {
  const { settings } = await getServiceClients(orgId);

  if (!settings.cloudflare_api_token || !settings.cloudflare_account_id) {
    return { valid: false, error: "Cloudflare credentials not configured" };
  }

  const cf = new CloudflareService(
    settings.cloudflare_api_token,
    settings.cloudflare_account_id
  );

  const data = await cf.verifyToken();

  if (data.success && data.result) {
    return { valid: true, status: data.result.status };
  }

  return {
    valid: false,
    error:
      data.errors?.[0]?.message || "Authentication error",
  };
}

