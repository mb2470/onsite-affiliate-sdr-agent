import { useState, useEffect, useRef } from 'react';
import './App.css';
import AgentMonitor from './AgentMonitor';
import { supabase } from './supabaseClient';
import { getTotalLeadCount, searchLeads, searchEnrichedLeads, addLead, bulkAddLeads, logActivity } from './services/leadService';
import { enrichLeads } from './services/enrichService';
import { generateEmail } from './services/emailService';
import { findContacts } from './services/contactService';
import { exportToGmail } from './services/exportService';

function App() {
  // Global state
  const [activeView, setActiveView] = useState('add');
  const [totalLeadCount, setTotalLeadCount] = useState(0);
  const [agentSettings, setAgentSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [activityLog, setActivityLog] = useState([]);

  // Add leads state
  const [newWebsite, setNewWebsite] = useState('');
  const [bulkWebsites, setBulkWebsites] = useState('');
  const [isUploading, setIsUploading] = useState(false);

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
        .in('status', ['enriched', 'contacted']);

      if (s && s.trim()) {
        query = query.or(`website.ilike.%${s.trim()}%,research_notes.ilike.%${s.trim()}%,industry.ilike.%${s.trim()}%`);
      }

      const cf = contactedFilter ?? manualFilterContacted;
      if (cf === 'contacted') {
        query = query.eq('status', 'contacted');
      } else if (cf === 'not_contacted') {
        query = query.eq('status', 'enriched');
      }

      const from = p * MANUAL_PAGE_SIZE;
      query = query.order('icp_fit', { ascending: true }).order('created_at', { ascending: false }).range(from, from + MANUAL_PAGE_SIZE - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      setManualLeads(data || []);
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
      const email = await generateEmail(selectedLeadForManual);
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
      setManualContacts(contacts);
    } catch (e) {
      console.error(e);
    }
    setIsLoadingContacts(false);
  };

  const toggleContact = (email) => {
    setSelectedManualContacts(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]);
  };

  const handleExportToGmail = async () => {
    if (!selectedLeadForManual) return;
    await exportToGmail(selectedLeadForManual.id, manualEmail, selectedManualContacts);
    // Reset after short delay
    setTimeout(() => {
      setManualStep(1);
      setSelectedLeadForManual(null);
      setManualEmail('');
      setManualContacts([]);
      setSelectedManualContacts([]);
      loadManualLeads();
    }, 1000);
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
        const websites = e.target.result.split('\n').slice(1).map(row => row.split(',')[0]?.trim()).filter(w => w);
        if (!websites.length) { alert('No valid websites found'); return; }
        const { added, skipped } = await bulkAddLeads(websites, 'csv_upload');
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
      setPipelineLeads(leads);
      setPipelineTotalCount(totalCount);
    } catch (e) { console.error(e); }
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
      {showContacted && lead.contacted_at && lead.contacted_at.length > 0 && (
        <div style={{ marginTop: '4px', fontSize: '10px', color: '#4ade80' }}>
          📧 Contacted: {formatContactedDates(lead.contacted_at)}
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
              <h2>➕ Add New Leads</h2>
              <div className="add-methods">
                <div className="add-method-card">
                  <h3>Add Single Website</h3>
                  <div className="input-group">
                    <input type="text" placeholder="revolut.com" value={newWebsite} onChange={(e) => setNewWebsite(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddSingle()} />
                    <button onClick={handleAddSingle} className="primary-btn">Add Lead</button>
                  </div>
                </div>
                <div className="add-method-card">
                  <h3>Bulk Add Websites</h3>
                  <p>Enter one website per line</p>
                  <textarea placeholder="revolut.com&#10;coach.com&#10;timbuk2.com" value={bulkWebsites} onChange={(e) => setBulkWebsites(e.target.value)} rows={8} />
                  <button onClick={handleBulkAdd} className="primary-btn">Add {bulkWebsites.split('\n').filter(w => w.trim()).length} Leads</button>
                </div>
                <div className="add-method-card">
                  <h3>Upload CSV</h3>
                  <p>CSV with website column, one per row</p>
                  <label className="upload-btn">
                    {isUploading ? '⏳ Uploading...' : '📤 Choose CSV File'}
                    <input type="file" accept=".csv" onChange={handleCSVUpload} disabled={isUploading} style={{ display: 'none' }} />
                  </label>
                </div>
              </div>
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
                    backgroundColor: '#1a1a2e', borderRadius: '16px', padding: '32px', maxWidth: '500px', width: '90%',
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
                    backgroundColor: '#1a1a2e', borderRadius: '16px', padding: '32px', maxWidth: '400px', width: '90%',
                    border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center'
                  }}>
                    <div style={{ fontSize: '36px', marginBottom: '16px' }}>🔬</div>
                    <h3>Enriching Leads...</h3>
                    <p style={{ opacity: 0.7 }}>{enrichProgress.current} of {enrichProgress.total}</p>
                    <p style={{ fontSize: '13px', opacity: 0.5 }}>{enrichProgress.currentSite}</p>
                    <div style={{ height: '4px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '16px' }}>
                      <div style={{ height: '100%', backgroundColor: '#8b5cf6', borderRadius: '2px', width: `${(enrichProgress.current / enrichProgress.total) * 100}%`, transition: 'width 0.3s' }} />
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
                      backgroundColor: manualStep === s.n ? 'rgba(139,92,246,0.3)' : manualStep > s.n ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
                      border: manualStep === s.n ? '1px solid rgba(139,92,246,0.6)' : '1px solid rgba(255,255,255,0.1)',
                      color: manualStep > s.n ? '#4ade80' : manualStep === s.n ? '#c4b5fd' : 'rgba(255,255,255,0.4)',
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
                    </select>
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                      {isLoadingManual ? '⏳' : `${manualTotalCount} leads`}
                    </span>
                  </div>

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

                  {selectedLeadForManual && (
                    <div style={{ position: 'sticky', bottom: 0, marginTop: '20px', padding: '16px', borderRadius: '12px', backgroundColor: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <strong>{selectedLeadForManual.website}</strong>
                        {selectedLeadForManual.icp_fit && <span className={`icp-badge ${selectedLeadForManual.icp_fit.toLowerCase()}`} style={{ marginLeft: '8px' }}>{selectedLeadForManual.icp_fit}</span>}
                        {selectedLeadForManual.industry && <span style={{ marginLeft: '12px', opacity: 0.7, fontSize: '13px' }}>{selectedLeadForManual.industry}</span>}
                      </div>
                      <button className="primary-btn" onClick={() => setManualStep(2)}>Next: Generate Email →</button>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
                        {manualContacts.map(c => (
                          <div key={c.email} onClick={() => toggleContact(c.email)}
                            style={{ padding: '12px 16px', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
                              border: selectedManualContacts.includes(c.email) ? '1px solid rgba(139,92,246,0.6)' : '1px solid rgba(255,255,255,0.1)',
                              backgroundColor: selectedManualContacts.includes(c.email) ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)' }}>
                            <input type="checkbox" checked={selectedManualContacts.includes(c.email)} readOnly />
                            <div style={{ flex: 1 }}>
                              <strong>{c.name}</strong>
                              <div style={{ fontSize: '12px', opacity: 0.7 }}>{c.title}</div>
                              <div style={{ fontSize: '12px', opacity: 0.5 }}>{c.email}</div>
                            </div>
                            {c.matchLevel && <span className={`match-badge ${c.matchClass}`}>{c.matchEmoji} {c.matchLevel}</span>}
                          </div>
                        ))}
                      </div>
                      <button className="primary-btn" onClick={() => setManualStep(4)} disabled={selectedManualContacts.length === 0} style={{ width: '100%', padding: '14px' }}>
                        Next: Export {selectedManualContacts.length} Contact(s) →
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
              <div className="activity-section">
                <h3>Recent Activity</h3>
                <div className="activity-list">
                  {activityLog.slice(0, 15).map(a => (
                    <div key={a.id} className="activity-item">
                      <span className="activity-icon">
                        {a.activity_type === 'lead_enriched' && '🔍'}
                        {a.activity_type === 'email_sent' && '📤'}
                        {a.activity_type === 'email_exported' && '📧'}
                        {a.activity_type === 'email_failed' && '❌'}
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
              <div className="pipeline-filters">
                <input type="text" placeholder="Search leads..." value={pipelineSearch} onChange={(e) => { setPipelineSearch(e.target.value); setPipelinePage(0); }} className="search-input" />
                <select value={pipelineFilter} onChange={(e) => { setPipelineFilter(e.target.value); setPipelinePage(0); }} className="filter-select">
                  <option value="all">All ({pipelineTotalCount})</option>
                  <option value="new">New</option>
                  <option value="enriched">Enriched</option>
                  <option value="contacted">Contacted</option>
                </select>
              </div>
              <div className="pipeline-table">
                <table>
                  <thead>
                    <tr><th>Website</th><th>Status</th><th>ICP Fit</th><th>Industry</th><th>Country</th><th>Contacted</th></tr>
                  </thead>
                  <tbody>
                    {pipelineLeads.map(lead => (
                      <tr key={lead.id}>
                        <td className="website-cell">{lead.website}</td>
                        <td><span className={`status-badge ${lead.status}`}>{lead.status}</span></td>
                        <td>{lead.icp_fit && <span className={`icp-badge ${lead.icp_fit.toLowerCase()}`}>{lead.icp_fit}</span>}</td>
                        <td style={{ fontSize: '12px' }}>{lead.industry || '—'}</td>
                        <td>{lead.country || '—'}</td>
                        <td style={{ fontSize: '12px' }}>{lead.contacted_at?.length ? formatContactedDates(lead.contacted_at) : '—'}</td>
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
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

export default App;
