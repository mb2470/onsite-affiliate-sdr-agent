const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// Use service role key (bypasses RLS) for server-side function,
// falling back to anon key if not set.
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  supabaseKey
);

// ── Tool definitions for Claude ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'query_leads',
    description:
      'Search and filter leads from the database. Use this to answer questions about leads, counts, statuses, ICP fit, etc.',
    input_schema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Optional text to search in website, industry, or research notes',
        },
        status: {
          type: 'string',
          enum: ['all', 'new', 'enriched', 'contacted', 'replied', 'no_contacts'],
          description: 'Filter by lead status. Default: all',
        },
        icp_fit: {
          type: 'string',
          enum: ['all', 'HIGH', 'MEDIUM', 'LOW'],
          description: 'Filter by ICP fit. Default: all',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 20, max 100)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, return only the count — not the rows',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_pipeline',
    description:
      'Get outreach pipeline data — contacted leads, email history, reply status, follow-ups.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'contacted', 'replied'],
          description: 'Filter pipeline by lead status',
        },
        limit: {
          type: 'number',
          description: 'Max rows (default 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_outreach_log',
    description:
      'Query the outreach log for email send history, follow-ups, replies, bounce info.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'Filter by website/domain',
        },
        contact_email: {
          type: 'string',
          description: 'Filter by contact email',
        },
        has_reply: {
          type: 'boolean',
          description: 'If true, only show rows with replies',
        },
        limit: {
          type: 'number',
          description: 'Max rows (default 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_contacts',
    description:
      'Search the contact database (509k+ contacts) by domain, name, title, or email.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to search (e.g. "nike.com")',
        },
        name: {
          type: 'string',
          description: 'Contact name to search',
        },
        title: {
          type: 'string',
          description: 'Job title to search',
        },
        email: {
          type: 'string',
          description: 'Email to search',
        },
        limit: {
          type: 'number',
          description: 'Max rows (default 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_stats',
    description:
      'Get summary statistics: total leads, leads by status, leads by ICP fit, emails sent today, replies, etc.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_lead',
    description: 'Add a single lead by website URL.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'The website domain to add (e.g. "example.com")',
        },
      },
      required: ['website'],
    },
  },
  {
    name: 'bulk_add_leads',
    description: 'Add multiple leads at once. Deduplicates against existing leads.',
    input_schema: {
      type: 'object',
      properties: {
        websites: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of website domains to add',
        },
      },
      required: ['websites'],
    },
  },
  {
    name: 'enrich_lead',
    description:
      'Trigger AI enrichment for a lead. Uses the enrichment waterfall: StoreLeads → Apollo → Claude AI.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'The website of the lead to enrich',
        },
      },
      required: ['website'],
    },
  },
  {
    name: 'find_contacts',
    description:
      'Find contacts for a lead from the contact database. Falls back to Apollo API if none found.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'The website/domain to find contacts for',
        },
      },
      required: ['website'],
    },
  },
  {
    name: 'generate_email',
    description:
      'Generate a personalized outreach email for a lead + contact using Claude AI and ICP context.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'The lead website to write about',
        },
        contact_name: {
          type: 'string',
          description: 'The contact first name to address',
        },
      },
      required: ['website', 'contact_name'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send an email via Gmail API. Verifies the address first, logs to outreach_log, and marks the lead as contacted.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          description: 'Email body text',
        },
        website: {
          type: 'string',
          description: 'The lead website (for logging)',
        },
        contact_name: {
          type: 'string',
          description: 'The contact name (for logging)',
        },
      },
      required: ['to', 'subject', 'body', 'website'],
    },
  },
  {
    name: 'get_agent_status',
    description:
      'Get the current agent automation settings and status — whether it is enabled, its sending limits, schedule, etc.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_agent_settings',
    description:
      'Update agent automation settings like enabling/disabling, send limits, schedule.',
    input_schema: {
      type: 'object',
      properties: {
        agent_enabled: {
          type: 'boolean',
          description: 'Enable or disable the agent',
        },
        daily_email_limit: {
          type: 'number',
          description: 'Max emails per day',
        },
        auto_send: {
          type: 'boolean',
          description: 'Auto-send emails or save as drafts',
        },
        min_minutes_between_emails: {
          type: 'number',
          description: 'Minimum gap between emails in minutes',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_activity_log',
    description: 'Get recent activity log entries (enrichments, sends, replies, errors).',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max entries (default 20)',
        },
        activity_type: {
          type: 'string',
          description: 'Filter by type: email_sent, enrichment, reply_detected, bounce, etc.',
        },
      },
      required: [],
    },
  },
  {
    name: 'delete_lead',
    description:
      'Delete a lead by website. Also removes its contacts, emails, and outreach history (cascade). Always confirm with the user before deleting.',
    input_schema: {
      type: 'object',
      properties: {
        website: {
          type: 'string',
          description: 'The website of the lead to delete (e.g. "example.com")',
        },
      },
      required: ['website'],
    },
  },
];

// ── Tool execution ───────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'query_leads': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('leads').select('*', { count: 'exact' });

      if (input.search) {
        query = query.or(
          `website.ilike.%${input.search}%,research_notes.ilike.%${input.search}%,industry.ilike.%${input.search}%`
        );
      }
      if (input.status && input.status !== 'all') query = query.eq('status', input.status);
      if (input.icp_fit && input.icp_fit !== 'all') query = query.eq('icp_fit', input.icp_fit);

      if (input.count_only) {
        const { count, error } = await query;
        if (error) return { error: error.message };
        return { count };
      }

      query = query.order('created_at', { ascending: false }).limit(limit);
      const { data, error, count } = await query;
      if (error) return { error: error.message };
      return { leads: data, total_count: count };
    }

    case 'query_pipeline': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .in('status', input.status === 'replied' ? ['replied'] : ['contacted', 'replied']);

      query = query.order('updated_at', { ascending: false }).limit(limit);
      const { data, error, count } = await query;
      if (error) return { error: error.message };
      return { leads: data, total_count: count };
    }

    case 'query_outreach_log': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('outreach_log').select('*');

      if (input.website) query = query.ilike('website', `%${input.website}%`);
      if (input.contact_email) query = query.ilike('contact_email', `%${input.contact_email}%`);
      if (input.has_reply) query = query.not('replied_at', 'is', null);

      query = query.order('sent_at', { ascending: false }).limit(limit);
      const { data, error } = await query;
      if (error) return { error: error.message };
      return { outreach: data };
    }

    case 'query_contacts': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('contact_database').select('*');
      const filters = [];

      if (input.domain) {
        const d = input.domain.replace(/^www\./, '');
        filters.push(`website.ilike.%${d}%,email_domain.ilike.%${d}%`);
      }
      if (input.name)
        filters.push(
          `first_name.ilike.%${input.name}%,last_name.ilike.%${input.name}%`
        );
      if (input.title) filters.push(`title.ilike.%${input.title}%`);
      if (input.email) filters.push(`email.ilike.%${input.email}%`);

      if (filters.length) query = query.or(filters.join(','));

      query = query.limit(limit);
      const { data, error } = await query;
      if (error) return { error: error.message };
      return { contacts: data, count: data?.length || 0 };
    }

    case 'get_stats': {
      // Use individual count queries to avoid Supabase's default 1000-row limit
      const [
        total,
        statusNew,
        statusEnriched,
        statusContacted,
        statusReplied,
        statusNoContacts,
        icpHigh,
        icpMedium,
        icpLow,
        outreachAll,
        outreachRecent,
        outreachReplies,
      ] = await Promise.all([
        supabase.from('leads').select('*', { count: 'exact', head: true }),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'enriched'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'contacted'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'replied'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'no_contacts'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'HIGH'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'MEDIUM'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'LOW'),
        // outreach_log is the primary source — send-email.js writes here
        supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true }),
        supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .gte('sent_at', new Date(Date.now() - 7 * 86400000).toISOString()),
        supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .not('replied_at', 'is', null),
      ]);

      const statusCounts = {};
      if (statusNew.count) statusCounts.new = statusNew.count;
      if (statusEnriched.count) statusCounts.enriched = statusEnriched.count;
      if (statusContacted.count) statusCounts.contacted = statusContacted.count;
      if (statusReplied.count) statusCounts.replied = statusReplied.count;
      if (statusNoContacts.count) statusCounts.no_contacts = statusNoContacts.count;

      const icpCounts = {};
      if (icpHigh.count) icpCounts.HIGH = icpHigh.count;
      if (icpMedium.count) icpCounts.MEDIUM = icpMedium.count;
      if (icpLow.count) icpCounts.LOW = icpLow.count;

      return {
        total_leads: total.count || 0,
        by_status: statusCounts,
        by_icp_fit: icpCounts,
        emails_sent_all_time: outreachAll.count || 0,
        emails_sent_last_7_days: outreachRecent.count || 0,
        total_replies: outreachReplies.count || 0,
      };
    }

    case 'add_lead': {
      const { data, error } = await supabase
        .from('leads')
        .insert([{ website: input.website.trim(), source: 'chat', status: 'new' }])
        .select();
      if (error) {
        if (error.code === '23505') return { error: 'This website already exists.' };
        return { error: error.message };
      }
      return { success: true, lead: data?.[0] };
    }

    case 'bulk_add_leads': {
      const websites = (input.websites || []).map((w) => w.trim()).filter(Boolean);
      if (!websites.length) return { error: 'No websites provided' };

      // Check existing
      const existingSet = new Set();
      for (let i = 0; i < websites.length; i += 200) {
        const batch = websites.slice(i, i + 200);
        const { data } = await supabase.from('leads').select('website').in('website', batch);
        (data || []).forEach((l) => existingSet.add(l.website));
      }

      const newRows = websites
        .filter((w) => !existingSet.has(w))
        .map((w) => ({ website: w, source: 'chat', status: 'new' }));

      if (!newRows.length) return { added: 0, skipped: websites.length, message: 'All already exist' };

      let added = 0;
      for (let i = 0; i < newRows.length; i += 100) {
        const batch = newRows.slice(i, i + 100);
        const { error } = await supabase.from('leads').insert(batch);
        if (!error) added += batch.length;
      }
      return { added, skipped: websites.length - added };
    }

    case 'enrich_lead': {
      // We call the existing enrichment functions via their Netlify endpoints
      const website = input.website.trim();

      // Step 1: Try StoreLeads
      try {
        const slRes = await fetch(
          `https://${process.env.URL || 'localhost:8888'}/.netlify/functions/storeleads-single?domain=${encodeURIComponent(website)}`
        );
        if (slRes.ok) {
          const slData = await slRes.json();
          if (slData && slData.store) {
            return {
              success: true,
              source: 'storeleads',
              message: `Enriched ${website} via StoreLeads`,
              data: slData.store,
            };
          }
        }
      } catch (e) {
        /* fall through */
      }

      // Step 2: Try Apollo
      try {
        const apRes = await fetch(
          `https://${process.env.URL || 'localhost:8888'}/.netlify/functions/apollo-enrich-single`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: website }),
          }
        );
        if (apRes.ok) {
          const apData = await apRes.json();
          if (apData && apData.organization) {
            return {
              success: true,
              source: 'apollo',
              message: `Enriched ${website} via Apollo`,
              data: apData.organization,
            };
          }
        }
      } catch (e) {
        /* fall through */
      }

      return {
        success: false,
        message: `Could not enrich ${website} via StoreLeads or Apollo. Try manual enrichment from the Enrich tab.`,
      };
    }

    case 'find_contacts': {
      const domain = input.website.toLowerCase().replace(/^www\./, '');
      const { data, error } = await supabase
        .from('contact_database')
        .select('*')
        .or(`website.ilike.%${domain}%,email_domain.ilike.%${domain}%`)
        .limit(20);

      if (error) return { error: error.message };

      if (data && data.length > 0) {
        const contacts = data.map((c) => ({
          name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          title: c.title,
          email: c.email,
          linkedin: c.linkedin_url,
        }));
        return { contacts, source: 'database' };
      }

      // Try Apollo fallback
      try {
        const res = await fetch(
          `https://${process.env.URL || 'localhost:8888'}/.netlify/functions/apollo-find-contacts`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
          }
        );
        const apData = await res.json();
        if (res.ok && apData.contacts?.length) {
          return {
            contacts: apData.contacts,
            source: 'apollo',
            message: `Found ${apData.contacts.length} contacts via Apollo`,
          };
        }
      } catch (e) {
        /* fall through */
      }

      return { contacts: [], message: 'No contacts found' };
    }

    case 'generate_email': {
      const { data: leadData } = await supabase
        .from('leads')
        .select('*')
        .ilike('website', `%${input.website}%`)
        .limit(1)
        .single();

      if (!leadData) return { error: `Lead not found for ${input.website}` };

      // Load ICP profile for email context
      const { data: icpData } = await supabase
        .from('icp_profiles')
        .select('*')
        .eq('is_active', true)
        .limit(1)
        .single();

      const ctx = icpData || {};
      const firstName = input.contact_name?.split(' ')[0] || 'there';
      const senderName = ctx.sender_name || 'Team';
      const senderUrl = ctx.sender_url || '';
      const sigLine = [senderName, senderUrl].filter(Boolean).join('\n');

      const systemPrompt = `You are an SDR writing outreach emails. Under 90 words, casual tone.
${ctx.elevator_pitch ? `\nWHAT WE DO:\n${ctx.elevator_pitch}` : ''}
${ctx.core_problem ? `\nCORE PROBLEM:\n${ctx.core_problem}` : ''}
${ctx.social_proof ? `\nSOCIAL PROOF:\n${ctx.social_proof}` : ''}
${ctx.email_tone ? `\nTONE: ${ctx.email_tone}` : 'TONE: Conversational, direct, no fluff.'}
SIGNATURE: Always end with:\n${sigLine}`;

      const prompt = `Write a casual outreach email for ${leadData.website}.
Contact name: "${firstName}" — address as "Hey ${firstName} -"
${leadData.industry ? `Industry: ${leadData.industry}` : ''}
${leadData.research_notes ? `Context: ${leadData.research_notes.substring(0, 300)}` : ''}
${leadData.pain_points ? `Pain Points: ${leadData.pain_points}` : ''}

Format:
Subject: [subject]

[body]`;

      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        return { email: text, lead: { website: leadData.website, industry: leadData.industry } };
      } catch (e) {
        return { error: `Email generation failed: ${e.message}` };
      }
    }

    case 'send_email': {
      // Find or create lead ID
      const { data: leadRow } = await supabase
        .from('leads')
        .select('id')
        .ilike('website', `%${input.website}%`)
        .limit(1)
        .single();

      const payload = {
        to: input.to,
        subject: input.subject,
        body: input.body,
        leadId: leadRow?.id || null,
        website: input.website,
        contactDetails: input.contact_name
          ? [{ name: input.contact_name, email: input.to }]
          : [],
      };

      try {
        const baseUrl = process.env.URL || 'localhost:8888';
        const res = await fetch(`https://${baseUrl}/.netlify/functions/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const resData = await res.json();
        if (!res.ok) return { error: resData.error || 'Send failed' };
        return { success: true, messageId: resData.messageId, recipients: resData.recipients };
      } catch (e) {
        return { error: `Send failed: ${e.message}` };
      }
    }

    case 'get_agent_status': {
      const { data, error } = await supabase
        .from('agent_settings')
        .select('*')
        .limit(1)
        .single();
      if (error) return { error: error.message };
      return { settings: data };
    }

    case 'update_agent_settings': {
      const updates = {};
      if (input.agent_enabled !== undefined) updates.agent_enabled = input.agent_enabled;
      if (input.daily_email_limit !== undefined) updates.daily_email_limit = input.daily_email_limit;
      if (input.auto_send !== undefined) updates.auto_send = input.auto_send;
      if (input.min_minutes_between_emails !== undefined)
        updates.min_minutes_between_emails = input.min_minutes_between_emails;

      if (!Object.keys(updates).length) return { error: 'No settings to update' };

      updates.updated_at = new Date().toISOString();

      const { data: existing } = await supabase
        .from('agent_settings')
        .select('id')
        .limit(1)
        .single();

      if (!existing) return { error: 'No agent_settings row found' };

      const { error } = await supabase
        .from('agent_settings')
        .update(updates)
        .eq('id', existing.id);

      if (error) return { error: error.message };
      return { success: true, updated: updates };
    }

    case 'get_activity_log': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('activity_log').select('*');
      if (input.activity_type) query = query.eq('activity_type', input.activity_type);
      query = query.order('created_at', { ascending: false }).limit(limit);

      const { data, error } = await query;
      if (error) return { error: error.message };
      return { activities: data };
    }

    case 'delete_lead': {
      const website = input.website.trim();
      const { data: lead } = await supabase
        .from('leads')
        .select('id, website, status')
        .ilike('website', `%${website}%`)
        .limit(1)
        .single();

      if (!lead) return { error: `No lead found matching "${website}"` };

      const { error } = await supabase.from('leads').delete().eq('id', lead.id);
      if (error) return { error: error.message };
      return { success: true, message: `Deleted lead ${lead.website} and all associated data.` };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the AI assistant for an SDR (Sales Development Representative) automation platform. You help users manage their outreach pipeline.

You have access to tools that let you:
- Query and search leads, contacts, outreach history, and pipeline data
- Add new leads (single or bulk)
- Enrich leads with company data (StoreLeads → Apollo → Claude AI waterfall)
- Find contacts at a company
- Generate personalized outreach emails
- Send emails via Gmail
- Check and update agent automation settings
- View activity logs

GUIDELINES:
- Be concise and direct. Users are busy salespeople.
- When showing data, format it clearly with key fields — don't dump raw JSON.
- When asked about counts or stats, use the count_only flag or get_stats tool.
- For actions like sending emails, always confirm the details with the user before executing.
- If a user asks you to do something you can't do with your tools, say so and suggest using the relevant tab in the UI.
- When listing leads or contacts, highlight the most important fields: website, ICP fit, status, contact name, title, email.
- Use markdown formatting for readability.`;

// ── Main handler ─────────────────────────────────────────────────────────────
// Two modes:
//   { messages }    → Single Claude API call, returns response (may include tool_use blocks)
//   { tool_calls }  → Execute tools server-side, return results
// The agentic loop lives in the frontend (ChatPanel.jsx) to avoid Netlify's 26s timeout.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);

    // ── Mode: Execute tool calls ──────────────────────────────────────────
    if (body.tool_calls) {
      const results = [];
      for (const call of body.tool_calls) {
        console.log(`Tool call: ${call.name}`, JSON.stringify(call.input));
        const result = await executeTool(call.name, call.input);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ tool_results: results }),
      };
    }

    // ── Mode: Single Claude API call ──────────────────────────────────────
    const { messages } = body;

    if (!messages || !messages.length) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Messages array is required' }),
      };
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 25_000,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Extract text content
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    // Extract tool calls for the frontend to execute
    const toolCalls = response.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        role: 'assistant',
        content: text,
        raw_content: response.content,
        tool_calls: toolCalls,
        stop_reason: response.stop_reason,
      }),
    };
  } catch (error) {
    console.error('Chat error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Chat request failed' }),
    };
  }
};
