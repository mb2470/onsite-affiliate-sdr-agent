#!/usr/bin/env node

/**
 * MCP Server for AI SDR Agent
 * Provides Claude with tools to interact with Supabase database and agent
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const server = new Server(
  {
    name: 'ai-sdr-agent',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool: Get leads with filters
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_leads',
        description: 'Query leads from the database with optional filters (status, ICP fit, enrichment status, search)',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: new, enriched, contacted, qualified, etc.',
            },
            icp_fit: {
              type: 'string',
              description: 'Filter by ICP fit: HIGH, MEDIUM, LOW',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default 50)',
              default: 50,
            },
            search: {
              type: 'string',
              description: 'Search websites containing this term',
            },
          },
        },
      },
      {
        name: 'get_lead_details',
        description: 'Get full details for a specific lead including research notes, contacts, and emails',
        inputSchema: {
          type: 'object',
          properties: {
            website: {
              type: 'string',
              description: 'Website domain of the lead',
            },
          },
          required: ['website'],
        },
      },
      {
        name: 'get_contacts',
        description: 'Get contacts for a specific lead or all contacts with filters',
        inputSchema: {
          type: 'object',
          properties: {
            lead_website: {
              type: 'string',
              description: 'Filter contacts by lead website',
            },
            min_score: {
              type: 'number',
              description: 'Minimum match score (0-200)',
            },
            limit: {
              type: 'number',
              description: 'Maximum results',
              default: 50,
            },
          },
        },
      },
      {
        name: 'get_emails',
        description: 'Get drafted or sent emails with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: draft, sent, failed',
            },
            lead_website: {
              type: 'string',
              description: 'Filter by lead website',
            },
            limit: {
              type: 'number',
              default: 20,
            },
          },
        },
      },
      {
        name: 'get_agent_settings',
        description: 'Get current agent configuration and settings',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'update_agent_settings',
        description: 'Update agent configuration (enable/disable, limits, filters, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            agent_enabled: {
              type: 'boolean',
              description: 'Enable or disable the agent',
            },
            auto_send: {
              type: 'boolean',
              description: 'Enable auto-send or require manual approval',
            },
            max_emails_per_day: {
              type: 'number',
              description: 'Maximum emails to send per day',
            },
            min_minutes_between_emails: {
              type: 'number',
              description: 'Minimum minutes between sending emails',
            },
            allowed_icp_fits: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of allowed ICP fits: ["HIGH", "MEDIUM", "LOW"]',
            },
            max_contacts_per_lead: {
              type: 'number',
              description: 'Maximum contacts to process per lead',
            },
          },
        },
      },
      {
        name: 'get_activity_log',
        description: 'Get recent agent activity and actions',
        inputSchema: {
          type: 'object',
          properties: {
            activity_type: {
              type: 'string',
              description: 'Filter by type: lead_enriched, contacts_found, email_drafted, email_sent',
            },
            status: {
              type: 'string',
              description: 'Filter by status: success, failed',
            },
            limit: {
              type: 'number',
              default: 50,
            },
          },
        },
      },
      {
        name: 'get_pipeline_stats',
        description: 'Get pipeline statistics and metrics',
        inputSchema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date for stats (YYYY-MM-DD), defaults to today',
            },
          },
        },
      },
      {
        name: 'search_pipeline',
        description: 'Search across leads, contacts, and emails with natural language query',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (e.g., "high ICP leads not yet contacted", "failed emails")',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'update_lead',
        description: 'Update a lead\'s status, ICP fit, or notes',
        inputSchema: {
          type: 'object',
          properties: {
            website: {
              type: 'string',
              description: 'Website domain of the lead',
            },
            status: {
              type: 'string',
              description: 'New status',
            },
            icp_fit: {
              type: 'string',
              description: 'New ICP fit: HIGH, MEDIUM, LOW',
            },
            research_notes: {
              type: 'string',
              description: 'Updated research notes',
            },
          },
          required: ['website'],
        },
      },
    ],
  };
});

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_leads': {
        let query = supabase.from('leads').select('*');
        
        if (args.status) {
          query = query.eq('status', args.status);
        }
        if (args.icp_fit) {
          query = query.eq('icp_fit', args.icp_fit);
        }
        if (args.search) {
          query = query.ilike('website', `%${args.search}%`);
        }
        
        query = query.order('created_at', { ascending: false }).limit(args.limit || 50);
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: data.length,
                leads: data,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_lead_details': {
        const { data: lead, error: leadError } = await supabase
          .from('leads')
          .select('*')
          .eq('website', args.website)
          .single();
        
        if (leadError) throw leadError;
        
        const { data: contacts } = await supabase
          .from('contacts')
          .select('*')
          .eq('lead_id', lead.id);
        
        const { data: emails } = await supabase
          .from('emails')
          .select('*')
          .eq('lead_id', lead.id);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                lead,
                contacts: contacts || [],
                emails: emails || [],
              }, null, 2),
            },
          ],
        };
      }

      case 'get_contacts': {
        let query = supabase.from('contacts').select('*, leads(website)');
        
        if (args.lead_website) {
          const { data: lead } = await supabase
            .from('leads')
            .select('id')
            .eq('website', args.lead_website)
            .single();
          
          if (lead) {
            query = query.eq('lead_id', lead.id);
          }
        }
        
        if (args.min_score) {
          query = query.gte('match_score', args.min_score);
        }
        
        query = query.limit(args.limit || 50);
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: data.length, contacts: data }, null, 2),
            },
          ],
        };
      }

      case 'get_emails': {
        let query = supabase.from('emails').select('*, leads(website), contacts(full_name, email)');
        
        if (args.status) {
          query = query.eq('status', args.status);
        }
        
        if (args.lead_website) {
          const { data: lead } = await supabase
            .from('leads')
            .select('id')
            .eq('website', args.lead_website)
            .single();
          
          if (lead) {
            query = query.eq('lead_id', lead.id);
          }
        }
        
        query = query.order('created_at', { ascending: false }).limit(args.limit || 20);
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: data.length, emails: data }, null, 2),
            },
          ],
        };
      }

      case 'get_agent_settings': {
        const { data, error } = await supabase
          .from('agent_settings')
          .select('*')
          .single();
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'update_agent_settings': {
        const updates = {};
        
        if (args.agent_enabled !== undefined) updates.agent_enabled = args.agent_enabled;
        if (args.auto_send !== undefined) updates.auto_send = args.auto_send;
        if (args.max_emails_per_day) updates.max_emails_per_day = args.max_emails_per_day;
        if (args.min_minutes_between_emails) updates.min_minutes_between_emails = args.min_minutes_between_emails;
        if (args.allowed_icp_fits) updates.allowed_icp_fits = args.allowed_icp_fits;
        if (args.max_contacts_per_lead) updates.max_contacts_per_lead = args.max_contacts_per_lead;
        
        const { data, error } = await supabase
          .from('agent_settings')
          .update(updates)
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .select()
          .single();
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Agent settings updated:\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      }

      case 'get_activity_log': {
        let query = supabase.from('activity_log').select('*, leads(website)');
        
        if (args.activity_type) {
          query = query.eq('activity_type', args.activity_type);
        }
        if (args.status) {
          query = query.eq('status', args.status);
        }
        
        query = query.order('created_at', { ascending: false }).limit(args.limit || 50);
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: data.length, activities: data }, null, 2),
            },
          ],
        };
      }

      case 'get_pipeline_stats': {
        const date = args.date || new Date().toISOString().split('T')[0];
        
        const { data: dailyStats } = await supabase
          .from('daily_stats')
          .select('*')
          .eq('date', date)
          .single();
        
        const { data: leads, count: totalLeads } = await supabase
          .from('leads')
          .select('status, icp_fit', { count: 'exact' });
        
        const statusCounts = {};
        const icpCounts = {};
        
        leads?.forEach(lead => {
          statusCounts[lead.status] = (statusCounts[lead.status] || 0) + 1;
          if (lead.icp_fit) {
            icpCounts[lead.icp_fit] = (icpCounts[lead.icp_fit] || 0) + 1;
          }
        });
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                date,
                daily_stats: dailyStats || {},
                total_leads: totalLeads,
                by_status: statusCounts,
                by_icp_fit: icpCounts,
              }, null, 2),
            },
          ],
        };
      }

      case 'search_pipeline': {
        // Intelligent search based on query
        const query = args.query.toLowerCase();
        let results = {};
        
        // Search leads
        if (query.includes('lead') || query.includes('high') || query.includes('medium') || query.includes('low')) {
          const { data: leads } = await supabase
            .from('leads')
            .select('*')
            .limit(20);
          results.leads = leads;
        }
        
        // Search for specific statuses
        if (query.includes('contacted') || query.includes('enriched') || query.includes('qualified')) {
          const status = query.includes('contacted') ? 'contacted' : 
                        query.includes('enriched') ? 'enriched' : 'qualified';
          const { data } = await supabase
            .from('leads')
            .select('*')
            .eq('status', status)
            .limit(20);
          results[`${status}_leads`] = data;
        }
        
        // Search for failed items
        if (query.includes('failed')) {
          const { data } = await supabase
            .from('activity_log')
            .select('*')
            .eq('status', 'failed')
            .order('created_at', { ascending: false })
            .limit(10);
          results.failures = data;
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'update_lead': {
        const updates = {};
        
        if (args.status) updates.status = args.status;
        if (args.icp_fit) updates.icp_fit = args.icp_fit;
        if (args.research_notes) updates.research_notes = args.research_notes;
        
        const { data, error } = await supabase
          .from('leads')
          .update(updates)
          .eq('website', args.website)
          .select()
          .single();
        
        if (error) throw error;
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Lead updated:\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AI SDR Agent MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
