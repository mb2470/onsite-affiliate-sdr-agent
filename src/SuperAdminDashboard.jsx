import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const cardStyle = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px',
  padding: '16px',
  marginBottom: '14px',
};

export default function SuperAdminDashboard({ onOrgCreated } = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [organizations, setOrganizations] = useState([]);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgSlug, setNewOrgSlug] = useState('');
  const [inviteOrgId, setInviteOrgId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [envOrgId, setEnvOrgId] = useState('');
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const [orgEnvRows, setOrgEnvRows] = useState([]);
  const [latestIcpLink, setLatestIcpLink] = useState('');

  const callAdmin = async (action, payload = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Missing auth session');

    const resp = await fetch('/.netlify/functions/super-admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });

    const body = await resp.json();
    if (!resp.ok) throw new Error(body.error || 'Request failed');
    return body;
  };

  const loadOrganizations = async () => {
    setLoading(true);
    setError('');
    try {
      const body = await callAdmin('list_orgs');
      const orgs = body.organizations || [];
      setOrganizations(orgs);
      if (orgs[0]?.id) {
        setInviteOrgId((prev) => prev || orgs[0].id);
        setEnvOrgId((prev) => prev || orgs[0].id);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadOrgEnv = async (orgId) => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const body = await callAdmin('list_org_env', { orgId });
      setOrgEnvRows(body.variables || []);
      if (body.warning) setMessage(body.warning);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrganizations().then(() => {
      // list_orgs auto-links super admin to all orgs; refresh parent dropdown
      if (onOrgCreated) onOrgCreated();
    });
  }, []);

  useEffect(() => {
    if (envOrgId) loadOrgEnv(envOrgId);
  }, [envOrgId]);

  const createOrganization = async () => {
    if (!newOrgName.trim() || !newOrgSlug.trim()) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const body = await callAdmin('create_org', { name: newOrgName.trim(), slug: newOrgSlug.trim() });
      setMessage(`Created ${body.organization.name}`);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.origin);
        url.searchParams.set('org', body.organization.slug || body.organization.id);
        url.searchParams.set('view', 'icp');
        url.searchParams.set('icp_template', 'blank');
        setLatestIcpLink(url.toString());
      }
      setNewOrgName('');
      setNewOrgSlug('');
      await loadOrganizations();
      if (onOrgCreated) onOrgCreated();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const inviteUser = async () => {
    if (!inviteOrgId || !inviteEmail.trim()) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const body = await callAdmin('invite_user', {
        orgId: inviteOrgId,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setMessage(`Invited ${body.email} to ${body.org.name}`);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.origin);
        url.searchParams.set('org', body.org.slug || body.org.id);
        url.searchParams.set('view', 'icp');
        url.searchParams.set('icp_template', 'blank');
        setLatestIcpLink(url.toString());
      }
      setInviteEmail('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveOrgVar = async () => {
    if (!envOrgId || !envKey.trim() || !envValue.trim()) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      await callAdmin('upsert_org_env', {
        orgId: envOrgId,
        key: envKey.trim(),
        value: envValue,
      });
      setMessage(`Saved ${envKey.trim()} for selected organization`);
      setEnvKey('');
      setEnvValue('');
      await loadOrgEnv(envOrgId);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ marginBottom: '14px' }}>Super Admin Dashboard</h2>

      {error && <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.35)', color: '#f87171' }}>{error}</div>}
      {message && <div style={{ ...cardStyle, borderColor: 'rgba(74,222,128,0.35)', color: '#4ade80' }}>{message}</div>}
      {latestIcpLink && (
        <div style={{ ...cardStyle, borderColor: 'rgba(59,130,246,0.35)' }}>
          <h3 style={{ marginTop: 0 }}>ICP setup link</h3>
          <p style={{ marginTop: '6px', fontSize: '12px', opacity: 0.8 }}>
            Send this to the user so they open ICP Setup in the correct org with a blank template.
          </p>
          <input readOnly value={latestIcpLink} style={{ width: '100%', marginTop: '8px' }} />
        </div>
      )}

      <div style={cardStyle}>
        <h3>Create organization</h3>
        <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
          <input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Organization name" />
          <input value={newOrgSlug} onChange={(e) => setNewOrgSlug(e.target.value)} placeholder="organization-slug" />
          <button disabled={loading} onClick={createOrganization}>Create Organization</button>
        </div>
      </div>

      <div style={cardStyle}>
        <h3>Invite user</h3>
        <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
          <select value={inviteOrgId} onChange={(e) => setInviteOrgId(e.target.value)}>
            {organizations.map((org) => <option key={org.id} value={org.id}>{org.name} ({org.slug})</option>)}
          </select>
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@company.com" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
            <option value="owner">owner</option>
          </select>
          <button disabled={loading} onClick={inviteUser}>Invite + Assign User</button>
        </div>
      </div>

      <div style={cardStyle}>
        <h3>Organization runtime variables</h3>
        <p style={{ fontSize: '12px', opacity: 0.7 }}>Store per-organization settings in Supabase instead of global Netlify env vars.</p>
        <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
          <select value={envOrgId} onChange={(e) => setEnvOrgId(e.target.value)}>
            {organizations.map((org) => <option key={org.id} value={org.id}>{org.name} ({org.slug})</option>)}
          </select>
          <input value={envKey} onChange={(e) => setEnvKey(e.target.value)} placeholder="API_KEY_NAME" />
          <textarea value={envValue} onChange={(e) => setEnvValue(e.target.value)} placeholder="Secret value" rows={3} />
          <button disabled={loading} onClick={saveOrgVar}>Save Variable</button>
        </div>

        <div style={{ marginTop: '12px', fontSize: '12px', opacity: 0.8 }}>
          {orgEnvRows.length === 0 ? 'No variables configured yet.' : orgEnvRows.map((row) => (
            <div key={row.id}>• {row.key_name} ({new Date(row.updated_at).toLocaleString()})</div>
          ))}
        </div>
      </div>
    </div>
  );
}
