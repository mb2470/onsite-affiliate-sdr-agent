import { useState, useEffect, useRef, useMemo } from 'react';
import './App.css';
import AgentMonitor from './AgentMonitor';
import ProspectPipeline from './ProspectPipeline';
import Login from './Login';
import PublicIcpIntake from './PublicIcpIntake';
import { supabase } from './supabaseClient';
import { getTotalLeadCount, searchLeads, searchEnrichedLeads, logActivity } from './services/leadService';
import { enrichLeads, setIcpContext } from './services/enrichService';
import { generateEmail, setEmailIcpContext, getCachedEmail, personalizeEmail } from './services/emailService';
import { findContacts, verifyContactEmails } from './services/contactService';
import { sendEmail, exportToGmail } from './services/exportService';
import { clearCachedOrgId } from './services/orgService';
import ChatPanel from './ChatPanel';
import SuperAdminDashboard from './SuperAdminDashboard';

function App() {
  const publicIcpParams = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const isPublic = (params.get('icp_public') || '').trim().toLowerCase() === '1';
    const org = (params.get('org') || params.get('org_slug') || params.get('org_id') || '').trim();
    return isPublic && org ? { org } : null;
  }, []);

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
      clearCachedOrgId();
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (publicIcpParams) {
    return <PublicIcpIntake orgIdentifier={publicIcpParams.org} />;
  }

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
  const EMPTY_ICP_PROFILE = useMemo(() => ({
    // Part 1: Product & Value Propositions
    elevator_pitch: '',
    core_problem: '',
    uvp_1: '',
    uvp_2: '',
    uvp_3: '',
    alternative: '',
    // Part 2: Firmographics
    industries: [],
    company_size: '',
    geography: [],
    revenue_range: '',
    tech_stack: [],
    trigger_events: [],
    // Part 2b: Scoring Thresholds
    min_product_count: 250,
    min_monthly_sales: 1000000,
    min_annual_revenue: 12000000,
    min_employee_count: 50,
    // Part 3: Buyer Persona
    primary_titles: [],
    key_responsibilities: '',
    daily_obstacles: '',
    success_metrics: '',
    user_persona: '',
    gatekeeper_persona: '',
    champion_persona: '',
    // Part 4: Summary
    perfect_fit_narrative: '',
    // Part 5: Messaging & Tone
    sender_name: '',
    sender_url: '',
    email_tone: '',
    social_proof: '',
    messaging_do: [],
    messaging_dont: [],
    email_example: '',
  }), []);

  const icpLinkParams = useMemo(() => {
    if (typeof window === 'undefined') return { targetOrg: '', openIcpView: false };
    const params = new URLSearchParams(window.location.search);
    const targetOrg = (params.get('org') || params.get('org_id') || params.get('org_slug') || '').trim();
    return {
      targetOrg,
      openIcpView: (params.get('view') || '').trim().toLowerCase() === 'icp',
    };
  }, []);

  const isSuperAdmin = (session?.user?.email || '').toLowerCase() === 'mike@onsiteaffiliates.com';
  const [orgLoading, setOrgLoading] = useState(true);
  const [organizations, setOrganizations] = useState([]);
  const [orgId, setOrgId] = useState(null);

  // Global state
  const [activeView, setActiveView] = useState('chat');
  const [totalLeadCount, setTotalLeadCount] = useState(0);
  const [enrichedCount, setEnrichedCount] = useState(0);
  const [unenrichedCount, setUnenrichedCount] = useState(0);
  const [icpCounts, setIcpCounts] = useState({ high: 0, medium: 0, low: 0 });
  const [emailsSent, setEmailsSent] = useState(0);
  const [outreachStats, setOutreachStats] = useState({ uniqueLeads: 0, uniqueContacts: 0, repliedLeads: 0, repliedContacts: 0 });
  const [deliverabilityStats, setDeliverabilityStats] = useState({ delivered: 0, sent: 0, percent: '0.0' });
  const [isCheckingBounces, setIsCheckingBounces] = useState(false);
  const [bounceResult, setBounceResult] = useState(null);
  const [agentSettings, setAgentSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [activityLog, setActivityLog] = useState([]);

  // Add leads state

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
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationMap, setVerificationMap] = useState({});
  const [cachedEmailUsed, setCachedEmailUsed] = useState(false);
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

  // ICP Profile state
  const [icpStep, setIcpStep] = useState(1);
  const [icpProfile, setIcpProfile] = useState(EMPTY_ICP_PROFILE);
  const [icpSaving, setIcpSaving] = useState(false);
  const [icpSaved, setIcpSaved] = useState(false);
  const [icpProfileId, setIcpProfileId] = useState(null);
  const [icpLoaded, setIcpLoaded] = useState(false);

  // ICP tag input helpers
  const [icpIndustryInput, setIcpIndustryInput] = useState('');
  const [icpGeoInput, setIcpGeoInput] = useState('');
  const [icpTechInput, setIcpTechInput] = useState('');
  const [icpTriggerInput, setIcpTriggerInput] = useState('');
  const [icpTitleInput, setIcpTitleInput] = useState('');
  const [icpMsgDoInput, setIcpMsgDoInput] = useState('');
  const [icpMsgDontInput, setIcpMsgDontInput] = useState('');
  const [icpLinkCopied, setIcpLinkCopied] = useState(false);

  // Create Audience state
  const [audienceFit, setAudienceFit] = useState([]);
  const [audienceExportType, setAudienceExportType] = useState(null); // 'company' or 'email'
  const [audienceStep, setAudienceStep] = useState(1);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [audiencePreviewCount, setAudiencePreviewCount] = useState(0);
  const [audienceDownloaded, setAudienceDownloaded] = useState(false);

  // ═══════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════

  const loadOrganizations = async () => {
    setOrgLoading(true);
    try {
      // For super admin, call list_orgs first to auto-link memberships
      if (isSuperAdmin) {
        try {
          const { data: { session: authSession } } = await supabase.auth.getSession();
          if (authSession?.access_token) {
            await fetch('/.netlify/functions/super-admin', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${authSession.access_token}`,
              },
              body: JSON.stringify({ action: 'list_orgs' }),
            });
          }
        } catch (e) {
          console.warn('Super admin org sync failed:', e);
        }
      }

      const { data, error } = await supabase
        .from('user_organizations')
        .select('org_id, organizations(id, name, slug)')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const orgs = (data || []).map((r) => ({
        id: r.org_id,
        name: r.organizations?.name || 'Organization',
        slug: r.organizations?.slug || '',
      }));

      setOrganizations(orgs);

      const storedOrgId = localStorage.getItem('selected_org_id');
      const requestedOrg = icpLinkParams.targetOrg
        ? orgs.find((o) => o.id === icpLinkParams.targetOrg || o.slug === icpLinkParams.targetOrg)
        : null;
      const hasStored = storedOrgId && orgs.some((o) => o.id === storedOrgId);
      const selected = requestedOrg?.id || (hasStored ? storedOrgId : (orgs[0]?.id || null));
      setOrgId(selected);
      if (icpLinkParams.openIcpView) setActiveView('icp');
    } catch (e) {
      console.error('Failed loading organizations:', e);
      setOrganizations([]);
      setOrgId(null);
    }
    setOrgLoading(false);
  };

  useEffect(() => {
    loadOrganizations();
  }, [session.user.id, icpLinkParams]);

  useEffect(() => {
    if (orgId) localStorage.setItem('selected_org_id', orgId);
  }, [orgId]);

  useEffect(() => {
    if (isSuperAdmin && !orgId) {
      setActiveView('super_admin');
    }
  }, [isSuperAdmin, orgId]);

  useEffect(() => {
    if (!orgId) return;
    loadGlobalData();
    loadEnrichLeads();
    loadManualLeads();
    loadIcpProfile();
  }, [orgId]);

  const loadGlobalData = async () => {
    try {
      const count = await getTotalLeadCount(orgId);
      setTotalLeadCount(count);
    } catch (e) { console.error(e); }

    // ICP fit counts (enriched leads only)
    try {
      const { count: enriched } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('org_id', orgId).in('status', ['enriched', 'contacted']);
      const { count: unenriched } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'new');
      setEnrichedCount(enriched || 0);
      setUnenrichedCount(unenriched || 0);
      const { count: high } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('org_id', orgId).eq('icp_fit', 'HIGH');
      const { count: medium } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('org_id', orgId).eq('icp_fit', 'MEDIUM');
      const { count: low } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('org_id', orgId).eq('icp_fit', 'LOW');
      setIcpCounts({ high: high || 0, medium: medium || 0, low: low || 0 });
    } catch (e) { console.error(e); }

    // Emails sent (lifetime): total outreach minus bounced
    try {
      const [{ count: totalOutreach }, { count: bouncedOutreachCount }] = await Promise.all([
        supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId),
        supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('bounced', true),
      ]);

      setEmailsSent((totalOutreach || 0) - (bouncedOutreachCount || 0));
    } catch (e) { console.error(e); }

    // Outreach stats: contacted/replied leads & contacts from outreach_log
    // Paginate to avoid Supabase's 1000-row default limit
    try {
      let outreach = [];
      let outreachFrom = 0;
      const outreachPageSize = 1000;
      let hasMoreOutreach = true;
      while (hasMoreOutreach) {
        const { data } = await supabase
          .from('outreach_log')
          .select('lead_id, website, contact_email, replied_at, bounced')
          .eq('org_id', orgId)
          .range(outreachFrom, outreachFrom + outreachPageSize - 1);
        if (data && data.length > 0) {
          outreach = outreach.concat(data);
          outreachFrom += outreachPageSize;
          if (data.length < outreachPageSize) hasMoreOutreach = false;
        } else {
          hasMoreOutreach = false;
        }
      }

      // Filter out bounced rows using the bounced flag already in outreach_log
      const rows = outreach.filter(r => !r.bounced);

      const toLeadKey = (row) => row.lead_id || (row.website ? `website:${row.website}` : null);

      const uniqueContacts = new Set(rows.map(r => r.contact_email?.toLowerCase()).filter(Boolean));
      const uniqueLeads = new Set(rows.map(toLeadKey).filter(Boolean));

      const repliedRows = rows.filter(r => !!r.replied_at);
      const repliedContacts = new Set(repliedRows.map(r => r.contact_email?.toLowerCase()).filter(Boolean));
      const repliedLeads = new Set(repliedRows.map(toLeadKey).filter(Boolean));

      setOutreachStats({
        uniqueLeads: uniqueLeads.size,
        uniqueContacts: uniqueContacts.size,
        repliedLeads: repliedLeads.size,
        repliedContacts: repliedContacts.size,
      });
    } catch (e) { console.error(e); }

    // Deliverability (trailing 7 days): prefer live Gmail metrics, then DB fallback
    try {
      let sent = null;
      let bouncedCount = null;

      try {
        const gmailStatsRes = await fetch('/.netlify/functions/gmail-inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stats', org_id: orgId, trailing_days: 7 }),
        });

        if (gmailStatsRes.ok) {
          const gmailStats = await gmailStatsRes.json();
          if (Number.isFinite(gmailStats?.gmail_sent_trailing)) {
            sent = Math.max(0, gmailStats.gmail_sent_trailing);
          }
          if (Number.isFinite(gmailStats?.gmail_bounces_trailing)) {
            bouncedCount = Math.max(0, gmailStats.gmail_bounces_trailing);
          }
        }
      } catch {
        // Gmail stats unavailable; fallback below
      }

      if (!Number.isFinite(sent) || !Number.isFinite(bouncedCount)) {
        const trailingStart = new Date();
        trailingStart.setDate(trailingStart.getDate() - 7);
        const trailingStartIso = trailingStart.toISOString();

        const { count: sentCount, error: sentError } = await supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .gte('sent_at', trailingStartIso);

        if (sentError) console.error('Deliverability sent query error:', sentError);

        const { count: bouncedCountRaw, error: bounceError } = await supabase
          .from('outreach_log')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('bounced', true)
          .gte('bounced_at', trailingStartIso);

        if (bounceError) console.error('Deliverability bounce query error:', bounceError);

        sent = sentCount || 0;
        bouncedCount = bouncedCountRaw || 0;
      }

      const boundedBounces = Math.min(sent || 0, bouncedCount || 0);
      const deliveredCount = Math.max(0, (sent || 0) - boundedBounces);
      const deliverabilityPercent = (sent || 0) > 0 ? ((deliveredCount / sent) * 100).toFixed(1) : '0.0';

      setDeliverabilityStats({ delivered: deliveredCount, sent: sent || 0, percent: deliverabilityPercent });
    } catch (e) { console.error(e); }

    try {
      const { data } = await supabase.from('agent_settings').select('*').eq('org_id', orgId).single();
      setAgentSettings(data);
    } catch (e) { console.error(e); }

    try {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase.from('daily_stats').select('*').eq('org_id', orgId).eq('date', today).maybeSingle();
      setStats(data || { leads_enriched: 0, contacts_found: 0, emails_drafted: 0, emails_sent: 0 });
    } catch (e) { console.error(e); }

    try {
      const { data } = await supabase.from('activity_log').select('*, leads(website)').eq('org_id', orgId).order('created_at', { ascending: false }).limit(50);
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
        orgId,
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

  useEffect(() => { if (orgId) loadEnrichLeads(); }, [enrichFilterCountry, enrichPage, orgId]);

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
    }, orgId);

    setIsEnriching(false);
    setEnrichProgress(null);
    setSelectedLeads([]);
    setEnrichResult(results);

    // Refresh data
    loadEnrichLeads();
    loadManualLeads();
    const count = await getTotalLeadCount(orgId);
    setTotalLeadCount(count);
    const { data: activity } = await supabase.from('activity_log').select('*, leads(website)').eq('org_id', orgId).order('created_at', { ascending: false }).limit(50);
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
        .eq('org_id', orgId)
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
          .eq('org_id', orgId)
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

  useEffect(() => { if (orgId) loadManualLeads(); }, [manualFilterContacted, manualPage, orgId]);

  const handleGenerateEmail = async (forceNew = false) => {
    if (!selectedLeadForManual) return;
    setIsGenerating(true);
    setCachedEmailUsed(false);

    // Determine contact name from selected contacts
    const selectedContact = manualContacts.find(c => selectedManualContacts.includes(c.email));
    const contactName = selectedContact?.name || selectedLeadForManual.contact_name;
    const firstName = contactName ? contactName.split(' ')[0] : 'there';

    try {
      // Check for cached email from previous outreach (saves AI compute)
      if (!forceNew) {
        const cached = await getCachedEmail(selectedLeadForManual.website, orgId);
        if (cached) {
          const personalized = personalizeEmail(cached.text, firstName);
          setManualEmail(personalized);
          setCachedEmailUsed(true);
          setIsGenerating(false);
          return;
        }
      }

      // No cache or forced regeneration — generate fresh
      const email = await generateEmail(selectedLeadForManual, contactName);
      setManualEmail(email);
    } catch (e) {
      console.error(e);
    }
    setIsGenerating(false);
  };

  const handleFindContacts = async () => {
    if (!selectedLeadForManual) return;
    setIsLoadingContacts(true);
    setVerificationMap({});
    try {
      const contacts = await findContacts(selectedLeadForManual, orgId);

      // Check which contacts were already emailed
      const { data: sent } = await supabase
        .from('outreach_log')
        .select('contact_email, sent_at')
        .eq('org_id', orgId)
        .eq('website', selectedLeadForManual.website);

      const sentEmails = new Map((sent || []).map(s => [s.contact_email, s.sent_at]));

      const enrichedContacts = contacts.map(c => ({
        ...c,
        alreadySent: sentEmails.has(c.email),
        sentAt: sentEmails.get(c.email) || null,
      }));

      setManualContacts(enrichedContacts);
      setIsLoadingContacts(false);

      // Run verification waterfall for all contacts
      if (enrichedContacts.length > 0) {
        setIsVerifying(true);
        const emails = enrichedContacts.map(c => c.email);
        const vMap = await verifyContactEmails(emails, orgId);
        setVerificationMap(vMap);
        setIsVerifying(false);
      }
    } catch (e) {
      console.error(e);
      setIsLoadingContacts(false);
      setIsVerifying(false);
    }
  };

  const toggleContact = (email) => {
    setSelectedManualContacts(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]);
  };

  const handleCheckBounces = async () => {
    setIsCheckingBounces(true);
    setBounceResult(null);
    try {
      const res = await fetch('/.netlify/functions/check-bounces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || 'Bounce check failed');
      }

      setBounceResult(data);
      await loadGlobalData();
      await loadManualLeads();
    } catch (e) {
      console.error(e);
      setBounceResult({ error: e.message });
    }
    setIsCheckingBounces(false);
  };

  const handleExportToGmail = async () => {
    if (!selectedLeadForManual) return;
    await exportToGmail(selectedLeadForManual.id, manualEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website, orgId);
    // Reset after short delay
    setTimeout(() => {
      setManualStep(1);
      setSelectedLeadForManual(null);
      setManualEmail('');
      setManualContacts([]);
      setSelectedManualContacts([]);
      setVerificationMap({});
      setCachedEmailUsed(false);
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
      const result = await sendEmail(selectedLeadForManual.id, personalizedEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website, orgId);
      setSendResult({ success: true, recipients: result.recipients });
      
      // Reset UI after brief delay to show success
      setTimeout(async () => {
        setManualStep(1);
        setSelectedLeadForManual(null);
        setManualEmail('');
        setManualContacts([]);
        setSelectedManualContacts([]);
        setVerificationMap({});
        setCachedEmailUsed(false);
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

    await exportToGmail(selectedLeadForManual.id, personalizedEmail, selectedManualContacts, manualContacts, selectedLeadForManual.website, orgId);

    setManualStep(1);
    setSelectedLeadForManual(null);
    setManualEmail('');
    setManualContacts([]);
    setSelectedManualContacts([]);
    setVerificationMap({});
    setCachedEmailUsed(false);
    await loadGlobalData();
    await loadManualLeads();
  };

  // ═══════════════════════════════════════════
  // AGENT SETTINGS
  // ═══════════════════════════════════════════

  const updateAgentSettings = async (updates) => {
    try {
      const { error } = await supabase.from('agent_settings').update(updates).eq('id', '00000000-0000-0000-0000-000000000001').eq('org_id', orgId);
      if (!error) setAgentSettings({ ...agentSettings, ...updates });
    } catch (e) { console.error(e); }
  };

  // ═══════════════════════════════════════════
  // PIPELINE
  // ═══════════════════════════════════════════

  const loadPipeline = async () => {
    try {
      const { leads, totalCount } = await searchLeads({
        orgId,
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
          .eq('org_id', orgId)
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
        .eq('org_id', orgId)
        .eq('has_contacts', true);
      const { count: readyToContact } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'enriched')
        .eq('has_contacts', true);
      const { count: totalContacted } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'contacted');
      const { count: totalReplied } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'replied');

      const contacted = (totalContacted || 0) + (totalReplied || 0);
      setPipelineStats({
        totalContacts: totalWithContacts || 0,
        readyToContact: readyToContact || 0,
        contacted,
        pctContacted: totalWithContacts > 0 ? (contacted / totalWithContacts * 100).toFixed(1) : 0,
      });
    } catch (e) { console.error(e); }
  };

  const openEmailDetail = (lead) => {
    setEmailDetailLead(lead);
    setEmailDetailData(lead.outreach_history || []);
  };

  useEffect(() => { if (activeView === 'pipeline' && orgId) loadPipeline(); }, [activeView, pipelineFilter, pipelinePage, pipelineSearch, orgId]);

  // ═══════════════════════════════════════════
  // CREATE AUDIENCE
  // ═══════════════════════════════════════════

  const toggleAudienceFit = (fit) => {
    setAudienceFit(prev => prev.includes(fit) ? prev.filter(f => f !== fit) : [...prev, fit]);
  };

  // Load preview count when fit selection changes
  useEffect(() => {
    if (audienceFit.length === 0) { setAudiencePreviewCount(0); return; }
    (async () => {
      const { count } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .in('status', ['enriched', 'contacted', 'replied'])
        .in('icp_fit', audienceFit);
      setAudiencePreviewCount(count || 0);
    })();
  }, [audienceFit, orgId]);

  const handleAudienceDownload = async () => {
    if (audienceFit.length === 0 || !audienceExportType) return;
    setAudienceLoading(true);
    setAudienceDownloaded(false);

    try {
      // Fetch all enriched leads matching the selected fits
      const { data: leads } = await supabase
        .from('leads')
        .select('*')
        .eq('org_id', orgId)
        .in('status', ['enriched', 'contacted', 'replied'])
        .in('icp_fit', audienceFit)
        .order('icp_fit', { ascending: true });

      if (!leads || leads.length === 0) {
        alert('No leads found for the selected fit criteria.');
        setAudienceLoading(false);
        return;
      }

      let csvContent = '';

      if (audienceExportType === 'company') {
        // LinkedIn Company List template
        const headers = ['companyname', 'companywebsite', 'companyemaildomain', 'linkedincompanypageurl', 'stocksymbol', 'industry', 'city', 'state', 'companycountry', 'zipcode'];
        csvContent = headers.join(',') + '\n';

        for (const lead of leads) {
          const domain = (lead.website || '').replace(/^www\./, '').toLowerCase();
          const row = [
            lead.company_name || domain.replace(/\.\w+$/, ''),
            lead.website || '',
            domain,
            '', // linkedincompanypageurl - not stored
            '', // stocksymbol - not stored
            lead.industry || '',
            lead.city || '',
            lead.state || '',
            lead.country || '',
            '', // zipcode - not stored
          ].map(v => `"${String(v).replace(/"/g, '""')}"`);
          csvContent += row.join(',') + '\n';
        }
      } else {
        // LinkedIn Email Contact List template
        const headers = ['email', 'firstname', 'lastname', 'jobtitle', 'employeecompany', 'country', 'googleaidid'];
        csvContent = headers.join(',') + '\n';

        // Get domains from leads
        const domains = leads.map(l => (l.website || '').replace(/^www\./, '').toLowerCase());

        // Fetch contacts from contact_database matching these domains
        let allContacts = [];
        for (let i = 0; i < domains.length; i += 200) {
          const batch = domains.slice(i, i + 200).filter(d => d);
          if (batch.length === 0) continue;
          const { data: contacts, error } = await supabase
            .from('contact_database')
            .select('*')
            .eq('org_id', orgId)
            .in('email_domain', batch)
            .limit(5000);
          if (error) console.error('Contact fetch error:', error);
          if (contacts) allContacts = allContacts.concat(contacts);
        }

        // Build a map of domain → lead for country lookup
        const domainToLead = {};
        for (const lead of leads) {
          const d = (lead.website || '').replace(/^www\./, '').toLowerCase();
          domainToLead[d] = lead;
        }

        // Deduplicate contacts by email
        const seen = new Set();
        for (const c of allContacts) {
          if (seen.has(c.email)) continue;
          seen.add(c.email);
          const contactDomain = (c.email_domain || '').toLowerCase();
          const matchedLead = domainToLead[contactDomain] || domainToLead[(c.website || '').replace(/^www\./, '').toLowerCase()];
          const row = [
            c.email || '',
            c.first_name || '',
            c.last_name || '',
            c.title || '',
            c.account_name || matchedLead?.company_name || (c.website || '').replace(/^www\./, '').replace(/\.\w+$/, ''),
            matchedLead?.country || '',
            '', // googleaidid - not stored
          ].map(v => `"${String(v).replace(/"/g, '""')}"`);
          csvContent += row.join(',') + '\n';
        }

        if (allContacts.length === 0) {
          alert('No contacts found in the database for the selected leads. Try exporting a Company List instead.');
          setAudienceLoading(false);
          return;
        }
      }

      // Trigger CSV download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const fitLabel = audienceFit.join('_').toLowerCase();
      link.href = url;
      link.download = `linkedin_${audienceExportType}_list_${fitLabel}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setAudienceDownloaded(true);
    } catch (e) {
      console.error('Audience export error:', e);
      alert('Export failed: ' + e.message);
    }
    setAudienceLoading(false);
  };

  // ═══════════════════════════════════════════
  // ICP PROFILE
  // ═══════════════════════════════════════════

  const loadIcpProfile = async () => {
    setIcpLoaded(false);
    try {
      if (icpLinkParams.forceBlankTemplate) {
        setIcpProfileId(null);
        setIcpProfile(EMPTY_ICP_PROFILE);
        setIcpContext(null);
        setEmailIcpContext(null);
        return;
      }

      const { data, error } = await supabase
        .from('icp_profiles')
        .select('*')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) { console.error('ICP load error:', error); return; }
      if (data) {
        setIcpProfileId(data.id);
        const profile = {
          ...EMPTY_ICP_PROFILE,
          elevator_pitch: data.elevator_pitch || '',
          core_problem: data.core_problem || '',
          uvp_1: data.uvp_1 || '',
          uvp_2: data.uvp_2 || '',
          uvp_3: data.uvp_3 || '',
          alternative: data.alternative || '',
          industries: data.industries || [],
          company_size: data.company_size || '',
          geography: data.geography || [],
          revenue_range: data.revenue_range || '',
          tech_stack: data.tech_stack || [],
          trigger_events: data.trigger_events || [],
          min_product_count: data.min_product_count ?? EMPTY_ICP_PROFILE.min_product_count,
          min_monthly_sales: data.min_monthly_sales ?? EMPTY_ICP_PROFILE.min_monthly_sales,
          min_annual_revenue: data.min_annual_revenue ?? EMPTY_ICP_PROFILE.min_annual_revenue,
          min_employee_count: data.min_employee_count ?? EMPTY_ICP_PROFILE.min_employee_count,
          primary_titles: data.primary_titles || [],
          key_responsibilities: data.key_responsibilities || '',
          daily_obstacles: data.daily_obstacles || '',
          success_metrics: data.success_metrics || '',
          user_persona: data.user_persona || '',
          gatekeeper_persona: data.gatekeeper_persona || '',
          champion_persona: data.champion_persona || '',
          perfect_fit_narrative: data.perfect_fit_narrative || '',
          sender_name: data.sender_name || '',
          sender_url: data.sender_url || '',
          email_tone: data.email_tone || '',
          social_proof: data.social_proof || '',
          messaging_do: data.messaging_do || [],
          messaging_dont: data.messaging_dont || [],
          email_example: data.email_example || '',
        };
        setIcpProfile(profile);
        setIcpContext(profile);
        setEmailIcpContext(profile);
      } else {
        setIcpProfileId(null);
        setIcpProfile(EMPTY_ICP_PROFILE);
        setIcpContext(null);
        setEmailIcpContext(null);
      }
    } catch (e) { console.error('ICP load error:', e); }
    setIcpLoaded(true);
  };

  const updateIcpField = (field, value) => {
    setIcpProfile(prev => ({ ...prev, [field]: value }));
    setIcpSaved(false);
  };

  const addIcpTag = (field, value, setInput) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!icpProfile[field].includes(trimmed)) {
      updateIcpField(field, [...icpProfile[field], trimmed]);
    }
    setInput('');
  };

  const removeIcpTag = (field, value) => {
    updateIcpField(field, icpProfile[field].filter(v => v !== value));
  };

  const saveIcpProfile = async () => {
    setIcpSaving(true);
    try {
      const payload = { ...icpProfile, is_active: true, org_id: orgId };

      if (icpProfileId) {
        const { error } = await supabase.from('icp_profiles').update(payload).eq('id', icpProfileId).eq('org_id', orgId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('icp_profiles').insert(payload).select().single();
        if (error) throw error;
        setIcpProfileId(data.id);
      }
      // Push ICP context to downstream services
      setIcpContext(icpProfile);
      setEmailIcpContext(icpProfile);
      setIcpSaved(true);
      setTimeout(() => setIcpSaved(false), 3000);
    } catch (e) {
      console.error('ICP save error:', e);
      alert('Failed to save ICP profile: ' + e.message);
    }
    setIcpSaving(false);
  };

  const generatePerfectFitNarrative = () => {
    const size = icpProfile.company_size || '[Company Size]';
    const industry = icpProfile.industries.length > 0 ? icpProfile.industries.join('/') : '[Industry]';
    const problem = icpProfile.core_problem || '[Main Pain Point]';
    const title = icpProfile.primary_titles.length > 0 ? icpProfile.primary_titles[0] : '[Job Title]';
    const kpi = icpProfile.success_metrics || '[Key Benefit/KPI]';
    const uvp = icpProfile.uvp_1 || '[Unique Value Prop]';

    const narrative = `Our ideal customer is a ${size} ${industry} company that is currently struggling with ${problem}. The ${title} is looking for a way to ${kpi} and chooses us because of our ${uvp}.`;
    updateIcpField('perfect_fit_narrative', narrative);
  };

  const buildIcpTemplateLink = () => {
    if (typeof window === 'undefined' || !activeOrg) return '';
    const url = new URL(window.location.origin);
    url.searchParams.set('org', activeOrg.slug || activeOrg.id);
    url.searchParams.set('icp_public', '1');
    url.searchParams.set('icp_template', 'blank');
    return url.toString();
  };

  const copyIcpTemplateLink = async () => {
    const link = buildIcpTemplateLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setIcpLinkCopied(true);
      setTimeout(() => setIcpLinkCopied(false), 2000);
    } catch (e) {
      console.error('Failed copying ICP template link:', e);
      alert(`Copy failed. Share this link manually:\n${link}`);
    }
  };

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

  if (orgLoading) {
    return <div className="app"><div style={{ padding: '32px', color: 'rgba(255,255,255,0.6)' }}>Loading organization…</div></div>;
  }

  if (!orgId && !isSuperAdmin) {
    return <div className="app"><div style={{ padding: '32px', color: '#f87171' }}>No organization assigned to this account.</div></div>;
  }

  const activeOrg = organizations.find((o) => o.id === orgId);

  // Delete a lead and refresh the list it came from
  const deleteLead = async (leadId, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!confirm('Delete this lead? This will also remove its contacts, emails, and outreach history.')) return;
    try {
      const { error } = await supabase.from('leads').delete().eq('id', leadId).eq('org_id', orgId);
      if (error) throw error;
      // Remove from local state immediately
      setEnrichLeadsList(prev => prev.filter(l => l.id !== leadId));
      setManualLeads(prev => prev.filter(l => l.id !== leadId));
      if (selectedLeadForManual?.id === leadId) setSelectedLeadForManual(null);
    } catch (err) {
      alert('Failed to delete lead: ' + err.message);
    }
  };

  // Lead card component used in both Enrich and Manual
  const LeadCard = ({ lead, selected, onClick, showContacted }) => (
    <div
      className={`lead-enrich-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      style={{ cursor: 'pointer', position: 'relative' }}
    >
      <button
        className="lead-delete-btn"
        title="Delete lead"
        onClick={(e) => deleteLead(lead.id, e)}
      >
        &times;
      </button>
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
      {!lead.fit_reason && lead.research_notes && (() => {
        try {
          const notes = JSON.parse(lead.research_notes);
          const parts = [];
          if (notes.employees) parts.push(`${notes.employees} employees`);
          if (notes.revenue) parts.push(`$${(notes.revenue / 1e6).toFixed(1)}M rev`);
          if (notes.industry) parts.push(notes.industry);
          return parts.length > 0
            ? <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '2px' }}>{parts.join(' · ')}</div>
            : null;
        } catch {
          return <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '2px' }}>{lead.research_notes.substring(0, 80)}</div>;
        }
      })()}
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
        </div>
        <div className="header-outreach-stats">
          <div className="outreach-stat-group">
            <span className="outreach-stat-title">Contacted</span>
            <div className="outreach-stat-row">
              <span className="outreach-stat-value">{outreachStats.uniqueLeads}</span>
              <span className="outreach-stat-label">Leads</span>
              <span className="outreach-stat-value" style={{ marginLeft: '10px' }}>{outreachStats.uniqueContacts}</span>
              <span className="outreach-stat-label">Contacts</span>
            </div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'stretch', margin: '4px 0' }} />
          <div className="outreach-stat-group">
            <span className="outreach-stat-title">Response Rate</span>
            <div className="outreach-stat-row">
              <span className="outreach-stat-value" style={{ color: '#4ade80' }}>{outreachStats.uniqueLeads ? ((outreachStats.repliedLeads / outreachStats.uniqueLeads) * 100).toFixed(1) : '0.0'}%</span>
              <span className="outreach-stat-label">Leads</span>
              <span className="outreach-stat-value" style={{ marginLeft: '10px', color: '#4ade80' }}>{outreachStats.uniqueContacts ? ((outreachStats.repliedContacts / outreachStats.uniqueContacts) * 100).toFixed(1) : '0.0'}%</span>
              <span className="outreach-stat-label">Contacts</span>
            </div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'stretch', margin: '4px 0' }} />
          <div className="outreach-stat-group">
            <span className="outreach-stat-title">Deliverability (7d)</span>
            <div className="outreach-stat-row">
              <span className="outreach-stat-value" style={{ color: '#60a5fa' }}>{deliverabilityStats.percent}%</span>
              <span className="outreach-stat-label">{deliverabilityStats.delivered}/{deliverabilityStats.sent}</span>
            </div>
          </div>
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
            {bounceResult?.error && (
              <span style={{ fontSize: '10px', color: '#f87171', marginTop: '4px', display: 'block' }}>
                ⚠ {bounceResult.error}
              </span>
            )}
            {!bounceResult?.error && bounceResult && bounceResult.bouncedEmails?.length > 0 && (
              <span style={{ fontSize: '10px', color: '#f87171', marginTop: '4px', display: 'block' }}>
                {bounceResult.bouncedEmails.length} bounced
              </span>
            )}
            {!bounceResult?.error && bounceResult && bounceResult.bouncedEmails?.length === 0 && (
              <span style={{ fontSize: '10px', color: '#4ade80', marginTop: '4px', display: 'block' }}>
                ✓ No bounces
              </span>
            )}
          </div>
          <div style={{ marginLeft: '8px' }}>
            <button onClick={() => {
              clearCachedOrgId();
              localStorage.removeItem('selected_org_id');
              supabase.auth.signOut();
            }}
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

          <div className="sidebar-org-selector">
            <div className="sidebar-org-badge" style={{ background: activeOrg ? 'var(--brand-gradient)' : 'rgba(255,255,255,0.1)' }}>
              {activeOrg?.name?.charAt(0)?.toUpperCase() || 'O'}
            </div>
            <select
              className="sidebar-org-select"
              value={orgId || ""}
              disabled={!orgId}
              onChange={(e) => {
                const nextOrgId = e.target.value;
                setOrgId(nextOrgId);
                setSelectedLeadForManual(null);
                setManualContacts([]);
                setSelectedManualContacts([]);
                setEmailDetailLead(null);
              }}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sidebar-section-label">Main</div>
          <nav className="sidebar-nav">
            {[
              { key: 'chat', label: 'Chat', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> },
              { key: 'icp', label: 'ICP Setup', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> },
              { key: 'prospects', label: 'Prospects', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
              { key: 'enrich', label: 'Lead Gen', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
              { key: 'pipeline', label: 'Pipeline', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> },
              { key: 'agent', label: 'Manage Agent', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> },
              { key: 'manual', label: 'Manual Outreach', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> },
              { key: 'audience', label: 'Create Audiences', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
            ...(isSuperAdmin ? [{ key: 'super_admin', label: 'Super Admin', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg> }] : []),
            ].map(item => (
              <button key={item.key} className={`sidebar-btn ${activeView === item.key ? 'active' : ''}`} onClick={() => setActiveView(item.key)}>
                <span className="btn-icon">{item.icon}</span>
                <span className="btn-label">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-spacer" />
          <div className="sidebar-section-label">Support</div>
          <nav className="sidebar-nav sidebar-nav-bottom">
            <button className={`sidebar-btn ${activeView === 'help' ? 'active' : ''}`} onClick={() => setActiveView('help')}>
              <span className="btn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
              <span className="btn-label">Help & Guide</span>
            </button>
            <a href="mailto:mb2470@gmail.com" className="sidebar-btn sidebar-link">
              <span className="btn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>
              <span className="btn-label">Contact Support</span>
            </a>
          </nav>
        </aside>

        <main className="main-content">

          {/* ═══ ICP SETUP ═══ */}
          {activeView === 'icp' && (
            <div className="view-container">
              <h2>ICP Discovery</h2>
              <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', marginBottom: '8px', maxWidth: '700px', lineHeight: 1.6 }}>
                Nailing your Ideal Customer Profile is the difference between emailing into a void and high-conversion messaging. Complete each section below to train your SDR agent.
              </p>
              {icpProfileId && (
                <p style={{ fontSize: '11px', color: 'rgba(144,21,237,0.6)', marginBottom: '16px' }}>
                  Profile loaded — edits auto-update downstream scoring & email generation.
                </p>
              )}

              <div style={{
                marginBottom: '18px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '10px',
                padding: '10px 12px',
              }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.72)', marginBottom: '6px' }}>
                  Share ICP intake link
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    readOnly
                    value={buildIcpTemplateLink()}
                    style={{
                      flex: 1, minWidth: '320px', padding: '8px 10px',
                      borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)',
                      background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.75)', fontSize: '12px',
                    }}
                  />
                  <button className="primary-btn" onClick={copyIcpTemplateLink} style={{ padding: '8px 12px', fontSize: '12px' }}>
                    {icpLinkCopied ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
                <p style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                  This opens ICP Setup in the selected org with a blank template.
                </p>
              </div>

              {/* Step indicators */}
              <div style={{ display: 'flex', gap: '6px', marginBottom: '28px', flexWrap: 'wrap' }}>
                {[
                  { num: 1, label: 'Product & UVPs' },
                  { num: 2, label: 'Firmographics' },
                  { num: 3, label: 'Buyer Persona' },
                  { num: 4, label: 'Messaging & Tone' },
                  { num: 5, label: 'Summary' },
                ].map(s => (
                  <div key={s.num} onClick={() => setIcpStep(s.num)} style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
                    background: icpStep === s.num ? 'var(--brand-gradient-subtle)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${icpStep === s.num ? 'rgba(144,21,237,0.3)' : 'rgba(255,255,255,0.06)'}`,
                    transition: 'all 0.15s',
                  }}>
                    <span style={{
                      width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', fontWeight: 700, fontFamily: "'Barlow', sans-serif",
                      background: icpStep > s.num ? 'rgba(34,197,94,0.2)' : icpStep === s.num ? 'rgba(144,21,237,0.25)' : 'rgba(255,255,255,0.08)',
                      color: icpStep > s.num ? '#4ade80' : icpStep === s.num ? '#c6beee' : 'rgba(255,255,255,0.3)',
                    }}>
                      {icpStep > s.num ? '✓' : s.num}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: icpStep === s.num ? '#c6beee' : 'rgba(255,255,255,0.5)' }}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>

              {/* ─── Part 1: Product & Unique Value Propositions ─── */}
              {icpStep === 1 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                    Part 1: Product & Unique Value Propositions
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '24px' }}>
                    Focus on the "Why." What makes your solution the obvious choice over the status quo?
                  </p>

                  {/* Elevator Pitch */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Elevator Pitch
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Describe your product in 2 sentences as if explaining it to a peer.
                    </p>
                    <textarea
                      value={icpProfile.elevator_pitch}
                      onChange={(e) => updateIcpField('elevator_pitch', e.target.value)}
                      placeholder="e.g., We help D2C brands copy Amazon's onsite commission model for their own website. Creators review products and earn commissions on sales they drive — zero upfront costs for brands."
                      rows={3}
                      style={{
                        width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        resize: 'vertical', lineHeight: 1.5,
                      }}
                    />
                  </div>

                  {/* Core Problem */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      The "Core" Problem
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      What is the single biggest pain point your product solves?
                    </p>
                    <textarea
                      value={icpProfile.core_problem}
                      onChange={(e) => updateIcpField('core_problem', e.target.value)}
                      placeholder="e.g., Brands spend thousands upfront on creator UGC content with no guarantee of ROI — the 'leaky bucket' problem."
                      rows={2}
                      style={{
                        width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        resize: 'vertical', lineHeight: 1.5,
                      }}
                    />
                  </div>

                  {/* UVPs */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Unique Value Propositions (UVPs)
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      List 3 things you do better than anyone else.
                    </p>
                    {[
                      { field: 'uvp_1', num: 1, placeholder: 'e.g., Zero upfront costs — brands only pay onsite commissions when creator videos drive actual sales' },
                      { field: 'uvp_2', num: 2, placeholder: 'e.g., Permanent UGC on PDPs — extend creator content ROI from 48 hours to forever' },
                      { field: 'uvp_3', num: 3, placeholder: 'e.g., Proven Amazon model adapted for D2C — not a new concept, just a new application' },
                    ].map(uvp => (
                      <div key={uvp.field} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
                        <span style={{
                          minWidth: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '11px', fontWeight: 700, fontFamily: "'Barlow', sans-serif",
                          background: 'rgba(144,21,237,0.15)', color: '#c6beee', marginTop: '10px',
                        }}>{uvp.num}</span>
                        <input
                          type="text"
                          value={icpProfile[uvp.field]}
                          onChange={(e) => updateIcpField(uvp.field, e.target.value)}
                          placeholder={uvp.placeholder}
                          style={{
                            flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                            backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          }}
                        />
                      </div>
                    ))}
                  </div>

                  {/* The Alternative */}
                  <div style={{ marginBottom: '24px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      The Alternative
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      If your product didn't exist, what would they use?
                    </p>
                    <input
                      type="text"
                      value={icpProfile.alternative}
                      onChange={(e) => updateIcpField('alternative', e.target.value)}
                      placeholder="e.g., Paying creators flat fees for UGC, traditional affiliate networks, or doing nothing"
                      style={{
                        width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button className="primary-btn" onClick={() => { saveIcpProfile(); setIcpStep(2); }}>
                      Save & Continue →
                    </button>
                  </div>
                </div>
              )}

              {/* ─── Part 2: Firmographics ─── */}
              {icpStep === 2 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                    Part 2: Firmographics (The Ideal Company)
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '24px' }}>
                    Focus on the "Where." What does the ideal organization look like from the outside?
                  </p>

                  {/* Industry/Vertical */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Industry / Vertical
                    </label>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpIndustryInput}
                        onChange={(e) => setIcpIndustryInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('industries', icpIndustryInput, setIcpIndustryInput)}
                        placeholder="e.g., Fashion & Apparel — press Enter to add"
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('industries', icpIndustryInput, setIcpIndustryInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.industries.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(144,21,237,0.12)', border: '1px solid rgba(144,21,237,0.25)', color: '#c6beee', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('industries', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Company Size */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Company Size
                    </label>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {['Startup (1–50)', 'Mid-market (50–500)', 'Growth (500–5000)', 'Enterprise (5000+)'].map(size => {
                        const selected = icpProfile.company_size === size;
                        return (
                          <div key={size} onClick={() => updateIcpField('company_size', size)}
                            style={{
                              padding: '10px 18px', borderRadius: '10px', cursor: 'pointer', fontSize: '13px', fontWeight: selected ? 600 : 400,
                              transition: 'all 0.15s',
                              background: selected ? 'rgba(144,21,237,0.12)' : 'rgba(255,255,255,0.03)',
                              border: `1px solid ${selected ? 'rgba(144,21,237,0.35)' : 'rgba(255,255,255,0.08)'}`,
                              color: selected ? '#c6beee' : 'rgba(255,255,255,0.5)',
                            }}>
                            {size}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Geography */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Geography
                    </label>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpGeoInput}
                        onChange={(e) => setIcpGeoInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('geography', icpGeoInput, setIcpGeoInput)}
                        placeholder="e.g., North America — press Enter to add"
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('geography', icpGeoInput, setIcpGeoInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.geography.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(36,94,249,0.12)', border: '1px solid rgba(36,94,249,0.25)', color: '#7da3fc', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('geography', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Revenue Range */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Revenue Range
                    </label>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {['<$1M', '$1M–$10M', '$10M–$50M', '$50M–$200M', '$200M+'].map(range => {
                        const selected = icpProfile.revenue_range === range;
                        return (
                          <div key={range} onClick={() => updateIcpField('revenue_range', range)}
                            style={{
                              padding: '10px 18px', borderRadius: '10px', cursor: 'pointer', fontSize: '13px', fontWeight: selected ? 600 : 400,
                              transition: 'all 0.15s',
                              background: selected ? 'rgba(144,21,237,0.12)' : 'rgba(255,255,255,0.03)',
                              border: `1px solid ${selected ? 'rgba(144,21,237,0.35)' : 'rgba(255,255,255,0.08)'}`,
                              color: selected ? '#c6beee' : 'rgba(255,255,255,0.5)',
                            }}>
                            {range}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Tech Stack */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Tech Stack (Must-haves)
                    </label>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpTechInput}
                        onChange={(e) => setIcpTechInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('tech_stack', icpTechInput, setIcpTechInput)}
                        placeholder="e.g., Shopify — press Enter to add"
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('tech_stack', icpTechInput, setIcpTechInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.tech_stack.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('tech_stack', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Trigger Events */}
                  <div style={{ marginBottom: '24px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Trigger Events
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Events that signal a company is ready to buy (e.g., "Just raised Series B", "Hiring a new CMO").
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpTriggerInput}
                        onChange={(e) => setIcpTriggerInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('trigger_events', icpTriggerInput, setIcpTriggerInput)}
                        placeholder="e.g., Launching new product line — press Enter to add"
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('trigger_events', icpTriggerInput, setIcpTriggerInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.trigger_events.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.25)', color: '#eab308', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('trigger_events', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Scoring Thresholds */}
                  <div style={{ marginBottom: '24px', padding: '20px', borderRadius: '12px', background: 'rgba(36,94,249,0.04)', border: '1px solid rgba(36,94,249,0.12)' }}>
                    <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.8)', marginBottom: '4px' }}>
                      Scoring Thresholds
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '16px' }}>
                      These thresholds determine how leads get scored as HIGH / MEDIUM / LOW. A lead must meet 3 thresholds + geography for HIGH, or 2 for MEDIUM.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          Min. Product Count
                        </label>
                        <input
                          type="number"
                          value={icpProfile.min_product_count}
                          onChange={(e) => updateIcpField('min_product_count', parseInt(e.target.value) || 0)}
                          placeholder="250"
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                            backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          }}
                        />
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '2px', display: 'block' }}>StoreLeads catalog size</span>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          Min. Monthly Sales
                        </label>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)', fontSize: '13px' }}>$</span>
                          <input
                            type="number"
                            value={icpProfile.min_monthly_sales}
                            onChange={(e) => updateIcpField('min_monthly_sales', parseInt(e.target.value) || 0)}
                            placeholder="1000000"
                            style={{
                              width: '100%', padding: '10px 14px 10px 24px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                              backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                            }}
                          />
                        </div>
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '2px', display: 'block' }}>StoreLeads est. monthly revenue</span>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          Min. Annual Revenue
                        </label>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)', fontSize: '13px' }}>$</span>
                          <input
                            type="number"
                            value={icpProfile.min_annual_revenue}
                            onChange={(e) => updateIcpField('min_annual_revenue', parseInt(e.target.value) || 0)}
                            placeholder="12000000"
                            style={{
                              width: '100%', padding: '10px 14px 10px 24px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                              backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                            }}
                          />
                        </div>
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '2px', display: 'block' }}>Apollo company revenue ($/yr)</span>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          Min. Employee Count
                        </label>
                        <input
                          type="number"
                          value={icpProfile.min_employee_count}
                          onChange={(e) => updateIcpField('min_employee_count', parseInt(e.target.value) || 0)}
                          placeholder="50"
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                            backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          }}
                        />
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '2px', display: 'block' }}>Apollo headcount proxy</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <button className="secondary-btn" onClick={() => setIcpStep(1)}>← Back</button>
                    <button className="primary-btn" onClick={() => { saveIcpProfile(); setIcpStep(3); }}>Save & Continue →</button>
                  </div>
                </div>
              )}

              {/* ─── Part 3: Buyer Persona ─── */}
              {icpStep === 3 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                    Part 3: The Buyer Persona (The "Who")
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '24px' }}>
                    Focus on the "Who." Identify the specific human being who signs the check.
                  </p>

                  {/* Primary Decision Maker section */}
                  <div style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '20px' }}>
                    <h4 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '14px', fontWeight: 700, color: '#c6beee', marginBottom: '16px' }}>
                      The Primary Decision Maker
                    </h4>

                    {/* Job Titles */}
                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Job Title(s)
                      </label>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <input
                          type="text"
                          value={icpTitleInput}
                          onChange={(e) => setIcpTitleInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addIcpTag('primary_titles', icpTitleInput, setIcpTitleInput)}
                          placeholder="e.g., VP of E-Commerce — press Enter to add"
                          style={{
                            flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                            backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          }}
                        />
                        <button onClick={() => addIcpTag('primary_titles', icpTitleInput, setIcpTitleInput)}
                          style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                          + Add
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {icpProfile.primary_titles.map(tag => (
                          <span key={tag} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                            background: 'rgba(144,21,237,0.12)', border: '1px solid rgba(144,21,237,0.25)', color: '#c6beee', fontSize: '12px',
                          }}>
                            {tag}
                            <span onClick={() => removeIcpTag('primary_titles', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Key Responsibilities */}
                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Key Responsibilities
                      </label>
                      <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                        What are they held accountable for in their annual review?
                      </p>
                      <textarea
                        value={icpProfile.key_responsibilities}
                        onChange={(e) => updateIcpField('key_responsibilities', e.target.value)}
                        placeholder="e.g., Growing D2C revenue, reducing customer acquisition cost, managing creator/influencer programs, increasing conversion rates on PDPs"
                        rows={2}
                        style={{
                          width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          resize: 'vertical', lineHeight: 1.5,
                        }}
                      />
                    </div>

                    {/* Daily Obstacles */}
                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Daily Obstacles
                      </label>
                      <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                        What frustrates them or keeps them working late?
                      </p>
                      <textarea
                        value={icpProfile.daily_obstacles}
                        onChange={(e) => updateIcpField('daily_obstacles', e.target.value)}
                        placeholder="e.g., Rising creator costs with no ROI guarantee, content that only lasts 48hrs on social, difficulty attributing sales to influencer spend"
                        rows={2}
                        style={{
                          width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          resize: 'vertical', lineHeight: 1.5,
                        }}
                      />
                    </div>

                    {/* Success Metrics */}
                    <div>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Success Metrics (KPIs)
                      </label>
                      <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                        How do they measure their own success?
                      </p>
                      <textarea
                        value={icpProfile.success_metrics}
                        onChange={(e) => updateIcpField('success_metrics', e.target.value)}
                        placeholder="e.g., CAC (Customer Acquisition Cost), ROAS on creator spend, PDP conversion rate, D2C revenue growth"
                        rows={2}
                        style={{
                          width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          resize: 'vertical', lineHeight: 1.5,
                        }}
                      />
                    </div>
                  </div>

                  {/* Buying Committee (Optional) */}
                  <div style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '24px' }}>
                    <h4 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                      The Buying Committee
                    </h4>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginBottom: '16px' }}>Optional but recommended.</p>

                    {[
                      { field: 'user_persona', label: 'The User', desc: 'Who actually uses the tool day-to-day?', placeholder: 'e.g., Marketing Coordinator or Content Manager who manages the creator dashboard' },
                      { field: 'gatekeeper_persona', label: 'The Gatekeeper', desc: 'Who might block this? (e.g., IT Security, Procurement)', placeholder: 'e.g., IT team evaluating script/tag impact on site speed, Legal reviewing commission terms' },
                      { field: 'champion_persona', label: 'The Champion', desc: 'Who will get excited about this and "sell" it internally?', placeholder: 'e.g., Social Media Manager who sees the content value, or Influencer Marketing lead tired of upfront fees' },
                    ].map(persona => (
                      <div key={persona.field} style={{ marginBottom: persona.field !== 'champion_persona' ? '16px' : 0 }}>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '4px' }}>
                          {persona.label}
                        </label>
                        <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>{persona.desc}</p>
                        <input
                          type="text"
                          value={icpProfile[persona.field]}
                          onChange={(e) => updateIcpField(persona.field, e.target.value)}
                          placeholder={persona.placeholder}
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                            backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                          }}
                        />
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <button className="secondary-btn" onClick={() => setIcpStep(2)}>← Back</button>
                    <button className="primary-btn" onClick={() => { saveIcpProfile(); setIcpStep(4); }}>Save & Continue →</button>
                  </div>
                </div>
              )}

              {/* ─── Part 4: Messaging & Tone ─── */}
              {icpStep === 4 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                    Part 4: Messaging & Tone
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '24px' }}>
                    This drives how your SDR agent writes emails. Your phrasing rules, social proof, and tone all flow directly into AI-generated outreach.
                  </p>

                  {/* Sender Name */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Sender Name
                      </label>
                      <input
                        type="text"
                        value={icpProfile.sender_name}
                        onChange={(e) => updateIcpField('sender_name', e.target.value)}
                        placeholder="e.g., Your Name"
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                        Sender URL
                      </label>
                      <input
                        type="text"
                        value={icpProfile.sender_url}
                        onChange={(e) => updateIcpField('sender_url', e.target.value)}
                        placeholder="e.g., YourCompany.com"
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                    </div>
                  </div>

                  {/* Social Proof */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Social Proof / Comparison
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      A well-known program or company your ICP already understands. The AI will reference this to position your product.
                    </p>
                    <input
                      type="text"
                      value={icpProfile.social_proof}
                      onChange={(e) => updateIcpField('social_proof', e.target.value)}
                      placeholder={`e.g., Amazon's Onsite Associates program`}
                      style={{
                        width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                      }}
                    />
                  </div>

                  {/* Correct Messaging */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Correct Phrases (Always Say)
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Exact phrasing the AI should use. These become hard rules in the email prompt.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpMsgDoInput}
                        onChange={(e) => setIcpMsgDoInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('messaging_do', icpMsgDoInput, setIcpMsgDoInput)}
                        placeholder={`e.g., "onsite commissions" (not "performance commissions") — press Enter`}
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('messaging_do', icpMsgDoInput, setIcpMsgDoInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.1)', color: '#4ade80', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.messaging_do.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('messaging_do', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Incorrect Messaging */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Banned Phrases (Never Say)
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Phrasing that misrepresents your product or confuses prospects.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={icpMsgDontInput}
                        onChange={(e) => setIcpMsgDontInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addIcpTag('messaging_dont', icpMsgDontInput, setIcpMsgDontInput)}
                        placeholder={`e.g., "performance commissions" — ALWAYS say "onsite commissions" — press Enter`}
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                          backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                        }}
                      />
                      <button onClick={() => addIcpTag('messaging_dont', icpMsgDontInput, setIcpMsgDontInput)}
                        style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)', color: '#f87171', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {icpProfile.messaging_dont.map(tag => (
                        <span key={tag} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '6px',
                          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '12px',
                        }}>
                          {tag}
                          <span onClick={() => removeIcpTag('messaging_dont', tag)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 700 }}>×</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Email Tone */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Email Tone
                    </label>
                    <input
                      type="text"
                      value={icpProfile.email_tone}
                      onChange={(e) => updateIcpField('email_tone', e.target.value)}
                      placeholder="e.g., Conversational, direct, no fluff. Like messaging a coworker on Slack."
                      style={{
                        width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '13px',
                      }}
                    />
                  </div>

                  {/* Example Email */}
                  <div style={{ marginBottom: '24px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                      Example Email
                    </label>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Paste a real email you love. The AI will match this style and structure.
                    </p>
                    <textarea
                      value={icpProfile.email_example}
                      onChange={(e) => updateIcpField('email_example', e.target.value)}
                      placeholder={`Hey Sarah -\n\nPaste a real outreach email you've sent that worked well.\n\nThe AI will analyze the tone, structure, and approach to match your style when generating new emails.\n\nYour Name\nYourCompany.com`}
                      rows={10}
                      style={{
                        width: '100%', padding: '14px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: "'Courier New', monospace", fontSize: '12px',
                        resize: 'vertical', lineHeight: 1.6,
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <button className="secondary-btn" onClick={() => setIcpStep(3)}>← Back</button>
                    <button className="primary-btn" onClick={() => { saveIcpProfile(); setIcpStep(5); }}>Save & Continue →</button>
                  </div>
                </div>
              )}

              {/* ─── Part 5: Summary — Perfect Fit Narrative ─── */}
              {icpStep === 5 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                    Part 5: The "Perfect Fit" Narrative
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '24px' }}>
                    This summary ties everything together. It's used as context for your SDR agent's scoring and email generation.
                  </p>

                  {/* Auto-generate button */}
                  <div style={{ marginBottom: '16px' }}>
                    <button onClick={generatePerfectFitNarrative}
                      style={{
                        padding: '10px 20px', borderRadius: '10px', border: '1px solid rgba(144,21,237,0.3)',
                        background: 'rgba(144,21,237,0.1)', color: '#c6beee', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, transition: 'all 0.15s',
                      }}>
                      Auto-generate from my answers
                    </button>
                  </div>

                  <textarea
                    value={icpProfile.perfect_fit_narrative}
                    onChange={(e) => updateIcpField('perfect_fit_narrative', e.target.value)}
                    placeholder={`Our ideal customer is a [Company Size] [Industry] company that is currently struggling with [Main Pain Point]. The [Job Title] is looking for a way to [Key Benefit/KPI] and chooses us because of our [Unique Value Prop].`}
                    rows={5}
                    style={{
                      width: '100%', padding: '14px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)',
                      backgroundColor: 'rgba(255,255,255,0.04)', color: '#f6f6f7', fontFamily: 'inherit', fontSize: '14px',
                      resize: 'vertical', lineHeight: 1.6, marginBottom: '24px',
                    }}
                  />

                  {/* ICP Profile Summary Card */}
                  <div style={{ padding: '20px', borderRadius: '12px', background: 'rgba(144,21,237,0.06)', border: '1px solid rgba(144,21,237,0.15)', marginBottom: '24px' }}>
                    <h4 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '14px', fontWeight: 700, color: '#c6beee', marginBottom: '16px' }}>
                      ICP Profile Summary
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '12px' }}>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Industries</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.industries.join(', ') || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Company Size</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.company_size || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Geography</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.geography.join(', ') || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Revenue</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.revenue_range || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Target Titles</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.primary_titles.join(', ') || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Tech Stack</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.tech_stack.join(', ') || '—'}</span>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Scoring Thresholds</span>
                        <span style={{ color: '#f6f6f7', fontSize: '11px' }}>
                          Products: {icpProfile.min_product_count}+ | Sales: ${(icpProfile.min_monthly_sales || 0).toLocaleString()}/mo | Revenue: ${(icpProfile.min_annual_revenue || 0).toLocaleString()}/yr | Employees: {icpProfile.min_employee_count}+
                        </span>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Core Problem</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.core_problem || '—'}</span>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>UVPs</span>
                        <span style={{ color: '#f6f6f7' }}>
                          {[icpProfile.uvp_1, icpProfile.uvp_2, icpProfile.uvp_3].filter(Boolean).join(' | ') || '—'}
                        </span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Sender</span>
                        <span style={{ color: '#f6f6f7' }}>{[icpProfile.sender_name, icpProfile.sender_url].filter(Boolean).join(' / ') || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Social Proof</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.social_proof || '—'}</span>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span style={{ color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '2px' }}>Tone</span>
                        <span style={{ color: '#f6f6f7' }}>{icpProfile.email_tone || '—'}</span>
                      </div>
                    </div>
                  </div>

                  {/* How This Affects Downstream */}
                  <div style={{ padding: '16px 20px', borderRadius: '10px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)', marginBottom: '24px', fontSize: '12px', lineHeight: 1.6 }}>
                    <strong style={{ color: '#4ade80', display: 'block', marginBottom: '6px' }}>How this affects your pipeline:</strong>
                    <ul style={{ color: 'rgba(255,255,255,0.5)', paddingLeft: '16px', margin: 0 }}>
                      <li><strong style={{ color: 'rgba(255,255,255,0.7)' }}>Lead Scoring</strong> — Your industries, geography, and company size drive HIGH / MEDIUM / LOW scoring.</li>
                      <li><strong style={{ color: 'rgba(255,255,255,0.7)' }}>Email Generation</strong> — Your elevator pitch, UVPs, social proof, tone, and do/don't phrases are the AI's system prompt. No hardcoded messaging.</li>
                      <li><strong style={{ color: 'rgba(255,255,255,0.7)' }}>Contact Matching</strong> — Your target titles prioritize which contacts to surface for each company.</li>
                    </ul>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button className="secondary-btn" onClick={() => setIcpStep(4)}>← Back</button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {icpSaved && (
                        <span style={{ fontSize: '13px', color: '#4ade80', fontWeight: 600 }}>Saved</span>
                      )}
                      <button className="primary-btn" onClick={saveIcpProfile} disabled={icpSaving}>
                        {icpSaving ? 'Saving...' : 'Save ICP Profile'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ LEAD GEN ═══ */}
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
                <h2>Lead Gen</h2>
                <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.45)', marginBottom: '16px' }}>
                  Enrich scored prospects with contact data from Apollo and other providers to generate leads.
                </p>
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
                {[{ n: 1, l: 'Select Lead' }, { n: 2, l: 'Find Contacts' }, { n: 3, l: 'Generate Email' }, { n: 4, l: 'Send / Export' }].map((s, i) => (
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
                      <button className="primary-btn" onClick={() => { setManualStep(2); handleFindContacts(); }} style={{ whiteSpace: 'nowrap' }}>Next: Find Contacts →</button>
                    </div>
                  )}

                  <div className="leads-grid">
                    {manualLeads.map(lead => (
                      <div key={lead.id} onClick={() => { setSelectedLeadForManual(lead); setManualEmail(''); setManualContacts([]); setSelectedManualContacts([]); setVerificationMap({}); setCachedEmailUsed(false); }}>
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

              {/* Step 2: Find & Verify Contacts */}
              {manualStep === 2 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ marginBottom: '20px' }}>
                    <h3 style={{ margin: '0 0 4px 0' }}>{selectedLeadForManual.website}</h3>
                    <span style={{ opacity: 0.6, fontSize: '13px' }}>Find and verify contacts</span>
                  </div>
                  {isLoadingContacts ? (
                    <div style={{ textAlign: 'center', padding: '40px', opacity: 0.6 }}>🔍 Searching database & Apollo for contacts...</div>
                  ) : manualContacts.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '40px' }}>
                      <p style={{ opacity: 0.6 }}>No contacts found for {selectedLeadForManual.website}</p>
                      <button className="secondary-btn" onClick={handleFindContacts}>🔄 Try Again</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <p style={{ margin: 0, opacity: 0.7 }}><strong>{manualContacts.length}</strong> contacts found:</p>
                        {isVerifying && <span style={{ fontSize: '12px', color: '#eab308' }}>⏳ Verifying emails...</span>}
                        {!isVerifying && Object.keys(verificationMap).length > 0 && (
                          <span style={{ fontSize: '12px', color: '#4ade80' }}>
                            ✓ {Object.values(verificationMap).filter(v => v.safe).length} verified
                            {Object.values(verificationMap).filter(v => !v.safe).length > 0 && (
                              <span style={{ color: '#f87171', marginLeft: '8px' }}>
                                · {Object.values(verificationMap).filter(v => !v.safe).length} invalid
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', maxHeight: '400px', overflowY: 'auto' }}>
                        {manualContacts.map(c => {
                          const vResult = verificationMap[c.email];
                          const isBadEmail = vResult?.safe === false;
                          return (
                          <div key={c.email} onClick={() => !isBadEmail && toggleContact(c.email)}
                            style={{ padding: '12px 16px', borderRadius: '8px', cursor: isBadEmail ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
                              opacity: isBadEmail ? 0.4 : 1,
                              border: selectedManualContacts.includes(c.email) ? '1px solid rgba(144,21,237,0.6)' : isBadEmail ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(255,255,255,0.1)',
                              backgroundColor: selectedManualContacts.includes(c.email) ? 'rgba(144,21,237,0.15)' : isBadEmail ? 'rgba(239,68,68,0.05)' : 'rgba(255,255,255,0.03)' }}>
                            <input type="checkbox" checked={selectedManualContacts.includes(c.email)} readOnly disabled={isBadEmail} />
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <strong>{c.name}</strong>
                                {c.alreadySent && <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(34,197,94,0.2)', color: '#4ade80' }}>✓ Sent</span>}
                                {vResult && vResult.safe && (
                                  <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                                    ✓ {vResult.source === 'apollo' ? 'Apollo Verified' : 'ELV Verified'}
                                  </span>
                                )}
                                {vResult && !vResult.safe && (
                                  <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
                                    ✗ Invalid ({vResult.status})
                                  </span>
                                )}
                                {!vResult && !isVerifying && c.apolloStatus && (
                                  <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
                                    {c.apolloStatus}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: '12px', opacity: 0.7 }}>{c.title}</div>
                              <div style={{ fontSize: '12px', opacity: 0.5 }}>{c.email}</div>
                              {c.alreadySent && <div style={{ fontSize: '10px', opacity: 0.4 }}>Sent {new Date(c.sentAt).toLocaleDateString()}</div>}
                            </div>
                            {c.matchLevel && <span className={`match-badge ${c.matchClass}`}>{c.matchEmoji} {c.matchLevel}</span>}
                          </div>
                          );
                        })}
                      </div>
                      <button className="primary-btn" onClick={() => { setManualStep(3); handleGenerateEmail(); }} disabled={selectedManualContacts.length === 0 || isVerifying} style={{ width: '100%', padding: '14px' }}>
                        {isVerifying ? '⏳ Waiting for verification...' : `Next: Generate Email → (${selectedManualContacts.length} selected)`}
                      </button>
                    </>
                  )}
                  <button onClick={() => { setManualStep(1); setManualContacts([]); setSelectedManualContacts([]); setVerificationMap({}); }} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to lead selection</button>
                </div>
              )}

              {/* Step 3: Generate / Reuse Email */}
              {manualStep === 3 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ marginBottom: '20px' }}>
                    <h3 style={{ margin: '0 0 4px 0' }}>{selectedLeadForManual.website}</h3>
                    <span style={{ opacity: 0.6, fontSize: '13px' }}>{selectedLeadForManual.industry} · {selectedLeadForManual.icp_fit} fit</span>
                  </div>
                  {cachedEmailUsed && (
                    <div style={{ padding: '10px 14px', borderRadius: '8px', backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', color: '#4ade80' }}>♻️ Reusing previous email (saves AI cost)</span>
                      <button onClick={() => handleGenerateEmail(true)} disabled={isGenerating}
                        style={{ padding: '4px 10px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', backgroundColor: 'transparent', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '12px' }}>
                        Generate Fresh
                      </button>
                    </div>
                  )}
                  {!manualEmail ? (
                    <div style={{ textAlign: 'center', padding: '40px', opacity: 0.6 }}>
                      {isGenerating ? '⏳ Generating with AI...' : 'Loading email...'}
                    </div>
                  ) : (
                    <>
                      <div style={{ backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '16px', marginBottom: '16px', position: 'relative' }}>
                        <button onClick={() => navigator.clipboard.writeText(manualEmail)}
                          style={{ position: 'absolute', top: '8px', right: '8px', padding: '4px 10px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', backgroundColor: 'transparent', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '12px' }}>📋 Copy</button>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '13px', lineHeight: '1.5' }}>{manualEmail}</pre>
                      </div>
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <button className="secondary-btn" onClick={() => handleGenerateEmail(true)} disabled={isGenerating}>🔄 Regenerate</button>
                        <button className="primary-btn" onClick={() => setManualStep(4)} style={{ flex: 1 }}>Next: Review & Send →</button>
                      </div>
                    </>
                  )}
                  <button onClick={() => { setManualStep(2); setManualEmail(''); setCachedEmailUsed(false); }} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to contacts</button>
                </div>
              )}

              {/* Step 4: Send / Export */}
              {manualStep === 4 && selectedLeadForManual && (
                <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>Ready to Send</h3>
                  <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)', marginBottom: '20px', textAlign: 'left' }}>
                    <div style={{ marginBottom: '12px' }}><strong>Lead:</strong> {selectedLeadForManual.website}</div>
                    <div style={{ marginBottom: '12px' }}><strong>Recipients ({selectedManualContacts.length}):</strong>
                      <div style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px' }}>{selectedManualContacts.join(', ')}</div>
                    </div>
                    <div style={{ fontSize: '12px', opacity: 0.5, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px', marginTop: '8px' }}>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, lineHeight: '1.4' }}>{manualEmail?.substring(0, 200)}{manualEmail?.length > 200 ? '...' : ''}</pre>
                    </div>
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
                  <button className="primary-btn" onClick={handleSendDirect} disabled={isSending} style={{ width: '100%', padding: '14px' }}>
                    {isSending ? '⏳ Sending...' : `📧 Send Email — ${selectedManualContacts.length} Contact(s)`}
                  </button>
                  <button onClick={handleExportFromContacts}
                    style={{ width: '100%', padding: '10px', marginTop: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '12px' }}>
                    Or open in Gmail →
                  </button>
                  <button onClick={() => setManualStep(3)} style={{ marginTop: '16px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px' }}>← Back to email</button>
                </div>
              )}
            </div>
          )}

          {/* ═══ MANAGE AGENT ═══ */}
          {activeView === 'agent' && (
            <div className="view-container">
              <AgentMonitor />
            </div>
          )}

          {/* ═══ PROSPECTS ═══ */}
          {activeView === 'prospects' && (
            <div className="view-container">
              <ProspectPipeline orgId={orgId} />
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
                  { label: 'Ready to Contact', value: pipelineStats.readyToContact || 0, color: '#f59e0b' },
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
                  <option value="ready_to_contact">Ready to Contact</option>
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

          {/* ═══ CREATE AUDIENCE ═══ */}
          {activeView === 'audience' && (
            <div className="view-container">
              <h2>🎯 Create Audience</h2>
              <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', marginBottom: '24px' }}>
                Export enriched leads for LinkedIn ad targeting. Select ICP fit, choose your export format, and download a ready-to-upload CSV.
              </p>

              {/* Step indicators */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '28px' }}>
                {[
                  { num: 1, label: 'Select Fit' },
                  { num: 2, label: 'Export Type' },
                  { num: 3, label: 'Download' },
                ].map(s => (
                  <div key={s.num} style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '8px',
                    background: audienceStep === s.num ? 'var(--brand-gradient-subtle)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${audienceStep === s.num ? 'rgba(144,21,237,0.3)' : 'rgba(255,255,255,0.06)'}`,
                    opacity: audienceStep >= s.num ? 1 : 0.4,
                  }}>
                    <span style={{
                      width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', fontWeight: 700, fontFamily: "'Barlow', sans-serif",
                      background: audienceStep > s.num ? 'rgba(34,197,94,0.2)' : audienceStep === s.num ? 'rgba(144,21,237,0.25)' : 'rgba(255,255,255,0.08)',
                      color: audienceStep > s.num ? '#4ade80' : audienceStep === s.num ? '#c6beee' : 'rgba(255,255,255,0.3)',
                    }}>
                      {audienceStep > s.num ? '✓' : s.num}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: audienceStep === s.num ? '#c6beee' : 'rgba(255,255,255,0.5)' }}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>

              {/* Step 1: Select ICP Fit */}
              {audienceStep === 1 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>
                    Select ICP Fit Levels
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '20px' }}>
                    Choose which fit levels to include in your audience. You can select multiple.
                  </p>

                  <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
                    {[
                      { value: 'HIGH', label: 'High Fit', count: icpCounts.high, color: '#4ade80', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)' },
                      { value: 'MEDIUM', label: 'Medium Fit', count: icpCounts.medium, color: '#eab308', bg: 'rgba(234,179,8,0.1)', border: 'rgba(234,179,8,0.3)' },
                      { value: 'LOW', label: 'Low Fit', count: icpCounts.low, color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
                    ].map(fit => {
                      const selected = audienceFit.includes(fit.value);
                      return (
                        <div
                          key={fit.value}
                          onClick={() => toggleAudienceFit(fit.value)}
                          style={{
                            flex: 1, padding: '20px', borderRadius: '12px', cursor: 'pointer', textAlign: 'center',
                            transition: 'all 0.15s ease',
                            background: selected ? fit.bg : 'rgba(255,255,255,0.02)',
                            border: `2px solid ${selected ? fit.border : 'rgba(255,255,255,0.08)'}`,
                          }}
                        >
                          <div style={{ fontSize: '28px', fontWeight: 800, fontFamily: "'Barlow', sans-serif", color: selected ? fit.color : 'rgba(255,255,255,0.2)', marginBottom: '4px' }}>
                            {fit.count}
                          </div>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: selected ? fit.color : 'rgba(255,255,255,0.4)' }}>
                            {fit.label}
                          </div>
                          <div style={{ marginTop: '8px' }}>
                            <input type="checkbox" checked={selected} readOnly style={{ accentColor: fit.color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {audienceFit.length > 0 && (
                    <div style={{
                      padding: '12px 16px', borderRadius: '8px', background: 'rgba(144,21,237,0.08)', border: '1px solid rgba(144,21,237,0.15)',
                      fontSize: '13px', color: '#c6beee', marginBottom: '20px',
                    }}>
                      <strong>{audiencePreviewCount}</strong> enriched lead{audiencePreviewCount !== 1 ? 's' : ''} matching: {audienceFit.join(', ')}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      className="primary-btn"
                      disabled={audienceFit.length === 0}
                      onClick={() => setAudienceStep(2)}
                      style={{ opacity: audienceFit.length === 0 ? 0.4 : 1 }}
                    >
                      Continue →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2: Choose Export Type */}
              {audienceStep === 2 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>
                    Choose Export Type
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '20px' }}>
                    Select the LinkedIn audience format to export.
                  </p>

                  <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                    {[
                      {
                        value: 'company',
                        icon: '🏢',
                        label: 'Company List',
                        desc: 'Export company names, domains, and industries for LinkedIn Company targeting.',
                        fields: 'companyname, companywebsite, companyemaildomain, industry, city, state, country',
                      },
                      {
                        value: 'email',
                        icon: '📧',
                        label: 'Email Contact List',
                        desc: 'Export individual contacts with emails for LinkedIn Contact targeting.',
                        fields: 'email, firstname, lastname, jobtitle, employeecompany, country',
                      },
                    ].map(opt => {
                      const selected = audienceExportType === opt.value;
                      return (
                        <div
                          key={opt.value}
                          onClick={() => setAudienceExportType(opt.value)}
                          style={{
                            flex: 1, padding: '24px', borderRadius: '12px', cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            background: selected ? 'rgba(144,21,237,0.08)' : 'rgba(255,255,255,0.02)',
                            border: `2px solid ${selected ? 'rgba(144,21,237,0.35)' : 'rgba(255,255,255,0.08)'}`,
                          }}
                        >
                          <div style={{ fontSize: '32px', marginBottom: '12px' }}>{opt.icon}</div>
                          <div style={{ fontSize: '15px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: selected ? '#c6beee' : 'rgba(255,255,255,0.7)', marginBottom: '6px' }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, marginBottom: '10px' }}>
                            {opt.desc}
                          </div>
                          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', fontFamily: "'JetBrains Mono', monospace" }}>
                            {opt.fields}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <button className="secondary-btn" onClick={() => setAudienceStep(1)}>
                      ← Back
                    </button>
                    <button
                      className="primary-btn"
                      disabled={!audienceExportType}
                      onClick={() => setAudienceStep(3)}
                      style={{ opacity: !audienceExportType ? 0.4 : 1 }}
                    >
                      Continue →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Download */}
              {audienceStep === 3 && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '28px' }}>
                  <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>
                    Download CSV
                  </h3>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '20px' }}>
                    Review your selections and download the CSV file ready for LinkedIn Matched Audiences.
                  </p>

                  {/* Summary */}
                  <div style={{
                    display: 'flex', gap: '16px', marginBottom: '24px',
                  }}>
                    <div style={{ flex: 1, padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: '8px' }}>ICP Fit</div>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {audienceFit.map(f => (
                          <span key={f} className={`icp-badge ${f.toLowerCase()}`}>{f}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{ flex: 1, padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: '8px' }}>Export Type</div>
                      <div style={{ fontSize: '14px', fontWeight: 600 }}>
                        {audienceExportType === 'company' ? '🏢 Company List' : '📧 Email Contact List'}
                      </div>
                    </div>
                    <div style={{ flex: 1, padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: '8px' }}>Matching Leads</div>
                      <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: '#c6beee' }}>
                        {audiencePreviewCount}
                      </div>
                    </div>
                  </div>

                  {audienceDownloaded && (
                    <div style={{
                      padding: '12px 16px', borderRadius: '8px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                      fontSize: '13px', color: '#4ade80', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px',
                    }}>
                      <span>✅</span> CSV downloaded successfully! Upload it to LinkedIn Campaign Manager under Matched Audiences.
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <button className="secondary-btn" onClick={() => setAudienceStep(2)}>
                      ← Back
                    </button>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        className="secondary-btn"
                        onClick={() => {
                          setAudienceStep(1);
                          setAudienceFit([]);
                          setAudienceExportType(null);
                          setAudienceDownloaded(false);
                        }}
                      >
                        Start Over
                      </button>
                      <button
                        className="primary-btn"
                        onClick={handleAudienceDownload}
                        disabled={audienceLoading}
                        style={{ minWidth: '160px' }}
                      >
                        {audienceLoading ? 'Exporting...' : `⬇ Download ${audienceExportType === 'company' ? 'Company' : 'Contact'} CSV`}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeView === 'super_admin' && isSuperAdmin && (
            <div className="view-container">
              <SuperAdminDashboard onOrgCreated={loadOrganizations} />
            </div>
          )}

          {/* ═══ HELP & GUIDE ═══ */}
          {activeView === 'help' && (
            <div className="view-container">
              <h2>Help & Guide</h2>
              <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', marginBottom: '28px', maxWidth: '700px', lineHeight: 1.6 }}>
                Everything you need to get started with AI SDR Agent and run high-converting outreach campaigns.
              </p>

              {/* Getting Started */}
              <div className="help-section">
                <div className="help-section-header">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9015ed" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  <h3>Getting Started</h3>
                </div>
                <div className="help-steps">
                  <div className="help-step">
                    <div className="help-step-num">1</div>
                    <div>
                      <h4>Define Your ICP</h4>
                      <p>Head to <strong>ICP Setup</strong> to define your ideal customer profile. This trains the AI on your product, target firmographics, buyer personas, and messaging tone so all enrichment and email generation is tailored to your business.</p>
                    </div>
                  </div>
                  <div className="help-step">
                    <div className="help-step-num">2</div>
                    <div>
                      <h4>Add Leads</h4>
                      <p>Use <strong>Add Leads</strong> to import prospects — paste a single website, bulk-paste a list, or upload a CSV.</p>
                    </div>
                  </div>
                  <div className="help-step">
                    <div className="help-step-num">3</div>
                    <div>
                      <h4>Enrich Your Leads</h4>
                      <p>Navigate to <strong>Lead Gen</strong> to enrich scored prospects with contact data. The system finds decision-makers, verified contact emails, and scores them against your ICP buyer personas.</p>
                    </div>
                  </div>
                  <div className="help-step">
                    <div className="help-step-num">4</div>
                    <div>
                      <h4>Review Your Pipeline</h4>
                      <p>The <strong>Pipeline</strong> view gives you a filterable, searchable overview of all leads with their enrichment status, ICP scores, contact info, and outreach history.</p>
                    </div>
                  </div>
                  <div className="help-step">
                    <div className="help-step-num">5</div>
                    <div>
                      <h4>Set Up Email Infrastructure</h4>
                      <p>Domain acquisition and DNS setup are now handled offline. Once your sender inboxes are ready, use <strong>Manual Outreach</strong> or <strong>Manage Agent</strong> to run campaigns from the platform.</p>
                    </div>
                  </div>
                  <div className="help-step">
                    <div className="help-step-num">6</div>
                    <div>
                      <h4>Send Outreach</h4>
                      <p>Use <strong>Manual Outreach</strong> to generate personalized emails for individual leads, or configure the <strong>Manage Agent</strong> to automate outreach at scale with customizable sending schedules and daily limits.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Features Overview */}
              <div className="help-section">
                <div className="help-section-header">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#245ef9" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <h3>Feature Overview</h3>
                </div>
                <div className="help-features-grid">
                  <div className="help-feature-card">
                    <h4>Chat Assistant</h4>
                    <p>Talk to an AI assistant that understands your pipeline. Ask questions about your leads, get outreach advice, or request analytics — all in natural language.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>ICP Setup</h4>
                    <p>A guided 5-step wizard to define your Ideal Customer Profile: product positioning, firmographics, buyer persona, messaging tone, and a summary the AI uses for scoring.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>AI Enrichment</h4>
                    <p>One-click enrichment scrapes brand websites, researches company details, identifies decision-makers, and finds verified email addresses using multiple data sources.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Email Generation</h4>
                    <p>AI-crafted personalized cold emails based on each lead's specific brand data, ensuring every outreach message is relevant and conversion-optimized.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Automated Agent</h4>
                    <p>Set up an autonomous SDR agent that runs on a schedule — enriching new leads, generating emails, and sending outreach within daily limits you configure.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Manual Outreach</h4>
                    <p>Generate personalized emails, verify contact addresses, and send directly from your configured sender accounts while keeping all outreach history in one place.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Pipeline Visibility</h4>
                    <p>Track contact status, email history, and replies in the Pipeline view so you can prioritize follow-ups and measure campaign performance.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Create Audiences</h4>
                    <p>Segment your pipeline into targeted audiences based on ICP score, enrichment status, country, or custom filters for more focused outreach campaigns.</p>
                  </div>
                  <div className="help-feature-card">
                    <h4>Bounce Detection</h4>
                    <p>Automatically check for bounced emails and keep your sender reputation healthy. Bounced contacts are flagged so you don't re-send to invalid addresses.</p>
                  </div>
                </div>
              </div>

              {/* FAQ */}
              <div className="help-section">
                <div className="help-section-header">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c6beee" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <h3>Frequently Asked Questions</h3>
                </div>
                <div className="help-faq-list">
                  <div className="help-faq-item">
                    <h4>How many leads can I enrich at once?</h4>
                    <p>You can select up to 50 leads at a time for batch enrichment. Each enrichment takes approximately 10–30 seconds per lead depending on the amount of data available.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>What email verification is used?</h4>
                    <p>We use EmailListVerify to validate all discovered email addresses before they enter your pipeline. This helps maintain a low bounce rate and protects your sender domain.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>Can I customize email templates?</h4>
                    <p>Yes. The ICP Setup messaging & tone section directly influences how AI-generated emails are written. You can also manually edit any generated email before sending.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>How does the automated agent work?</h4>
                    <p>The agent runs on a configurable schedule (e.g., every 4 hours between 8 AM–6 PM). It picks unenriched leads, enriches them, generates emails, and sends — all within daily limits you set.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>How do I set up email sending domains?</h4>
                    <p>Sending domain purchase and DNS configuration are now handled offline. After setup is complete, connect your sending mailbox credentials in your existing workflow and continue outreach from Pipeline, Manual Outreach, or Manage Agent.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>What is email warmup?</h4>
                    <p>Email warmup is still recommended, but it is now managed outside this app. Complete warmup in your preferred deliverability tooling before ramping outbound volume in Manual Outreach or the automated agent.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>How do I monitor campaign replies?</h4>
                    <p>Use the <strong>Pipeline</strong> view to monitor contacted leads, reply status, and outreach history. This includes the latest delivery and response activity for each lead.</p>
                  </div>
                  <div className="help-faq-item">
                    <h4>Is my data secure?</h4>
                    <p>All data is stored in your Supabase instance with row-level security (RLS). API keys and credentials are stored as environment variables and never exposed to the frontend.</p>
                  </div>
                </div>
              </div>

              {/* Contact */}
              <div className="help-section help-contact-section">
                <div className="help-section-header">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                  <h3>Need More Help?</h3>
                </div>
                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', lineHeight: 1.6, marginBottom: '16px' }}>
                  Can't find what you're looking for? Reach out to our team and we'll get back to you as soon as possible.
                </p>
                <a href="mailto:mb2470@gmail.com" className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  Contact Support
                </a>
              </div>
            </div>
          )}

          {/* ═══ CHAT ═══ */}
          {activeView === 'chat' && (
            <ChatPanel orgId={orgId} />
          )}




        </main>
      </div>
    </div>
  );
}

export default App;
