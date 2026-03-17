import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function AgentMonitor() {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState({ emailsToday: 0, repliesToday: 0, maxPerDay: 20, lastHeartbeat: null });
  const [senderAccounts, setSenderAccounts] = useState([]);
  const [savingSenderId, setSavingSenderId] = useState(null);
  const [addingSender, setAddingSender] = useState(false);
  const [senderError, setSenderError] = useState('');
  const [senderSuccess, setSenderSuccess] = useState('');
  const [newSender, setNewSender] = useState({ email: '', displayName: 'Sam Reid', dailyLimit: 30 });
  const [activeOrgId, setActiveOrgId] = useState(null);
  const [isCheckingReplies, setIsCheckingReplies] = useState(false);
  const [replyResult, setReplyResult] = useState(null);
  const [activityLog, setActivityLog] = useState([]);

  // Date filter state
  const [dateRange, setDateRange] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [rangeStats, setRangeStats] = useState({ sent: 0, replies: 0, bounces: 0, replyRate: 0 });

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadRangeStats();
  }, [dateRange, customStart, customEnd, activeOrgId]);

  const loadData = async () => {
    // Load agent settings
    const { data: s } = await supabase.from('agent_settings').select('*').limit(1).single();
    setSettings(s);

    // Load sender accounts + per-account limits for agent routing
    const { data: accounts } = await supabase
      .from('email_accounts')
      .select('id, org_id, domain_id, email_address, display_name, daily_send_limit, current_daily_sent, status')
      .order('created_at', { ascending: false });
    const nextAccounts = accounts || [];
    setSenderAccounts(nextAccounts);

    const resolvedOrgId = s?.org_id || nextAccounts[0]?.org_id || null;
    setActiveOrgId(resolvedOrgId);

    // Load today's stats — scoped by org_id
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Query outreach_log for accurate sent count (source of truth per CLAUDE.md)
    let emailsTodayQuery = supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('sent_at', todayStart.toISOString());
    if (resolvedOrgId) emailsTodayQuery = emailsTodayQuery.eq('org_id', resolvedOrgId);
    const { count: emailsToday } = await emailsTodayQuery;

    // Query outreach_log for accurate reply count — exclude bounces and auto-responders
    // (auto-responders have replied_at cleared by check-replies; bounces have bounced=true)
    let repliesTodayQuery = supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('replied_at', todayStart.toISOString())
      .or('bounced.is.null,bounced.eq.false');
    if (resolvedOrgId) repliesTodayQuery = repliesTodayQuery.eq('org_id', resolvedOrgId);
    const { count: repliesToday } = await repliesTodayQuery;

    setStats(prev => ({
      ...prev,
      emailsToday: emailsToday || 0,
      repliesToday: repliesToday || 0,
      maxPerDay: s?.max_emails_per_day || 20,
      lastHeartbeat: s?.last_heartbeat,
    }));

    // Load recent activity — scoped by org_id
    let activityQuery = supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (resolvedOrgId) activityQuery = activityQuery.eq('org_id', resolvedOrgId);
    const { data: activity } = await activityQuery;
    setActivityLog(activity || []);
  };

  const handleUpdateSenderLimit = async (accountId, dailyLimit) => {
    const parsedLimit = Number.isFinite(dailyLimit) ? dailyLimit : parseInt(dailyLimit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) return;

    setSavingSenderId(accountId);
    setSenderError('');
    setSenderSuccess('');

    const { error } = await supabase
      .from('email_accounts')
      .update({ daily_send_limit: parsedLimit })
      .eq('id', accountId);

    if (error) {
      setSenderError(error.message || 'Failed to update sender daily limit.');
      setSavingSenderId(null);
      return;
    }

    setSenderAccounts((prev) => prev.map((account) => (
      account.id === accountId
        ? { ...account, daily_send_limit: parsedLimit }
        : account
    )));
    setSavingSenderId(null);
  };


  const handleAddSenderAccount = async () => {
    const email = (newSender.email || '').trim().toLowerCase();
    const dailyLimit = parseInt(newSender.dailyLimit, 10);

    if (!activeOrgId) {
      setSenderError('Could not determine org for this workspace yet.');
      return;
    }

    if (!email || !email.includes('@')) {
      setSenderError('Enter a valid sender email address.');
      return;
    }

    if (!Number.isFinite(dailyLimit) || dailyLimit < 1) {
      setSenderError('Daily limit must be at least 1.');
      return;
    }

    const [localPart, domainName] = email.split('@');
    if (!localPart || !domainName) {
      setSenderError('Sender email format is invalid.');
      return;
    }

    const existing = senderAccounts.find((account) => account.email_address?.toLowerCase() === email);
    if (existing) {
      setSenderError('That sender email is already configured.');
      return;
    }

    setAddingSender(true);
    setSenderError('');
    setSenderSuccess('');

    const { data: existingDomain, error: domainError } = await supabase
      .from('email_domains')
      .select('id, domain')
      .eq('org_id', activeOrgId)
      .ilike('domain', domainName)
      .limit(1)
      .maybeSingle();

    if (domainError) {
      setSenderError(domainError.message || 'Failed to validate sender domain.');
      setAddingSender(false);
      return;
    }

    let resolvedDomainId = existingDomain?.id || null;
    let fallbackLinkedDomain = false;

    if (!resolvedDomainId && senderAccounts.length > 0) {
      const primarySender = senderAccounts[0];
      if (primarySender?.domain_id) {
        resolvedDomainId = primarySender.domain_id;
        fallbackLinkedDomain = true;
      }
    }

    if (!resolvedDomainId) {
      setSenderError(`No matching sender domain found for ${domainName}. Add/verify this domain first.`);
      setAddingSender(false);
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('email_accounts')
      .insert({
        org_id: activeOrgId,
        domain_id: resolvedDomainId,
        email_address: email,
        display_name: (newSender.displayName || 'Sam Reid').trim(),
        first_name: (newSender.displayName || 'Sam').trim().split(' ')[0],
        daily_send_limit: dailyLimit,
        current_daily_sent: 0,
        status: 'active',
      })
      .select('id, org_id, domain_id, email_address, display_name, daily_send_limit, current_daily_sent, status')
      .single();

    if (insertError) {
      setSenderError(insertError.message || 'Failed to add sender account.');
      setAddingSender(false);
      return;
    }

    setSenderAccounts((prev) => [inserted, ...prev]);
    setNewSender({ email: '', displayName: newSender.displayName || 'Sam Reid', dailyLimit: 30 });
    setSenderSuccess(
      fallbackLinkedDomain
        ? `${inserted.email_address} added successfully and linked to your default sender account. Active at ${dailyLimit}/day.`
        : `${inserted.email_address} added successfully. Active at ${dailyLimit}/day.`
    );
    setAddingSender(false);
  };

  const getDateRange = () => {
    const now = new Date();
    let start, end;

    switch (dateRange) {
      case 'today':
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end = new Date(now); end.setHours(23, 59, 59, 999);
        break;
      case 'week':
        start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
        end = new Date(now); end.setHours(23, 59, 59, 999);
        break;
      case 'month':
        start = new Date(now); start.setDate(start.getDate() - 30); start.setHours(0, 0, 0, 0);
        end = new Date(now); end.setHours(23, 59, 59, 999);
        break;
      case 'custom':
        start = customStart ? new Date(customStart) : new Date(now);
        end = customEnd ? new Date(customEnd + 'T23:59:59.999') : new Date(now);
        break;
      default:
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end = new Date(now);
    }
    return { start: start.toISOString(), end: end.toISOString() };
  };

  const loadRangeStats = async () => {
    const { start, end } = getDateRange();

    const activityRangeQuery = (activityType) => {
      let q = supabase
        .from('activity_log')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', start)
        .lte('created_at', end);
      if (activeOrgId) q = q.eq('org_id', activeOrgId);
      if (Array.isArray(activityType)) {
        q = q.in('activity_type', activityType);
      } else {
        q = q.eq('activity_type', activityType);
      }
      return q;
    };

    // Query outreach_log for accurate sent count (source of truth per CLAUDE.md)
    let sentQuery = supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('sent_at', start)
      .lte('sent_at', end);
    if (activeOrgId) sentQuery = sentQuery.eq('org_id', activeOrgId);
    const { count: sent } = await sentQuery;

    // Query outreach_log for accurate reply count — exclude bounces and auto-responders
    let repliesQuery = supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('replied_at', start)
      .lte('replied_at', end)
      .or('bounced.is.null,bounced.eq.false');
    if (activeOrgId) repliesQuery = repliesQuery.eq('org_id', activeOrgId);
    const { count: replies } = await repliesQuery;

    const { count: bounces } = await activityRangeQuery('email_bounced');

    const replyRate = sent > 0 ? ((replies || 0) / sent * 100).toFixed(1) : 0;

    setRangeStats({ sent: sent || 0, replies: replies || 0, bounces: bounces || 0, replyRate });
  };

  const handleCheckReplies = async () => {
    setIsCheckingReplies(true);
    setReplyResult(null);
    try {
      const res = await fetch('/.netlify/functions/check-replies', { method: 'POST' });
      const data = await res.json();
      setReplyResult(data);
      await loadData();
      await loadRangeStats();
    } catch (err) {
      setReplyResult({ error: err.message });
    }
    setIsCheckingReplies(false);
  };

  const handleSaveSettings = async (updates) => {
    const newSettings = { ...settings, ...updates };
    await supabase.from('agent_settings').update(updates).eq('id', settings.id);
    setSettings(newSettings);
  };

  const heartbeatAgo = () => {
    if (!stats.lastHeartbeat) return 'Never';
    const mins = Math.floor((Date.now() - new Date(stats.lastHeartbeat).getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  };

  const isOnline = stats.lastHeartbeat && (Date.now() - new Date(stats.lastHeartbeat).getTime()) < 600000;

  const labelStyle = { fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' };
  const cardStyle = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '24px' };
  const statBoxStyle = { background: 'rgba(0,0,0,0.2)', borderRadius: '10px', padding: '16px', flex: 1 };
  const statNumStyle = { fontSize: '28px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", display: 'block', letterSpacing: '-0.5px' };
  const statLabelStyle = { fontSize: '11px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginTop: '4px', display: 'block' };
  const settingLabelStyle = { fontSize: '12px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' };
  const selectStyle = { flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontFamily: 'inherit' };
  const inputStyle = { width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', fontSize: '16px', fontFamily: 'inherit', boxSizing: 'border-box' };

  return (
    <div>
      <h2>🤖 AI Agent Manager</h2>

      {/* ── Agent Status + Controls ── */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
        <span style={{
          padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
          background: settings?.agent_enabled ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
          color: settings?.agent_enabled ? '#4ade80' : '#f87171',
          border: `1px solid ${settings?.agent_enabled ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}>
          ● {settings?.agent_enabled ? 'Active' : 'Paused'}
        </span>
        <span style={{
          padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
          background: isOnline ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: isOnline ? '#4ade80' : '#f87171',
        }}>
          {isOnline ? '● Online' : '● Offline'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => handleSaveSettings({ agent_enabled: !settings?.agent_enabled })}
          className="secondary-btn" style={{ fontSize: '12px', padding: '6px 14px' }}>
          {settings?.agent_enabled ? '⏸ Pause Agent' : '▶️ Start Agent'}
        </button>
      </div>

      {/* ── Top Stats Row ── */}
      <div style={{ ...cardStyle, marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={statBoxStyle}>
            <span style={{ ...statNumStyle, color: isOnline ? '#4ade80' : '#f87171' }}>{heartbeatAgo()}</span>
            <span style={statLabelStyle}>Last Heartbeat</span>
            {stats.lastHeartbeat && (
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', display: 'block', marginTop: '2px' }}>
                {new Date(stats.lastHeartbeat).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div style={statBoxStyle}>
            <span style={{ ...statNumStyle, color: '#9015ed' }}>{stats.emailsToday} / {stats.maxPerDay}</span>
            <span style={statLabelStyle}>Emails Today</span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', display: 'block', marginTop: '2px' }}>
              {stats.maxPerDay - stats.emailsToday} remaining
            </span>
          </div>
          <div style={statBoxStyle}>
            <span style={{ ...statNumStyle, color: '#245ef9' }}>{stats.repliesToday}</span>
            <span style={statLabelStyle}>Replies Today</span>
            <button onClick={handleCheckReplies} disabled={isCheckingReplies}
              style={{
                marginTop: '6px', padding: '4px 10px', borderRadius: '6px', fontSize: '10px',
                border: '1px solid rgba(36,94,249,0.3)', background: 'rgba(36,94,249,0.1)',
                color: '#245ef9', cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {isCheckingReplies ? '⏳ Checking...' : '📬 Check Replies'}
            </button>
            {replyResult && !replyResult.error && (
              <span style={{ fontSize: '10px', color: replyResult.newReplies > 0 ? '#4ade80' : 'rgba(255,255,255,0.3)', display: 'block', marginTop: '4px' }}>
                {replyResult.newReplies > 0 ? `${replyResult.newReplies} new!` : '✓ No new replies'}
                {replyResult.autoResponders > 0 && ` (${replyResult.autoResponders} auto-responders filtered)`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Performance by Date Range ── */}
      <div style={{ ...cardStyle, marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 600 }}>📊 Performance</h3>
          <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '3px' }}>
            {['today', 'week', 'month', 'custom'].map(range => (
              <button key={range} onClick={() => setDateRange(range)}
                style={{
                  padding: '6px 12px', borderRadius: '6px', border: 'none', fontSize: '11px',
                  fontFamily: 'inherit', fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize',
                  background: dateRange === range ? 'rgba(144,21,237,0.2)' : 'transparent',
                  color: dateRange === range ? '#c6beee' : 'rgba(255,255,255,0.4)',
                }}>
                {range === 'week' ? '7 Days' : range === 'month' ? '30 Days' : range}
              </button>
            ))}
          </div>
        </div>

        {dateRange === 'custom' && (
          <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }} />
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px' }}>to</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }} />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          <div style={{ ...statBoxStyle, textAlign: 'center' }}>
            <span style={{ ...statNumStyle, fontSize: '22px', color: '#9015ed' }}>{rangeStats.sent}</span>
            <span style={statLabelStyle}>Sent</span>
          </div>
          <div style={{ ...statBoxStyle, textAlign: 'center' }}>
            <span style={{ ...statNumStyle, fontSize: '22px', color: '#245ef9' }}>{rangeStats.replies}</span>
            <span style={statLabelStyle}>Replies</span>
          </div>
          <div style={{ ...statBoxStyle, textAlign: 'center' }}>
            <span style={{ ...statNumStyle, fontSize: '22px', color: '#f87171' }}>{rangeStats.bounces}</span>
            <span style={statLabelStyle}>Bounces</span>
          </div>
          <div style={{ ...statBoxStyle, textAlign: 'center' }}>
            <span style={{ ...statNumStyle, fontSize: '22px', color: rangeStats.replyRate > 5 ? '#4ade80' : rangeStats.replyRate > 0 ? '#eab308' : 'rgba(255,255,255,0.3)' }}>{rangeStats.replyRate}%</span>
            <span style={statLabelStyle}>Reply Rate</span>
          </div>
        </div>
      </div>

      {/* ── Agent Settings (Editable) ── */}
      {settings && (
        <div style={{ ...cardStyle, marginBottom: '20px' }}>
          <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>⚙️ Agent Settings</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {/* Send Hours */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>Send Hours (EST)</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                <select value={settings.send_hour_start ?? settings.send_hours_start ?? 9} onChange={e => handleSaveSettings({ send_hour_start: parseInt(e.target.value), send_hours_start: parseInt(e.target.value) })}
                  style={selectStyle}>
                  {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{i}:00</option>)}
                </select>
                <span style={{ opacity: 0.5, fontSize: '12px' }}>to</span>
                <select value={settings.send_hour_end ?? settings.send_hours_end ?? 17} onChange={e => handleSaveSettings({ send_hour_end: parseInt(e.target.value), send_hours_end: parseInt(e.target.value) })}
                  style={selectStyle}>
                  {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{i}:00</option>)}
                </select>
              </div>
            </div>

            {/* Max Emails Per Day */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>Max Emails Per Day</label>
              <input type="number" value={settings.max_emails_per_day || 10}
                onChange={e => handleSaveSettings({ max_emails_per_day: parseInt(e.target.value) })}
                style={inputStyle} />
            </div>

            {/* Min Minutes Between Emails */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>Min Minutes Between Emails</label>
              <input type="number" value={settings.min_minutes_between_emails || 10}
                onChange={e => handleSaveSettings({ min_minutes_between_emails: parseInt(e.target.value) })}
                style={inputStyle} />
            </div>

            {/* ICP Filter */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>ICP Fit Filter</label>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                {['HIGH', 'MEDIUM', 'LOW'].map(fit => {
                  const allowed = settings.allowed_icp_fits || ['HIGH'];
                  const isActive = allowed.includes(fit);
                  return (
                    <button key={fit} onClick={() => {
                      const newFits = isActive ? allowed.filter(f => f !== fit) : [...allowed, fit];
                      if (newFits.length > 0) handleSaveSettings({ allowed_icp_fits: newFits });
                    }} style={{
                      flex: 1, padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold',
                      border: isActive ? '1px solid' : '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: isActive ? (fit === 'HIGH' ? 'rgba(34,197,94,0.2)' : fit === 'MEDIUM' ? 'rgba(234,179,8,0.2)' : 'rgba(239,68,68,0.2)') : 'transparent',
                      color: isActive ? (fit === 'HIGH' ? '#4ade80' : fit === 'MEDIUM' ? '#facc15' : '#f87171') : 'rgba(255,255,255,0.3)',
                      borderColor: isActive ? (fit === 'HIGH' ? 'rgba(34,197,94,0.5)' : fit === 'MEDIUM' ? 'rgba(234,179,8,0.5)' : 'rgba(239,68,68,0.5)') : 'rgba(255,255,255,0.15)',
                      fontFamily: 'inherit',
                    }}>{fit}</button>
                  );
                })}
              </div>
            </div>

            {/* Max Contacts Per Lead Per Day */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>Max Contacts Per Lead Per Day</label>
              <input type="number" value={settings.max_contacts_per_lead_per_day || 1} min={1} max={5}
                onChange={e => handleSaveSettings({ max_contacts_per_lead_per_day: parseInt(e.target.value) })}
                style={inputStyle} />
              <div style={{ fontSize: '11px', opacity: 0.4, marginTop: '4px' }}>Sends to multiple contacts at a company over multiple days</div>
            </div>

            {/* Send Days */}
            <div style={{ ...statBoxStyle, flex: 'unset' }}>
              <label style={settingLabelStyle}>Send Days</label>
              <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => {
                  const sendDays = settings.send_days || [1, 2, 3, 4, 5];
                  const dayNum = i + 1;
                  const isDayActive = sendDays.includes(dayNum);
                  return (
                    <button key={day} onClick={() => {
                      const newDays = isDayActive ? sendDays.filter(d => d !== dayNum) : [...sendDays, dayNum].sort();
                      if (newDays.length > 0) handleSaveSettings({ send_days: newDays });
                    }} style={{
                      flex: 1, padding: '6px 2px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
                      border: isDayActive ? '1px solid rgba(144,21,237,0.5)' : '1px solid rgba(255,255,255,0.15)',
                      backgroundColor: isDayActive ? 'rgba(144,21,237,0.2)' : 'transparent',
                      color: isDayActive ? '#a78bfa' : 'rgba(255,255,255,0.3)',
                      fontFamily: 'inherit',
                    }}>{day}</button>
                  );
                })}
              </div>
            </div>

            {/* Auto-Send Toggle */}
            <div style={{ ...statBoxStyle, flex: 'unset', gridColumn: 'span 2' }}>
              <label style={settingLabelStyle}>Auto-Send</label>
              <div style={{ marginTop: '8px' }}>
                <button onClick={() => handleSaveSettings({ auto_send: !settings.auto_send })}
                  style={{
                    width: '100%', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold',
                    border: settings.auto_send ? '1px solid rgba(234,179,8,0.5)' : '1px solid rgba(255,255,255,0.15)',
                    backgroundColor: settings.auto_send ? 'rgba(234,179,8,0.2)' : 'transparent',
                    color: settings.auto_send ? '#facc15' : 'rgba(255,255,255,0.4)',
                    fontFamily: 'inherit',
                  }}>
                  {settings.auto_send ? '⚠️ Auto-Send ON' : '📝 Draft Only'}
                </button>
                <div style={{ fontSize: '11px', opacity: 0.4, marginTop: '4px' }}>
                  {settings.auto_send ? 'Agent sends emails automatically' : 'Agent drafts emails for your review'}
                </div>
              </div>
            </div>

            {/* Sender Accounts + Per-Account Daily Limits */}
            <div style={{ ...statBoxStyle, flex: 'unset', gridColumn: 'span 2' }}>
              <label style={settingLabelStyle}>Sender Accounts (Per-Day Limits)</label>
              <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '4px', marginBottom: '10px' }}>
                Configure how many emails the agent can send from each Sam inbox per day (example: 50 from one account and 10 from another).
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 120px 100px',
                gap: '8px',
                alignItems: 'end',
                marginBottom: '12px',
              }}>
                <div>
                  <label style={{ ...settingLabelStyle, opacity: 0.5 }}>Sender Email</label>
                  <input
                    type="email"
                    value={newSender.email}
                    placeholder="sam@onsite-affiliate.net"
                    onChange={(e) => setNewSender((prev) => ({ ...prev, email: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ ...settingLabelStyle, opacity: 0.5 }}>Display Name</label>
                  <input
                    value={newSender.displayName}
                    placeholder="Sam Reid"
                    onChange={(e) => setNewSender((prev) => ({ ...prev, displayName: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ ...settingLabelStyle, opacity: 0.5 }}>Daily Limit</label>
                  <input
                    type="number"
                    min={1}
                    value={newSender.dailyLimit}
                    onChange={(e) => setNewSender((prev) => ({ ...prev, dailyLimit: parseInt(e.target.value, 10) || 1 }))}
                    style={inputStyle}
                  />
                </div>
                <button
                  onClick={handleAddSenderAccount}
                  disabled={addingSender}
                  style={{
                    height: '42px',
                    marginTop: '8px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.18)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(255,255,255,0.9)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: 600,
                  }}
                >
                  {addingSender ? 'Adding…' : '+ Add'}
                </button>
              </div>

              {senderError && (
                <div style={{ fontSize: '12px', color: '#f87171', marginBottom: '10px' }}>{senderError}</div>
              )}

              {senderSuccess && (
                <div style={{ fontSize: '12px', color: '#4ade80', marginBottom: '10px' }}>{senderSuccess}</div>
              )}

              {senderAccounts.length === 0 ? (
                <div style={{ fontSize: '12px', opacity: 0.45 }}>No sender inboxes found in email_accounts yet.</div>
              ) : (
                <div style={{ display: 'grid', gap: '8px' }}>
                  {senderAccounts.map((account) => (
                    <div key={account.id} style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 120px 80px',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '8px',
                      borderRadius: '8px',
                      background: 'rgba(0,0,0,0.2)',
                      border: '1px solid rgba(255,255,255,0.07)',
                    }}>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.9)' }}>
                        {account.display_name ? `${account.display_name} · ` : ''}{account.email_address}
                        <span style={{ marginLeft: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.45)' }}>
                          {account.current_daily_sent || 0} sent today
                        </span>
                        <span style={{ marginLeft: '8px', fontSize: '11px', color: '#86efac' }}>
                          {(account.status || 'active').toUpperCase()} · Active at {(account.daily_send_limit || 1)}/day
                        </span>
                      </div>
                      <input
                        type="number"
                        min={1}
                        value={account.daily_send_limit || 1}
                        onChange={(e) => {
                          const next = parseInt(e.target.value, 10);
                          setSenderAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, daily_send_limit: next } : a)));
                        }}
                        style={inputStyle}
                      />
                      <button
                        onClick={() => handleUpdateSenderLimit(account.id, account.daily_send_limit)}
                        disabled={savingSenderId === account.id}
                        style={{
                          padding: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)',
                          background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.85)',
                          cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px',
                        }}
                      >
                        {savingSenderId === account.id ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Activity Log ── */}
      <div style={cardStyle}>
        <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Recent Activity</h3>
        <div className="activity-list">
          {activityLog.map(a => (
            <div key={a.id} className="activity-item">
              <span className="activity-icon">
                {a.activity_type === 'lead_enriched' && '🔍'}
                {a.activity_type === 'email_sent' && '📤'}
                {a.activity_type === 'email_exported' && '📧'}
                {a.activity_type === 'email_failed' && '❌'}
                {a.activity_type === 'email_bounced' && '🔄'}
                {a.activity_type === 'email_reply' && '💬'}
                {a.activity_type === 'autonomous_run' && '🤖'}
                {a.activity_type === 'batch_send' && '📦'}
                {a.activity_type === 'apollo_discovery' && '🚀'}
                {a.activity_type === 'apollo_org_enrichment' && '🏢'}
                {a.activity_type === 'lead_discovery' && '🌐'}
                {a.activity_type === 'bulk_socials' && '📱'}
                {a.activity_type === 'prioritized_enrichment' && '⚡'}
                {a.activity_type === 'contact_matching' && '👥'}
                {a.activity_type === 'bulk_enrichment' && '📊'}
                {!['lead_enriched','email_sent','email_exported','email_failed','email_bounced','email_reply','autonomous_run','batch_send','apollo_discovery','apollo_org_enrichment','lead_discovery','bulk_socials','prioritized_enrichment','contact_matching','bulk_enrichment'].includes(a.activity_type) && '📋'}
              </span>
              <span className="activity-summary">{a.summary}</span>
              <span className="activity-time">{new Date(a.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
