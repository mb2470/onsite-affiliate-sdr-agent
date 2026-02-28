import { supabase, getServiceClients } from "./helpers.js";

// ── listEmailAccounts ───────────────────────────────────────────────────────

export async function listEmailAccounts(orgId) {
  const { data: accounts, error } = await supabase
    .from("email_accounts")
    .select("*, domain:email_domains(domain, status)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    const err = new Error("Failed to fetch accounts: " + error.message);
    err.status = 500;
    throw err;
  }

  return (accounts || []).map((a) => ({
    id: a.id,
    email_address: a.email_address,
    smartlead_account_id: a.smartlead_account_id,
    warmup_enabled: a.smartlead_warmup_enabled,
    warmup_status: a.smartlead_warmup_status,
    daily_send_limit: a.daily_send_limit,
    status: a.status,
    domain: a.domain,
  }));
}

// ── createEmailAccount ──────────────────────────────────────────────────────

export async function createEmailAccount(orgId, params) {
  const {
    domainId,
    localPart,
    password,
    fromName,
    smtpHost = "smtp.zoho.com",
    smtpPort = 587,
    imapHost = "imap.zoho.com",
    imapPort = 993,
  } = params;

  if (!domainId || !localPart || !password) {
    const err = new Error(
      "Missing required fields: domainId, localPart, password"
    );
    err.status = 400;
    throw err;
  }

  // Verify domain belongs to org
  const { data: domain, error: domErr } = await supabase
    .from("email_domains")
    .select("id, domain")
    .eq("id", domainId)
    .eq("org_id", orgId)
    .single();

  if (domErr || !domain) {
    const err = new Error("Domain not found");
    err.status = 404;
    throw err;
  }

  const emailAddress = `${localPart}@${domain.domain}`;

  // Check uniqueness
  const { count } = await supabase
    .from("email_accounts")
    .select("*", { count: "exact", head: true })
    .eq("email_address", emailAddress);

  if (count > 0) {
    const err = new Error(
      `Email account ${emailAddress} already exists`
    );
    err.status = 400;
    throw err;
  }

  // Register in Smartlead
  const { smartlead, settings } = await getServiceClients(orgId);
  if (!smartlead) {
    const err = new Error("Smartlead API key not configured");
    err.status = 400;
    throw err;
  }

  const slResult = await smartlead.addEmailAccount({
    from_email: emailAddress,
    from_name: fromName || localPart,
    username: emailAddress,
    password,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    imap_host: imapHost,
    imap_port: imapPort,
    warmup_enabled: true,
  });

  const smartleadAccountId =
    slResult?.id?.toString() ||
    slResult?.email_account_id?.toString() ||
    null;

  // Store in database
  const { data: account, error: insertErr } = await supabase
    .from("email_accounts")
    .insert({
      org_id: orgId,
      domain_id: domainId,
      email_address: emailAddress,
      display_name: fromName || localPart,
      first_name: fromName ? fromName.split(" ")[0] : localPart,
      smartlead_account_id: smartleadAccountId,
      smartlead_warmup_enabled: true,
      smartlead_warmup_status: "in_progress",
      warmup_started_at: new Date().toISOString(),
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      imap_host: imapHost,
      imap_port: imapPort,
      daily_send_limit: settings.default_daily_send_limit || 30,
      status: "warming",
    })
    .select()
    .single();

  if (insertErr) {
    const err = new Error(
      "Failed to save email account: " + insertErr.message
    );
    err.status = 500;
    throw err;
  }

  return account;
}

// ── toggleWarmup ────────────────────────────────────────────────────────────

export async function toggleWarmup(orgId, accountId, enabled) {
  if (typeof enabled !== "boolean") {
    const err = new Error("Missing required field: enabled (boolean)");
    err.status = 400;
    throw err;
  }

  // Verify account belongs to org
  const { data: account, error: accErr } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("id", accountId)
    .eq("org_id", orgId)
    .single();

  if (accErr || !account) {
    const err = new Error("Email account not found");
    err.status = 404;
    throw err;
  }

  if (!account.smartlead_account_id) {
    const err = new Error("Account not registered with Smartlead");
    err.status = 400;
    throw err;
  }

  const { smartlead } = await getServiceClients(orgId);
  if (!smartlead) {
    const err = new Error("Smartlead API key not configured");
    err.status = 400;
    throw err;
  }

  await smartlead.updateWarmup(account.smartlead_account_id, enabled);

  const newStatus = enabled ? "in_progress" : "paused";
  const { data: updated, error: updateErr } = await supabase
    .from("email_accounts")
    .update({
      smartlead_warmup_enabled: enabled,
      smartlead_warmup_status: newStatus,
    })
    .eq("id", accountId)
    .select()
    .single();

  if (updateErr) {
    const err = new Error("Failed to update account: " + updateErr.message);
    err.status = 500;
    throw err;
  }

  return updated;
}

// ── getWarmupStats ──────────────────────────────────────────────────────────

export async function getWarmupStats(orgId, accountId) {
  // Verify account belongs to org
  const { data: account, error: accErr } = await supabase
    .from("email_accounts")
    .select("smartlead_account_id")
    .eq("id", accountId)
    .eq("org_id", orgId)
    .single();

  if (accErr || !account) {
    const err = new Error("Email account not found");
    err.status = 404;
    throw err;
  }

  if (!account.smartlead_account_id) {
    const err = new Error("Account not registered with Smartlead");
    err.status = 400;
    throw err;
  }

  const { smartlead } = await getServiceClients(orgId);
  if (!smartlead) {
    const err = new Error("Smartlead API key not configured");
    err.status = 400;
    throw err;
  }

  return smartlead.getWarmupStats(account.smartlead_account_id);
}

// ── assignToCampaign ────────────────────────────────────────────────────────

export async function assignToCampaign(orgId, accountId, campaignId) {
  if (!campaignId) {
    const err = new Error("Missing required field: campaignId");
    err.status = 400;
    throw err;
  }

  // Verify account belongs to org
  const { data: account, error: accErr } = await supabase
    .from("email_accounts")
    .select("id, email_address, smartlead_account_id")
    .eq("id", accountId)
    .eq("org_id", orgId)
    .single();

  if (accErr || !account) {
    const err = new Error("Email account not found");
    err.status = 404;
    throw err;
  }

  if (!account.smartlead_account_id) {
    const err = new Error("Account not registered with Smartlead");
    err.status = 400;
    throw err;
  }

  // Verify campaign belongs to org
  const { data: campaign, error: campErr } = await supabase
    .from("outreach_campaigns")
    .select("id, name, smartlead_campaign_id, sending_account_ids")
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .single();

  if (campErr || !campaign) {
    const err = new Error("Campaign not found");
    err.status = 404;
    throw err;
  }

  if (!campaign.smartlead_campaign_id) {
    const err = new Error("Campaign not registered with Smartlead");
    err.status = 400;
    throw err;
  }

  // Assign in Smartlead
  const { smartlead } = await getServiceClients(orgId);
  if (!smartlead) {
    const err = new Error("Smartlead API key not configured");
    err.status = 400;
    throw err;
  }

  await smartlead.addEmailsToCampaign(campaign.smartlead_campaign_id, [
    account.smartlead_account_id,
  ]);

  // Update sending_account_ids JSONB array on campaign
  const currentIds = campaign.sending_account_ids || [];
  if (!currentIds.includes(account.id)) {
    await supabase
      .from("outreach_campaigns")
      .update({ sending_account_ids: [...currentIds, account.id] })
      .eq("id", campaignId);
  }

  return {
    success: true,
    message: `${account.email_address} assigned to ${campaign.name}`,
  };
}
