import { supabase, getServiceClients } from "./helpers.js";

// ── listCampaigns ───────────────────────────────────────────────────────────

export async function listCampaigns(orgId) {
  const { data: campaigns, error } = await supabase
    .from("outreach_campaigns")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    const err = new Error("Failed to fetch campaigns: " + error.message);
    err.status = 500;
    throw err;
  }

  return (campaigns || []).map((c) => ({
    id: c.id,
    name: c.name,
    smartlead_campaign_id: c.smartlead_campaign_id,
    status: c.status,
    email_account_ids: c.sending_account_ids || [],
    total_leads: c.total_leads || 0,
    total_sent: c.total_sent || 0,
    total_replies: c.total_replied || 0,
    created_at: c.created_at,
  }));
}

// ── createCampaign ──────────────────────────────────────────────────────────

export async function createCampaign(orgId, name) {
  if (!name || !name.trim()) {
    const err = new Error("Campaign name is required");
    err.status = 400;
    throw err;
  }

  const { smartlead } = await getServiceClients(orgId);
  if (!smartlead) {
    const err = new Error("Smartlead API key not configured");
    err.status = 400;
    throw err;
  }

  const slResult = await smartlead.createCampaign(name.trim());
  const smartleadCampaignId = slResult?.id?.toString() || null;

  const { data: campaign, error: insertErr } = await supabase
    .from("outreach_campaigns")
    .insert({
      org_id: orgId,
      name: name.trim(),
      smartlead_campaign_id: smartleadCampaignId,
      status: "draft",
    })
    .select()
    .single();

  if (insertErr) {
    const err = new Error(
      "Failed to save campaign: " + insertErr.message
    );
    err.status = 500;
    throw err;
  }

  return {
    id: campaign.id,
    name: campaign.name,
    smartlead_campaign_id: campaign.smartlead_campaign_id,
    status: campaign.status,
    email_account_ids: [],
    total_leads: 0,
    total_sent: 0,
    total_replies: 0,
    created_at: campaign.created_at,
  };
}

// ── getCampaignDetail ───────────────────────────────────────────────────────

export async function getCampaignDetail(orgId, campaignId) {
  // Load campaign
  const { data: campaign, error: campErr } = await supabase
    .from("outreach_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .single();

  if (campErr || !campaign) {
    const err = new Error("Campaign not found");
    err.status = 404;
    throw err;
  }

  // Fetch assigned email accounts
  const accountIds = campaign.sending_account_ids || [];
  let accounts = [];
  if (accountIds.length > 0) {
    const { data: accts } = await supabase
      .from("email_accounts")
      .select("id, email_address, smartlead_warmup_status, status")
      .in("id", accountIds);
    accounts = accts || [];
  }

  // Count inbound conversations for this campaign
  const { count: replyCount } = await supabase
    .from("email_conversations")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("campaign_id", campaignId)
    .eq("direction", "inbound");

  // Try Smartlead stats (non-blocking — graceful degradation)
  let smartleadStats = null;
  if (campaign.smartlead_campaign_id) {
    try {
      const { smartlead } = await getServiceClients(orgId);
      if (smartlead) {
        smartleadStats = await smartlead.getCampaignStats(
          campaign.smartlead_campaign_id
        );
      }
    } catch {
      // Stats are supplementary — swallow errors
    }
  }

  return {
    id: campaign.id,
    name: campaign.name,
    smartlead_campaign_id: campaign.smartlead_campaign_id,
    status: campaign.status,
    email_account_ids: accountIds,
    accounts,
    reply_count: replyCount || 0,
    smartlead_stats: smartleadStats,
    total_leads: campaign.total_leads || 0,
    total_sent: campaign.total_sent || 0,
    total_replies: campaign.total_replied || 0,
  };
}
