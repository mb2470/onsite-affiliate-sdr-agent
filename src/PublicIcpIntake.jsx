import { useEffect, useState } from 'react';

const cardStyle = {
  padding: '20px',
  borderRadius: '12px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
};

const labelStyle = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 600,
  color: 'rgba(255,255,255,0.78)',
  marginBottom: '6px',
};

const helperStyle = {
  fontSize: '11px',
  color: 'rgba(255,255,255,0.4)',
  marginBottom: '8px',
  lineHeight: 1.5,
};

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

function Field({ label, helpText, children }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={labelStyle}>{label}</label>
      {helpText && <p style={helperStyle}>{helpText}</p>}
      {children}
    </div>
  );
}

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

        <div style={{ display: 'grid', gap: '16px' }}>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0, marginBottom: '4px', fontSize: '16px' }}>Part 1: Product & Value Proposition</h3>
            <p style={{ ...helperStyle, marginBottom: '16px' }}>
              This information is used by the agent to understand your product and position it correctly in outreach.
            </p>

            <Field label="Elevator Pitch" helpText="How would you describe your product in one concise sentence?">
              <textarea rows={3} style={inputStyle} placeholder="e.g., We help ecommerce brands turn creator content into high-converting onsite shopping experiences." value={form.elevator_pitch} onChange={(e) => setField('elevator_pitch', e.target.value)} />
            </Field>

            <Field label="Core Problem" helpText="What expensive or frustrating problem are you solving for this customer?">
              <textarea rows={3} style={inputStyle} placeholder="e.g., Brands pay creators for content but see limited measurable revenue from that spend." value={form.core_problem} onChange={(e) => setField('core_problem', e.target.value)} />
            </Field>

            <Field label="Unique Value Proposition (Top UVP)" helpText="What is the biggest reason customers pick your solution over alternatives?">
              <input style={inputStyle} placeholder="e.g., Pay commissions only after sales happen, not upfront for uncertain content ROI." value={form.uvp_1} onChange={(e) => setField('uvp_1', e.target.value)} />
            </Field>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0, marginBottom: '4px', fontSize: '16px' }}>Part 2: Customer Firmographics</h3>
            <p style={{ ...helperStyle, marginBottom: '16px' }}>
              Match the logged-in setup: provide concrete target attributes so lead scoring and qualification stay accurate.
            </p>

            <Field label="Industries" helpText="Comma-separated. Which verticals are your best fit?">
              <input style={inputStyle} placeholder="e.g., Apparel, Beauty, Health & Wellness" value={form.industries} onChange={(e) => setField('industries', e.target.value)} />
            </Field>
            <Field label="Company Size" helpText="Describe your target team size or stage.">
              <input style={inputStyle} placeholder="e.g., Mid-market D2C brands with 15-200 employees" value={form.company_size} onChange={(e) => setField('company_size', e.target.value)} />
            </Field>
            <Field label="Geography" helpText="Comma-separated regions or countries you prioritize.">
              <input style={inputStyle} placeholder="e.g., United States, Canada, United Kingdom" value={form.geography} onChange={(e) => setField('geography', e.target.value)} />
            </Field>
            <Field label="Revenue Range" helpText="What annual revenue band is the strongest fit?">
              <input style={inputStyle} placeholder="e.g., $5M-$100M ARR" value={form.revenue_range} onChange={(e) => setField('revenue_range', e.target.value)} />
            </Field>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0, marginBottom: '4px', fontSize: '16px' }}>Part 3: Buyer & Messaging Inputs</h3>
            <p style={{ ...helperStyle, marginBottom: '16px' }}>
              These fields shape who the agent targets and how generated emails should sound.
            </p>

            <Field label="Primary Decision Maker Titles" helpText="Comma-separated. Who usually owns the problem and budget?">
              <input style={inputStyle} placeholder="e.g., VP of Ecommerce, Director of Growth, CMO" value={form.primary_titles} onChange={(e) => setField('primary_titles', e.target.value)} />
            </Field>
            <Field label="Success Metrics (KPIs)" helpText="How does this buyer measure success?">
              <input style={inputStyle} placeholder="e.g., CAC, ROAS, onsite conversion rate, D2C revenue growth" value={form.success_metrics} onChange={(e) => setField('success_metrics', e.target.value)} />
            </Field>
            <Field label="Sender Name">
              <input style={inputStyle} placeholder="e.g., Alex" value={form.sender_name} onChange={(e) => setField('sender_name', e.target.value)} />
            </Field>
            <Field label="Sender URL">
              <input style={inputStyle} placeholder="e.g., yourcompany.com" value={form.sender_url} onChange={(e) => setField('sender_url', e.target.value)} />
            </Field>
            <Field label="Email Tone" helpText="Describe tone rules for outbound messaging.">
              <input style={inputStyle} placeholder="e.g., Conversational, direct, no fluff. Like a trusted operator." value={form.email_tone} onChange={(e) => setField('email_tone', e.target.value)} />
            </Field>
            <Field label="Social Proof / Comparison" helpText="A known company or program your ICP already understands.">
              <input style={inputStyle} placeholder="e.g., Amazon's Onsite Associates program" value={form.social_proof} onChange={(e) => setField('social_proof', e.target.value)} />
            </Field>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0, marginBottom: '4px', fontSize: '16px' }}>Part 4: Perfect Fit Narrative</h3>
            <p style={{ ...helperStyle, marginBottom: '16px' }}>
              This summary ties everything together and is used for personalization + scoring context.
            </p>
            <Field label="Perfect-Fit Narrative">
              <textarea rows={5} style={inputStyle} placeholder="Our ideal customer is a [Company Size] [Industry] company struggling with [Main Pain Point]. The [Job Title] wants to improve [KPI] and chooses us because [UVP]." value={form.perfect_fit_narrative} onChange={(e) => setField('perfect_fit_narrative', e.target.value)} />
            </Field>
          </div>

          <button className="primary-btn" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Submit ICP'}</button>
        </div>
      </div>
    </div>
  );
}
