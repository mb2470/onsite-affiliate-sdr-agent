import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import './AgentMonitor.css';
import { supabase } from './supabaseClient';

function AgentMonitor() {
  const [agentStatus, setAgentStatus] = useState(null);
  const [heartbeat, setHeartbeat] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 10000); // Update every 10 seconds
    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    try {
      // Get agent settings including heartbeat
      const { data: settings } = await supabase
        .from('agent_settings')
        .select('*')
        .single();

      setAgentStatus(settings);

      // Calculate heartbeat status
      if (settings?.last_heartbeat) {
        const lastBeat = new Date(settings.last_heartbeat);
        const now = new Date();
        const diffMinutes = (now - lastBeat) / 1000 / 60;
        
        setHeartbeat({
          timestamp: lastBeat,
          status: diffMinutes < 2 ? 'healthy' : diffMinutes < 5 ? 'warning' : 'offline',
          minutesAgo: Math.floor(diffMinutes)
        });
      }

      // Get today's stats
      const today = new Date().toISOString().split('T')[0];
      const { data: todayStats } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('date', today)
        .single();

      setStats(todayStats || {
        leads_enriched: 0,
        contacts_found: 0,
        emails_drafted: 0,
        emails_sent: 0
      });

    } catch (error) {
      console.error('Error loading status:', error);
    }
  };

  const getStatusColor = () => {
    if (!agentStatus?.agent_enabled) return 'paused';
    if (!heartbeat) return 'offline';
    return heartbeat.status;
  };

  const getStatusText = () => {
    if (!agentStatus?.agent_enabled) return '⏸️ Paused';
    if (!heartbeat) return '⚠️ No Heartbeat';
    if (heartbeat.status === 'healthy') return '🟢 Active';
    if (heartbeat.status === 'warning') return '🟡 Slow';
    return '🔴 Offline';
  };

  return (
    <div className="agent-monitor">
      <div className="monitor-header">
        <h3>🤖 Agent Status</h3>
        <div className={`status-pill ${getStatusColor()}`}>
          {getStatusText()}
        </div>
      </div>

      <div className="monitor-grid">
        <div className="monitor-card">
          <div className="card-label">Last Heartbeat</div>
          <div className="card-value">
            {heartbeat ? `${heartbeat.minutesAgo}m ago` : 'Never'}
          </div>
          <div className="card-subtext">
            {heartbeat?.timestamp.toLocaleTimeString() || 'Waiting...'}
          </div>
        </div>

        <div className="monitor-card">
          <div className="card-label">Emails Today</div>
          <div className="card-value">
            {stats?.emails_sent || 0} / {agentStatus?.max_emails_per_day || 50}
          </div>
          <div className="card-subtext">
            {agentStatus?.max_emails_per_day - (stats?.emails_sent || 0)} remaining
          </div>
        </div>

        <div className="monitor-card">
          <div className="card-label">Leads Processed</div>
          <div className="card-value">{stats?.leads_enriched || 0}</div>
          <div className="card-subtext">Today</div>
        </div>

        <div className="monitor-card">
          <div className="card-label">Contacts Found</div>
          <div className="card-value">{stats?.contacts_found || 0}</div>
          <div className="card-subtext">Today</div>
        </div>
      </div>

      <div className="monitor-details">
        <div className="detail-row">
          <span className="detail-label">Send Hours:</span>
          <span className="detail-value">
            {agentStatus?.send_hours_start || 9}:00 - {agentStatus?.send_hours_end || 17}:00 EST
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Min Between Emails:</span>
          <span className="detail-value">
            {agentStatus?.min_minutes_between_emails || 15} minutes
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">ICP Filters:</span>
          <span className="detail-value">
            {agentStatus?.allowed_icp_fits?.join(', ') || 'HIGH'}
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Auto-Send:</span>
          <span className={`detail-value ${agentStatus?.auto_send ? 'text-warning' : 'text-success'}`}>
            {agentStatus?.auto_send ? '⚠️ Enabled' : '✅ Manual Approval'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default AgentMonitor;
