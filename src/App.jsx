import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import { createClient } from '@supabase/supabase-js';
import AgentMonitor from './AgentMonitor'; 
import { supabase } from './supabaseClient';

function App() {
  const [activeView, setActiveView] = useState('add');
  const [leads, setLeads] = useState([]);
  const [totalLeadCount, setTotalLeadCount] = useState(0);
  const [isLoadingLeads, setIsLoadingLeads] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [newWebsite, setNewWebsite] = useState('');
  const [bulkWebsites, setBulkWebsites] = useState('');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [isEnriching, setIsEnriching] = useState(false);
  const [agentSettings, setAgentSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Enrich page - server-side search/filter state
  const [enrichSearchTerm, setEnrichSearchTerm] = useState('');
  const [enrichFilterStatus, setEnrichFilterStatus] = useState('all');
  const [enrichFilterICP, setEnrichFilterICP] = useState('all');
  const [enrichFilterCountry, setEnrichFilterCountry] = useState('all');
  const [enrichPage, setEnrichPage] = useState(0);
  const [enrichLeads, setEnrichLeads] = useState([]);
  const [enrichTotalCount, setEnrichTotalCount] = useState(0);
  const [isLoadingEnrich, setIsLoadingEnrich] = useState(false);
  const ENRICH_PAGE_SIZE = 100;
  const searchTimerRef = useRef(null);

  // Manual outreach state
  const [selectedLeadForManual, setSelectedLeadForManual] = useState(null);
  const [manualEmail, setManualEmail] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [manualContacts, setManualContacts] = useState([]);
  const [isLoadingManualContacts, setIsLoadingManualContacts] = useState(false);
  const [selectedManualContacts, setSelectedManualContacts] = useState([]);

  // Load data on mount
  useEffect(() => {
    loadLeads();
    loadAgentSettings();
    loadStats();
    loadActivity();
  }, []);

  // Load lead count (lightweight - no full data download)
  const loadLeads = async () => {
    setIsLoadingLeads(true);
    try {
      const { count, error } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true });

      if (error) throw error;
      setTotalLeadCount(count || 0);
      
      // Also load a small set for other views that need leads (manual outreach dropdown, etc.)
      const { data } = await supabase
        .from('leads')
        .select('*')
        .in('status', ['enriched', 'contacted'])
        .order('created_at', { ascending: false })
        .limit(500);
      
      setLeads(data || []);
    } catch (error) {
      console.error('💥 Error loading leads:', error);
      alert('Failed to load leads: ' + error.message);
    } finally {
      setIsLoadingLeads(false);
    }
  };

  // Server-side search for Enrich page
  const searchEnrichLeads = async (search, status, icp, country, page) => {
    setIsLoadingEnrich(true);
    try {
      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' });

      // Text search
      if (search && search.trim()) {
        query = query.or(
          `website.ilike.%${search.trim()}%,research_notes.ilike.%${search.trim()}%`
        );
      }

      // Status filter
      if (status !== 'all') {
        query = query.eq('status', status);
      }

      // ICP filter
      if (icp !== 'all') {
        query = query.eq('icp_fit', icp);
      }

      // Country filter
      if (country !== 'all') {
        if (country === 'US/CA') {
          query = query.in('country', ['US (assumed)', 'US', 'Canada']);
        } else if (country === 'International') {
          query = query.not('country', 'in', '("US (assumed)","US","Canada","Unknown")');
          query = query.not('country', 'is', null);
        } else if (country === 'Unknown') {
          query = query.or('country.is.null,country.eq.Unknown');
        } else {
          query = query.eq('country', country);
        }
      }

      // Pagination
      const from = page * ENRICH_PAGE_SIZE;
      const to = from + ENRICH_PAGE_SIZE - 1;

      query = query
        .order('created_at', { ascending: false })
        .range(from, to);

      const { data, error, count } = await query;

      if (error) throw error;

      setEnrichLeads(data || []);
      setEnrichTotalCount(count || 0);
    } catch (error) {
      console.error('❌ Error searching leads:', error);
    } finally {
      setIsLoadingEnrich(false);
    }
  };

  // Debounced search - waits 400ms after typing stops
  const debouncedEnrichSearch = (search, status, icp, country) => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      searchEnrichLeads(search, status, icp, country, 0);
      setEnrichPage(0);
    }, 400);
  };

  // Load enrich leads when filters change (non-search filters are immediate)
  useEffect(() => {
    searchEnrichLeads(enrichSearchTerm, enrichFilterStatus, enrichFilterICP, enrichFilterCountry, enrichPage);
  }, [enrichFilterStatus, enrichFilterICP, enrichFilterCountry, enrichPage]);

  // Load enrich leads on first mount
  useEffect(() => {
    searchEnrichLeads('', 'all', 'all', 'all', 0);
  }, []);

  // Load agent settings
  const loadAgentSettings = async () => {
    try {
      const { data } = await supabase
        .from('agent_settings')
        .select('*')
        .single();
      setAgentSettings(data);
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  };

  // Load stats
  const loadStats = async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('date', today)
        .maybeSingle();
      setStats(data || {
        leads_enriched: 0,
        contacts_found: 0,
        emails_drafted: 0,
        emails_sent: 0
      });
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  };

  // Load activity
  const loadActivity = async () => {
    try {
      const { data } = await supabase
        .from('activity_log')
        .select('*, leads(website)')
        .order('created_at', { ascending: false })
        .limit(50);
      setActivityLog(data || []);
    } catch (error) {
      console.error('Error loading activity:', error);
    }
  };

  // Add single website
  const addSingleWebsite = async () => {
    if (!newWebsite.trim()) return;

    try {
      const { data, error } = await supabase
        .from('leads')
        .insert([{ website: newWebsite.trim(), source: 'manual', status: 'new' }])
        .select();

      if (error) {
        if (error.code === '23505') {
          alert('This website already exists!');
        } else {
          throw error;
        }
        return;
      }

      setNewWebsite('');
      await loadLeads();
      alert('✅ Lead added successfully!');
    } catch (error) {
      console.error('Error adding lead:', error);
      alert('Failed to add lead: ' + error.message);
    }
  };

  // Bulk add websites
  const bulkAddWebsites = async () => {
    if (!bulkWebsites.trim()) return;

    const websites = bulkWebsites
      .split('\n')
      .map(w => w.trim())
      .filter(w => w);

    if (websites.length === 0) return;

    try {
      const { data: existing } = await supabase
        .from('leads')
        .select('website')
        .in('website', websites);

      const existingWebsites = new Set(existing?.map(l => l.website) || []);
      const newWebsites = websites
        .filter(w => !existingWebsites.has(w))
        .map(w => ({ website: w, source: 'bulk_add', status: 'new' }));

      if (newWebsites.length === 0) {
        alert('All websites already exist!');
        return;
      }

      const { error } = await supabase
        .from('leads')
        .insert(newWebsites);

      if (error) throw error;

      setBulkWebsites('');
      await loadLeads();
      alert(`✅ Added ${newWebsites.length} new leads!\nSkipped ${websites.length - newWebsites.length} duplicates.`);
    } catch (error) {
      console.error('Error bulk adding:', error);
      alert('Failed to add leads: ' + error.message);
    }
  };

  // Import from CSV
  const handleCSVUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setIsUploading(true);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const rows = text.split('\n').slice(1);
        
        const websites = rows
          .map(row => row.split(',')[0]?.trim())
          .filter(w => w);

        if (websites.length === 0) {
          alert('No valid websites found in CSV');
          return;
        }

        const { data: existing } = await supabase
          .from('leads')
          .select('website')
          .in('website', websites);

        const existingWebsites = new Set(existing?.map(l => l.website) || []);
        const newWebsites = websites
          .filter(w => !existingWebsites.has(w))
          .map(w => ({ website: w, source: 'csv_upload', status: 'new' }));

        if (newWebsites.length === 0) {
          alert('All websites already exist!');
          return;
        }

        const { error } = await supabase
          .from('leads')
          .insert(newWebsites);

        if (error) throw error;

        await loadLeads();
        alert(`✅ Imported ${newWebsites.length} new leads!\nSkipped ${websites.length - newWebsites.length} duplicates.`);
      } catch (error) {
        console.error('Error importing CSV:', error);
        alert('Failed to import: ' + error.message);
      } finally {
        setIsUploading(false);
      }
    };
    reader.readAsText(file);
  };

  // Enrich selected leads - with web search and expanded scoring
  const enrichSelectedLeads = async () => {
    if (selectedLeads.length === 0) return;

    setIsEnriching(true);

    for (const leadId of selectedLeads) {
      const lead = enrichLeads.find(l => l.id === leadId) || leads.find(l => l.id === leadId);
      if (!lead) continue;

      try {
        console.log(`🔬 Enriching ${lead.website}...`);

        const response = await fetch('/.netlify/functions/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            useWebSearch: true,
            prompt: `Research the company at ${lead.website} for B2B sales qualification.

TASKS:
1. Visit or search for ${lead.website} to understand what they sell
2. Search Google Shopping for "${lead.website}" or their brand name to check if they list products there
3. Determine their headquarters location

Provide in this EXACT format (return ONLY plain text, no markdown code fences, no extra commentary):

Industry: [specific industry/vertical]
Catalog Size: [Small (<100 products) / Medium (100-250) / Large (250+)]
Sells D2C: [YES/NO - do they sell direct to consumer on their own website?]
Headquarters: [City, State/Country]
Google Shopping: [YES/NO/UNKNOWN - are their products listed on Google Shopping?]
ICP Fit: [HIGH/MEDIUM/LOW]
Fit Reason: [one sentence explaining why this score]
Decision Makers: [comma-separated likely titles e.g. CMO, VP Marketing, Head of Ecommerce]
Pain Points: [2-3 pain points related to creator content, UGC costs, or influencer spend]`,
            systemPrompt: `You are a B2B sales researcher for Onsite Affiliate. You have web search available — USE IT to look up the company website and check Google Shopping.

Return ONLY plain text in the exact format requested. No markdown, no code fences, no extra explanation.

WHAT ONSITE AFFILIATE DOES:
We help D2C ecommerce brands run performance-based creator/UGC programs on their own website. Brands get video content with no upfront costs — creators earn commissions on sales they drive.

ICP SCORING RULES (follow these EXACTLY):

HIGH FIT — ALL of these must be true:
1. Sells products D2C on their own website (having retail/wholesale channels too is FINE — Nike, Coach, Nordstrom all count as D2C because they sell on their own site)
2. Large product catalog (estimate 250+ products)
3. Primary category is one of: Fashion/Apparel, Home Goods, Outdoor/Lifestyle, Electronics
4. Headquartered in US or Canada
5. BONUS: If found on Google Shopping, this is a strong HIGH signal

MEDIUM FIT — has a D2C website BUT one or more:
- Catalog under 250 products in a target category
- Large catalog but in a non-target category (Beauty, Pet, Food, Health, Sports, Toys, etc.)
- Headquartered outside US/Canada

LOW FIT — any of these:
- No D2C ecommerce (B2B only, SaaS, services, marketplace-only seller with no own store)
- Brick-and-mortar only with no online store
- Non-profit, government, media company, blog
- No product sales at all

IMPORTANT EXAMPLES:
- Wayfair.com → HIGH (D2C ecommerce, huge Home Goods catalog, US-based)
- Nordstrom.com → HIGH (D2C ecommerce, huge Fashion catalog, US-based)
- Nike.com → HIGH (D2C ecommerce, large Fashion/Apparel catalog, US-based)
- A small Shopify jewelry store with 30 products → MEDIUM (D2C but small catalog)
- A UK-based home goods brand → MEDIUM (D2C but non-US/CA)
- A B2B industrial supplier → LOW (not D2C consumer)
- A SaaS company → LOW (no product sales)`
          })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        const data = await response.json();
        
        // Use the extracted text field (strips out web search blocks)
        let research = data.text || '';
        if (!research && data.content && Array.isArray(data.content)) {
          research = data.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        }

        // Parse all fields from the response
        const parseField = (fieldName) => {
          const match = research.match(new RegExp(`${fieldName}:\\s*(.+)`, 'i'));
          return match ? match[1].trim() : null;
        };

        const icpFit = parseField('ICP Fit')?.toUpperCase() || null;
        const industry = parseField('Industry');
        const catalogSize = parseField('Catalog Size');
        const sellsD2C = parseField('Sells D2C');
        const headquarters = parseField('Headquarters');
        const googleShopping = parseField('Google Shopping');
        const fitReason = parseField('Fit Reason');
        const decisionMakers = parseField('Decision Makers');
        const painPoints = parseField('Pain Points');

        // Store everything to Supabase
        await supabase
          .from('leads')
          .update({
            research_notes: research,
            icp_fit: icpFit,
            industry: industry,
            catalog_size: catalogSize,
            sells_d2c: sellsD2C,
            headquarters: headquarters,
            google_shopping: googleShopping,
            fit_reason: fitReason,
            decision_makers: decisionMakers,
            pain_points: painPoints,
            status: 'enriched',
            enrichment_status: 'completed'
          })
          .eq('id', leadId);

        await supabase
          .from('activity_log')
          .insert({
            activity_type: 'lead_enriched',
            lead_id: leadId,
            summary: `Enriched ${lead.website} — ICP: ${icpFit || 'Unknown'} | ${industry || ''} | D2C: ${sellsD2C || '?'} | Catalog: ${catalogSize || '?'} | GShop: ${googleShopping || '?'}`,
            status: 'success'
          });

        console.log(`✅ ${lead.website} → ${icpFit} | ${industry} | D2C:${sellsD2C} | Catalog:${catalogSize} | GShop:${googleShopping}`);

      } catch (error) {
        console.error(`❌ Error enriching ${lead.website}:`, error);
        
        await supabase
          .from('activity_log')
          .insert({
            activity_type: 'lead_enriched',
            lead_id: leadId,
            summary: `Failed to enrich ${lead.website}: ${error.message}`,
            status: 'failed'
          });
      }

      // Rate limit between calls
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    setIsEnriching(false);
    setSelectedLeads([]);
    await loadLeads();
    await searchEnrichLeads(enrichSearchTerm, enrichFilterStatus, enrichFilterICP, enrichFilterCountry, enrichPage);
    await loadActivity();
  };

  // Toggle lead selection
  const toggleLeadSelection = (leadId) => {
    setSelectedLeads(prev =>
      prev.includes(leadId)
        ? prev.filter(id => id !== leadId)
        : [...prev, leadId]
    );
  };

  // Select all unenriched leads on current page
  const selectAllUnenriched = () => {
    const unenriched = enrichLeads
      .filter(l => l.status === 'new' || !l.research_notes)
      .map(l => l.id);
    setSelectedLeads(unenriched);
  };

  // Generate email for manual outreach
  const generateManualEmail = async (lead) => {
    setIsGenerating(true);
    try {
      const response = await fetch('/.netlify/functions/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Write a casual outreach email for ${lead.website}. 

${lead.research_notes ? `Context: ${lead.research_notes.substring(0, 300)}` : ''}

Requirements:
- Under 90 words total
- Ask about upfront creator costs OR gifting logistics
- Explain: Amazon proved performance commissions eliminate upfront costs
- Key point: We help brands COPY that model for their OWN site (not access to Amazon creators)
- Tone: Casual, like a Slack message
- Include subject line

Format:
Subject: [subject]

[body]`,
          systemPrompt: `You are an SDR for Onsite Affiliate. Under 90 words, casual tone.

CRITICAL - WHAT WE ACTUALLY DO:
We help D2C brands COPY Amazon's Influencer commission model for their OWN website. We provide the platform/technology to run performance-based creator programs. We are NOT a network, NOT providing access to Amazon creators, NOT a middleman.

THE OFFER:
- Brands implement same commission structure Amazon uses on their own site
- Get UGC video content with ZERO upfront costs (no gifting, no retainers, no content fees)
- Only pay performance commissions when videos actually drive sales
- Creators earn MORE long-term through commissions vs one-time payments

CORRECT MESSAGING (USE THESE):
✓ "Copy Amazon's commission model for your site"
✓ "Build what Amazon built for your brand"  
✓ "Same structure Amazon uses, but for your products"
✓ "Implement Amazon's model on your own site"

NEVER SAY (THESE ARE WRONG):
✗ "Tap into Amazon's creators"
✗ "Access Amazon influencers"
✗ "Work with Amazon creators"
✗ "Our network of Amazon creators"
✗ "Through our Onsite Affiliate network"

EMAIL STRUCTURE (under 90 words):
[Name] -
[Pain question: upfront costs OR gifting logistics]
[Amazon proved performance commissions work - no upfront, pay after sales]
[We help you copy that exact model for YOUR site/products]
[Simple CTA question]
Mike

EXAMPLE (72 words):
Sarah -

Still paying creators $1k upfront for every UGC post?

Amazon figured out how to eliminate that with performance commissions. Creators promote products, earn after driving actual sales. Zero upfront costs.

We help D2C brands copy that exact model for their own site - same commission structure Amazon uses, but for your products.

Worth a quick call to see how it works?

Mike

TONE: Conversational, direct, no fluff. Like messaging a coworker on Slack.`
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const email = data.content[0]?.text || '';
      setManualEmail(email);
    } catch (error) {
      console.error('Error generating email:', error);
      alert('Failed to generate email: ' + error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Find contacts for manual outreach
  const findManualContacts = async (lead) => {
    setIsLoadingManualContacts(true);
    try {
      const response = await fetch('/.netlify/functions/csv-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          website: lead.website,
          researchNotes: lead.research_notes,
          offset: 0
        })
      });

      if (!response.ok) throw new Error('Failed to find contacts');

      const data = await response.json();
      setManualContacts(data.contacts || []);
      
      if (!data.contacts || data.contacts.length === 0) {
        alert(`No contacts found for ${lead.website}`);
      }
    } catch (error) {
      console.error('Error finding contacts:', error);
      alert('Failed to find contacts: ' + error.message);
    } finally {
      setIsLoadingManualContacts(false);
    }
  };

  // Toggle contact selection
  const toggleManualContact = (contactEmail) => {
    setSelectedManualContacts(prev =>
      prev.includes(contactEmail)
        ? prev.filter(e => e !== contactEmail)
        : [...prev, contactEmail]
    );
  };

  // Export selected contacts to Gmail
  const exportToGmail = () => {
    if (selectedManualContacts.length === 0) {
      alert('Please select at least one contact');
      return;
    }

    if (!manualEmail) {
      alert('Please generate an email first');
      return;
    }

    const subjectMatch = manualEmail.match(/Subject:\s*(.+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'Onsite Affiliate Introduction';
    
    const bodyStart = manualEmail.indexOf('\n', manualEmail.indexOf('Subject:'));
    const body = bodyStart > -1 ? manualEmail.substring(bodyStart).trim() : manualEmail;

    const bccEmails = selectedManualContacts.join(',');
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(bccEmails)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.open(gmailUrl, '_blank');

    alert(`✅ Opening Gmail with ${selectedManualContacts.length} contact(s) in BCC!`);
  };

  // Update agent settings
  const updateAgentSettings = async (updates) => {
    try {
      const { error } = await supabase
        .from('agent_settings')
        .update(updates)
        .eq('id', '00000000-0000-0000-0000-000000000001');
      
      if (!error) {
        setAgentSettings({ ...agentSettings, ...updates });
        alert('✅ Settings updated!');
      }
    } catch (error) {
      console.error('Error updating settings:', error);
      alert('Failed to update settings');
    }
  };

  // Get filtered leads for pipeline
  const getFilteredLeads = () => {
    let filtered = leads;

    if (filterStatus !== 'all') {
      filtered = filtered.filter(l => l.status === filterStatus);
    }

    if (searchTerm) {
      filtered = filtered.filter(l =>
        l.website.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    return filtered;
  };

  // Get status count
  const getStatusCount = (status) => leads.filter(l => l.status === status).length;

  // Computed pagination values for enrich page
  const enrichTotalPages = Math.ceil(enrichTotalCount / ENRICH_PAGE_SIZE);
  const enrichStartItem = enrichTotalCount > 0 ? enrichPage * ENRICH_PAGE_SIZE + 1 : 0;
  const enrichEndItem = Math.min((enrichPage + 1) * ENRICH_PAGE_SIZE, enrichTotalCount);

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>🤖 AI SDR Agent</h1>
          <p>Onsite Affiliate Outreach Platform</p>
        </div>
        <div className="header-stats">
          <div className="stat">
            <span className="stat-value">{totalLeadCount}</span>
            <span className="stat-label">Total Leads</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats?.leads_enriched || 0}</span>
            <span className="stat-label">Enriched Today</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats?.emails_sent || 0}</span>
            <span className="stat-label">Emails Sent</span>
          </div>
        </div>
      </header>

      <div className="main-layout">
        <aside className="vertical-sidebar">
  <button
    className={`sidebar-btn ${activeView === 'add' ? 'active' : ''}`}
    onClick={() => setActiveView('add')}
  >
    <span className="btn-icon">➕</span>
    <span className="btn-label">Add Leads</span>
  </button>
  
  <button
    className={`sidebar-btn ${activeView === 'enrich' ? 'active' : ''}`}
    onClick={() => setActiveView('enrich')}
  >
    <span className="btn-icon">🔬</span>
    <span className="btn-label">Enrich Leads</span>
  </button>

  <button
    className={`sidebar-btn ${activeView === 'manual' ? 'active' : ''}`}
    onClick={() => setActiveView('manual')}
  >
    <span className="btn-icon">✉️</span>
    <span className="btn-label">Manual Outreach</span>
  </button>
  
  <button
    className={`sidebar-btn ${activeView === 'agent' ? 'active' : ''}`}
    onClick={() => setActiveView('agent')}
  >
    <span className="btn-icon">🤖</span>
    <span className="btn-label">Manage Agent</span>
  </button>
  
  <button
    className={`sidebar-btn ${activeView === 'pipeline' ? 'active' : ''}`}
    onClick={() => setActiveView('pipeline')}
  >
    <span className="btn-icon">📊</span>
    <span className="btn-label">Pipeline</span>
  </button>
</aside>

        <main className="main-content">
          {activeView === 'add' && (
            <div className="view-container">
              <h2>➕ Add New Leads</h2>
              
              <div className="add-methods">
                <div className="add-method-card">
                  <h3>Add Single Website</h3>
                  <div className="input-group">
                    <input
                      type="text"
                      placeholder="revolut.com"
                      value={newWebsite}
                      onChange={(e) => setNewWebsite(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && addSingleWebsite()}
                    />
                    <button onClick={addSingleWebsite} className="primary-btn">
                      Add Lead
                    </button>
                  </div>
                </div>

                <div className="add-method-card">
                  <h3>Bulk Add Websites</h3>
                  <p>Enter one website per line</p>
                  <textarea
                    placeholder="revolut.com&#10;coach.com&#10;timbuk2.com"
                    value={bulkWebsites}
                    onChange={(e) => setBulkWebsites(e.target.value)}
                    rows={8}
                  />
                  <button onClick={bulkAddWebsites} className="primary-btn">
                    Add {bulkWebsites.split('\n').filter(w => w.trim()).length} Leads
                  </button>
                </div>

                <div className="add-method-card">
                  <h3>Upload CSV</h3>
                  <p>CSV Format: website column with one website per row</p>
                  <label className="upload-btn">
                    {isUploading ? '⏳ Uploading...' : '📤 Choose CSV File'}
                    <input
                      type="file"
                      accept=".csv"
                      onChange={handleCSVUpload}
                      disabled={isUploading}
                      style={{ display: 'none' }}
                    />
                  </label>
                  <div className="csv-example">
                    <p><strong>Example CSV:</strong></p>
                    <pre>website
revolut.com
coach.com
timbuk2.com</pre>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeView === 'enrich' && (
            <div className="view-container">
              <div className="view-header">
                <h2>🔬 Enrich Leads with AI</h2>
                <div className="view-actions">
                  <button onClick={selectAllUnenriched} className="secondary-btn">
                    Select All on Page ({enrichLeads.filter(l => l.status === 'new').length})
                  </button>
                  <button
                    onClick={enrichSelectedLeads}
                    disabled={selectedLeads.length === 0 || isEnriching}
                    className="primary-btn"
                  >
                    {isEnriching ? '🔬 Enriching...' : `Enrich ${selectedLeads.length} Lead(s)`}
                  </button>
                </div>
              </div>

              {/* Search and Filter Bar */}
              <div className="enrich-filters" style={{
                display: 'flex',
                gap: '12px',
                marginBottom: '20px',
                alignItems: 'center',
                flexWrap: 'wrap'
              }}>
                <input
                  type="text"
                  placeholder="🔍 Search by website or notes..."
                  value={enrichSearchTerm}
                  onChange={(e) => { 
                    setEnrichSearchTerm(e.target.value); 
                    debouncedEnrichSearch(e.target.value, enrichFilterStatus, enrichFilterICP, enrichFilterCountry);
                  }}
                  style={{
                    flex: '1',
                    minWidth: '250px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.15)',
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    color: 'inherit',
                    fontSize: '14px'
                  }}
                />
                <select
                  value={enrichFilterStatus}
                  onChange={(e) => { setEnrichFilterStatus(e.target.value); setEnrichPage(0); }}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.15)',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: 'inherit',
                    fontSize: '14px'
                  }}
                >
                  <option value="all">All Status ({totalLeadCount})</option>
                  <option value="new">New</option>
                  <option value="enriched">Enriched</option>
                  <option value="contacted">Contacted</option>
                </select>
                <select
                  value={enrichFilterICP}
                  onChange={(e) => { setEnrichFilterICP(e.target.value); setEnrichPage(0); }}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.15)',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: 'inherit',
                    fontSize: '14px'
                  }}
                >
                  <option value="all">All ICP</option>
                  <option value="HIGH">🟢 HIGH</option>
                  <option value="MEDIUM">🟡 MEDIUM</option>
                  <option value="LOW">🔴 LOW</option>
                </select>
                <select
                  value={enrichFilterCountry}
                  onChange={(e) => { setEnrichFilterCountry(e.target.value); setEnrichPage(0); }}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.15)',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: 'inherit',
                    fontSize: '14px'
                  }}
                >
                  <option value="all">All Countries</option>
                  <option value="US/CA">🇺🇸🇨🇦 US & Canada Only</option>
                  <option value="US (assumed)">🇺🇸 US (assumed)</option>
                  <option value="Canada">🇨🇦 Canada</option>
                  <option value="International">🌍 International</option>
                  <option value="UK">🇬🇧 UK</option>
                  <option value="Australia">🇦🇺 Australia</option>
                  <option value="Germany">🇩🇪 Germany</option>
                  <option value="France">🇫🇷 France</option>
                  <option value="Unknown">❓ Unknown</option>
                </select>
                {(enrichSearchTerm || enrichFilterStatus !== 'all' || enrichFilterICP !== 'all' || enrichFilterCountry !== 'all') && (
                  <button
                    onClick={() => {
                      setEnrichSearchTerm('');
                      setEnrichFilterStatus('all');
                      setEnrichFilterICP('all');
                      setEnrichFilterCountry('all');
                      setEnrichPage(0);
                      searchEnrichLeads('', 'all', 'all', 'all', 0);
                    }}
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: 'rgba(255,80,80,0.15)',
                      color: '#ff6b6b',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    ✕ Clear
                  </button>
                )}
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                  {isLoadingEnrich ? '⏳ Loading...' : `Showing ${enrichStartItem}–${enrichEndItem} of ${enrichTotalCount} leads`}
                </span>
              </div>

              <div className="leads-grid">
                {enrichLeads.map(lead => (
                  <div
                    key={lead.id}
                    className={`lead-enrich-card ${selectedLeads.includes(lead.id) ? 'selected' : ''}`}
                    onClick={() => toggleLeadSelection(lead.id)}
                  >
                    <div className="lead-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedLeads.includes(lead.id)}
                        onChange={() => toggleLeadSelection(lead.id)}
                      />
                    </div>
                    <div className="lead-info">
                      <h4>{lead.website}</h4>
                      <span className={`status-badge ${lead.status}`}>
                        {lead.status}
                      </span>
                      {lead.icp_fit && (
                        <span className={`icp-badge ${lead.icp_fit.toLowerCase()}`}>
                          {lead.icp_fit}
                        </span>
                      )}
                      {lead.country && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: '600',
                          backgroundColor: lead.country === 'US (assumed)' || lead.country === 'US' 
                            ? 'rgba(59,130,246,0.15)' 
                            : lead.country === 'Canada' 
                            ? 'rgba(239,68,68,0.15)' 
                            : 'rgba(255,255,255,0.1)',
                          color: lead.country === 'US (assumed)' || lead.country === 'US'
                            ? '#60a5fa'
                            : lead.country === 'Canada'
                            ? '#f87171'
                            : 'rgba(255,255,255,0.6)'
                        }}>
                          {lead.country === 'US (assumed)' ? '🇺🇸 US' : 
                           lead.country === 'US' ? '🇺🇸 US' :
                           lead.country === 'Canada' ? '🇨🇦 CA' :
                           lead.country === 'UK' ? '🇬🇧 UK' :
                           lead.country === 'Australia' ? '🇦🇺 AU' :
                           lead.country === 'Germany' ? '🇩🇪 DE' :
                           lead.country === 'France' ? '🇫🇷 FR' :
                           lead.country}
                        </span>
                      )}
                    </div>
                    {lead.research_notes && (
                      <div className="lead-research-preview">
                        {lead.industry && <div><strong>{lead.industry}</strong></div>}
                        {lead.fit_reason && <div>{lead.fit_reason}</div>}
                        {!lead.fit_reason && lead.research_notes.substring(0, 100) + '...'}
                        {(lead.catalog_size || lead.google_shopping || lead.sells_d2c) && (
                          <div style={{ marginTop: '4px', fontSize: '11px', opacity: 0.7 }}>
                            {lead.sells_d2c && `D2C: ${lead.sells_d2c}`}
                            {lead.catalog_size && ` · ${lead.catalog_size}`}
                            {lead.google_shopping && ` · GShop: ${lead.google_shopping}`}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {enrichTotalPages > 1 && (
                <div style={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '12px',
                  marginTop: '24px',
                  paddingBottom: '20px'
                }}>
                  <button
                    onClick={() => setEnrichPage(0)}
                    disabled={enrichPage === 0}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: enrichPage === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                      color: enrichPage === 0 ? 'rgba(255,255,255,0.3)' : 'inherit',
                      cursor: enrichPage === 0 ? 'default' : 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    ⟨⟨ First
                  </button>
                  <button
                    onClick={() => setEnrichPage(p => Math.max(0, p - 1))}
                    disabled={enrichPage === 0}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: enrichPage === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                      color: enrichPage === 0 ? 'rgba(255,255,255,0.3)' : 'inherit',
                      cursor: enrichPage === 0 ? 'default' : 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    ⟨ Prev
                  </button>
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', fontWeight: '600' }}>
                    Page {enrichPage + 1} of {enrichTotalPages}
                  </span>
                  <button
                    onClick={() => setEnrichPage(p => Math.min(enrichTotalPages - 1, p + 1))}
                    disabled={enrichPage >= enrichTotalPages - 1}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: enrichPage >= enrichTotalPages - 1 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                      color: enrichPage >= enrichTotalPages - 1 ? 'rgba(255,255,255,0.3)' : 'inherit',
                      cursor: enrichPage >= enrichTotalPages - 1 ? 'default' : 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    Next ⟩
                  </button>
                  <button
                    onClick={() => setEnrichPage(enrichTotalPages - 1)}
                    disabled={enrichPage >= enrichTotalPages - 1}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: enrichPage >= enrichTotalPages - 1 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                      color: enrichPage >= enrichTotalPages - 1 ? 'rgba(255,255,255,0.3)' : 'inherit',
                      cursor: enrichPage >= enrichTotalPages - 1 ? 'default' : 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    Last ⟩⟩
                  </button>
                </div>
              )}
            </div>
          )}

          {activeView === 'manual' && (
            <div className="view-container">
              <h2>✉️ Manual Outreach</h2>
              <p>Create personalized emails and export contacts to Gmail for hands-on outreach</p>

              <div className="manual-outreach-layout">
                <div className="manual-section">
                  <div className="section-card">
                    <h3>Step 1: Select Lead</h3>
                    <div className="lead-selector">
                      <select
                        value={selectedLeadForManual?.id || ''}
                        onChange={(e) => {
                          const lead = leads.find(l => l.id === e.target.value);
                          setSelectedLeadForManual(lead);
                          setManualEmail('');
                          setManualContacts([]);
                          setSelectedManualContacts([]);
                        }}
                      >
                        <option value="">Choose a lead...</option>
                        {leads
                          .filter(l => l.status === 'enriched' || l.research_notes)
                          .map(lead => (
                            <option key={lead.id} value={lead.id}>
                              {lead.website} {lead.icp_fit ? `(${lead.icp_fit})` : ''}
                            </option>
                          ))}
                      </select>
                    </div>

                    {selectedLeadForManual && (
                      <div className="selected-lead-info">
                        <h4>{selectedLeadForManual.website}</h4>
                        {selectedLeadForManual.icp_fit && (
                          <span className={`icp-badge ${selectedLeadForManual.icp_fit.toLowerCase()}`}>
                            {selectedLeadForManual.icp_fit}
                          </span>
                        )}
                        {selectedLeadForManual.research_notes && (
                          <div className="lead-research-preview">
                            <p><strong>Research:</strong></p>
                            <pre>{selectedLeadForManual.research_notes.substring(0, 200)}...</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {selectedLeadForManual && (
                    <div className="section-card">
                      <h3>Step 2: Generate Email</h3>
                      <button
                        className="primary-btn"
                        onClick={() => generateManualEmail(selectedLeadForManual)}
                        disabled={isGenerating}
                      >
                        {isGenerating ? '⏳ Generating...' : '✨ Generate Email with AI'}
                      </button>

                      {manualEmail && (
                        <div className="email-preview">
                          <div className="email-header">
                            <strong>Generated Email:</strong>
                            <button
                              className="secondary-btn"
                              onClick={() => navigator.clipboard.writeText(manualEmail)}
                            >
                              📋 Copy
                            </button>
                          </div>
                          <pre>{manualEmail}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {selectedLeadForManual && manualEmail && (
                  <div className="manual-section">
                    <div className="section-card">
                      <h3>Step 3: Find Contacts</h3>
                      <button
                        className="primary-btn"
                        onClick={() => findManualContacts(selectedLeadForManual)}
                        disabled={isLoadingManualContacts}
                      >
                        {isLoadingManualContacts ? '🔍 Searching...' : '🔍 Find Contacts'}
                      </button>

                      {manualContacts.length > 0 && (
                        <>
                          <div className="contacts-found">
                            <p><strong>{manualContacts.length} contacts found</strong></p>
                            <p className="text-muted">Select contacts to export to Gmail</p>
                          </div>

                          <div className="manual-contacts-list">
                            {manualContacts.map(contact => (
                              <div
                                key={contact.email}
                                className={`manual-contact-card ${selectedManualContacts.includes(contact.email) ? 'selected' : ''}`}
                                onClick={() => toggleManualContact(contact.email)}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedManualContacts.includes(contact.email)}
                                  onChange={() => toggleManualContact(contact.email)}
                                />
                                <div className="contact-details">
                                  <strong>{contact.name}</strong>
                                  <p className="contact-title">{contact.title}</p>
                                  <p className="contact-email">{contact.email}</p>
                                  {contact.matchLevel && (
                                    <span className={`match-badge ${contact.matchClass}`}>
                                      {contact.matchEmoji} {contact.matchLevel}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>

                          <div className="export-actions">
                            <button
                              className="primary-btn"
                              onClick={exportToGmail}
                              disabled={selectedManualContacts.length === 0}
                            >
                              📧 Export {selectedManualContacts.length} Contact(s) to Gmail
                            </button>
                            <p className="text-muted">
                              Opens Gmail with selected contacts in BCC
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeView === 'agent' && (
            <div className="view-container">
              <div className="agent-header">
                <h2>🤖 AI Agent Manager</h2>
                <div className="agent-status">
                  <div className={`status-indicator ${agentSettings?.agent_enabled ? 'active' : 'paused'}`}>
                    {agentSettings?.agent_enabled ? '🟢 Active' : '⏸️ Paused'}
                  </div>
                  <button
                    className="toggle-agent-btn"
                    onClick={() => updateAgentSettings({ agent_enabled: !agentSettings?.agent_enabled })}
                  >
                    {agentSettings?.agent_enabled ? 'Pause Agent' : 'Start Agent'}
                  </button>
                </div>
              </div>
             <AgentMonitor />
              <div className="agent-settings">
                <div className="settings-card">
                  <h3>Email Limits</h3>
                  <div className="setting-item">
                    <label>Max Emails Per Day</label>
                    <input
                      type="number"
                      value={agentSettings?.max_emails_per_day || 50}
                      onChange={(e) => updateAgentSettings({ max_emails_per_day: parseInt(e.target.value) })}
                    />
                  </div>
                  <div className="setting-item">
                    <label>Minutes Between Emails</label>
                    <input
                      type="number"
                      value={agentSettings?.min_minutes_between_emails || 15}
                      onChange={(e) => updateAgentSettings({ min_minutes_between_emails: parseInt(e.target.value) })}
                    />
                  </div>
                  <div className="setting-item">
                    <label>Send Hours (EST)</label>
                    <div className="hours-input">
                      <input
                        type="number"
                        min="0"
                        max="23"
                        value={agentSettings?.send_hours_start || 9}
                        onChange={(e) => updateAgentSettings({ send_hours_start: parseInt(e.target.value) })}
                        style={{ width: '80px' }}
                      />
                      <span>to</span>
                      <input
                        type="number"
                        min="0"
                        max="23"
                        value={agentSettings?.send_hours_end || 17}
                        onChange={(e) => updateAgentSettings({ send_hours_end: parseInt(e.target.value) })}
                        style={{ width: '80px' }}
                      />
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <h3>Contact Limits</h3>
                  <div className="setting-item">
                    <label>Max Contacts Per Lead</label>
                    <input
                      type="number"
                      value={agentSettings?.max_contacts_per_lead || 3}
                      onChange={(e) => updateAgentSettings({ max_contacts_per_lead: parseInt(e.target.value) })}
                    />
                    <p className="setting-hint">
                      Maximum number of people to contact at each company
                    </p>
                  </div>
                  <div className="setting-item">
                    <label>Max Per Company Per Day</label>
                    <input
                      type="number"
                      value={agentSettings?.max_contacts_per_company_per_day || 1}
                      onChange={(e) => updateAgentSettings({ max_contacts_per_company_per_day: parseInt(e.target.value) })}
                    />
                    <p className="setting-hint">
                      Prevents spamming multiple people at the same company in one day
                    </p>
                  </div>
                </div>

                <div className="settings-card">
                  <h3>Contact Quality</h3>
                  <div className="setting-item">
                    <label>Minimum Match Level</label>
                    <select
                      value={agentSettings?.min_match_level || 'Good Match'}
                      onChange={(e) => updateAgentSettings({ min_match_level: e.target.value })}
                    >
                      <option value="Best Match">Best Match Only</option>
                      <option value="Great Match">Great Match or Better</option>
                      <option value="Good Match">Good Match or Better</option>
                      <option value="Possible Match">All Matches</option>
                    </select>
                    <p className="setting-hint">
                      Only contact decision makers that meet this quality threshold
                    </p>
                  </div>
                  <div className="setting-item">
                    <label>Minimum Match Score</label>
                    <input
                      type="number"
                      value={agentSettings?.min_match_score || 40}
                      onChange={(e) => updateAgentSettings({ min_match_score: parseInt(e.target.value) })}
                    />
                    <p className="setting-hint">
                      Minimum scoring threshold (0-200+). Higher scores = better title match.
                    </p>
                  </div>
                </div>

                <div className="settings-card">
                  <h3>ICP Fit Filter</h3>
                  <div className="checkbox-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={agentSettings?.allowed_icp_fits?.includes('HIGH')}
                        onChange={(e) => {
                          const fits = agentSettings?.allowed_icp_fits || [];
                          const newFits = e.target.checked
                            ? [...fits, 'HIGH']
                            : fits.filter(f => f !== 'HIGH');
                          updateAgentSettings({ allowed_icp_fits: newFits });
                        }}
                      />
                      HIGH Only
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={agentSettings?.allowed_icp_fits?.includes('MEDIUM')}
                        onChange={(e) => {
                          const fits = agentSettings?.allowed_icp_fits || [];
                          const newFits = e.target.checked
                            ? [...fits, 'MEDIUM']
                            : fits.filter(f => f !== 'MEDIUM');
                          updateAgentSettings({ allowed_icp_fits: newFits });
                        }}
                      />
                      Include MEDIUM
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={agentSettings?.allowed_icp_fits?.includes('LOW')}
                        onChange={(e) => {
                          const fits = agentSettings?.allowed_icp_fits || [];
                          const newFits = e.target.checked
                            ? [...fits, 'LOW']
                            : fits.filter(f => f !== 'LOW');
                          updateAgentSettings({ allowed_icp_fits: newFits });
                        }}
                      />
                      Include LOW
                    </label>
                  </div>
                  <p className="setting-hint">
                    Agent will only work on leads that match selected ICP fit levels
                  </p>
                </div>

                <div className="settings-card">
                  <h3>Approval Mode</h3>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={agentSettings?.auto_send || false}
                      onChange={(e) => updateAgentSettings({ auto_send: e.target.checked })}
                    />
                    <span>Auto-send emails (no manual approval)</span>
                  </label>
                  <p className="setting-hint">
                    {agentSettings?.auto_send
                      ? '⚠️ Emails will send automatically'
                      : '✅ Emails require your approval'}
                  </p>
                </div>
              </div>

              <div className="activity-section">
                <h3>Recent Activity</h3>
                <div className="activity-list">
                  {activityLog.slice(0, 10).map(activity => (
                    <div key={activity.id} className="activity-item">
                      <span className="activity-icon">
                        {activity.activity_type === 'lead_enriched' && '🔍'}
                        {activity.activity_type === 'email_sent' && '📤'}
                        {activity.activity_type === 'email_failed' && '❌'}
                      </span>
                      <span className="activity-summary">{activity.summary}</span>
                      <span className="activity-time">
                        {new Date(activity.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeView === 'pipeline' && (
            <div className="view-container">
              <h2>📊 Lead Pipeline</h2>
              
              <div className="pipeline-filters">
                <input
                  type="text"
                  placeholder="Search leads..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All Status ({leads.length})</option>
                  <option value="new">New ({getStatusCount('new')})</option>
                  <option value="enriched">Enriched ({getStatusCount('enriched')})</option>
                  <option value="contacted">Contacted ({getStatusCount('contacted')})</option>
                  <option value="qualified">Qualified ({getStatusCount('qualified')})</option>
                </select>
              </div>

              <div className="pipeline-table">
                <table>
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th>Status</th>
                      <th>ICP Fit</th>
                      <th>Country</th>
                      <th>Source</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getFilteredLeads().map(lead => (
                      <tr key={lead.id}>
                        <td className="website-cell">{lead.website}</td>
                        <td>
                          <span className={`status-badge ${lead.status}`}>
                            {lead.status}
                          </span>
                        </td>
                        <td>
                          {lead.icp_fit && (
                            <span className={`icp-badge ${lead.icp_fit.toLowerCase()}`}>
                              {lead.icp_fit}
                            </span>
                          )}
                        </td>
                        <td>{lead.country || '—'}</td>
                        <td>{lead.source}</td>
                        <td>{new Date(lead.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
