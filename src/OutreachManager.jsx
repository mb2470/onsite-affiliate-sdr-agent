import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

// ── API helper ──────────────────────────────────────────────────────────────

async function api(fn, body) {
  const res = await fetch(`/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';

  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return html;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const blockedTags = ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'style'];

  blockedTags.forEach((tag) => {
    doc.querySelectorAll(tag).forEach((node) => node.remove());
  });

  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value?.trim().toLowerCase() || '';

      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        return;
      }

      if ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:')) {
        node.removeAttribute(attr.name);
      }
    });
  });

  return doc.body.innerHTML;
}

function getDkimRecords(domain) {
  const direct = Array.isArray(domain?.dkim_records) ? domain.dkim_records : null;
  if (direct && direct.length > 0) return direct;

  const fallback = [
    {
      name: domain?.dkim_name || domain?.dkim_host || domain?.dkim_selector,
      content: domain?.dkim_content || domain?.dkim_value || domain?.dkim_public_key,
      type: domain?.dkim_type || 'TXT',
    },
  ].filter((record) => record.name && record.content);

  return fallback;
}

// ── Shared styles ───────────────────────────────────────────────────────────

const cardStyle = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '14px',
  padding: '20px',
  marginBottom: '16px',
};

const labelStyle = {
  display: 'block', fontSize: '12px', fontWeight: 600,
  color: 'rgba(255,255,255,0.5)', marginBottom: '6px', textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const inputStyle = {
  width: '100%', padding: '10px 14px', borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)',
  color: '#f6f6f7', fontSize: '14px', fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const btnPrimary = {
  padding: '10px 20px', borderRadius: '10px', border: 'none',
  background: 'linear-gradient(135deg, #9015ed 0%, #4a3fed 50%, #245ef9 100%)',
  color: '#fff', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  fontFamily: 'inherit',
};

const btnSecondary = {
  padding: '10px 20px', borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.7)', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
  fontFamily: 'inherit',
};

const badgeStyle = (color) => ({
  display: 'inline-block', padding: '3px 10px', borderRadius: '20px', fontSize: '11px',
  fontWeight: 600, textTransform: 'uppercase',
  background: `${color}22`, color, border: `1px solid ${color}44`,
});

const emptyState = (msg) => (
  <div style={{ textAlign: 'center', padding: '48px 20px', color: 'rgba(255,255,255,0.3)', fontSize: '14px' }}>
    {msg}
  </div>
);

// ── Status badge helper ─────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const colors = {
    active: '#4ade80', pending: '#facc15', provisioning: '#38bdf8',
    verified: '#4ade80', dns_pending: '#facc15', purchased: '#38bdf8',
    warmup: '#f59e0b', paused: '#94a3b8', error: '#f87171',
    running: '#4ade80', draft: '#94a3b8', completed: '#38bdf8',
    sending: '#4ade80',
  };
  const c = colors[status] || '#94a3b8';
  return <span style={badgeStyle(c)}>{status?.replace(/_/g, ' ') || 'unknown'}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ═══════════════════════════════════════════════════════════════════════════

function SettingsTab({ orgId }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState({});
  const [testResults, setTestResults] = useState({});
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('smartlead-email', { org_id: orgId, action: 'get-settings' });
      setSettings(data);
      setForm({
        smartlead_api_key: '',
        cloudflare_api_token: '',
        cloudflare_account_id: data.cloudflare_account_id || '',
        gmail_from_email: data.gmail_from_email || '',
        gmail_from_name: data.gmail_from_name || '',
        smartlead_webhook_secret: '',
        whois_first_name: data.whois_first_name || '',
        whois_last_name: data.whois_last_name || '',
        whois_address: data.whois_address || '',
        whois_city: data.whois_city || '',
        whois_state: data.whois_state || '',
        whois_zip: data.whois_zip || '',
        whois_country: data.whois_country || '',
        whois_phone: data.whois_phone || '',
        whois_email: data.whois_email || '',
      });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const updates = {};
      for (const [k, v] of Object.entries(form)) {
        if (v !== '' && v !== undefined) updates[k] = v;
      }
      await api('smartlead-email', { org_id: orgId, action: 'update-settings', ...updates });
      setMsg({ type: 'success', text: 'Settings saved.' });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setSaving(false);
  };

  const handleTest = async (service) => {
    setTesting(p => ({ ...p, [service]: true }));
    setTestResults(p => ({ ...p, [service]: null }));
    try {
      const fn = service === 'smartlead' ? 'smartlead-email' : 'cloudflare-domains';
      const action = service === 'smartlead' ? 'test-smartlead' : 'test';
      const data = await api(fn, { org_id: orgId, action });
      setTestResults(p => ({ ...p, [service]: { ok: true, data } }));
    } catch (e) {
      setTestResults(p => ({ ...p, [service]: { ok: false, error: e.message } }));
    }
    setTesting(p => ({ ...p, [service]: false }));
  };

  if (loading) return emptyState('Loading settings...');

  const f = (key) => form[key] || '';
  const set = (key, val) => setForm(p => ({ ...p, [key]: val }));

  return (
    <div>
      {msg && (
        <div style={{ ...cardStyle, borderColor: msg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)', background: msg.type === 'error' ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.06)', marginBottom: '20px' }}>
          <span style={{ color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '14px' }}>{msg.text}</span>
        </div>
      )}

      {/* Smartlead */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>Smartlead</h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {settings?.has_smartlead && <StatusBadge status="active" />}
            <button style={btnSecondary} onClick={() => handleTest('smartlead')} disabled={testing.smartlead}>
              {testing.smartlead ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>
        {testResults.smartlead && (
          <div style={{ marginBottom: '12px', fontSize: '13px', color: testResults.smartlead.ok ? '#4ade80' : '#f87171' }}>
            {testResults.smartlead.ok ? 'Connection successful' : testResults.smartlead.error}
          </div>
        )}
        <label style={labelStyle}>API Key {settings?.has_smartlead && '(saved — enter new to change)'}</label>
        <input style={inputStyle} type="password" placeholder={settings?.has_smartlead ? '••••••••••••' : 'Enter Smartlead API key'} value={f('smartlead_api_key')} onChange={e => set('smartlead_api_key', e.target.value)} />
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Webhook Secret</label>
          <input style={inputStyle} type="password" placeholder="Enter webhook secret" value={f('smartlead_webhook_secret')} onChange={e => set('smartlead_webhook_secret', e.target.value)} />
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '4px' }}>Used to validate inbound Smartlead webhooks. Append <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '4px' }}>?secret=YOUR_SECRET</code> to your webhook URL.</div>
        </div>
      </div>

      {/* Cloudflare */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>Cloudflare</h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {settings?.has_cloudflare && <StatusBadge status="active" />}
            <button style={btnSecondary} onClick={() => handleTest('cloudflare')} disabled={testing.cloudflare}>
              {testing.cloudflare ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>
        {testResults.cloudflare && (
          <div style={{ marginBottom: '12px', fontSize: '13px', color: testResults.cloudflare.ok ? '#4ade80' : '#f87171' }}>
            {testResults.cloudflare.ok ? 'Connection successful' : testResults.cloudflare.error}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>API Token {settings?.has_cloudflare && '(saved)'}</label>
            <input style={inputStyle} type="password" placeholder={settings?.has_cloudflare ? '••••••••••••' : 'Enter Cloudflare API token'} value={f('cloudflare_api_token')} onChange={e => set('cloudflare_api_token', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Account ID</label>
            <input style={inputStyle} placeholder="Cloudflare Account ID" value={f('cloudflare_account_id')} onChange={e => set('cloudflare_account_id', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Gmail Forwarding */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>Gmail Forwarding</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>From Email</label>
            <input style={inputStyle} placeholder="sender@example.com" value={f('gmail_from_email')} onChange={e => set('gmail_from_email', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>From Name</label>
            <input style={inputStyle} placeholder="Display Name" value={f('gmail_from_name')} onChange={e => set('gmail_from_name', e.target.value)} />
          </div>
        </div>
      </div>

      {/* WHOIS */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 6px', fontSize: '16px' }}>WHOIS Contact (Domain Registration)</h3>
        <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', margin: '0 0 16px' }}>Required for purchasing domains via Cloudflare.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div><label style={labelStyle}>First Name</label><input style={inputStyle} value={f('whois_first_name')} onChange={e => set('whois_first_name', e.target.value)} /></div>
          <div><label style={labelStyle}>Last Name</label><input style={inputStyle} value={f('whois_last_name')} onChange={e => set('whois_last_name', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Street Address</label><input style={inputStyle} value={f('whois_address')} onChange={e => set('whois_address', e.target.value)} /></div>
          <div><label style={labelStyle}>City</label><input style={inputStyle} value={f('whois_city')} onChange={e => set('whois_city', e.target.value)} /></div>
          <div><label style={labelStyle}>State</label><input style={inputStyle} value={f('whois_state')} onChange={e => set('whois_state', e.target.value)} /></div>
          <div><label style={labelStyle}>ZIP</label><input style={inputStyle} value={f('whois_zip')} onChange={e => set('whois_zip', e.target.value)} /></div>
          <div><label style={labelStyle}>Country (2-letter code)</label><input style={inputStyle} placeholder="US" value={f('whois_country')} onChange={e => set('whois_country', e.target.value)} /></div>
          <div><label style={labelStyle}>Phone</label><input style={inputStyle} placeholder="+1.5551234567" value={f('whois_phone')} onChange={e => set('whois_phone', e.target.value)} /></div>
          <div><label style={labelStyle}>Email</label><input style={inputStyle} type="email" value={f('whois_email')} onChange={e => set('whois_email', e.target.value)} /></div>
        </div>
      </div>

      <button style={{ ...btnPrimary, width: '100%' }} onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DOMAINS TAB
// ═══════════════════════════════════════════════════════════════════════════

function DomainsTab({ orgId }) {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [purchasing, setPurchasing] = useState(null);
  const [provisioning, setProvisioning] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [expandedDomain, setExpandedDomain] = useState(null);
  const [domainStatus, setDomainStatus] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('cloudflare-domains', { org_id: orgId, action: 'list' });
      setDomains(data.domains || []);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const data = await api('cloudflare-domains', { org_id: orgId, action: 'search', query: searchQuery.trim() });
      setSearchResults(data.domains || []);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setSearching(false);
  };

  const handlePurchase = async (domain) => {
    setPurchasing(domain);
    try {
      await api('cloudflare-domains', { org_id: orgId, action: 'purchase', domain });
      setMsg({ type: 'success', text: `${domain} purchased successfully!` });
      setSearchResults(null);
      setSearchQuery('');
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setPurchasing(null);
  };

  const handleProvision = async (domain) => {
    const dkimRecords = getDkimRecords(domain);
    setProvisioning(domain.id);
    try {
      const data = await api('cloudflare-domains', {
        org_id: orgId,
        action: 'provision-dns',
        domain_id: domain.id,
        provider: {
          dkimRecords,
        },
      });
      if (data.results?.errors?.length) {
        setMsg({ type: 'error', text: `DNS provisioned with ${data.results.errors.length} error(s)` });
      } else if (dkimRecords.length === 0) {
        setMsg({ type: 'error', text: 'DNS provisioned, but no DKIM record was supplied. Add DKIM data and retry setup before verifying.' });
      } else {
        setMsg({ type: 'success', text: 'DNS records provisioned (MX, SPF, DKIM, DMARC).' });
      }
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setProvisioning(null);
  };

  const handleVerify = async (domainId) => {
    setVerifying(domainId);
    try {
      const data = await api('cloudflare-domains', { org_id: orgId, action: 'verify-dns', domain_id: domainId });
      setDomainStatus(data);
      if (data.all_verified) {
        setMsg({ type: 'success', text: 'All DNS records verified!' });
      } else {
        setMsg({ type: 'error', text: 'Some DNS records are not yet propagated.' });
      }
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setVerifying(null);
  };

  const handleExpand = async (domain) => {
    if (expandedDomain === domain.id) {
      setExpandedDomain(null);
      setDomainStatus(null);
      return;
    }
    setExpandedDomain(domain.id);
    try {
      const data = await api('cloudflare-domains', { org_id: orgId, action: 'status', domain_id: domain.id });
      setDomainStatus(data);
    } catch { /* silent */ }
  };

  if (loading) return emptyState('Loading domains...');

  return (
    <div>
      {msg && (
        <div style={{ ...cardStyle, borderColor: msg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)', background: msg.type === 'error' ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.06)', marginBottom: '20px' }}>
          <span style={{ color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '14px' }}>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>x</button>
        </div>
      )}

      {/* Search & Purchase */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>Search & Purchase Domain</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input style={{ ...inputStyle, flex: 1 }} placeholder="e.g. acmecorp" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
          <button style={btnPrimary} onClick={handleSearch} disabled={searching}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        {searchResults && (
          <div style={{ marginTop: '12px' }}>
            {searchResults.length === 0 ? (
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>No available domains found.</div>
            ) : (
              searchResults.map(d => (
                <div key={d.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{d.name}</span>
                    {d.available && <span style={{ marginLeft: '12px', color: '#4ade80', fontSize: '13px' }}>${d.price ?? '?'}/yr</span>}
                    {!d.available && <span style={{ marginLeft: '12px', color: '#f87171', fontSize: '13px' }}>Unavailable</span>}
                  </div>
                  {d.available && (
                    <button style={btnPrimary} onClick={() => handlePurchase(d.name)} disabled={purchasing === d.name}>
                      {purchasing === d.name ? 'Purchasing...' : 'Buy'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Domain List */}
      <h3 style={{ fontSize: '16px', marginBottom: '12px' }}>Your Domains ({domains.length})</h3>
      {domains.length === 0 ? emptyState('No domains yet. Search and purchase one above.') : (
        domains.map(d => (
          <div key={d.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => handleExpand(d)}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '15px' }}>{d.domain}</span>
                <span style={{ marginLeft: '12px' }}><StatusBadge status={d.status} /></span>
                <span style={{ marginLeft: '12px', color: 'rgba(255,255,255,0.35)', fontSize: '12px' }}>
                  {d.account_count || 0} account{d.account_count !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {d.status === 'purchased' && (
                  <button style={btnSecondary} onClick={e => { e.stopPropagation(); handleProvision(d); }} disabled={provisioning === d.id}>
                    {provisioning === d.id ? 'Provisioning...' : 'Setup DNS'}
                  </button>
                )}
                {(d.status === 'dns_pending' || d.status === 'provisioning') && (
                  <button style={btnSecondary} onClick={e => { e.stopPropagation(); handleVerify(d.id); }} disabled={verifying === d.id}>
                    {verifying === d.id ? 'Verifying...' : 'Verify DNS'}
                  </button>
                )}
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '18px' }}>{expandedDomain === d.id ? '\u25B2' : '\u25BC'}</span>
              </div>
            </div>
            {expandedDomain === d.id && domainStatus && (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {domainStatus.status && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                    {['mx', 'spf', 'dkim', 'dmarc'].map(k => (
                      <div key={k} style={{ textAlign: 'center', padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>{k}</div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: domainStatus.status[k] ? '#4ade80' : '#f87171', marginTop: '4px' }}>
                          {domainStatus.status[k] ? 'OK' : 'Pending'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {domainStatus.accounts?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '6px' }}>Email Accounts:</div>
                    {domainStatus.accounts.map(a => (
                      <div key={a.id} style={{ fontSize: '13px', padding: '4px 0', color: 'rgba(255,255,255,0.7)' }}>
                        {a.email_address} — <StatusBadge status={a.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNTS TAB
// ═══════════════════════════════════════════════════════════════════════════

function AccountsTab({ orgId }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [domains, setDomains] = useState([]);
  const [form, setForm] = useState({ domain_id: '', local_part: '', password: '', from_name: '' });
  const [creating, setCreating] = useState(false);
  const [togglingWarmup, setTogglingWarmup] = useState(null);
  const [warmupStats, setWarmupStats] = useState({});
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('smartlead-email', { org_id: orgId, action: 'list-accounts' });
      setAccounts(data.accounts || []);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const openCreate = async () => {
    try {
      const data = await api('cloudflare-domains', { org_id: orgId, action: 'list' });
      setDomains((data.domains || []).filter(d => d.status === 'verified' || d.status === 'active'));
    } catch { /* silent */ }
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!form.domain_id || !form.local_part || !form.password) {
      setMsg({ type: 'error', text: 'Domain, local part, and password are required.' });
      return;
    }
    setCreating(true);
    try {
      await api('smartlead-email', { org_id: orgId, action: 'create-account', ...form });
      setMsg({ type: 'success', text: 'Email account created!' });
      setShowCreate(false);
      setForm({ domain_id: '', local_part: '', password: '', from_name: '' });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setCreating(false);
  };

  const toggleWarmup = async (accountId, enabled) => {
    setTogglingWarmup(accountId);
    try {
      await api('smartlead-email', { org_id: orgId, action: 'toggle-warmup', account_id: accountId, enabled });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setTogglingWarmup(null);
  };

  const loadWarmupStats = async (accountId) => {
    if (warmupStats[accountId]) {
      setWarmupStats(p => { const n = { ...p }; delete n[accountId]; return n; });
      return;
    }
    try {
      const data = await api('smartlead-email', { org_id: orgId, action: 'warmup-stats', account_id: accountId });
      setWarmupStats(p => ({ ...p, [accountId]: data }));
    } catch { /* silent */ }
  };

  if (loading) return emptyState('Loading accounts...');

  return (
    <div>
      {msg && (
        <div style={{ ...cardStyle, borderColor: msg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)', background: msg.type === 'error' ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.06)', marginBottom: '20px' }}>
          <span style={{ color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '14px' }}>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>x</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>Email Accounts ({accounts.length})</h3>
        <button style={btnPrimary} onClick={openCreate}>+ New Account</button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div style={{ ...cardStyle, borderColor: 'rgba(144,21,237,0.3)' }}>
          <h4 style={{ margin: '0 0 16px', fontSize: '15px' }}>Create Email Account</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Domain</label>
              <select style={{ ...inputStyle, appearance: 'auto' }} value={form.domain_id} onChange={e => setForm(p => ({ ...p, domain_id: e.target.value }))}>
                <option value="">Select domain...</option>
                {domains.map(d => <option key={d.id} value={d.id}>{d.domain}</option>)}
              </select>
              {domains.length === 0 && <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '4px' }}>No verified domains. Purchase and verify a domain first.</div>}
            </div>
            <div>
              <label style={labelStyle}>Local Part (before @)</label>
              <input style={inputStyle} placeholder="e.g. sarah" value={form.local_part} onChange={e => setForm(p => ({ ...p, local_part: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Password</label>
              <input style={inputStyle} type="password" placeholder="SMTP/IMAP password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Display Name (optional)</label>
              <input style={inputStyle} placeholder="Sarah Miller" value={form.from_name} onChange={e => setForm(p => ({ ...p, from_name: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button style={btnSecondary} onClick={() => setShowCreate(false)}>Cancel</button>
            <button style={btnPrimary} onClick={handleCreate} disabled={creating}>{creating ? 'Creating...' : 'Create Account'}</button>
          </div>
        </div>
      )}

      {/* Account List */}
      {accounts.length === 0 ? emptyState('No email accounts yet. Create one to get started.') : (
        accounts.map(a => (
          <div key={a.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '14px' }}>{a.email_address}</span>
                {a.display_name && <span style={{ marginLeft: '8px', color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>({a.display_name})</span>}
                <span style={{ marginLeft: '12px' }}><StatusBadge status={a.status} /></span>
                {a.domain?.domain && <span style={{ marginLeft: '8px', color: 'rgba(255,255,255,0.3)', fontSize: '12px' }}>{a.domain.domain}</span>}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button style={{ ...btnSecondary, fontSize: '12px', padding: '6px 12px' }} onClick={() => loadWarmupStats(a.id)}>
                  {warmupStats[a.id] ? 'Hide Stats' : 'Warmup Stats'}
                </button>
                <button
                  style={{ ...btnSecondary, fontSize: '12px', padding: '6px 12px', borderColor: a.warmup_enabled ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.15)', color: a.warmup_enabled ? '#4ade80' : 'rgba(255,255,255,0.7)' }}
                  onClick={() => toggleWarmup(a.id, !a.warmup_enabled)}
                  disabled={togglingWarmup === a.id}
                >
                  {togglingWarmup === a.id ? '...' : a.warmup_enabled ? 'Warmup ON' : 'Warmup OFF'}
                </button>
              </div>
            </div>
            {a.daily_send_limit && (
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginTop: '6px' }}>
                Limit: {a.daily_send_limit}/day | SMTP: {a.smtp_host}:{a.smtp_port}
              </div>
            )}
            {warmupStats[a.id] && (
              <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{JSON.stringify(warmupStats[a.id], null, 2)}</pre>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGNS TAB
// ═══════════════════════════════════════════════════════════════════════════

function CampaignsTab({ orgId }) {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [assigning, setAssigning] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('smartlead-email', { org_id: orgId, action: 'list-campaigns' });
      setCampaigns(data.campaigns || []);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api('smartlead-email', { org_id: orgId, action: 'create-campaign', name: newName.trim() });
      setNewName('');
      setMsg({ type: 'success', text: 'Campaign created!' });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setCreating(false);
  };

  const handleExpand = async (c) => {
    if (expanded === c.id) { setExpanded(null); setDetail(null); return; }
    setExpanded(c.id);
    try {
      const [campaignData, accountsData] = await Promise.all([
        api('smartlead-email', { org_id: orgId, action: 'get-campaign', campaign_id: c.id }),
        api('smartlead-email', { org_id: orgId, action: 'list-accounts' }),
      ]);
      setDetail(campaignData);
      setAccounts(accountsData.accounts || []);
    } catch { /* silent */ }
  };

  const handleAssign = async (campaignId, accountId) => {
    setAssigning(accountId);
    try {
      await api('smartlead-email', { org_id: orgId, action: 'assign-account', campaign_id: campaignId, account_id: accountId });
      setMsg({ type: 'success', text: 'Account assigned to campaign.' });
      await handleExpand({ id: campaignId });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setAssigning(null);
  };

  if (loading) return emptyState('Loading campaigns...');

  return (
    <div>
      {msg && (
        <div style={{ ...cardStyle, borderColor: msg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)', background: msg.type === 'error' ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.06)', marginBottom: '20px' }}>
          <span style={{ color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '14px' }}>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>x</button>
        </div>
      )}

      {/* Create */}
      <div style={{ ...cardStyle, display: 'flex', gap: '8px' }}>
        <input style={{ ...inputStyle, flex: 1 }} placeholder="Campaign name..." value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()} />
        <button style={btnPrimary} onClick={handleCreate} disabled={creating}>{creating ? 'Creating...' : '+ New Campaign'}</button>
      </div>

      {/* Campaign List */}
      {campaigns.length === 0 ? emptyState('No campaigns yet. Create one to start sending outreach.') : (
        campaigns.map(c => (
          <div key={c.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => handleExpand(c)}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '15px' }}>{c.name}</span>
                <span style={{ marginLeft: '12px' }}><StatusBadge status={c.status} /></span>
              </div>
              <div style={{ display: 'flex', gap: '20px', alignItems: 'center', fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                <span>Leads: {c.total_leads || 0}</span>
                <span>Sent: {c.total_sent || 0}</span>
                <span style={{ color: '#4ade80' }}>Replies: {c.total_replied || 0}</span>
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '18px' }}>{expanded === c.id ? '\u25B2' : '\u25BC'}</span>
              </div>
            </div>
            {expanded === c.id && detail && (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '16px' }}>
                  {[
                    { label: 'Total Leads', value: detail.total_leads || 0 },
                    { label: 'Sent', value: detail.total_sent || 0 },
                    { label: 'Replied', value: detail.reply_count || detail.total_replied || 0, color: '#4ade80' },
                    { label: 'Smartlead ID', value: detail.smartlead_campaign_id || '—' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>{s.label}</div>
                      <div style={{ fontSize: '18px', fontWeight: 700, color: s.color || '#f6f6f7', marginTop: '4px' }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Assigned Accounts */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '6px' }}>Assigned Accounts:</div>
                  {detail.accounts?.length > 0 ? (
                    detail.accounts.map(a => (
                      <div key={a.id} style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', padding: '3px 0' }}>
                        {a.email_address} — <StatusBadge status={a.warmup_status || a.status} />
                      </div>
                    ))
                  ) : (
                    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>No accounts assigned yet.</div>
                  )}
                </div>

                {/* Assign Account */}
                {accounts.length > 0 && (
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: '6px' }}>Add Account:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {accounts
                        .filter(a => !detail.accounts?.some(da => da.id === a.id))
                        .map(a => (
                          <button key={a.id} style={{ ...btnSecondary, fontSize: '12px', padding: '5px 12px' }} onClick={() => handleAssign(c.id, a.id)} disabled={assigning === a.id}>
                            {assigning === a.id ? '...' : `+ ${a.email_address}`}
                          </button>
                        ))
                      }
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INBOX TAB
// ═══════════════════════════════════════════════════════════════════════════

function InboxTab({ orgId }) {
  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inboxData, statsData] = await Promise.all([
        api('smartlead-email', { org_id: orgId, action: 'list-inbox', page, limit: 20 }),
        api('smartlead-email', { org_id: orgId, action: 'inbox-stats' }),
      ]);
      setConversations(inboxData.conversations || []);
      setPagination(inboxData.pagination || null);
      setStats(statsData);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setLoading(false);
  }, [orgId, page]);

  useEffect(() => { load(); }, [load]);

  const handleSelect = async (conv) => {
    if (selected === conv.id) { setSelected(null); setDetail(null); return; }
    setSelected(conv.id);
    try {
      const data = await api('smartlead-email', { org_id: orgId, action: 'get-conversation', conversation_id: conv.id });
      setDetail(data.conversation);
      // Mark read
      if (!conv.read_at) {
        await api('smartlead-email', { org_id: orgId, action: 'mark-read', conversation_id: conv.id });
        setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, read_at: new Date().toISOString() } : c));
      }
    } catch { /* silent */ }
  };

  const formatDate = (d) => {
    if (!d) return '';
    const date = new Date(d);
    const now = new Date();
    const diff = now - date;
    if (diff < 86400000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  if (loading) return emptyState('Loading inbox...');

  return (
    <div>
      {msg && (
        <div style={{ ...cardStyle, borderColor: msg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)', background: msg.type === 'error' ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.06)', marginBottom: '20px' }}>
          <span style={{ color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '14px' }}>{msg.text}</span>
        </div>
      )}

      {/* Stats Bar */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
          {[
            { label: 'Total', value: stats.total || 0 },
            { label: 'Unread', value: stats.unread || 0, color: '#f59e0b' },
            { label: 'Campaigns', value: stats.by_campaign?.length || 0 },
          ].map(s => (
            <div key={s.label} style={{ ...cardStyle, textAlign: 'center', marginBottom: 0 }}>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>{s.label}</div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: s.color || '#f6f6f7', marginTop: '4px' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Conversation List */}
      {conversations.length === 0 ? emptyState('No conversations yet. Replies will appear here once your campaigns are running.') : (
        <div>
          {conversations.map(conv => (
            <div key={conv.id} style={{ ...cardStyle, cursor: 'pointer', borderColor: selected === conv.id ? 'rgba(144,21,237,0.3)' : undefined, background: !conv.read_at ? 'rgba(144,21,237,0.04)' : cardStyle.background }} onClick={() => handleSelect(conv)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {!conv.read_at && <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#9015ed', flexShrink: 0 }} />}
                    <span style={{ fontWeight: conv.read_at ? 400 : 600, fontSize: '14px' }}>{conv.from_email}</span>
                    <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px' }}>{formatDate(conv.created_at)}</span>
                  </div>
                  {conv.subject && <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>{conv.subject}</div>}
                  {conv.body_text && <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '600px' }}>{conv.body_text.substring(0, 120)}</div>}
                </div>
                <StatusBadge status={conv.message_type || conv.direction} />
              </div>

              {/* Expanded Detail */}
              {selected === conv.id && detail && (
                <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px', fontSize: '13px' }}>
                    <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>From:</span> {detail.from_email}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>To:</span> {detail.to_email}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Direction:</span> {detail.direction}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Type:</span> {detail.message_type}</div>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '8px', padding: '16px', fontSize: '13px', lineHeight: 1.7, color: 'rgba(255,255,255,0.7)' }}>
                    {detail.body_html ? (
                      <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.body_html) }} />
                    ) : (
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{detail.body_text || '(no body)'}</pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          {pagination && pagination.total_pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
              <button style={btnSecondary} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
              <span style={{ padding: '10px 16px', fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                Page {page} of {pagination.total_pages}
              </span>
              <button style={btnSecondary} disabled={page >= pagination.total_pages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { key: 'settings', label: 'Settings' },
  { key: 'domains',  label: 'Domains' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'inbox',    label: 'Inbox' },
];

export default function OutreachManager() {
  const [activeTab, setActiveTab] = useState('settings');
  const [orgId, setOrgId] = useState(null);
  const [orgLoading, setOrgLoading] = useState(true);

  // Resolve org_id from the authenticated user
  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data } = await supabase
          .from('user_organizations')
          .select('org_id')
          .eq('user_id', user.id)
          .limit(1)
          .single();
        if (data) setOrgId(data.org_id);
      } catch (e) {
        console.error('Failed to resolve org_id:', e);
      }
      setOrgLoading(false);
    })();
  }, []);

  if (orgLoading) {
    return emptyState('Loading...');
  }

  if (!orgId) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 20px' }}>
        <p style={{ color: '#f87171', fontSize: '14px' }}>No organization found for your account. Contact support.</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Outreach Manager</h2>
      <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', marginBottom: '24px', maxWidth: '700px', lineHeight: 1.6 }}>
        Manage your email sending infrastructure — domains, mailboxes, campaigns, and replies.
      </p>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '5px', marginBottom: '24px' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              padding: '12px 16px', borderRadius: '10px', border: 'none',
              background: activeTab === t.key ? 'rgba(144,21,237,0.15)' : 'transparent',
              color: activeTab === t.key ? '#c6beee' : 'rgba(255,255,255,0.45)',
              fontFamily: 'inherit', fontSize: '14px', fontWeight: activeTab === t.key ? 600 : 500,
              cursor: 'pointer', transition: 'all 0.2s',
              boxShadow: activeTab === t.key ? '0 0 0 1px rgba(144,21,237,0.25)' : 'none',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'settings' && <SettingsTab orgId={orgId} />}
      {activeTab === 'domains' && <DomainsTab orgId={orgId} />}
      {activeTab === 'accounts' && <AccountsTab orgId={orgId} />}
      {activeTab === 'campaigns' && <CampaignsTab orgId={orgId} />}
      {activeTab === 'inbox' && <InboxTab orgId={orgId} />}
    </div>
  );
}
