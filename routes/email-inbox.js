import { supabase } from "./helpers.js";

// ── listConversations ───────────────────────────────────────────────────────

export async function listConversations(
  orgId,
  { campaignId, page = 1, limit = 25 } = {}
) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit) || 25));
  const offset = (page - 1) * limit;

  // Build base filter — inbox only shows inbound messages
  let dataQuery = supabase
    .from("email_conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  let countQuery = supabase
    .from("email_conversations")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("direction", "inbound");

  if (campaignId) {
    dataQuery = dataQuery.eq("campaign_id", campaignId);
    countQuery = countQuery.eq("campaign_id", campaignId);
  }

  // Run both queries in parallel
  const [dataResult, countResult] = await Promise.all([dataQuery, countQuery]);

  if (dataResult.error) {
    const err = new Error(
      "Failed to fetch conversations: " + dataResult.error.message
    );
    err.status = 500;
    throw err;
  }

  const total = countResult.count || 0;

  return {
    conversations: dataResult.data || [],
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

// ── getInboxStats ───────────────────────────────────────────────────────────

export async function getInboxStats(orgId) {
  // Three parallel queries — all scoped to inbound only
  const [totalResult, unreadResult, byCampaignResult] = await Promise.all([
    supabase
      .from("email_conversations")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("direction", "inbound"),

    supabase
      .from("email_conversations")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .eq("is_read", false),

    supabase
      .from("email_conversations")
      .select("campaign_id")
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .not("campaign_id", "is", null),
  ]);

  // Aggregate by_campaign from raw rows
  const campaignCounts = {};
  for (const row of byCampaignResult.data || []) {
    campaignCounts[row.campaign_id] =
      (campaignCounts[row.campaign_id] || 0) + 1;
  }

  const byCampaign = Object.entries(campaignCounts).map(
    ([campaign_id, count]) => ({ campaign_id, count })
  );

  return {
    total: totalResult.count || 0,
    unread: unreadResult.count || 0,
    by_campaign: byCampaign,
  };
}

// ── getConversation ─────────────────────────────────────────────────────────

export async function getConversation(orgId, conversationId) {
  const { data: conversation, error } = await supabase
    .from("email_conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("org_id", orgId)
    .single();

  if (error || !conversation) {
    const err = new Error("Conversation not found");
    err.status = 404;
    throw err;
  }

  // Auto-mark as read
  if (!conversation.is_read) {
    const now = new Date().toISOString();
    await supabase
      .from("email_conversations")
      .update({ is_read: true, read_at: now })
      .eq("id", conversationId);
    conversation.is_read = true;
    conversation.read_at = now;
  }

  return conversation;
}

// ── markAsRead ──────────────────────────────────────────────────────────────

export async function markAsRead(orgId, conversationId) {
  // Verify row exists for org
  const { count } = await supabase
    .from("email_conversations")
    .select("*", { count: "exact", head: true })
    .eq("id", conversationId)
    .eq("org_id", orgId);

  if (!count || count === 0) {
    const err = new Error("Conversation not found");
    err.status = 404;
    throw err;
  }

  const { error } = await supabase
    .from("email_conversations")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("org_id", orgId);

  if (error) {
    const err = new Error("Failed to mark as read: " + error.message);
    err.status = 500;
    throw err;
  }

  return { success: true };
}
