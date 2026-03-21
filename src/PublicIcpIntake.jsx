import { useEffect, useState } from 'react';

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1px solid rgba(255,255,255,0.15)',
  background: 'rgba(255,255,255,0.04)',
  color: '#f6f6f7',
};

const EMPTY_FORM = {
  elevator_pitch: '',
  core_problem: '',
  uvp_1: '',
  industries: '',
  company_size: '',
  geography: '',
  revenue_range: '',
  primary_titles: '',
  success_metrics: '',
  sender_name: '',
  sender_url: '',
  email_tone: '',
  social_proof: '',
  perfect_fit_narrative: '',
};

export default function PublicIcpIntake({ orgIdentifier }) {
  const [orgName, setOrgName] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const loadOrg = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`/.netlify/functions/public-icp-intake?action=get_org&org=${encodeURIComponent(orgIdentifier)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Unable to load organization');
        setOrgName(body.organization?.name || 'Organization');
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    loadOrg();
  }, [orgIdentifier]);

  const setField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        org: orgIdentifier,
        ...form,
        industries: form.industries.split(',').map((s) => s.trim()).filter(Boolean),
        geography: form.geography.split(',').map((s) => s.trim()).filter(Boolean),
        primary_titles: form.primary_titles.split(',').map((s) => s.trim()).filter(Boolean),
        is_active: true,
      };
      const res = await fetch('/.netlify/functions/public-icp-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed saving ICP profile');
      setSaved(true);
      setForm(EMPTY_FORM);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="app"><div style={{ padding: '32px', color: 'rgba(255,255,255,0.7)' }}>Loading ICP intake form…</div></div>;
  }

  return (
    <div className="app">
      <div style={{ maxWidth: '820px', margin: '24px auto', padding: '20px', color: '#f6f6f7' }}>
        <h2 style={{ marginBottom: '6px' }}>ICP Intake Form</h2>
        <p style={{ opacity: 0.75, marginBottom: '16px' }}>Submitting for: <strong>{orgName}</strong></p>
        {error && <div style={{ marginBottom: '12px', color: '#f87171' }}>{error}</div>}
        {saved && <div style={{ marginBottom: '12px', color: '#4ade80' }}>Saved. Your ICP details were added to this organization.</div>}

        <div style={{ display: 'grid', gap: '12px' }}>
          <textarea rows={3} style={inputStyle} placeholder="Elevator pitch" value={form.elevator_pitch} onChange={(e) => setField('elevator_pitch', e.target.value)} />
          <textarea rows={3} style={inputStyle} placeholder="Core problem" value={form.core_problem} onChange={(e) => setField('core_problem', e.target.value)} />
          <input style={inputStyle} placeholder="Top unique value proposition" value={form.uvp_1} onChange={(e) => setField('uvp_1', e.target.value)} />
          <input style={inputStyle} placeholder="Industries (comma-separated)" value={form.industries} onChange={(e) => setField('industries', e.target.value)} />
          <input style={inputStyle} placeholder="Company size" value={form.company_size} onChange={(e) => setField('company_size', e.target.value)} />
          <input style={inputStyle} placeholder="Geography (comma-separated)" value={form.geography} onChange={(e) => setField('geography', e.target.value)} />
          <input style={inputStyle} placeholder="Revenue range" value={form.revenue_range} onChange={(e) => setField('revenue_range', e.target.value)} />
          <input style={inputStyle} placeholder="Primary titles (comma-separated)" value={form.primary_titles} onChange={(e) => setField('primary_titles', e.target.value)} />
          <input style={inputStyle} placeholder="Success metrics" value={form.success_metrics} onChange={(e) => setField('success_metrics', e.target.value)} />
          <input style={inputStyle} placeholder="Sender name" value={form.sender_name} onChange={(e) => setField('sender_name', e.target.value)} />
          <input style={inputStyle} placeholder="Sender URL" value={form.sender_url} onChange={(e) => setField('sender_url', e.target.value)} />
          <input style={inputStyle} placeholder="Email tone" value={form.email_tone} onChange={(e) => setField('email_tone', e.target.value)} />
          <input style={inputStyle} placeholder="Social proof" value={form.social_proof} onChange={(e) => setField('social_proof', e.target.value)} />
          <textarea rows={4} style={inputStyle} placeholder="Perfect-fit narrative" value={form.perfect_fit_narrative} onChange={(e) => setField('perfect_fit_narrative', e.target.value)} />
          <button className="primary-btn" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Submit ICP'}</button>
        </div>
      </div>
    </div>
  );
}
