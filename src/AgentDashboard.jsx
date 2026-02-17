import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import './AgentDashboard.css';
import { supabase } from './supabaseClient';

function AgentDashboard() {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [pendingEmails, setPendingEmails] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load data on mount
  useEffect(() => {
    loadDashboard();
    
    // Refresh every 10 seconds
    const interval = setInterval(loadDashboard, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadDashboard = async () => {
    try {
      // Load settings
      const { data: settingsData } = await supabase
        .from('agent_settings')
        .select('*')
        .single();
      setSettings(settingsData);

      // Load today's stats
      const today = new Date().toISOString().split('T')[0];
      const { data: statsData } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('date', today)
        .single();
      setStats(statsData || {
        leads_enriched: 0,
        contacts_found: 0,
        emails_drafted: 0,
        emails_sent: 0,
        emails_failed: 0
      });

      // Load recent activity
      const { data: activityData } = await supabase
        .from('activity_log')
        .select('*, leads(website), contacts(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(20);
      setActivityLog(activityData || []);

      // Load pending emails (drafts)
      const { data: emailsData } = await supabase
        .from('emails')
        .select('*, leads(website), contacts(full_name, title, email)')
        .eq('status', 'draft')
        .order('created_at', { ascending: false })
        .limit(10);
      setPendingEmails(emailsData || []);

      setLoading(false);
    } catch (error) {
      console.error('Error loading dashboard:', error);
    }
  };

  const updateSettings = async (updates) => {
    try {
      const { error } = await supabase
        .from('agent_settings')
        .update(updates)
        .eq('id', '00000000-0000-0000-0000-000000000001');
      
      if (!error) {
        setSettings({ ...settings, ...updates });
        alert('✅ Settings updated!');
      }
    } catch (error) {
      console.error('Error updating settings:', error);
      alert('❌ Failed to update settings');
    }
  };

  const approveEmail = async (emailId) => {
    if (!confirm('Send this email now?')) return;
    
    try {
      alert(`Email ${emailId} approved! (Would send via agent API)`);
      loadDashboard();
    } catch (error) {
      console.error('Error approving email:', error);
    }
  };

  const rejectEmail = async (emailId) => {
    if (!confirm('Delete this draft?')) return;
    
    try {
      await supabase
        .from('emails')
        .update({ status: 'rejected' })
        .eq('id', emailId);
      
      loadDashboard();
    } catch (error) {
      console.error('Error rejecting email:', error);
    }
  };

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  return (
    <div className="agent-dashboard">
      <header className="dashboard-header">
        <h1>🤖 AI SDR Agent Manager</h1>
        <div className="agent-status">
          <div className={`status-indicator ${settings?.agent_enabled ? 'active' : 'paused'}`}>
            {settings?.agent_enabled ? '🟢 Active' : '⏸️ Paused'}
          </div>
          <button
            className="toggle-agent-btn"
            onClick={() => updateSettings({ agent_enabled: !settings?.agent_enabled })}
          >
            {settings?.agent_enabled ? 'Pause Agent' : 'Start Agent'}
          </button>
        </div>
      </header>

      {/* Stats Overview */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats?.leads_enriched || 0}</div>
          <div className="stat-label">Leads Enriched Today</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.contacts_found || 0}</div>
          <div className="stat-label">Contacts Found</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.emails_drafted || 0}</div>
          <div className="stat-label">Emails Drafted</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.emails_sent || 0}</div>
          <div className="stat-label">Emails Sent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {(settings?.max_emails_per_day || 50) - (settings?.emails_sent_today || 0)}
          </div>
          <div className="stat-label">Remaining Today</div>
        </div>
      </div>

      <div className="dashboard-content">
        {/* Settings Panel */}
        <div className="settings-panel">
          <h2>⚙️ Agent Settings</h2>
          
          <div className="settings-section">
            <h3>Email Limits</h3>
            <div className="setting-item">
              <label>Max Emails Per Day</label>
              <input
                type="number"
                value={settings?.max_emails_per_day || 50}
                onChange={(e) => updateSettings({ max_emails_per_day: parseInt(e.target.value) })}
              />
            </div>
            <div className="setting-item">
              <label>Minutes Between Emails</label>
              <input
                type="number"
                value={settings?.min_minutes_between_emails || 15}
                onChange={(e) => updateSettings({ min_minutes_between_emails: parseInt(e.target.value) })}
              />
            </div>
            <div className="setting-item">
              <label>Send Hours (EST)</label>
              <div className="hours-input">
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={settings?.send_hours_start || 9}
                  onChange={(e) => updateSettings({ send_hours_start: parseInt(e.target.value) })}
                />
                <span>to</span>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={settings?.send_hours_end || 17}
                  onChange={(e) => updateSettings({ send_hours_end: parseInt(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>Lead Filters</h3>
            <div className="setting-item">
              <label>ICP Fit Requirements</label>
              <div className="checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={settings?.allowed_icp_fits?.includes('HIGH')}
                    onChange={(e) => {
                      const fits = settings?.allowed_icp_fits || [];
                      const newFits = e.target.checked
                        ? [...fits, 'HIGH']
                        : fits.filter(f => f !== 'HIGH');
                      updateSettings({ allowed_icp_fits: newFits });
                    }}
                  />
                  HIGH Only
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings?.allowed_icp_fits?.includes('MEDIUM')}
                    onChange={(e) => {
                      const fits = settings?.allowed_icp_fits || [];
                      const newFits = e.target.checked
                        ? [...fits, 'MEDIUM']
                        : fits.filter(f => f !== 'MEDIUM');
                      updateSettings({ allowed_icp_fits: newFits });
                    }}
                  />
                  Include MEDIUM
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings?.allowed_icp_fits?.includes('LOW')}
                    onChange={(e) => {
                      const fits = settings?.allowed_icp_fits || [];
                      const newFits = e.target.checked
                        ? [...fits, 'LOW']
                        : fits.filter(f => f !== 'LOW');
                      updateSettings({ allowed_icp_fits: newFits });
                    }}
                  />
                  Include LOW
                </label>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>Contact Quality</h3>
            <div className="setting-item">
              <label>Minimum Match Level</label>
              <select
                value={settings?.min_match_level || 'Good Match'}
                onChange={(e) => updateSettings({ min_match_level: e.target.value })}
              >
                <option value="Best Match">Best Match Only</option>
                <option value="Great Match">Great Match or Better</option>
                <option value="Good Match">Good Match or Better</option>
                <option value="Possible Match">All Matches</option>
              </select>
            </div>
            <div className="setting-item">
              <label>Minimum Score</label>
              <input
                type="number"
                value={settings?.min_match_score || 40}
                onChange={(e) => updateSettings({ min_match_score: parseInt(e.target.value) })}
              />
            </div>
          </div>

          <div className="settings-section">
            <h3>Contact Limits</h3>
            <div className="setting-item">
              <label>Max Contacts Per Lead</label>
              <input
                type="number"
                value={settings?.max_contacts_per_lead || 3}
                onChange={(e) => updateSettings({ max_contacts_per_lead: parseInt(e.target.value) })}
              />
            </div>
            <div className="setting-item">
              <label>Max Per Company Per Day</label>
              <input
                type="number"
                value={settings?.max_contacts_per_company_per_day || 1}
                onChange={(e) => updateSettings({ max_contacts_per_company_per_day: parseInt(e.target.value) })}
              />
            </div>
          </div>

          <div className="settings-section">
            <h3>Approval Mode</h3>
            <div className="setting-item">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={settings?.auto_send || false}
                  onChange={(e) => updateSettings({ auto_send: e.target.checked })}
                />
                <span>Auto-send emails (no manual approval)</span>
              </label>
              <p className="setting-hint">
                {settings?.auto_send
                  ? '⚠️ Emails will send automatically'
                  : '✅ Emails require your approval'}
              </p>
            </div>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="activity-panel">
          <h2>📊 Recent Activity</h2>
          <div className="activity-log">
            {activityLog.length === 0 ? (
              <p className="empty-state">No activity yet. Start the agent to begin!</p>
            ) : (
              activityLog.map(activity => (
                <div key={activity.id} className={`activity-item ${activity.status}`}>
                  <div className="activity-icon">
                    {activity.activity_type === 'lead_enriched' && '🔍'}
                    {activity.activity_type === 'contacts_found' && '👥'}
                    {activity.activity_type === 'email_drafted' && '✉️'}
                    {activity.activity_type === 'email_sent' && '📤'}
                    {activity.activity_type === 'email_failed' && '❌'}
                  </div>
                  <div className="activity-details">
                    <div className="activity-summary">{activity.summary}</div>
                    <div className="activity-meta">
                      {activity.leads?.website} • {new Date(activity.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Pending Emails */}
        {!settings?.auto_send && pendingEmails.length > 0 && (
          <div className="pending-panel">
            <h2>📬 Pending Approval ({pendingEmails.length})</h2>
            <div className="pending-emails">
              {pendingEmails.map(email => (
                <div key={email.id} className="email-card">
                  <div className="email-header">
                    <div className="email-to">
                      <strong>{email.contacts?.full_name}</strong>
                      <span className="email-title">{email.contacts?.title}</span>
                      <span className="email-address">{email.contacts?.email}</span>
                    </div>
                    <div className="email-company">{email.leads?.website}</div>
                  </div>
                  <div className="email-subject">
                    <strong>Subject:</strong> {email.subject}
                  </div>
                  <div className="email-body">
                    <pre>{email.body}</pre>
                  </div>
                  <div className="email-actions">
                    <button
                      className="approve-btn"
                      onClick={() => approveEmail(email.id)}
                    >
                      ✅ Approve & Send
                    </button>
                    <button
                      className="reject-btn"
                      onClick={() => rejectEmail(email.id)}
                    >
                      ❌ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentDashboard;
