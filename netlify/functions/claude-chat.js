const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs/promises');
const path = require('path');

// Use service role key (bypasses RLS) for server-side function,
// falling back to anon key if not set.
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  supabaseAnonKey;

const supabase = createClient(
  supabaseUrl,
  supabaseKey
);

function getBearerToken(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim() || null;
}

async function resolveAuthorizedOrgId(userId, requestedOrgId) {
  if (!requestedOrgId) return null;

  const { data, error } = await supabase
    .from('user_organizations')
    .select('org_id')
    .eq('user_id', userId)
    .eq('org_id', requestedOrgId)
    .limit(1)
    .single();

  if (error || !data?.org_id) {
    throw new Error('Authenticated user is not a member of the specified org_id');
  }

  return data.org_id;
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAX_FILE_SIZE_BYTES = 200_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.netlify']);

function resolveRepoPath(relativePath = '') {
  const normalized = relativePath.trim().replace(/^\/+/, '');
  const resolved = path.resolve(REPO_ROOT, normalized);

  if (!resolved.startsWith(REPO_ROOT)) {
    throw new Error('Path must remain inside repository root');
  }

  return resolved;
}

const SEARCH_TIMEOUT_MS = 8_000; // 8s — well within Netlify's 26s limit
const SEARCH_MAX_FILES = 500;    // Cap files scanned to prevent runaway walks

async function searchRepoFiles({ query, path_prefix = '', limit = 20 }) {
  const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
  const searchRoot = resolveRepoPath(path_prefix);
  const lowerQuery = query.toLowerCase();
  const matches = [];
  const startTime = Date.now();
  let filesScanned = 0;
  let timedOut = false;

  async function walk(currentDir) {
    if (matches.length >= safeLimit || timedOut) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      if (matches.length >= safeLimit) break;

      // Check timeout every iteration
      if (Date.now() - startTime > SEARCH_TIMEOUT_MS) {
        timedOut = true;
        break;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(REPO_ROOT, fullPath);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
          if (timedOut) break;
        }
        continue;
      }

      if (filesScanned >= SEARCH_MAX_FILES) {
        timedOut = true;
        break;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!['.js', '.jsx', '.ts', '.tsx', '.md', '.sql', '.json', '.toml', '.txt', '.py', '.css'].includes(extension)) {
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stats.size > MAX_FILE_SIZE_BYTES) continue;

      filesScanned++;
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          matches.push({
            path: relativePath,
            line: i + 1,
            snippet: lines[i].trim(),
          });
          if (matches.length >= safeLimit) break;
        }
      }
    }
  }

  await walk(searchRoot);
  return {
    query,
    path_prefix,
    matches,
    ...(timedOut ? { partial: true, note: `Search stopped early (${filesScanned} files scanned). Try a more specific path_prefix to narrow results.` } : {}),
  };
}

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
    name: 'repo_search',
    description:
      'Search the repository for code or documentation snippets by keyword. Use this before answering implementation questions.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword or phrase to search for',
        },
        path_prefix: {
          type: 'string',
          description: 'Optional relative folder path to constrain search (e.g. "src/services")',
        },
        limit: {
          type: 'number',
          description: 'Max number of matches to return (default 20, max 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'repo_read_file',
    description:
      'Read a repository file so you can answer feature and function questions accurately.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative file path',
        },
      },
      required: ['path'],
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
        days: {
          type: 'number',
          description: 'Only include records from the last N days',
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
    name: 'get_email_deliverability',
    description:
      'Get email deliverability stats for a date range: total sent, bounced, replied, and deliverability rate. Use this for any deliverability or bounce-rate questions.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look back (default 7)',
        },
      },
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
  {
    name: 'submit_dev_request',
    description:
      'Submit a development request (bug fix, feature, or general task) to the Claude Code agent. The assistant should first gather enough detail from the user, then draft a structured spec using the standard template, then submit it. Returns a request ID for tracking.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the dev request (e.g. "Add CSV export to leads table")',
        },
        type: {
          type: 'string',
          enum: ['bug', 'feature', 'task'],
          description: 'Type of request: bug, feature, or task',
        },
        spec: {
          type: 'string',
          description: 'Full structured spec using the standard template (Task, Business goal, Scope, Files involved, Acceptance criteria, etc.)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Priority level. Default: medium',
        },
      },
      required: ['title', 'type', 'spec'],
    },
  },
  {
    name: 'check_dev_request',
    description:
      'Check the status of a development request, or list recent dev requests. Use this when users ask about the status of their submitted tasks.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'Specific request ID to check. If omitted, returns recent requests.',
        },
        status_filter: {
          type: 'string',
          enum: ['all', 'pending', 'in_progress', 'completed', 'failed'],
          description: 'Filter by status. Default: all',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10)',
        },
      },
      required: [],
    },
  },
];

// ── Tool execution ───────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 15_000; // 15s per tool — leaves headroom within Netlify's 26s limit

function withTimeout(promise, ms, toolName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function executeToolWithTimeout(name, input, orgId, authContext = null) {
  try {
    return await withTimeout(executeTool(name, input, orgId, authContext), TOOL_TIMEOUT_MS, name);
  } catch (err) {
    console.error(`Tool timeout/error: ${name}`, err.message);
    return { error: err.message };
  }
}

async function executeTool(name, input, orgId, authContext = null) {
  switch (name) {
    case 'repo_search': {
      if (!input.query || !input.query.trim()) return { error: 'query is required' };
      try {
        return await searchRepoFiles(input);
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'repo_read_file': {
      if (!input.path || !input.path.trim()) return { error: 'path is required' };
      try {
        const fullPath = resolveRepoPath(input.path);
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) return { error: 'path must be a file' };
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          return { error: `File too large (${stats.size} bytes). Max allowed is ${MAX_FILE_SIZE_BYTES}.` };
        }
        const content = await fs.readFile(fullPath, 'utf8');
        return {
          path: input.path,
          size_bytes: stats.size,
          content,
        };
      } catch (error) {
        return { error: error.message };
      }
    }

    case 'query_leads': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('leads').select('*', { count: 'exact' });
      if (orgId) query = query.eq('org_id', orgId);

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
      if (orgId) query = query.eq('org_id', orgId);

      query = query.order('updated_at', { ascending: false }).limit(limit);
      const { data, error, count } = await query;
      if (error) return { error: error.message };
      return { leads: data, total_count: count };
    }

    case 'query_outreach_log': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('outreach_log').select('*');
      if (orgId) query = query.eq('org_id', orgId);

      if (input.website) query = query.ilike('website', `%${input.website}%`);
      if (input.contact_email) query = query.ilike('contact_email', `%${input.contact_email}%`);
      if (input.has_reply) query = query.not('replied_at', 'is', null);
      if (input.days) {
        const since = new Date(Date.now() - input.days * 86400000).toISOString();
        query = query.gte('sent_at', since);
      }

      query = query.order('sent_at', { ascending: false }).limit(limit);
      const { data, error } = await query;
      if (error) return { error: error.message };
      return { outreach: data };
    }

    case 'query_contacts': {
      const limit = Math.min(input.limit || 20, 100);
      let query = supabase.from('contact_database').select('*');
      if (orgId) query = query.eq('org_id', orgId);
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
      // All queries are scoped to org_id for multi-tenant correctness
      const leadsQuery = (extra) => {
        let q = supabase.from('leads').select('*', { count: 'exact', head: true });
        if (orgId) q = q.eq('org_id', orgId);
        return extra ? extra(q) : q;
      };
      const outreachQuery = (extra) => {
        let q = supabase.from('outreach_log').select('*', { count: 'exact', head: true });
        if (orgId) q = q.eq('org_id', orgId);
        return extra ? extra(q) : q;
      };

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
        leadsQuery(),
        leadsQuery((q) => q.eq('status', 'new')),
        leadsQuery((q) => q.eq('status', 'enriched')),
        leadsQuery((q) => q.eq('status', 'contacted')),
        leadsQuery((q) => q.eq('status', 'replied')),
        leadsQuery((q) => q.eq('status', 'no_contacts')),
        leadsQuery((q) => q.eq('icp_fit', 'HIGH')),
        leadsQuery((q) => q.eq('icp_fit', 'MEDIUM')),
        leadsQuery((q) => q.eq('icp_fit', 'LOW')),
        // outreach_log is the primary source — send-email.js writes here
        outreachQuery(),
        outreachQuery((q) => q.gte('sent_at', new Date(Date.now() - 7 * 86400000).toISOString())),
        outreachQuery((q) => q.not('replied_at', 'is', null)),
      ]);

      // "Contacted leads" = leads with status contacted OR replied (matches dashboard header)
      const contactedLeads = (statusContacted.count || 0) + (statusReplied.count || 0);

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
        contacted_leads: contactedLeads,
        by_icp_fit: icpCounts,
        emails_sent_all_time: outreachAll.count || 0,
        emails_sent_last_7_days: outreachRecent.count || 0,
        total_replies: outreachReplies.count || 0,
      };
    }

    case 'get_email_deliverability': {
      const days = input.days || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();

      const outreachQ = (extra) => {
        let q = supabase.from('outreach_log').select('*', { count: 'exact', head: true });
        if (orgId) q = q.eq('org_id', orgId);
        q = q.gte('sent_at', since);
        return extra ? extra(q) : q;
      };
      const bounceQ = () => {
        let q = supabase.from('activity_log').select('*', { count: 'exact', head: true });
        if (orgId) q = q.eq('org_id', orgId);
        q = q.eq('activity_type', 'email_bounced').gte('created_at', since);
        return q;
      };

      const [sentResult, repliedResult, bouncedResult] = await Promise.all([
        outreachQ(),
        outreachQ((q) => q.not('replied_at', 'is', null)),
        bounceQ(),
      ]);

      const sent = sentResult.count || 0;
      const bounced = bouncedResult.count || 0;
      const replied = repliedResult.count || 0;
      const delivered = sent - bounced;
      const deliverabilityRate = sent > 0 ? ((delivered / sent) * 100).toFixed(1) : 'N/A';
      const replyRate = sent > 0 ? ((replied / sent) * 100).toFixed(1) : 'N/A';

      return {
        period_days: days,
        since: since,
        total_sent: sent,
        bounced: bounced,
        delivered: delivered,
        replied: replied,
        deliverability_rate: deliverabilityRate + '%',
        reply_rate: replyRate + '%',
      };
    }

    case 'add_lead': {
      const row = { website: input.website.trim(), source: 'chat', status: 'new' };
      if (orgId) row.org_id = orgId;
      const { data, error } = await supabase
        .from('leads')
        .insert([row])
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
        let q = supabase.from('leads').select('website').in('website', batch);
        if (orgId) q = q.eq('org_id', orgId);
        const { data } = await q;
        (data || []).forEach((l) => existingSet.add(l.website));
      }

      const newRows = websites
        .filter((w) => !existingSet.has(w))
        .map((w) => {
          const row = { website: w, source: 'chat', status: 'new' };
          if (orgId) row.org_id = orgId;
          return row;
        });

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
      let fcQuery = supabase
        .from('contact_database')
        .select('*')
        .or(`website.ilike.%${domain}%,email_domain.ilike.%${domain}%`);
      if (orgId) fcQuery = fcQuery.eq('org_id', orgId);
      const { data, error } = await fcQuery.limit(20);

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
      let genLeadQ = supabase.from('leads').select('*').ilike('website', `%${input.website}%`);
      if (orgId) genLeadQ = genLeadQ.eq('org_id', orgId);
      const { data: leadData } = await genLeadQ.limit(1).single();

      if (!leadData) return { error: `Lead not found for ${input.website}` };

      // Load ICP profile for email context
      let icpQ = supabase.from('icp_profiles').select('*').eq('is_active', true);
      if (orgId) icpQ = icpQ.eq('org_id', orgId);
      const { data: icpData } = await icpQ.limit(1).single();

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
      let sendLeadQ = supabase.from('leads').select('id').ilike('website', `%${input.website}%`);
      if (orgId) sendLeadQ = sendLeadQ.eq('org_id', orgId);
      const { data: leadRow } = await sendLeadQ.limit(1).single();

      const payload = {
        to: input.to,
        subject: input.subject,
        body: input.body,
        leadId: leadRow?.id || null,
        website: input.website,
        org_id: orgId,
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
      let agentQ = supabase.from('agent_settings').select('*');
      if (orgId) agentQ = agentQ.eq('org_id', orgId);
      const { data, error } = await agentQ.limit(1).single();
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

      let existQ = supabase.from('agent_settings').select('id');
      if (orgId) existQ = existQ.eq('org_id', orgId);
      const { data: existing } = await existQ.limit(1).single();

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
      if (orgId) query = query.eq('org_id', orgId);
      if (input.activity_type) query = query.eq('activity_type', input.activity_type);
      query = query.order('created_at', { ascending: false }).limit(limit);

      const { data, error } = await query;
      if (error) return { error: error.message };
      return { activities: data };
    }

    case 'delete_lead': {
      const website = input.website.trim();
      let delQ = supabase.from('leads').select('id, website, status').ilike('website', `%${website}%`);
      if (orgId) delQ = delQ.eq('org_id', orgId);
      const { data: lead } = await delQ.limit(1).single();

      if (!lead) return { error: `No lead found matching "${website}"` };

      const { error } = await supabase.from('leads').delete().eq('id', lead.id);
      if (error) return { error: error.message };
      return { success: true, message: `Deleted lead ${lead.website} and all associated data.` };
    }

    case 'submit_dev_request': {
      if (!input.title || !input.spec) return { error: 'title and spec are required' };
      if (!authContext?.user?.id) {
        console.warn('submit_dev_request rejected: authContext is', JSON.stringify(authContext));
        return { error: 'Authentication is required to submit dev requests. Please sign out and sign back in to refresh your session.' };
      }
      if (!orgId) return { error: 'org_id is required to submit dev requests' };

      const row = {
        title: input.title.trim(),
        type: input.type || 'feature',
        spec: input.spec,
        priority: input.priority || 'medium',
        status: 'pending',
        requested_by: authContext.user.email || 'chat_assistant',
      };
      if (orgId) row.org_id = orgId;

      const { data, error } = await supabase
        .from('dev_requests')
        .insert([row])
        .select();

      if (error) return { error: error.message };

      const request = data?.[0];
      return {
        success: true,
        request_id: request?.id,
        title: request?.title,
        status: request?.status,
        message: `Dev request "${request?.title}" submitted successfully. The Claude Code agent will pick it up shortly. Track it with ID: ${request?.id}`,
      };
    }

    case 'check_dev_request': {
      if (input.request_id) {
        let q = supabase.from('dev_requests').select('*').eq('id', input.request_id);
        if (orgId) q = q.eq('org_id', orgId);
        const { data, error } = await q.limit(1).single();
        if (error) return { error: error.message };
        if (!data) return { error: 'Request not found' };
        return { request: data };
      }

      // List recent requests
      const limit = Math.min(input.limit || 10, 50);
      let q = supabase.from('dev_requests').select('id, title, type, status, priority, created_at, completed_at, branch_name, result_summary');
      if (orgId) q = q.eq('org_id', orgId);
      if (input.status_filter && input.status_filter !== 'all') {
        q = q.eq('status', input.status_filter);
      }
      q = q.order('created_at', { ascending: false }).limit(limit);

      const { data, error } = await q;
      if (error) return { error: error.message };
      return { requests: data, count: data?.length || 0 };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the AI assistant for an SDR (Sales Development Representative) automation platform. You help users manage their outreach pipeline.

You have access to tools that let you:
- Search and read repository files to answer feature/function questions with evidence
- Query and search leads, contacts, outreach history, and pipeline data
- Add new leads (single or bulk)
- Enrich leads with company data (StoreLeads → Apollo → Claude AI waterfall)
- Find contacts at a company
- Generate personalized outreach emails
- Send emails via Gmail
- Check and update agent automation settings
- View activity logs
- Submit development requests (bugs, features, tasks) to a Claude Code agent that will implement them
- Check the status of submitted dev requests

GUIDELINES:
- Be concise and direct. Users are busy salespeople.
- For repository or implementation questions, use repo_search + repo_read_file before answering and cite concrete files/functions.
- When asked to draft a spec for a new feature or bug fix, return a filled-in version of this template:

# Task
[One-paragraph description of desired change]

# Business goal
[Why this matters, what user/system outcome should improve]

# Scope
- In scope:
  - [list]
- Out of scope:
  - [list]

# Repository context
- Frontend: \`src/\` (React/Vite)
- Backend: \`netlify/functions/\` (CommonJS serverless functions)
- DB: \`supabase/\` (schema + migrations)
- Optional automation: \`agent/\` (Python)

# Constraints
- Preserve multi-tenant org isolation (\`org_id\`) across reads/writes.
- Netlify functions must keep CORS + OPTIONS handling.
- No secrets in source code.
- Frontend should use existing service layer patterns in \`src/services/\`.

# Files likely involved
- [path 1]
- [path 2]
- [path 3]

# API/data contract changes
- Request/response updates:
  - [details]
- Schema changes:
  - [details + migration requirements]

# Acceptance criteria
- [ ] Functional requirement 1
- [ ] Functional requirement 2
- [ ] Handles edge case X
- [ ] No regressions in existing flow Y

# Test plan
- Unit/integration checks:
  - [commands]
- Manual validation:
  - [steps]

# Non-functional requirements
- Performance: [target]
- Observability/logging: [required logs/metrics]
- Security/privacy: [requirements]

# Deliverables
- Code changes
- Migration (if needed)
- Short summary of changed files and rationale
- Risks + follow-up recommendations

DEV REQUESTS:
- When a user wants a bug fixed, feature built, or any code change, gather the details conversationally.
- Before submitting, draft the spec using the standard template and show it to the user for confirmation.
- Use repo_search to identify files likely involved so the spec is accurate.
- After submitting, give the user the request ID so they can check status later.
- Users can ask "check my dev requests" or "what's the status of request X" to track progress.

- When showing data, format it clearly with key fields — don't dump raw JSON.
- When asked about counts or stats, use the count_only flag or get_stats tool.
- For actions like sending emails, always confirm the details with the user before executing.
- If a user asks you to do something you can't do with your tools, say so and suggest using the relevant tab in the UI.
- When listing leads or contacts, highlight the most important fields: website, ICP fit, status, contact name, title, email.
- Use markdown formatting for readability.`;

// ── Token management ─────────────────────────────────────────────────────────
// Claude's context window is 200K tokens. We reserve budget for the system
// prompt (~2K), tool definitions (~8K), and the response (4K), leaving ~186K
// for messages. Estimate tokens as ceil(chars / 3.5) (conservative for mixed
// content including JSON tool results).

const MAX_MESSAGE_TOKENS = 160000; // conservative budget for messages

function estimateTokens(content) {
  if (!content) return 0;
  if (typeof content === 'string') return Math.ceil(content.length / 3.5);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (typeof block === 'string') return sum + Math.ceil(block.length / 3.5);
      if (block.text) return sum + Math.ceil(block.text.length / 3.5);
      if (block.content) return sum + Math.ceil(String(block.content).length / 3.5);
      // tool_use input
      if (block.input) return sum + Math.ceil(JSON.stringify(block.input).length / 3.5);
      return sum + 50; // fallback estimate for other block types
    }, 0);
  }
  // Object (e.g. tool_use block)
  return Math.ceil(JSON.stringify(content).length / 3.5);
}

/**
 * Truncate a single tool_result content string if it's excessively large.
 * Keeps first and last portions so the model still has context.
 */
function truncateToolResult(content, maxChars = 30000) {
  if (typeof content !== 'string' || content.length <= maxChars) return content;
  const keep = Math.floor(maxChars / 2);
  return (
    content.slice(0, keep) +
    `\n\n... [truncated ${content.length - maxChars} chars] ...\n\n` +
    content.slice(-keep)
  );
}

/**
 * Trim messages to fit within the token budget.
 * Strategy:
 * 1. First, truncate any oversized tool_result content blocks.
 * 2. If still over budget, drop the oldest message pairs (keeping the
 *    most recent user message intact).
 */
function trimMessages(messages) {
  // Step 1: Truncate large tool results in-place (work on a deep-ish copy)
  let trimmed = messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((block) => {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            return { ...block, content: truncateToolResult(block.content) };
          }
          return block;
        }),
      };
    }
    return m;
  });

  // Step 2: If total is still over budget, drop oldest pairs
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  while (totalTokens > MAX_MESSAGE_TOKENS && trimmed.length > 2) {
    // Remove the oldest message (index 0)
    const removed = trimmed.shift();
    totalTokens -= estimateTokens(removed.content);

    // If the new first message is a 'user' tool_result (orphaned), also remove it
    // to maintain valid message alternation
    if (
      trimmed.length > 1 &&
      trimmed[0].role === 'user' &&
      Array.isArray(trimmed[0].content) &&
      trimmed[0].content.every((b) => b.type === 'tool_result')
    ) {
      const removed2 = trimmed.shift();
      totalTokens -= estimateTokens(removed2.content);
    }
  }

  // Ensure first message is from user (API requirement)
  while (trimmed.length > 0 && trimmed[0].role !== 'user') {
    const removed = trimmed.shift();
    totalTokens -= estimateTokens(removed.content);
  }

  console.log(`Token estimate: ~${totalTokens} tokens in ${trimmed.length} messages`);
  return trimmed;
}

// ── Main handler ─────────────────────────────────────────────────────────────
// Two modes:
//   { messages }    → Single Claude API call, returns response (may include tool_use blocks)
//   { tool_calls }  → Execute tools server-side, return results
// The agentic loop lives in the frontend (ChatPanel.jsx) to avoid Netlify's 26s timeout.

const { corsHeaders } = require('./lib/cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const token = getBearerToken(event.headers || {});
    let authContext = null;
    if (token) {
      // Use anon-key client for JWT validation (service-role client can
      // behave differently with auth.getUser and may silently fail).
      const authClient = createClient(supabaseUrl, supabaseAnonKey || supabaseKey);
      const { data: authData, error: authError } = await authClient.auth.getUser(token);
      if (authError) {
        console.warn('Auth token validation failed:', authError.message);
      }
      if (!authError && authData?.user?.id) {
        authContext = { user: authData.user };
        console.log('Auth context established for user:', authData.user.id);
      }
    } else {
      console.log('No bearer token in request headers');
    }

    let orgId = body.org_id || null;
    if (orgId && authContext?.user?.id) {
      orgId = await resolveAuthorizedOrgId(authContext.user.id, orgId);
    }

    // ── Mode: Execute tool calls ──────────────────────────────────────────
    if (body.tool_calls) {
      // Execute all tool calls in parallel to avoid sequential timeout accumulation
      const promises = body.tool_calls.map(async (call) => {
        console.log(`Tool call: ${call.name}`, JSON.stringify(call.input));
        const result = await executeToolWithTimeout(call.name, call.input, orgId, authContext);
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
        };
      });
      const results = await Promise.all(promises);
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

    const safeMsgs = trimMessages(messages);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: safeMsgs,
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
