import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function AgentMonitor() {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState({ emailsToday: 0, repliesToday: 0, maxPerDay: 20, lastHeartbeat: null });
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
  }, [dateRange, customStart, customEnd]);

  const loadData = async () => {
    // Load agent settings
    const { data: s } = await supabase.from('agent_settings').select('*').limit(1).single();
    setSettings(s);

    // Load today's stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count: emailsToday } = await supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('sent_at', todayStart.toISOString());

    const { count: repliesToday } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('activity_type', 'email_reply')
      .gte('created_at', todayStart.toISOString());

    setStats(prev => ({
      ...prev,
      emailsToday: emailsToday || 0,
      repliesToday: repliesToday || 0,
      maxPerDay: s?.max_emails_per_day || 20,
      lastHeartbeat: s?.last_heartbeat,
    }));

    // Load recent activity
    const { data: activity } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    setActivityLog(activity || []);
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

    const { count: sent } = await supabase
      .from('outreach_log')
      .select('*', { count: 'exact', head: true })
      .gte('sent_at', start)
      .lte('sent_at', end);

    const { count: replies } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('activity_type', 'email_reply')
      .gte('created_at', start)
      .lte('created_at', end);

    const { count: bounces } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('activity_type', 'email_bounced')
      .gte('created_at', start)
      .lte('created_at', end);

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

      {/* ── Agent Settings ── */}
      {settings && (
        <div style={{ ...cardStyle, marginBottom: '20px' }}>
          <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>⚙️ Agent Settings</h3>
          <div style={{ display: 'grid', gap: '12px' }}>
            {[
              { label: 'Send Hours:', value: `${settings.send_hour_start || 8}:00 – ${settings.send_hour_end || 17}:00 EST` },
              { label: 'Min Between Emails:', value: `${settings.min_minutes_between_emails || 10} minutes` },
              { label: 'ICP Filters:', value: (settings.allowed_icp_fits || ['HIGH']).join(', ') },
              { label: 'Auto-Send:', value: settings.agent_enabled ? '⚡ Enabled' : '⏸ Disabled', color: settings.agent_enabled ? '#4ade80' : '#f87171' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>{row.label}</span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: row.color || 'rgba(255,255,255,0.8)' }}>{row.value}</span>
              </div>
            ))}
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
