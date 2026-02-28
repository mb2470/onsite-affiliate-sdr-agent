import { supabase, getServiceClients, CloudflareService } from "./helpers.js";

// ── Required WHOIS fields for domain purchase ───────────────────────────────

const REQUIRED_WHOIS = [
  "first_name",
  "last_name",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "phone",
  "email",
];

// ── listDomains ─────────────────────────────────────────────────────────────

export async function listDomains(orgId) {
  const { data: domains, error } = await supabase
    .from("email_domains")
    .select("*, email_accounts(id, email_address, status)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    const err = new Error("Failed to fetch domains: " + error.message);
    err.status = 500;
    throw err;
  }

  return domains || [];
}

// ── getDomainStatus ─────────────────────────────────────────────────────────

export async function getDomainStatus(orgId, domainId) {
  const { data: domain, error } = await supabase
    .from("email_domains")
    .select("*, email_accounts(*)")
    .eq("id", domainId)
    .eq("org_id", orgId)
    .single();

  if (error || !domain) {
    const err = new Error("Domain not found");
    err.status = 404;
    throw err;
  }

  return domain;
}

// ── searchDomains ───────────────────────────────────────────────────────────

export async function searchDomains(orgId, query) {
  if (!query) {
    const err = new Error("Missing required field: query");
    err.status = 400;
    throw err;
  }

  const { cloudflare } = await getServiceClients(orgId);
  if (!cloudflare) {
    const err = new Error(
      "Cloudflare credentials not configured. Update Email Settings first."
    );
    err.status = 400;
    throw err;
  }

  const data = await cloudflare.searchDomains(query);

  if (!data.success) {
    const err = new Error("Cloudflare domain search failed");
    err.status = 502;
    throw err;
  }

  return data.result || [];
}

// ── purchaseDomain ──────────────────────────────────────────────────────────

export async function purchaseDomain(orgId, domain, years = 1) {
  if (!domain) {
    const err = new Error("Missing required field: domain");
    err.status = 400;
    throw err;
  }

  const { cloudflare, settings } = await getServiceClients(orgId);
  if (!cloudflare) {
    const err = new Error(
      "Cloudflare credentials not configured. Update Email Settings first."
    );
    err.status = 400;
    throw err;
  }

  // Build and validate WHOIS contact from settings.metadata.whois
  const whois = settings.metadata?.whois || {};
  const missing = REQUIRED_WHOIS.filter((f) => !whois[f]);
  if (missing.length > 0) {
    const err = new Error(
      `Missing WHOIS contact info: ${missing.join(", ")}. Update Email Settings first.`
    );
    err.status = 400;
    throw err;
  }

  // Check if domain already exists for this org
  const { data: existing } = await supabase
    .from("email_domains")
    .select("id")
    .eq("org_id", orgId)
    .eq("domain", domain)
    .limit(1);

  if (existing && existing.length > 0) {
    const err = new Error(`Domain ${domain} already exists in your account`);
    err.status = 400;
    throw err;
  }

  // Purchase via Cloudflare Registrar
  const contactInfo = {
    first_name: whois.first_name,
    last_name: whois.last_name,
    address: whois.address,
    city: whois.city,
    state: whois.state,
    zip: whois.zip,
    country: whois.country,
    phone: whois.phone,
    email: whois.email,
    organization: whois.organization || "",
  };

  const purchaseData = await cloudflare.purchaseDomain(
    domain,
    contactInfo,
    years
  );

  if (!purchaseData.success) {
    const err = new Error("Domain purchase failed");
    err.status = 502;
    err.details = purchaseData.errors;
    throw err;
  }

  // Attempt to capture auto-created zone
  const zoneId = await cloudflare.getZoneId(domain);

  // Compute expiry
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + years);

  // Insert into email_domains
  const { data: domainRow, error: insertError } = await supabase
    .from("email_domains")
    .insert({
      org_id: orgId,
      domain,
      status: "purchased",
      registrar: "cloudflare",
      purchased_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      purchase_price: purchaseData.result?.price || null,
      cloudflare_zone_id: zoneId,
      cloudflare_account_id: settings.cloudflare_account_id,
    })
    .select()
    .single();

  if (insertError) {
    const err = new Error(
      "Domain purchased but failed to save to database: " +
        insertError.message
    );
    err.status = 500;
    throw err;
  }

  return domainRow;
}

// ── provisionDns ────────────────────────────────────────────────────────────

export async function provisionDns(orgId, domainId, providerConfig) {
  // Verify domain belongs to org
  const { data: domainRow, error: domErr } = await supabase
    .from("email_domains")
    .select("*")
    .eq("id", domainId)
    .eq("org_id", orgId)
    .single();

  if (domErr || !domainRow) {
    const err = new Error("Domain not found");
    err.status = 404;
    throw err;
  }

  const { cloudflare } = await getServiceClients(orgId);
  if (!cloudflare) {
    const err = new Error(
      "Cloudflare credentials not configured. Update Email Settings first."
    );
    err.status = 400;
    throw err;
  }

  // Resolve zone ID — find or create
  let zoneId = domainRow.cloudflare_zone_id;
  if (!zoneId) {
    zoneId = await cloudflare.getZoneId(domainRow.domain);
    if (!zoneId) {
      zoneId = await cloudflare.createZone(domainRow.domain);
    }
    if (!zoneId) {
      const err = new Error("Failed to resolve or create Cloudflare zone");
      err.status = 502;
      throw err;
    }
    // Persist zone ID
    await supabase
      .from("email_domains")
      .update({ cloudflare_zone_id: zoneId })
      .eq("id", domainId);
  }

  // Provision DNS records
  const results = await cloudflare.provisionColdEmailDns(
    zoneId,
    domainRow.domain,
    providerConfig
  );

  // Update domain row with provisioning status
  const updateData = {
    status: "dns_pending",
    dns_configured: true,
    dns_configured_at: new Date().toISOString(),
    mx_verified: results.mx.length > 0,
    spf_verified: !!results.spf,
    dmarc_verified: !!results.dmarc,
    dkim_verified: results.dkim.length > 0,
  };

  if (
    updateData.mx_verified &&
    updateData.spf_verified &&
    updateData.dmarc_verified
  ) {
    updateData.status = "active";
  }

  await supabase
    .from("email_domains")
    .update(updateData)
    .eq("id", domainId);

  return results;
}

// ── verifyDns ───────────────────────────────────────────────────────────────

export async function verifyDns(orgId, domainId) {
  // Verify domain belongs to org
  const { data: domainRow, error: domErr } = await supabase
    .from("email_domains")
    .select("*")
    .eq("id", domainId)
    .eq("org_id", orgId)
    .single();

  if (domErr || !domainRow) {
    const err = new Error("Domain not found");
    err.status = 404;
    throw err;
  }

  const zoneId = domainRow.cloudflare_zone_id;
  if (!zoneId) {
    const err = new Error(
      "No Cloudflare zone ID found for this domain. Run provision first."
    );
    err.status = 400;
    throw err;
  }

  const { cloudflare } = await getServiceClients(orgId);
  if (!cloudflare) {
    const err = new Error("Cloudflare credentials not configured");
    err.status = 400;
    throw err;
  }

  const status = await cloudflare.verifyDnsRecords(zoneId, domainRow.domain);
  if (!status) {
    const err = new Error("Failed to fetch DNS records from Cloudflare");
    err.status = 502;
    throw err;
  }

  // Persist verification status
  await supabase
    .from("email_domains")
    .update({
      mx_verified: status.mx,
      spf_verified: status.spf,
      dkim_verified: status.dkim,
      dmarc_verified: status.dmarc,
      status:
        status.mx && status.spf && status.dkim && status.dmarc
          ? "active"
          : "dns_pending",
    })
    .eq("id", domainId);

  return status;
}
