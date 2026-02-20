import { useState, useEffect, useRef } from 'react';
import './App.css';
import AgentMonitor from './AgentMonitor';
import Login from './Login';
import { supabase } from './supabaseClient';
import { getTotalLeadCount, searchLeads, searchEnrichedLeads, addLead, bulkAddLeads, logActivity } from './services/leadService';
import { enrichLeads } from './services/enrichService';
import { generateEmail } from './services/emailService';
import { findContacts } from './services/contactService';
import { sendEmail, exportToGmail } from './services/exportService';

function App() {
  // Auth state
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    // Check current session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Show loading while checking auth
  if (authLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(170deg, #01081e 0%, #070e24 50%, #01081e 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Raleway', sans-serif", color: '#f6f6f7',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', fontFamily: "'Barlow', sans-serif", fontWeight: 800,
            background: 'linear-gradient(135deg, #9015ed, #245ef9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>AI SDR Agent</div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)', marginTop: '8px' }}>Loading...</div>
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!session) {
    return <Login />;
  }

  return <AuthenticatedApp session={session} />;
}

function AuthenticatedApp({ session }) {
  // Global state
  const [activeView, setActiveView] = useState('add');
  const [totalLeadCount, setTotalLeadCount] = useState(0);
  const [enrichedCount, setEnrichedCount] = useState(0);
  const [unenrichedCount, setUnenrichedCount] = useState(0);
  const [icpCounts, setIcpCounts] = useState({ high: 0, medium: 0, low: 0 });
  const [emailsSent, setEmailsSent] = useState(0);
  const [isCheckingBounces, setIsCheckingBounces] = useState(false);
  const [bounceResult, setBounceResult] = useState(null);
  const [agentSettings, setAgentSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [activityLog, setActivityLog] = useState([]);

  // Add leads state
  const [newWebsite, setNewWebsite] = useState('');
  const [bulkWebsites, setBulkWebsites] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [addTab, setAddTab] = useState('single');
  const [autoEnrich, setAutoEnrich] = useState(false);
  const [discoverSource, setDiscoverSource] = useState('storeleads');
  const [discoverCategories, setDiscoverCategories] = useState(['Fashion & Apparel']);
  const [discoverCountries, setDiscoverCountries] = useState(['US']);
  const [discoverMinProducts, setDiscoverMinProducts] = useState(250);
  const [discoverMinRevenue, setDiscoverMinRevenue] = useState(1000000);
  const [discoverMaxResults, setDiscoverMaxResults] = useState(100);
  const [discoverStatus, setDiscoverStatus] = useState(null);
  const [discoverResults, setDiscoverResults] = useState(null);

  // Enrich page state
  const [enrichLeadsList, setEnrichLeadsList] = useState([]);
  const [enrichTotalCount, setEnrichTotalCount] = useState(0);
  const [isLoadingEnrich, setIsLoadingEnrich] = useState(false);
  const [enrichSearchTerm, setEnrichSearchTerm] = useState('');
  const [enrichFilterCountry, setEnrichFilterCountry] = useState('all');
  const [enrichPage, setEnrichPage] = useState(0);
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [enrichResult, setEnrichResult] = useState(null);
  const ENRICH_PAGE_SIZE = 100;
  const enrichTimerRef = useRef(null);

  // Manual outreach state
  const [manualStep, setManualStep] = useState(1);
  const [manualLeads, setManualLeads] = useState([]);
  const [manualTotalCount, setManualTotalCount] = useState(0);
  const [isLoadingManual, setIsLoadingManual] = useState(false);
  const [manualSearchTerm, setManualSearchTerm] = useState('');
  const [manualFilterContacted, setManualFilterContacted] = useState('all');
  const [manualPage, setManualPage] = useState(0);
  const [selectedLeadForManual, setSelectedLeadForManual] = useState(null);
  const [manualEmail, setManualEmail] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [manualContacts, setManualContacts] = useState([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [selectedManualContacts, setSelectedManualContacts] = useState([]);
  const MANUAL_PAGE_SIZE = 50;
  const manualTimerRef = useRef(null);

  // Pipeline state
  const [pipelineLeads, setPipelineLeads] = useState([]);
  const [pipelineTotalCount, setPipelineTotalCount] = useState(0);
  const [pipelineSearch, setPipelineSearch] = useState('');
  const [pipelineFilter, setPipelineFilter] = useState('all');
  const [pipelinePage, setPipelinePage] = useState(0);
  const [pipelineStats, setPipelineStats] = useState({ totalContacts: 0, contacted: 0, pctContacted: 0 });
  const [emailDetailLead, setEmailDetailLead] = useState(null);
  const [emailDetailData, setEmailDetailData] = useState([]);
  const PIPELINE_PAGE_SIZE = 100;

  // ═══════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════

  useEffect(() => {
    loadGlobalData();
    loadEnrichLeads();
    loadManualLeads();
  }, []);

  const loadGlobalData = async () => {
    try {
      const count = await getTotalLeadCount();
      setTotalLeadCount(count);
    } catch (e) { console.error(e); }

    // ICP fit counts (enriched leads only)
    try {
      const { count: enriched } = await supabase.from('leads').select('*', { count: 'exact', head: true }).in('status', ['enriched', 'contacted']);
      const { count: unenriched } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new');
      setEnrichedCount(enriched || 0);
      setUnenrichedCount(unenriched || 0);
      const { count: high } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'HIGH');
      const { count: medium } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'MEDIUM');
      const { count: low } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('icp_fit', 'LOW');
      setIcpCounts({ high: high || 0, medium: medium || 0, low: low || 0 });
    } catch (e) { console.error(e); }

    // Emails sent (contacted leads)
    try {
      const { count } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'contacted');
      setEmailsSent(count || 0);
    } catch (e) { console.error(e); }

    try {
      const { data } = await supabase.from('agent_settings').select('*').single();
      setAgentSettings(data);
    } catch (e) { console.error(e); }

    try {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase.from('daily_stats').select('*').eq('date', today).maybeSingle();
      setStats(data || { leads_enriched: 0, contacts_found: 0, emails_drafted: 0, emails_sent: 0 });
    } catch (e) { console.error(e); }

    try {
      const { data } = await supabase.from('activity_log').select('*, leads(website)').order('created_at', { ascending: false }).limit(50);
      setActivityLog(data || []);
    } catch (e) { console.error(e); }
  };

  // ═══════════════════════════════════════════
  // ENRICH PAGE - Server-side search
  // ═══════════════════════════════════════════

  const loadEnrichLeads = async (search, country, page) => {
    setIsLoadingEnrich(true);
    try {
      const { leads, totalCount } = await searchLeads({
        search: search ?? enrichSearchTerm,
        country: country ?? enrichFilterCountry,
        unenrichedOnly: true,
        page: page ?? enrichPage,
        pageSize: ENRICH_PAGE_SIZE
      });
      setEnrichLeadsList(leads);
      setEnrichTotalCount(totalCount);
    } catch (e) { console.error(e); }
    setIsLoadingEnrich(false);
  };

  const debouncedEnrichSearch = (search) => {
    if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
    enrichTimerRef.current = setTimeout(() => {
      setEnrichPage(0);
      loadEnrichLeads(search, enrichFilterCountry, 0);
    }, 400);
  };

  useEffect(() => { loadEnrichLeads(); }, [enrichFilterCountry, enrichPage]);

  // ═══════════════════════════════════════════
  // ENRICHMENT
  // ═══════════════════════════════════════════

  const handleEnrich = async () => {
    if (selectedLeads.length === 0) return;
    setIsEnriching(true);
    setEnrichProgress({ current: 0, total: selectedLeads.length, currentSite: '' });
    setEnrichResult(null);

    const results = await enrichLeads(selectedLeads, enrichLeadsList, (current, total, site, status) => {
      setEnrichProgress({ current, total, currentSite: site, status });
    });

    setIsEnriching(false);
    setEnrichProgress(null);
    setSelectedLeads([]);
    setEnrichResult(results);

    // Refresh data
    loadEnrichLeads();
    loadManualLeads();
    const count = await getTotalLeadCount();
    setTotalLeadCount(count);
    const { data: activity } = await supabase.from('activity_log').select('*, leads(website)').order('created_at', { ascending: false }).limit(50);
    setActivityLog(activity || []);
  };

  const selectAllOnPage = () => {
    const ids = enrichLeadsList.filter(l => l.status === 'new' || !l.research_notes).map(l => l.id);
    setSelectedLeads(ids);
  };

  const toggleLeadSelection = (leadId) => {
    setSelectedLeads(prev => prev.includes(leadId) ? prev.filter(id => id !== leadId) : [...prev, leadId]);
  };

  // ═══════════════════════════════════════════
  // MANUAL OUTREACH - Server-side search
  // ═══════════════════════════════════════════

  const loadManualLeads = async (search, contactedFilter, page) => {
    setIsLoadingManual(true);
    try {
      const s = search ?? manualSearchTerm;
      const p = page ?? manualPage;
      
      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .in('status', ['enriched', 'contacted', 'replied']);

      if (s && s.trim()) {
        query = query.or(`website.ilike.%${s.trim()}%,research_notes.ilike.%${s.trim()}%,industry.ilike.%${s.trim()}%`);
      }

      const cf = contactedFilter ?? manualFilterContacted;
      if (cf === 'contacted') {
        query = query.eq('status', 'contacted');
      } else if (cf === 'not_contacted') {
        query = query.eq('status', 'enriched');
      } else if (cf === 'has_contacts') {
        query = query.eq('has_contacts', true);
      } else if (cf === 'high_with_contacts') {
        query = query.eq('has_contacts', true).eq('icp_fit', 'HIGH');
      }

      const from = p * MANUAL_PAGE_SIZE;
      query = query.order('has_contacts', { ascending: false, nullsFirst: false }).order('icp_fit', { ascending: true }).order('created_at', { ascending: false }).range(from, from + MANUAL_PAGE_SIZE - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      // Enrich leads with outreach history
      const websites = (data || []).map(l => l.website);
      let outreachMap = {};
      if (websites.length > 0) {
        const { data: outreachData } = await supabase
          .from('outreach_log')
          .select('website, contact_email, contact_name, sent_at, replied_at')
          .in('website', websites)
          .order('sent_at', { ascending: false });

        for (const o of (outreachData || [])) {
          if (!outreachMap[o.website]) outreachMap[o.website] = [];
          outreachMap[o.website].push(o);
        }
      }

      const enrichedLeads = (data || []).map(lead => ({
        ...lead,
        outreach_history: outreachMap[lead.website] || [],
      }));

      setManualLeads(enrichedLeads);
      setManualTotalCount(count || 0);
    } catch (e) { console.error(e); }
    setIsLoadingManual(false);
  };

  const debouncedManualSearch = (search) => {
    if (manualTimerRef.current) clearTimeout(manualTimerRef.current);
    manualTimerRef.current = setTimeout(() => {
      setManualPage(0);
      loadManualLeads(search, manualFilterContacted, 0);
    }, 400);
  };

  useEffect(() => { loadManualLeads(); }, [manualFilterContacted, manualPage]);

  const handleGenerateEmail = async () => {
    if (!selectedLeadForManual) return;
    setIsGenerating(true);
    try {
      const email = await generateEmail(selectedLeadForManual, selectedLeadForManual.contact_name);
      setManualEmail(email);
    } catch (e) {
      console.error(e);
    }
    setIsGenerating(false);
  };

  const handleFindContacts = async () => {
    if (!selectedLeadForManual) return;
    setIsLoadingContacts(true);
    try {
      const contacts = await findContacts(selectedLeadForManual);

      // Check which contacts were already emailed
      const { data: sent } = await supabase
        .from('outreach_log')
        .select('contact_email, sent_at')
        .eq('website', selectedLeadForManual.website);

      const sentEmails = new Map((sent || []).map(s => [s.contact_email, s.sent_at]));

      const enrichedContacts = contacts.map(c => ({
        ...c,
        alreadySent: sentEmails.has(c.email),
        sentAt: sentEmails.get(c.email) || null,
      }));

      setManualContacts(enrichedContacts);
    } catch (e) {
      console.error(e);
    }
    setIsLoadingContacts(false);
  };

  const toggleContact = (email) => {
    setSelectedManualContacts(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]);
  };

  const handleCheckBounces = async () => {
    setIsCheckingBounces(true);
    setBounceResult(null);
    try {
      const res = await fetch('/.netlify/functions/check-bounces', { method: 'POST' });
      const data = await res.json();
      setBounceResult(data);
      if (data.bouncedEmails?.length > 0) {
        await loadGlobalData();
        await loadManualLeads();
      }
    } catch (e) {
      console.error(e);
      setBounceResult({ error: e.message });
    }
    setIsCheckingBounces(false);
  };

  const handleExportToGmail = async () => {
    if (!selectedLeadForManual) return;
    await exportToGmail(selectedLeadForManual.id, manualEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website);
    // Reset after short delay
    setTimeout(() => {
      setManualStep(1);
      setSelectedLeadForManual(null);
      setManualEmail('');
      setManualContacts([]);
      setSelectedManualContacts([]);
      loadManualLeads();
      loadGlobalData();
    }, 1000);
  };

  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  const handleSendDirect = async () => {
    if (!selectedLeadForManual || selectedManualContacts.length === 0) return;

    const selectedContact = manualContacts.find(c => selectedManualContacts.includes(c.email));
    let personalizedEmail = manualEmail;

    if (selectedContact && selectedContact.name) {
      const firstName = selectedContact.name.split(' ')[0];
      personalizedEmail = personalizedEmail.replace(/Hey \w+ -/i, `Hey ${firstName} -`);
      personalizedEmail = personalizedEmail.replace(/Hey there -/i, `Hey ${firstName} -`);
    }

    setIsSending(true);
    setSendResult(null);
    try {
      const result = await sendEmail(selectedLeadForManual.id, personalizedEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website);
      setSendResult({ success: true, recipients: result.recipients });
      
      // Reset UI after brief delay to show success
      setTimeout(async () => {
        setManualStep(1);
        setSelectedLeadForManual(null);
        setManualEmail('');
        setManualContacts([]);
        setSelectedManualContacts([]);
        setSendResult(null);
        await loadGlobalData();
        await loadManualLeads();
      }, 1500);
    } catch (e) {
      console.error(e);
      setSendResult({ error: e.message });
    }
    setIsSending(false);
  };

  const handleExportFromContacts = async () => {
    if (!selectedLeadForManual || selectedManualContacts.length === 0) return;

    const selectedContact = manualContacts.find(c => selectedManualContacts.includes(c.email));
    let personalizedEmail = manualEmail;

    if (selectedContact && selectedContact.name) {
      const firstName = selectedContact.name.split(' ')[0];
      personalizedEmail = personalizedEmail.replace(/Hey \w+ -/i, `Hey ${firstName} -`);
      personalizedEmail = personalizedEmail.replace(/Hey there -/i, `Hey ${firstName} -`);
    }

    await exportToGmail(selectedLeadForManual.id, personalizedEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website);
    
    setManualStep(1);
    setSelectedLeadForManual(null);
    setManualEmail('');
    setManualContacts([]);
    setSelectedManualContacts([]);
    await loadGlobalData();
    await loadManualLeads();
  };

  // ═══════════════════════════════════════════
  // ADD LEADS
  // ═══════════════════════════════════════════

  const handleAddSingle = async () => {
    if (!newWebsite.trim()) return;
    try {
      await addLead(newWebsite);
      setNewWebsite('');
      const count = await getTotalLeadCount();
      setTotalLeadCount(count);
      loadEnrichLeads();
    } catch (e) { alert(e.message); }
  };

  const handleBulkAdd = async () => {
    const websites = bulkWebsites.split('\n').map(w => w.trim()).filter(w => w);
    if (!websites.length) return;
    try {
      const { added, skipped } = await bulkAddLeads(websites);
      setBulkWebsites('');
      const count = await getTotalLeadCount();
      setTotalLeadCount(count);
      loadEnrichLeads();
      alert(`✅ Added ${added} leads. Skipped ${skipped} duplicates.`);
    } catch (e) { alert(e.message); }
  };

  const handleCSVUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const lines = e.target.result.split('\n').filter(l => l.trim());
        if (lines.length < 2) { alert('No data found in CSV'); setIsUploading(false); return; }

        // Parse header
        const headerLine = lines[0];
        const headers = headerLine.split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));

        // Map common column name variations
        const colMap = {
          'website': ['website', 'domain', 'url', 'site'],
          'industry': ['industry', 'vertical', 'category', 'niche'],
          'country': ['country', 'location', 'region'],
          'sells_d2c': ['sells_d2c', 'selss_d2c', 'd2c', 'dtc', 'sells_dtc'],
          'icp_fit': ['icp_fit', 'icp', 'fit', 'score'],
          'headquarters': ['headquarters', 'hq', 'address'],
          'platform': ['platform', 'ecommerce_platform'],
          'catalog_size': ['catalog_size', 'products', 'product_count'],
          'city': ['city'],
          'state': ['state', 'province'],
        };

        // Find column indices
        const colIdx = {};
        for (const [field, aliases] of Object.entries(colMap)) {
          const idx = headers.findIndex(h => aliases.includes(h));
          if (idx !== -1) colIdx[field] = idx;
        }

        if (!('website' in colIdx)) { alert('No "website" column found in CSV'); setIsUploading(false); return; }

        // Parse rows
        const leads = [];
        for (let i = 1; i < lines.length; i++) {
          // Handle quoted CSV values
          const row = lines[i].match(/(".*?"|[^",]+|(?<=,)(?=,))/g)?.map(v => v.replace(/^"|"$/g, '').trim()) || lines[i].split(',').map(v => v.trim());

          const website = (row[colIdx.website] || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').trim();
          if (!website || !website.includes('.')) continue;

          const lead = { website };
          for (const [field, idx] of Object.entries(colIdx)) {
            if (field !== 'website' && row[idx]) {
              lead[field] = row[idx].trim();
            }
          }
          leads.push(lead);
        }

        if (!leads.length) { alert('No valid websites found'); setIsUploading(false); return; }

        const { added, skipped } = await bulkAddLeads(leads, 'csv_upload');
        const count = await getTotalLeadCount();
        setTotalLeadCount(count);
        loadEnrichLeads();
        alert(`✅ Imported ${added} leads. Skipped ${skipped} duplicates.`);
      } catch (e) { alert(e.message); }
      setIsUploading(false);
    };
    reader.readAsText(file);
  };

  // ═══════════════════════════════════════════
  // AGENT SETTINGS
  // ═══════════════════════════════════════════

  const updateAgentSettings = async (updates) => {
    try {
      const { error } = await supabase.from('agent_settings').update(updates).eq('id', '00000000-0000-0000-0000-000000000001');
      if (!error) setAgentSettings({ ...agentSettings, ...updates });
    } catch (e) { console.error(e); }
  };

  // ═══════════════════════════════════════════
  // PIPELINE
  // ═══════════════════════════════════════════

  const loadPipeline = async () => {
    try {
      const { leads, totalCount } = await searchLeads({
        search: pipelineSearch,
        status: pipelineFilter,
        page: pipelinePage,
        pageSize: PIPELINE_PAGE_SIZE
      });

      // Enrich with outreach history
      const websites = leads.map(l => l.website);
      let outreachMap = {};
      if (websites.length > 0) {
        const { data: outreachData } = await supabase
          .from('outreach_log')
          .select('website, contact_email, contact_name, email_subject, email_body, sent_at, replied_at')
          .in('website', websites)
          .order('sent_at', { ascending: false });

        for (const o of (outreachData || [])) {
          if (!outreachMap[o.website]) outreachMap[o.website] = [];
          outreachMap[o.website].push(o);
        }
      }

      const enrichedLeads = leads.map(lead => ({
        ...lead,
        outreach_history: outreachMap[lead.website] || [],
      }));

      setPipelineLeads(enrichedLeads);
      setPipelineTotalCount(totalCount);

      // Pipeline stats — total contacts and % contacted
      const { count: totalWithContacts } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('has_contacts', true);
      const { count: totalContacted } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'contacted');
      const { count: totalReplied } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'replied');

      const contacted = (totalContacted || 0) + (totalReplied || 0);
      setPipelineStats({
        totalContacts: totalWithContacts || 0,
        contacted,
        pctContacted: totalWithContacts > 0 ? (contacted / totalWithContacts * 100).toFixed(1) : 0,
      });
    } catch (e) { console.error(e); }
  };

  const openEmailDetail = (lead) => {
    setEmailDetailLead(lead);
    setEmailDetailData(lead.outreach_history || []);
  };

  useEffect(() => { if (activeView === 'pipeline') loadPipeline(); }, [activeView, pipelineFilter, pipelinePage, pipelineSearch]);

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  const enrichTotalPages = Math.ceil(enrichTotalCount / ENRICH_PAGE_SIZE);
  const enrichStart = enrichTotalCount > 0 ? enrichPage * ENRICH_PAGE_SIZE + 1 : 0;
  const enrichEnd = Math.min((enrichPage + 1) * ENRICH_PAGE_SIZE, enrichTotalCount);

  const formatContactedDates = (contactedAt) => {
    if (!contactedAt || !contactedAt.length) return null;
    return contactedAt.map(d => new Date(d).toLocaleDateString()).join(', ');
  };

  // Country badge component
  const CountryBadge = ({ country }) => {
    if (!country) return null;
    const label = country === 'US (assumed)' ? '🇺🇸 US' : country === 'Canada' ? '🇨🇦 CA' : country === 'UK' ? '🇬🇧 UK' : country;
    return (
      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600', backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }}>
        {label}
      </span>
    );
  };

  // Lead card component used in both Enrich and Manual
  const LeadCard = ({ lead, selected, onClick, showContacted }) => (
    <div
      className={`lead-enrich-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {onClick && (
        <div className="lead-checkbox">
          <input type="checkbox" checked={selected} readOnly />
        </div>
      )}
      <div className="lead-info">
        <h4>{lead.website}</h4>
        {lead.status === 'enriched' && <span className="status-badge enriched">ENRICHED</span>}
        {lead.status === 'contacted' && <span className="status-badge contacted" style={{ backgroundColor: 'rgba(34,197,94,0.2)', color: '#4ade80' }}>CONTACTED</span>}
        {lead.status === 'replied' && <span className="status-badge contacted" style={{ backgroundColor: 'rgba(36,94,249,0.2)', color: '#245ef9' }}>REPLIED</span>}
        {lead.icp_fit && <span className={`icp-badge ${lead.icp_fit.toLowerCase()}`}>{lead.icp_fit}</span>}
        <CountryBadge country={lead.country} />
      </div>
      {lead.industry && <div style={{ fontSize: '12px', opacity: 0.7, marginTop: '4px' }}>{lead.industry}</div>}
      {lead.fit_reason && <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '2px' }}>{lead.fit_reason}</div>}
      {!lead.fit_reason && lead.research_notes && (
        <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '2px' }}>{lead.research_notes.substring(0, 80)}...</div>
      )}
      {(lead.catalog_size || lead.google_shopping) && (
        <div style={{ marginTop: '4px', fontSize: '10px', opacity: 0.4 }}>
          {lead.sells_d2c && `D2C: ${lead.sells_d2c}`}
          {lead.catalog_size && ` · ${lead.catalog_size}`}
          {lead.google_shopping && ` · GShop: ${lead.google_shopping}`}
        </div>
      )}

      {/* Outreach History */}
      {lead.outreach_history && lead.outreach_history.length > 0 ? (
        <div style={{ marginTop: '6px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
          {lead.outreach_history.map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', marginTop: i > 0 ? '3px' : 0 }}>
              <span style={{ color: o.replied_at ? '#245ef9' : '#4ade80' }}>
                {o.replied_at ? '💬' : '✓'}
              </span>
              <span style={{ color: o.replied_at ? '#245ef9' : '#4ade80', fontWeight: 500 }}>
                {o.contact_name || o.contact_email}
              </span>
              {o.contact_name && (
                <span style={{ color: 'rgba(255,255,255,0.25)' }}>
                  {o.contact_email}
                </span>
              )}
              <span style={{ color: 'rgba(255,255,255,0.2)', marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: '9px' }}>
                {new Date(o.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              {o.replied_at && (
                <span style={{ color: '#245ef9', fontSize: '9px', fontWeight: 600 }}>REPLIED</span>
              )}
            </div>
          ))}
        </div>
      ) : lead.has_contacts ? (
        <div style={{ marginTop: '4px', fontSize: '10px', color: '#9015ed' }}>
          📧 {lead.contact_name || 'Contact available'}{lead.contact_email ? ` · ${lead.contact_email}` : ''}
        </div>
      ) : (
        <div style={{ marginTop: '4px', fontSize: '10px', color: 'rgba(255,255,255,0.25)' }}>
          ⚠️ No contact email
        </div>
      )}
    </div>
  );

  // ═══════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════

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
            <span className="stat-value">{enrichedCount}</span>
            <span className="stat-label">Enriched</span>
          </div>
          <div className="stat">
            <span className="stat-value" style={{ opacity: 0.5 }}>{unenrichedCount}</span>
            <span className="stat-label">Unenriched</span>
          </div>
          <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 4px' }} />
          <div className="stat">
            <span className="stat-value" style={{ color: '#22c55e' }}>{icpCounts.high}</span>
            <span className="stat-label">HIGH</span>
          </div>
          <div className="stat">
            <span className="stat-value" style={{ color: '#eab308' }}>{icpCounts.medium}</span>
            <span className="stat-label">MED</span>
          </div>
          <div className="stat">
            <span className="stat-value" style={{ color: '#ef4444' }}>{icpCounts.low}</span>
            <span className="stat-label">LOW</span>
          </div>
          <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 4px' }} />
          <div className="stat">
            <span className="stat-value" style={{ color: '#9015ed' }}>{emailsSent}</span>
            <span className="stat-label">Emails Sent</span>
          </div>
          <div className="stat">
            <button onClick={handleCheckBounces} disabled={isCheckingBounces}
              style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.4)', backgroundColor: isCheckingBounces ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.15)', color: '#f87171', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' }}>
              {isCheckingBounces ? '⏳ Checking...' : '🔄 Check Bounces'}
            </button>
            {bounceResult && bounceResult.bouncedEmails?.length > 0 && (
              <span style={{ fontSize: '10px', color: '#f87171', marginTop: '4px', display: 'block' }}>
                {bounceResult.bouncedEmails.length} bounced
              </span>
            )}
            {bounceResult && bounceResult.bouncedEmails?.length === 0 && (
              <span style={{ fontSize: '10px', color: '#4ade80', marginTop: '4px', display: 'block' }}>
                ✓ No bounces
              </span>
            )}
          </div>
          <div style={{ marginLeft: '8px' }}>
            <button onClick={() => supabase.auth.signOut()}
              style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap', fontFamily: 'inherit', transition: 'all 0.15s' }}
              onMouseEnter={(e) => { e.target.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.target.style.color = 'rgba(255,255,255,0.7)'; }}
              onMouseLeave={(e) => { e.target.style.backgroundColor = 'rgba(255,255,255,0.04)'; e.target.style.color = 'rgba(255,255,255,0.4)'; }}>
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <div className="main-layout">
        <aside className="vertical-sidebar">
          {[
            { key: 'add', icon: '➕', label: 'Add Leads' },
            { key: 'enrich', icon: '🔬', label: 'Enrich Leads' },
            { key: 'manual', icon: '✉️', label: 'Manual Outreach' },
            { key: 'agent', icon: '🤖', label: 'Manage Agent' },
            { key: 'pipeline', icon: '📊', label: 'Pipeline' },
          ].map(item => (
            <button key={item.key} className={`sidebar-btn ${activeView === item.key ? 'active' : ''}`} onClick={() => setActiveView(item.key)}>
              <span className="btn-icon">{item.icon}</span>
              <span className="btn-label">{item.label}</span>
            </button>
          ))}
        </aside>

        <main className="main-content">

          {/* ═══ ADD LEADS ═══ */}
          {activeView === 'add' && (
            <div className="view-container">
              <h2>+ Add Leads</h2>

              {/* Tab Bar */}
              <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '5px', marginBottom: '24px' }}>
                {[
                  { key: 'single', icon: '🌐', label: 'Single Website' },
                  { key: 'bulk', icon: '📋', label: 'Bulk Add' },
                  { key: 'csv', icon: '📄', label: 'Import CSV' },
                  { key: 'discover', icon: '🔍', label: 'Discover' },
                ].map(t => (
                  <button key={t.key} onClick={() => setAddTab(t.key)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                      padding: '12px 16px', borderRadius: '10px', border: 'none',
                      background: addTab === t.key ? 'rgba(144,21,237,0.15)' : 'transparent',
                      color: addTab === t.key ? '#c6beee' : 'rgba(255,255,255,0.45)',
                      fontFamily: 'inherit', fontSize: '14px', fontWeight: addTab === t.key ? 600 : 500,
                      cursor: 'pointer', transition: 'all 0.2s',
                      boxShadow: addTab === t.key ? '0 0 0 1px rgba(144,21,237,0.25)' : 'none',
                    }}>
                    <span>{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>

              {/* ── Single Website ── */}
              {addTab === 'single' && (
                <div className="add-method-card" style={{ maxWidth: '600px' }}>
                  <h3>Add a single website</h3>
                  <p>Enter a domain to add it to your pipeline.</p>
                  <div className="input-group">
                    <input type="text" placeholder="e.g. allbirds.com" value={newWebsite}
                      onChange={(e) => setNewWebsite(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddSingle()} />
                    <button onClick={handleAddSingle} className="primary-btn" disabled={!newWebsite.trim()}>➕ Add Lead</button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <div onClick={() => setAutoEnrich(!autoEnrich)}
                      style={{ width: '40px', height: '22px', borderRadius: '11px', background: autoEnrich ? 'rgba(144,21,237,0.6)' : 'rgba(255,255,255,0.12)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}>
                      <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'white', position: 'absolute', top: '3px', left: autoEnrich ? '21px' : '3px', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                    </div>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                      <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Auto-enrich on add</strong> — runs StoreLeads → Apollo → Claude waterfall + contact matching
                    </span>
                  </div>
                </div>
              )}

              {/* ── Bulk Add ── */}
              {addTab === 'bulk' && (
                <div className="add-method-card" style={{ maxWidth: '600px' }}>
                  <h3>Add multiple websites</h3>
                  <p>Paste one domain per line. Duplicates are automatically skipped.</p>
                  <textarea placeholder={"allbirds.com\naway.com\nbrookinen.com\noutdoorvoices.com\nparachutehome.com"}
                    value={bulkWebsites} onChange={(e) => setBulkWebsites(e.target.value)}
                    style={{ minHeight: '180px', lineHeight: '1.7' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.35)' }}>
                      {bulkWebsites.split('\n').filter(w => w.trim()).length > 0
                        ? `${bulkWebsites.split('\n').filter(w => w.trim()).length} domain(s) ready`
                        : 'No domains entered'}
                    </span>
                    <button onClick={handleBulkAdd} className="primary-btn"
                      disabled={bulkWebsites.split('\n').filter(w => w.trim()).length === 0}>
                      ➕ Add {bulkWebsites.split('\n').filter(w => w.trim()).length} Lead{bulkWebsites.split('\n').filter(w => w.trim()).length !== 1 ? 's' : ''}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <div onClick={() => setAutoEnrich(!autoEnrich)}
                      style={{ width: '40px', height: '22px', borderRadius: '11px', background: autoEnrich ? 'rgba(144,21,237,0.6)' : 'rgba(255,255,255,0.12)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}>
                      <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'white', position: 'absolute', top: '3px', left: autoEnrich ? '21px' : '3px', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                    </div>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                      <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Auto-enrich on add</strong> — waterfall enrichment runs for each domain after import
                    </span>
                  </div>
                </div>
              )}

              {/* ── CSV Import ── */}
              {addTab === 'csv' && (
                <div className="add-method-card" style={{ maxWidth: '600px' }}>
                  <h3>Import from CSV</h3>
                  <p>Upload a .csv file with a <span style={{ color: '#c6beee', fontWeight: 600 }}>website</span> column. Additional columns are mapped automatically.</p>
                  <label style={{ display: 'block', cursor: 'pointer' }}>
                    <div style={{ border: '2px dashed rgba(255,255,255,0.1)', borderRadius: '14px', padding: '48px 32px', textAlign: 'center', transition: 'all 0.2s', background: 'rgba(0,0,0,0.15)' }}>
                      <div style={{ fontSize: '40px', marginBottom: '12px', opacity: 0.7 }}>📄</div>
                      <div style={{ fontSize: '15px', fontWeight: 500, color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                        {isUploading ? '⏳ Uploading...' : 'Drop CSV here or click to browse'}
                      </div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', marginBottom: '16px' }}>Accepts .csv files</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center' }}>
                        {[
                          { name: 'website', required: true }, { name: 'industry' }, { name: 'country' },
                          { name: 'sells_d2c' }, { name: 'icp_fit' }, { name: 'platform' },
                          { name: 'city' }, { name: 'state' }, { name: 'catalog_size' },
                        ].map(col => (
                          <span key={col.name} style={{
                            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace',
                            background: col.required ? 'rgba(144,21,237,0.15)' : 'rgba(255,255,255,0.06)',
                            color: col.required ? '#c6beee' : 'rgba(255,255,255,0.4)',
                            border: col.required ? '1px solid rgba(144,21,237,0.2)' : 'none',
                          }}>{col.name}{col.required ? ' *' : ''}</span>
                        ))}
                      </div>
                    </div>
                    <input type="file" accept=".csv" onChange={handleCSVUpload} disabled={isUploading} style={{ display: 'none' }} />
                  </label>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.25)', marginTop: '12px', lineHeight: 1.5 }}>
                    Column names are auto-detected (supports variations like <code style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>domain</code>, <code style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>url</code>, <code style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>site</code> for website). Existing domains are skipped.
                  </div>
                </div>
              )}

              {/* ── Discover ── */}
              {addTab === 'discover' && (
                <div className="add-method-card" style={{ maxWidth: '700px' }}>
                  <h3>Discover new leads</h3>
                  <p>Search StoreLeads or Apollo to find ecommerce stores matching your ICP. New domains are automatically added to your pipeline.</p>

                  {/* Source Toggle */}
                  <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '4px', marginBottom: '24px' }}>
                    <button onClick={() => setDiscoverSource('storeleads')}
                      style={{
                        flex: 1, padding: '10px 16px', border: 'none', borderRadius: '8px',
                        background: discoverSource === 'storeleads' ? 'rgba(255,255,255,0.08)' : 'transparent',
                        color: discoverSource === 'storeleads' ? '#e2e8f0' : 'rgba(255,255,255,0.45)',
                        fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                        boxShadow: discoverSource === 'storeleads' ? '0 0 0 1px rgba(255,255,255,0.08)' : 'none',
                      }}>
                      🛍️ StoreLeads — Stores by category, rank & sales
                    </button>
                    <button onClick={() => setDiscoverSource('apollo')}
                      style={{
                        flex: 1, padding: '10px 16px', border: 'none', borderRadius: '8px',
                        background: discoverSource === 'apollo' ? 'rgba(255,255,255,0.08)' : 'transparent',
                        color: discoverSource === 'apollo' ? '#e2e8f0' : 'rgba(255,255,255,0.45)',
                        fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                        boxShadow: discoverSource === 'apollo' ? '0 0 0 1px rgba(255,255,255,0.08)' : 'none',
                      }}>
                      🚀 Apollo — Companies by industry, revenue & size
                    </button>
                  </div>

                  {/* Category Filter */}
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '10px' }}>
                      {discoverSource === 'storeleads' ? 'Store Categories' : 'Industries'}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {['Fashion & Apparel', 'Home & Garden', 'Electronics', 'Sporting & Outdoors', 'Health & Beauty', 'Food & Beverage', 'Toys & Games', 'Jewelry & Accessories', 'Automotive', 'Pet Supplies'].map(cat => (
                        <button key={cat} onClick={() => setDiscoverCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])}
                          style={{
                            padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer',
                            border: discoverCategories.includes(cat) ? '1px solid rgba(144,21,237,0.3)' : '1px solid rgba(255,255,255,0.08)',
                            background: discoverCategories.includes(cat) ? 'rgba(144,21,237,0.15)' : 'transparent',
                            color: discoverCategories.includes(cat) ? '#c6beee' : 'rgba(255,255,255,0.45)',
                            transition: 'all 0.15s',
                          }}>{cat}</button>
                      ))}
                    </div>
                  </div>

                  {/* Country Filter */}
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '10px' }}>Countries</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {[{ code: 'US', label: '🇺🇸 United States' }, { code: 'CA', label: '🇨🇦 Canada' }, { code: 'GB', label: '🇬🇧 United Kingdom' }, { code: 'AU', label: '🇦🇺 Australia' }, { code: 'DE', label: '🇩🇪 Germany' }].map(c => (
                        <button key={c.code} onClick={() => setDiscoverCountries(prev => prev.includes(c.code) ? prev.filter(x => x !== c.code) : [...prev, c.code])}
                          style={{
                            padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer',
                            border: discoverCountries.includes(c.code) ? '1px solid rgba(144,21,237,0.3)' : '1px solid rgba(255,255,255,0.08)',
                            background: discoverCountries.includes(c.code) ? 'rgba(144,21,237,0.15)' : 'transparent',
                            color: discoverCountries.includes(c.code) ? '#c6beee' : 'rgba(255,255,255,0.45)',
                            transition: 'all 0.15s',
                          }}>{c.label}</button>
                      ))}
                    </div>
                  </div>

                  {/* Numeric Filters */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                    <div>
                      <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '6px', fontWeight: 500 }}>
                        {discoverSource === 'storeleads' ? 'Min Products' : 'Min Employees'}
                      </label>
                      <input type="number" value={discoverMinProducts} onChange={(e) => setDiscoverMinProducts(Number(e.target.value))}
                        style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', outline: 'none' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '6px', fontWeight: 500 }}>
                        {discoverSource === 'storeleads' ? 'Min Monthly Sales ($)' : 'Min Annual Revenue ($)'}
                      </label>
                      <input type="number" value={discoverMinRevenue} onChange={(e) => setDiscoverMinRevenue(Number(e.target.value))}
                        style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', outline: 'none' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '6px', fontWeight: 500 }}>Max Results</label>
                      <input type="number" value={discoverMaxResults} onChange={(e) => setDiscoverMaxResults(Number(e.target.value))} min={10} max={500}
                        style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', outline: 'none' }} />
                    </div>
                  </div>

                  {/* Discover Button */}
                  {!discoverStatus && (
                    <button className="primary-btn" disabled={discoverCategories.length === 0 || discoverCountries.length === 0}
                      onClick={async () => {
                        setDiscoverStatus('running');
                        setDiscoverResults(null);
                        try {
                          const res = await fetch('/.netlify/functions/storeleads-top500', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ categories: discoverCategories, countries: discoverCountries, minProducts: discoverMinProducts, maxResults: discoverMaxResults }),
                          });
                          const data = await res.json();
                          setDiscoverResults(data);
                          setDiscoverStatus('done');
                          const count = await getTotalLeadCount();
                          setTotalLeadCount(count);
                          await loadGlobalData();
                        } catch (err) {
                          console.error('Discover error:', err);
                          setDiscoverStatus('done');
                          setDiscoverResults({ error: err.message });
                        }
                      }}
                      style={{ width: '100%', justifyContent: 'center', padding: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      🔍 Discover {discoverSource === 'storeleads' ? 'Stores' : 'Companies'}
                    </button>
                  )}

                  {/* Running */}
                  {discoverStatus === 'running' && (
                    <div style={{ textAlign: 'center', padding: '40px' }}>
                      <div style={{ width: '32px', height: '32px', border: '3px solid rgba(144,21,237,0.2)', borderTopColor: '#9015ed', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
                      <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)' }}>Searching {discoverSource === 'storeleads' ? 'StoreLeads' : 'Apollo'}...</div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', marginTop: '6px' }}>
                        Filtering by {discoverCategories.length} categories across {discoverCountries.length} countries
                      </div>
                      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                    </div>
                  )}

                  {/* Results */}
                  {discoverStatus === 'done' && discoverResults && !discoverResults.error && (
                    <div style={{ background: 'rgba(144,21,237,0.06)', border: '1px solid rgba(144,21,237,0.15)', borderRadius: '14px', padding: '28px', marginTop: '24px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        ✅ Discovery Complete
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                        <div style={{ textAlign: 'center', padding: '14px', borderRadius: '10px', background: 'rgba(0,0,0,0.2)' }}>
                          <span style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: '#c6beee', display: 'block' }}>{discoverResults.totalFetched || 0}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', display: 'block' }}>Found</span>
                        </div>
                        <div style={{ textAlign: 'center', padding: '14px', borderRadius: '10px', background: 'rgba(0,0,0,0.2)' }}>
                          <span style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: '#4ade80', display: 'block' }}>{discoverResults.newAdded || 0}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', display: 'block' }}>New Added</span>
                        </div>
                        <div style={{ textAlign: 'center', padding: '14px', borderRadius: '10px', background: 'rgba(0,0,0,0.2)' }}>
                          <span style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.3)', display: 'block' }}>{discoverResults.alreadyExisted || 0}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', display: 'block' }}>Already Existed</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                        <button className="secondary-btn" onClick={() => { setDiscoverStatus(null); setDiscoverResults(null); }}>🔍 New Search</button>
                        <button className="primary-btn" onClick={() => { setActiveView('enrich'); loadEnrichLeads(); }}>🔬 Enrich New Leads →</button>
                      </div>
                    </div>
                  )}

                  {discoverStatus === 'done' && discoverResults?.error && (
                    <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '16px', marginTop: '16px', color: '#f87171', fontSize: '13px' }}>
                      ❌ Error: {discoverResults.error}
                      <button className="secondary-btn" onClick={() => { setDiscoverStatus(null); setDiscoverResults(null); }} style={{ marginTop: '12px' }}>Try Again</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ═══ ENRICH LEADS ═══ */}
          {activeView === 'enrich' && (
            <div className="view-container">
              {/* Enrichment result modal */}
              {enrichResult && (
                <div style={{
                  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                  backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
                }}>
                  <div style={{
                    backgroundColor: '#0d1530', borderRadius: '16px', padding: '32px', maxWidth: '500px', width: '90%',
                    border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center'
                  }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
                    <h3 style={{ marginBottom: '8px' }}>Enrichment Complete!</h3>
                    <p style={{ opacity: 0.7, marginBottom: '24px' }}>
                      {enrichResult.success.length} lead{enrichResult.success.length !== 1 ? 's' : ''} enriched successfully
                      {enrichResult.failed.length > 0 && `, ${enrichResult.failed.length} failed`}
                    </p>
                    {enrichResult.success.length > 0 && (
                      <div style={{ marginBottom: '24px', textAlign: 'left', maxHeight: '200px', overflowY: 'auto' }}>
                        {enrichResult.success.map(l => (
                          <div key={l.id} style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.05)', marginBottom: '4px', fontSize: '13px' }}>
                            <strong>{l.website}</strong>
                            {l.icp_fit && <span className={`icp-badge ${l.icp_fit.toLowerCase()}`} style={{ marginLeft: '8px' }}>{l.icp_fit}</span>}
                            {l.fit_reason && <div style={{ opacity: 0.6, fontSize: '11px', marginTop: '2px' }}>{l.fit_reason}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                      <button className="primary-btn" onClick={() => { setEnrichResult(null); setActiveView('manual'); loadManualLeads(); }}>
                        ✉️ Start Outreach
                      </button>
                      <button className="secondary-btn" onClick={() => { setEnrichResult(null); loadEnrichLeads(); }}>
                        🔬 Keep Enriching
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Enrichment progress overlay */}
              {isEnriching && enrichProgress && (
                <div style={{
                  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                  backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
                }}>
                  <div style={{
                    backgroundColor: '#0d1530', borderRadius: '16px', padding: '32px', maxWidth: '400px', width: '90%',
                    border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center'
                  }}>
                    <div style={{ fontSize: '36px', marginBottom: '16px' }}>🔬</div>
                    <h3>Enriching Leads...</h3>
                    <p style={{ opacity: 0.7 }}>{enrichProgress.current} of {enrichProgress.total}</p>
                    <p style={{ fontSize: '13px', opacity: 0.5 }}>{enrichProgress.currentSite}</p>
                    <div style={{ height: '4px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '16px' }}>
                      <div style={{ height: '100%', backgroundColor: '#9015ed', borderRadius: '2px', width: `${(enrichProgress.current / enrichProgress.total) * 100}%`, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                </div>
              )}

              <div className="view-header">
                <h2>🔬 Enrich Leads with AI</h2>
                <div className="view-actions">
                  <button onClick={selectAllOnPage} className="secondary-btn">
                    Select All on Page ({enrichLeadsList.length})
                  </button>
                  <button onClick={handleEnrich} disabled={selectedLeads.length === 0 || isEnriching} className="primary-btn">
                    {isEnriching ? '🔬 Enriching...' : `Enrich ${selectedLeads.length} Lead(s)`}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text" placeholder="🔍 Search by website or notes..."
                  value={enrichSearchTerm}
                  onChange={(e) => { setEnrichSearchTerm(e.target.value); debouncedEnrichSearch(e.target.value); }}
                  style={{ flex: '1', minWidth: '250px', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'inherit', fontSize: '14px' }}
                />
                <select value={enrichFilterCountry} onChange={(e) => { setEnrichFilterCountry(e.target.value); setEnrichPage(0); }}
                  style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '14px' }}>
                  <option value="all">All Countries</option>
                  <option value="US/CA">🇺🇸🇨🇦 US & Canada</option>
                  <option value="International">🌍 International</option>
                  <option value="Unknown">❓ Unknown</option>
                </select>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                  {isLoadingEnrich ? '⏳' : `${enrichStart}–${enrichEnd} of ${enrichTotalCount} unenriched`}
                </span>
              </div>

              <div className="leads-grid">
                {enrichLeadsList.map(lead => (
                  <LeadCard key={lead.id} lead={lead} selected={selectedLeads.includes(lead.id)} onClick={() => toggleLeadSelection(lead.id)} />
                ))}
              </div>

              {enrichTotalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '24px', paddingBottom: '20px' }}>
                  <button onClick={() => setEnrichPage(p => Math.max(0, p - 1))} disabled={enrichPage === 0}
                    style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>⟨ Prev</button>
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', lineHeight: '36px' }}>Page {enrichPage + 1} of {enrichTotalPages}</span>
                  <button onClick={() => setEnrichPage(p => p + 1)} disabled={enrichPage >= enrichTotalPages - 1}
                    style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>Next ⟩</button>
                </div>
              )}
            </div>
          )}

          {/* ═══ MANUAL OUTREACH ═══ */}
          {activeView === 'manual' && (
            <div className="view-container">
              <h2>✉️ Manual Outreach</h2>

              {/* Step indicator */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', alignItems: 'center', flexWrap: 'wrap' }}>
                {[{ n: 1, l: 'Select Lead' }, { n: 2, l: 'Generate Email' }, { n: 3, l: 'Find Contacts' }, { n: 4, l: 'Export to Gmail' }].map((s, i) => (
                  <div key={s.n} style={{ display: 'flex', alignItems: 'center' }}>
                    <div style={{
                      padding: '8px 16px', borderRadius: '20px', fontSize: '13px',
                      backgroundColor: manualStep === s.n ? 'rgba(144,21,237,0.3)' : manualStep > s.n ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
                      border: manualStep === s.n ? '1px solid rgba(144,21,237,0.6)' : '1px solid rgba(255,255,255,0.1)',
                      color: manualStep > s.n ? '#4ade80' : manualStep === s.n ? '#c6beee' : 'rgba(255,255,255,0.4)',
                      fontWeight: manualStep === s.n ? '600' : '400'
                    }}>
                      {manualStep > s.n ? '✓' : s.n} {s.l}
                    </div>
                    {i < 3 && <span style={{ color: 'rgba(255,255,255,0.2)', margin: '0 4px' }}>→</span>}
                  </div>
                ))}
              </div>

              {/* Step 1: Select Lead */}
              {manualStep === 1 && (
                <>
                  <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="text" placeholder="🔍 Search enriched leads..."
                      value={manualSearchTerm}
                      onChange={(e) => { setManualSearchTerm(e.target.value); debouncedManualSearch(e.target.value); }}
                      style={{ flex: '1', minWidth: '200px', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'inherit', fontSize: '14px' }}
                    />
                    <select value={manualFilterContacted} onChange={(e) => { setManualFilterContacted(e.target.value); setManualPage(0); }}
                      style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '14px' }}>
                      <option value="all">All Enriched</option>
                      <option value="not_contacted">Not Contacted</option>
                      <option value="contacted">Already Contacted</option>
                      <option value="has_contacts">Has Contacts</option>
                      <option value="high_with_contacts">HIGH + Has Contacts</option>
                    </select>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                      {isLoadingManual ? '⏳' : `${manualTotalCount} leads`}
                    </span>
                  </div>

                  {selectedLeadForManual && (
                    <div style={{ position: 'sticky', top: 0, zIndex: 10, marginBottom: '16px', padding: '16px', borderRadius: '12px', backgroundColor: 'rgba(144,21,237,0.2)', border: '1px solid rgba(144,21,237,0.5)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backdropFilter: 'blur(12px)' }}>
                      <div>
                        <strong style={{ fontSize: '16px' }}>{selectedLeadForManual.website}</strong>
                        {selectedLeadForManual.icp_fit && <span className={`icp-badge ${selectedLeadForManual.icp_fit.toLowerCase()}`} style={{ marginLeft: '8px' }}>{selectedLeadForManual.icp_fit}</span>}
                        {selectedLeadForManual.industry && <span style={{ marginLeft: '12px', opacity: 0.7, fontSize: '13px' }}>{selectedLeadForManual.industry}</span>}
                      </div>
                      <button className="primary-btn" onClick={() => { setManualStep(2); handleGenerateEmail(); }} style={{ whiteSpace: 'nowrap' }}>Next: Generate Email →</button>
                    </div>
                  )}

                  <div className="leads-grid">
                    {manualLeads.map(lead => (
                      <div key={lead.id} onClick={() => { setSelectedLeadForManual(lead); setManualEmail(''); setManualContacts([]); setSelectedManualContacts([]); }}>
                        <LeadCard lead={lead} selected={selectedLeadForManual?.id === lead.id} showContacted={true} />
                      </div>
                    ))}
                  </div>

                  {manualTotalCount > MANUAL_PAGE_SIZE && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '20px' }}>
                      <button onClick={() => setManualPage(p => Math.max(0, p - 1))} disabled={manualPage === 0}
                        style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>⟨ Prev</button>
                      <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', lineHeight: '36px' }}>Page {manualPage + 1} of {Math.ceil(manualTotalCount / MANUAL_PAGE_SIZE)}</span>
                      <button onClick={() => setManualPage(p => p + 1)} disabled={(manualPage + 1) * MANUAL_PAGE_SIZE >= manualTotalCount}
                        style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>Next ⟩</button>
                    </div>
                  )}
                </>
              )}

              {/* Step 2: Generate Email */}
              {manualStep === 2 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ marginBottom: '20px' }}>
                    <h3 style={{ margin: '0 0 4px 0' }}>{selectedLeadForManual.website}</h3>
                    <span style={{ opacity: 0.6, fontSize: '13px' }}>{selectedLeadForManual.industry} · {selectedLeadForManual.icp_fit} fit</span>
                  </div>
                  {!manualEmail ? (
                    <button className="primary-btn" onClick={handleGenerateEmail} disabled={isGenerating} style={{ width: '100%', padding: '14px' }}>
                      {isGenerating ? '⏳ Generating with AI...' : '✨ Generate Personalized Email'}
                    </button>
                  ) : (
                    <>
                      <div style={{ backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '16px', marginBottom: '16px', position: 'relative' }}>
                        <button onClick={() => navigator.clipboard.writeText(manualEmail)}
                          style={{ position: 'absolute', top: '8px', right: '8px', padding: '4px 10px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', backgroundColor: 'transparent', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '12px' }}>📋 Copy</button>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '13px', lineHeight: '1.5' }}>{manualEmail}</pre>
                      </div>
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <button className="secondary-btn" onClick={handleGenerateEmail} disabled={isGenerating}>🔄 Regenerate</button>
                        <button className="primary-btn" onClick={() => { setManualStep(3); handleFindContacts(); }} style={{ flex: 1 }}>Next: Find Contacts →</button>
                      </div>
                    </>
                  )}
                  <button onClick={() => setManualStep(1)} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to lead selection</button>
                </div>
              )}

              {/* Step 3: Find Contacts */}
              {manualStep === 3 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ marginBottom: '20px' }}>
                    <h3 style={{ margin: '0 0 4px 0' }}>{selectedLeadForManual.website}</h3>
                    <span style={{ opacity: 0.6, fontSize: '13px' }}>Select contacts to reach out to</span>
                  </div>
                  {isLoadingContacts ? (
                    <div style={{ textAlign: 'center', padding: '40px', opacity: 0.6 }}>🔍 Searching for contacts...</div>
                  ) : manualContacts.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '40px' }}>
                      <p style={{ opacity: 0.6 }}>No contacts found for {selectedLeadForManual.website}</p>
                      <button className="secondary-btn" onClick={handleFindContacts}>🔄 Try Again</button>
                    </div>
                  ) : (
                    <>
                      <p style={{ marginBottom: '12px', opacity: 0.7 }}><strong>{manualContacts.length}</strong> contacts found:</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', maxHeight: '400px', overflowY: 'auto' }}>
                        {manualContacts.map(c => (
                          <div key={c.email} onClick={() => toggleContact(c.email)}
                            style={{ padding: '12px 16px', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
                              border: selectedManualContacts.includes(c.email) ? '1px solid rgba(144,21,237,0.6)' : '1px solid rgba(255,255,255,0.1)',
                              backgroundColor: selectedManualContacts.includes(c.email) ? 'rgba(144,21,237,0.15)' : 'rgba(255,255,255,0.03)' }}>
                            <input type="checkbox" checked={selectedManualContacts.includes(c.email)} readOnly />
                            <div style={{ flex: 1 }}>
                              <strong>{c.name}</strong>
                              {c.alreadySent && <span style={{ marginLeft: '8px', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(34,197,94,0.2)', color: '#4ade80' }}>✓ Sent</span>}
                              <div style={{ fontSize: '12px', opacity: 0.7 }}>{c.title}</div>
                              <div style={{ fontSize: '12px', opacity: 0.5 }}>{c.email}</div>
                              {c.alreadySent && <div style={{ fontSize: '10px', opacity: 0.4 }}>Sent {new Date(c.sentAt).toLocaleDateString()}</div>}
                            </div>
                            {c.matchLevel && <span className={`match-badge ${c.matchClass}`}>{c.matchEmoji} {c.matchLevel}</span>}
                          </div>
                        ))}
                      </div>
                      {sendResult?.success && (
                        <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', marginBottom: '12px', textAlign: 'center', color: '#4ade80' }}>
                          ✅ Email sent to {sendResult.recipients?.join(', ')}
                        </div>
                      )}
                      {sendResult?.error && (
                        <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', marginBottom: '12px', textAlign: 'center', color: '#f87171', fontSize: '13px' }}>
                          ❌ {sendResult.error}
                        </div>
                      )}
                      <button className="primary-btn" onClick={handleSendDirect} disabled={selectedManualContacts.length === 0 || isSending} style={{ width: '100%', padding: '14px' }}>
                        {isSending ? '⏳ Sending...' : `📧 Send Email — ${selectedManualContacts.length} Contact(s)`}
                      </button>
                      <button onClick={handleExportFromContacts} disabled={selectedManualContacts.length === 0}
                        style={{ width: '100%', padding: '10px', marginTop: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '12px' }}>
                        Or open in Gmail →
                      </button>
                    </>
                  )}
                  <button onClick={() => setManualStep(2)} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to email</button>
                </div>
              )}

              {/* Step 4: Export */}
              {manualStep === 4 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center' }}>
                  <h3 style={{ marginBottom: '20px' }}>Ready to Send!</h3>
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)', marginBottom: '20px', textAlign: 'left' }}>
                    <div style={{ marginBottom: '12px' }}><strong>Lead:</strong> {selectedLeadForManual.website}</div>
                    <div style={{ marginBottom: '12px' }}><strong>Recipients ({selectedManualContacts.length}):</strong>
                      <div style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px' }}>{selectedManualContacts.join(', ')}</div>
                    </div>
                  </div>
                  <button className="primary-btn" onClick={handleExportToGmail} style={{ width: '100%', padding: '16px', fontSize: '16px' }}>📧 Open in Gmail</button>
                  <p style={{ marginTop: '8px', opacity: 0.5, fontSize: '12px' }}>Opens Gmail with contacts in BCC and your email</p>
                  <button onClick={() => setManualStep(3)} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to contacts</button>
                </div>
              )}
            </div>
          )}

          {/* ═══ MANAGE AGENT ═══ */}
          {activeView === 'agent' && (
            <div className="view-container">
              <div className="agent-header">
                <h2>🤖 AI Agent Manager</h2>
                <div className="agent-status">
                  <div className={`status-indicator ${agentSettings?.agent_enabled ? 'active' : 'paused'}`}>
                    {agentSettings?.agent_enabled ? '🟢 Active' : '⏸️ Paused'}
                  </div>
                  <button className="toggle-agent-btn" onClick={() => updateAgentSettings({ agent_enabled: !agentSettings?.agent_enabled })}>
                    {agentSettings?.agent_enabled ? 'Pause Agent' : 'Start Agent'}
                  </button>
                </div>
              </div>
              <AgentMonitor />

              {/* Editable Settings */}
              <div style={{ marginTop: '24px', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <h3 style={{ margin: '0 0 20px 0' }}>⚙️ Agent Settings</h3>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  {/* Send Hours */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Send Hours (EST)</label>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                      <select value={agentSettings?.send_hours_start || 9} onChange={e => updateAgentSettings({ send_hours_start: parseInt(e.target.value) })}
                        style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit' }}>
                        {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{i}:00</option>)}
                      </select>
                      <span style={{ opacity: 0.5 }}>to</span>
                      <select value={agentSettings?.send_hours_end || 17} onChange={e => updateAgentSettings({ send_hours_end: parseInt(e.target.value) })}
                        style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit' }}>
                        {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{i}:00</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Max Emails Per Day */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Max Emails Per Day</label>
                    <input type="number" value={agentSettings?.max_emails_per_day || 10}
                      onChange={e => updateAgentSettings({ max_emails_per_day: parseInt(e.target.value) })}
                      style={{ width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '16px' }} />
                  </div>

                  {/* Min Minutes Between Emails */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Min Minutes Between Emails</label>
                    <input type="number" value={agentSettings?.min_minutes_between_emails || 10}
                      onChange={e => updateAgentSettings({ min_minutes_between_emails: parseInt(e.target.value) })}
                      style={{ width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '16px' }} />
                  </div>

                  {/* ICP Filter */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>ICP Fit Filter</label>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      {['HIGH', 'MEDIUM', 'LOW'].map(fit => {
                        const allowed = agentSettings?.allowed_icp_fits || ['HIGH'];
                        const isActive = allowed.includes(fit);
                        return (
                          <button key={fit} onClick={() => {
                            const newFits = isActive ? allowed.filter(f => f !== fit) : [...allowed, fit];
                            if (newFits.length > 0) updateAgentSettings({ allowed_icp_fits: newFits });
                          }} style={{
                            flex: 1, padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold',
                            border: isActive ? '1px solid' : '1px solid rgba(255,255,255,0.15)',
                            backgroundColor: isActive ? (fit === 'HIGH' ? 'rgba(34,197,94,0.2)' : fit === 'MEDIUM' ? 'rgba(234,179,8,0.2)' : 'rgba(239,68,68,0.2)') : 'transparent',
                            color: isActive ? (fit === 'HIGH' ? '#4ade80' : fit === 'MEDIUM' ? '#facc15' : '#f87171') : 'rgba(255,255,255,0.3)',
                            borderColor: isActive ? (fit === 'HIGH' ? 'rgba(34,197,94,0.5)' : fit === 'MEDIUM' ? 'rgba(234,179,8,0.5)' : 'rgba(239,68,68,0.5)') : 'rgba(255,255,255,0.15)',
                          }}>{fit}</button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Max Contacts Per Lead Per Day */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Max Contacts Per Lead Per Day</label>
                    <input type="number" value={agentSettings?.max_contacts_per_lead_per_day || 1} min={1} max={5}
                      onChange={e => updateAgentSettings({ max_contacts_per_lead_per_day: parseInt(e.target.value) })}
                      style={{ width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '16px' }} />
                    <div style={{ fontSize: '11px', opacity: 0.4, marginTop: '4px' }}>Agent sends to multiple contacts at a company over multiple days</div>
                  </div>

                  {/* Send Days */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Send Days</label>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => {
                        const sendDays = agentSettings?.send_days || [1, 2, 3, 4, 5];
                        const dayNum = i + 1;
                        const isActive = sendDays.includes(dayNum);
                        return (
                          <button key={day} onClick={() => {
                            const newDays = isActive ? sendDays.filter(d => d !== dayNum) : [...sendDays, dayNum].sort();
                            if (newDays.length > 0) updateAgentSettings({ send_days: newDays });
                          }} style={{
                            flex: 1, padding: '6px 2px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
                            border: isActive ? '1px solid rgba(144,21,237,0.5)' : '1px solid rgba(255,255,255,0.15)',
                            backgroundColor: isActive ? 'rgba(144,21,237,0.2)' : 'transparent',
                            color: isActive ? '#a78bfa' : 'rgba(255,255,255,0.3)',
                          }}>{day}</button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Auto-Send Toggle */}
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                    <label style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Auto-Send</label>
                    <div style={{ marginTop: '8px' }}>
                      <button onClick={() => updateAgentSettings({ auto_send: !agentSettings?.auto_send })}
                        style={{
                          width: '100%', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold',
                          border: agentSettings?.auto_send ? '1px solid rgba(234,179,8,0.5)' : '1px solid rgba(255,255,255,0.15)',
                          backgroundColor: agentSettings?.auto_send ? 'rgba(234,179,8,0.2)' : 'transparent',
                          color: agentSettings?.auto_send ? '#facc15' : 'rgba(255,255,255,0.4)',
                        }}>
                        {agentSettings?.auto_send ? '⚠️ Auto-Send ON' : '📝 Draft Only'}
                      </button>
                      <div style={{ fontSize: '11px', opacity: 0.4, marginTop: '4px' }}>
                        {agentSettings?.auto_send ? 'Agent sends emails automatically' : 'Agent drafts emails for your review'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="activity-section" style={{ marginTop: '24px' }}>
                <h3>Recent Activity</h3>
                <div className="activity-list">
                  {activityLog.slice(0, 20).map(a => (
                    <div key={a.id} className="activity-item">
                      <span className="activity-icon">
                        {a.activity_type === 'lead_enriched' && '🔍'}
                        {a.activity_type === 'email_sent' && '📤'}
                        {a.activity_type === 'email_exported' && '📧'}
                        {a.activity_type === 'email_failed' && '❌'}
                        {a.activity_type === 'email_bounced' && '🔄'}
                        {a.activity_type === 'autonomous_run' && '🤖'}
                        {a.activity_type === 'batch_send' && '📦'}
                        {a.activity_type === 'apollo_discovery' && '🚀'}
                        {a.activity_type === 'apollo_org_enrichment' && '🏢'}
                        {a.activity_type === 'lead_discovery' && '🌐'}
                        {a.activity_type === 'bulk_socials' && '📱'}
                        {a.activity_type === 'prioritized_enrichment' && '⚡'}
                        {a.activity_type === 'contact_matching' && '👥'}
                        {a.activity_type === 'email_verified' && '✅'}
                        {a.activity_type === 'bulk_enrichment' && '📊'}
                        {!['lead_enriched','email_sent','email_exported','email_failed','email_bounced','autonomous_run','batch_send','apollo_discovery','apollo_org_enrichment','lead_discovery','bulk_socials','prioritized_enrichment','contact_matching','email_verified','bulk_enrichment'].includes(a.activity_type) && '📋'}
                      </span>
                      <span className="activity-summary">{a.summary}</span>
                      <span className="activity-time">{new Date(a.created_at).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ═══ PIPELINE ═══ */}
          {activeView === 'pipeline' && (
            <div className="view-container">
              <h2>📊 Lead Pipeline</h2>

              {/* Stats Bar */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
                {[
                  { label: 'Total Leads', value: pipelineTotalCount, color: '#f6f6f7' },
                  { label: 'With Contacts', value: pipelineStats.totalContacts, color: '#9015ed' },
                  { label: 'Contacted', value: pipelineStats.contacted, color: '#4ade80' },
                  { label: '% Contacted', value: `${pipelineStats.pctContacted}%`, color: parseFloat(pipelineStats.pctContacted) > 20 ? '#4ade80' : '#eab308' },
                ].map(s => (
                  <div key={s.label} style={{ flex: 1, padding: '14px 16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginTop: '4px' }}>{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="pipeline-filters">
                <input type="text" placeholder="Search leads..." value={pipelineSearch} onChange={(e) => { setPipelineSearch(e.target.value); setPipelinePage(0); }} className="search-input" style={{ flex: 1 }} />
                <select value={pipelineFilter} onChange={(e) => { setPipelineFilter(e.target.value); setPipelinePage(0); }} className="filter-select">
                  <option value="all">All ({pipelineTotalCount})</option>
                  <option value="new">New</option>
                  <option value="enriched">Enriched</option>
                  <option value="contacted">Contacted</option>
                </select>
              </div>

              <div className="pipeline-table" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Website</th>
                      <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Status</th>
                      <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>ICP</th>
                      <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Industry</th>
                      <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Country</th>
                      <th style={{ textAlign: 'center', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Emails Sent</th>
                      <th style={{ textAlign: 'center', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Last Contacted</th>
                      <th style={{ textAlign: 'center', padding: '10px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Reply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelineLeads.map(lead => (
                      <tr key={lead.id}
                        onClick={() => lead.outreach_history.length > 0 && openEmailDetail(lead)}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: lead.outreach_history.length > 0 ? 'pointer' : 'default', transition: 'background 0.1s' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <td style={{ padding: '10px 12px', fontSize: '13px', fontWeight: 500 }}>{lead.website}</td>
                        <td style={{ padding: '10px 8px' }}><span className={`status-badge ${lead.status}`}>{lead.status}</span></td>
                        <td style={{ padding: '10px 8px' }}>{lead.icp_fit && <span className={`icp-badge ${lead.icp_fit.toLowerCase()}`}>{lead.icp_fit}</span>}</td>
                        <td style={{ padding: '10px 8px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{lead.industry || '—'}</td>
                        <td style={{ padding: '10px 8px', fontSize: '12px' }}>{lead.country || '—'}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                          {lead.outreach_history.length > 0 ? (
                            <span style={{
                              padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600,
                              background: 'rgba(144,21,237,0.12)', color: '#c6beee', cursor: 'pointer',
                            }}>
                              {lead.outreach_history.length} ✉️
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px 8px', textAlign: 'center', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)' }}>
                          {lead.outreach_history.length > 0
                            ? new Date(lead.outreach_history[0].sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : '—'}
                        </td>
                        <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                          {lead.outreach_history.some(o => o.replied_at)
                            ? <span style={{ color: '#245ef9', fontWeight: 600, fontSize: '11px' }}>💬 YES</span>
                            : lead.outreach_history.length > 0
                              ? <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: '11px' }}>—</span>
                              : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pipelineTotalCount > PIPELINE_PAGE_SIZE && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '20px' }}>
                  <button onClick={() => setPipelinePage(p => Math.max(0, p - 1))} disabled={pipelinePage === 0}
                    style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>⟨ Prev</button>
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', lineHeight: '36px' }}>Page {pipelinePage + 1} of {Math.ceil(pipelineTotalCount / PIPELINE_PAGE_SIZE)}</span>
                  <button onClick={() => setPipelinePage(p => p + 1)} disabled={(pipelinePage + 1) * PIPELINE_PAGE_SIZE >= pipelineTotalCount}
                    style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>Next ⟩</button>
                </div>
              )}

              {/* ── Email Detail Modal ── */}
              {emailDetailLead && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
                  onClick={() => setEmailDetailLead(null)}>
                  <div style={{ backgroundColor: '#0d1530', borderRadius: '18px', padding: '32px', maxWidth: '700px', width: '90%', maxHeight: '80vh', overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)' }}
                    onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
                      <div>
                        <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '18px', fontWeight: 700, marginBottom: '4px' }}>
                          {emailDetailLead.website}
                        </h3>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span className={`status-badge ${emailDetailLead.status}`}>{emailDetailLead.status}</span>
                          {emailDetailLead.icp_fit && <span className={`icp-badge ${emailDetailLead.icp_fit.toLowerCase()}`}>{emailDetailLead.icp_fit}</span>}
                          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)' }}>{emailDetailLead.industry}</span>
                        </div>
                      </div>
                      <button onClick={() => setEmailDetailLead(null)}
                        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '20px', cursor: 'pointer', padding: '4px 8px' }}>✕</button>
                    </div>

                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '12px' }}>
                      {emailDetailData.length} Email{emailDetailData.length !== 1 ? 's' : ''} Sent
                    </div>

                    {emailDetailData.map((o, i) => (
                      <div key={i} style={{
                        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: '12px', padding: '16px', marginBottom: '12px',
                        borderLeft: o.replied_at ? '3px solid #245ef9' : '3px solid rgba(144,21,237,0.3)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                          <div>
                            <span style={{ fontWeight: 600, fontSize: '13px' }}>{o.contact_name || 'Contact'}</span>
                            <span style={{ color: 'rgba(255,255,255,0.3)', marginLeft: '8px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" }}>
                              {o.contact_email}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {o.replied_at && (
                              <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: 600, background: 'rgba(36,94,249,0.15)', color: '#245ef9' }}>
                                💬 REPLIED
                              </span>
                            )}
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', fontFamily: "'JetBrains Mono', monospace" }}>
                              {new Date(o.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at {new Date(o.sent_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                        {o.email_subject && (
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '8px' }}>
                            Subject: {o.email_subject}
                          </div>
                        )}
                        {o.email_body && (
                          <div style={{
                            fontSize: '12px', lineHeight: 1.6, color: 'rgba(255,255,255,0.5)',
                            background: 'rgba(0,0,0,0.2)', borderRadius: '8px', padding: '12px',
                            whiteSpace: 'pre-wrap', fontFamily: "'Raleway', sans-serif",
                          }}>
                            {o.email_body}
                          </div>
                        )}
                      </div>
                    ))}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                      <button className="secondary-btn" onClick={() => setEmailDetailLead(null)}>Close</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

export default App;
