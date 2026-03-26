import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { getProspects, getProspectStats, getProspectWithRelations, addProspect, bulkAddProspects, getTotalProspectCount } from './services/prospectService';

export default function ProspectPipeline({ orgId }) {
  const [prospects, setProspects] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTab, setUploadTab] = useState('single');
  const [newWebsite, setNewWebsite] = useState('');
  const [bulkWebsites, setBulkWebsites] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [businessModelFilter, setBusinessModelFilter] = useState('');
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState('');

  // Detail modal
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Re-enrichment
  const [reenrichPreview, setReenrichPreview] = useState(null);
  const [reenrichLoading, setReenrichLoading] = useState(false);
  const [reenrichResult, setReenrichResult] = useState(null);
  const [reenrichError, setReenrichError] = useState('');

  // Upload handlers
  const handleAddSingle = async () => {
    if (!newWebsite.trim()) return;
    setIsUploading(true);
    try {
      await addProspect(newWebsite, orgId);
      setNewWebsite('');
      setUploadResult({ added: 1, skipped: 0 });
      loadProspects();
      loadStats();
    } catch (e) {
      alert(e.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleBulkAdd = async () => {
    const items = bulkWebsites.split('\n').map(w => w.trim()).filter(w => w).map(line => {
      const colonMatch = line.match(/^(.+?):\s+(\S+\.\S+)$/);
      if (colonMatch) {
        return { company_name: colonMatch[1].trim(), website: colonMatch[2].trim() };
      }
      return { website: line };
    });
    if (!items.length) return;
    setIsUploading(true);
    try {
      const result = await bulkAddProspects(items, 'bulk_add', orgId);
      setBulkWebsites('');
      setUploadResult(result);
      loadProspects();
      loadStats();
    } catch (e) {
      alert(e.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCSVUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const lines = e.target.result.split('\n').filter(l => l.trim());
        if (lines.length < 2) { alert('No data found in CSV'); setIsUploading(false); return; }

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
        const colMap = {
          'website': ['website', 'domain', 'url', 'site', 'website_url'],
          'company_name': ['company_name', 'company', 'organization_name', 'org_name', 'name', 'business_name'],
          'industry': ['industry', 'vertical', 'category', 'niche'],
          'country': ['country', 'location', 'region'],
          'sells_d2c': ['sells_d2c', 'd2c', 'dtc', 'sells_dtc'],
          'city': ['city'],
          'platform': ['platform', 'ecommerce_platform'],
          'employee_range': ['employee_range', 'employees', 'employee_count', 'company_size'],
        };

        const colIdx = {};
        for (const [field, aliases] of Object.entries(colMap)) {
          const idx = headers.findIndex(h => aliases.includes(h));
          if (idx !== -1) colIdx[field] = idx;
        }

        if (!('website' in colIdx)) { alert('No "website" column found in CSV'); setIsUploading(false); return; }

        const prospects = [];
        for (let i = 1; i < lines.length; i++) {
          const row = lines[i].match(/(".*?"|[^",]+|(?<=,)(?=,))/g)?.map(v => v.replace(/^"|"$/g, '').trim()) || lines[i].split(',').map(v => v.trim());
          const website = (row[colIdx.website] || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').trim();
          if (!website || !website.includes('.')) continue;

          const prospect = { website };
          for (const [field, idx] of Object.entries(colIdx)) {
            if (field !== 'website' && row[idx]) {
              prospect[field] = row[idx].trim();
            }
          }
          prospects.push(prospect);
        }

        if (!prospects.length) { alert('No valid websites found'); setIsUploading(false); return; }

        const result = await bulkAddProspects(prospects, 'csv_upload', orgId);
        setUploadResult(result);
        loadProspects();
        loadStats();
      } catch (err) { alert(err.message); }
      setIsUploading(false);
    };
    reader.readAsText(file);
  };

  const loadStats = useCallback(async () => {
    if (!orgId) return;
    try {
      const s = await getProspectStats(orgId);
      setStats(s);
    } catch (e) {
      console.error('Failed to load prospect stats:', e);
    }
  }, [orgId]);

  const loadProspects = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const filters = {
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        orderBy: 'created_at',
        ascending: false,
      };
      if (statusFilter) filters.status = statusFilter;
      if (industryFilter) filters.industry_primary = industryFilter;
      if (businessModelFilter) filters.business_model = businessModelFilter;
      if (minConfidence > 0) filters.min_confidence = minConfidence;
      if (search.trim()) filters.search = search.trim();

      const { prospects: data, totalCount: count } = await getProspects(orgId, filters);
      setProspects(data);
      setTotalCount(count);
    } catch (e) {
      console.error('Failed to load prospects:', e);
    } finally {
      setLoading(false);
    }
  }, [orgId, page, statusFilter, industryFilter, businessModelFilter, minConfidence, search]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadProspects(); }, [loadProspects]);

  const openDetail = async (prospect) => {
    setSelectedProspect(prospect);
    setDetailLoading(true);
    try {
      const data = await getProspectWithRelations(orgId, prospect.id);
      setDetailData(data);
    } catch (e) {
      console.error('Failed to load prospect detail:', e);
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedProspect(null);
    setDetailData(null);
  };

  const handleReenrichPreview = async () => {
    setReenrichLoading(true);
    setReenrichError('');
    setReenrichPreview(null);
    setReenrichResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/prospect-reenrich', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ org_id: orgId, dry_run: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReenrichPreview(data);
    } catch (e) {
      setReenrichError(e.message);
    } finally {
      setReenrichLoading(false);
    }
  };

  const handleReenrichExecute = async () => {
    setReenrichLoading(true);
    setReenrichError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/prospect-reenrich', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ org_id: orgId, dry_run: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReenrichResult(data);
      setReenrichPreview(null);
      // Refresh stats and list
      loadStats();
      loadProspects();
    } catch (e) {
      setReenrichError(e.message);
    } finally {
      setReenrichLoading(false);
    }
  };

  const totalAll = stats ? Object.values(stats.byStatus).reduce((a, b) => a + b, 0) : 0;
  const qualifiedCount = stats?.byStatus?.qualified || 0;
  const avgConf = stats?.avgConfidence != null ? stats.avgConfidence.toFixed(2) : '—';
  const staleCount = stats ? (stats.byStatus?.new || 0) : '—';

  const thStyle = {
    textAlign: 'left', padding: '10px 8px', fontSize: '11px',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'rgba(255,255,255,0.35)', fontWeight: 600,
  };

  const statusColors = {
    new: '#6b7280', enriching: '#f59e0b', enriched: '#9015ed',
    qualified: '#245ef9', contacted: '#4ade80', engaged: '#22d3ee', disqualified: '#ef4444',
  };

  const confColor = (score) => {
    if (score == null) return 'rgba(255,255,255,0.3)';
    if (score >= 0.8) return '#4ade80';
    if (score >= 0.6) return '#f59e0b';
    return '#f87171';
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Prospects</h2>
        <button
          onClick={() => { setShowUpload(!showUpload); setUploadResult(null); }}
          style={{
            padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: showUpload ? 'rgba(255,255,255,0.08)' : 'linear-gradient(135deg, #9015ed, #245ef9)',
            color: '#fff',
          }}
        >
          {showUpload ? 'Close' : '+ Add Prospects'}
        </button>
      </div>

      {/* Upload Panel */}
      {showUpload && (
        <div style={{
          background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px', padding: '20px', marginBottom: '16px',
        }}>
          {/* Upload Tabs */}
          <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '10px', padding: '4px', marginBottom: '16px' }}>
            {[
              { key: 'single', label: 'Single Website' },
              { key: 'bulk', label: 'Bulk Add' },
              { key: 'csv', label: 'Import CSV' },
            ].map(t => (
              <button key={t.key} onClick={() => setUploadTab(t.key)}
                style={{
                  flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: uploadTab === t.key ? 'rgba(144,21,237,0.2)' : 'transparent',
                  color: uploadTab === t.key ? '#c6beee' : 'rgba(255,255,255,0.4)',
                }}
              >{t.label}</button>
            ))}
          </div>

          {/* Single */}
          {uploadTab === 'single' && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text" placeholder="e.g. allbirds.com" value={newWebsite}
                onChange={(e) => setNewWebsite(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddSingle()}
                className="search-input" style={{ flex: 1 }}
              />
              <button onClick={handleAddSingle} disabled={!newWebsite.trim() || isUploading}
                style={{
                  padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: 'linear-gradient(135deg, #9015ed, #245ef9)', color: '#fff',
                  opacity: (!newWebsite.trim() || isUploading) ? 0.5 : 1,
                }}
              >{isUploading ? 'Adding...' : 'Add Prospect'}</button>
            </div>
          )}

          {/* Bulk */}
          {uploadTab === 'bulk' && (
            <div>
              <textarea
                placeholder={'Paste one per line:\nallbirds.com\npeanut: teampeanut.com\naway.com'}
                value={bulkWebsites}
                onChange={(e) => setBulkWebsites(e.target.value)}
                style={{
                  width: '100%', minHeight: '120px', padding: '12px', borderRadius: '8px',
                  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)',
                  color: 'inherit', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace",
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                  {bulkWebsites.split('\n').filter(w => w.trim()).length} prospect(s) ready
                </span>
                <button onClick={handleBulkAdd}
                  disabled={bulkWebsites.split('\n').filter(w => w.trim()).length === 0 || isUploading}
                  style={{
                    padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: 'linear-gradient(135deg, #9015ed, #245ef9)', color: '#fff',
                    opacity: (bulkWebsites.split('\n').filter(w => w.trim()).length === 0 || isUploading) ? 0.5 : 1,
                  }}
                >{isUploading ? 'Adding...' : 'Add Prospects'}</button>
              </div>
            </div>
          )}

          {/* CSV */}
          {uploadTab === 'csv' && (
            <div>
              <label style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: '24px', borderRadius: '10px', border: '2px dashed rgba(255,255,255,0.1)',
                background: 'rgba(0,0,0,0.2)', cursor: 'pointer', textAlign: 'center',
              }}>
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display: 'none' }} />
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                  {isUploading ? 'Uploading...' : 'Click to upload CSV'}
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>
                  Required: website | Optional: company_name, industry, country, city, employee_range, platform
                </div>
              </label>
            </div>
          )}

          {/* Upload Result */}
          {uploadResult && (
            <div style={{
              marginTop: '12px', padding: '10px 14px', borderRadius: '8px',
              background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)',
              fontSize: '13px', color: '#4ade80', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Added {uploadResult.added} prospect(s). {uploadResult.skipped > 0 ? `Skipped ${uploadResult.skipped} duplicate(s).` : ''}</span>
              <button onClick={() => setUploadResult(null)}
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '14px' }}>
                X
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats Bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total Prospects', value: totalAll, color: '#f6f6f7' },
          { label: 'Qualified', value: qualifiedCount, color: '#245ef9' },
          { label: 'Avg Confidence', value: avgConf, color: '#9015ed' },
          { label: 'Contacted', value: stats?.byStatus?.contacted || 0, color: '#4ade80' },
          { label: 'Engaged', value: stats?.byStatus?.engaged || 0, color: '#22d3ee' },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, padding: '14px 16px', borderRadius: '10px',
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginTop: '4px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Re-enrichment Controls */}
      <div style={{
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '10px', padding: '16px', marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>Data Freshness</span>
          <button
            onClick={handleReenrichPreview}
            disabled={reenrichLoading}
            style={{
              padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
              border: '1px solid rgba(144,21,237,0.3)', background: 'rgba(144,21,237,0.1)',
              color: '#c6beee', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {reenrichLoading && !reenrichPreview ? 'Scanning...' : 'Scan for Stale Data'}
          </button>
          {reenrichResult && (
            <span style={{ fontSize: '12px', color: '#4ade80' }}>
              Done: {reenrichResult.stale_recrawl} re-crawled, {reenrichResult.low_confidence_enrich} re-enriched
            </span>
          )}
          {reenrichError && (
            <span style={{ fontSize: '12px', color: '#f87171' }}>{reenrichError}</span>
          )}
        </div>

        {/* Preview results */}
        {reenrichPreview && (
          <div style={{ marginTop: '12px' }}>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
              <div style={{ padding: '10px 16px', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: '#f59e0b' }}>{reenrichPreview.stale_recrawl}</div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginTop: '2px' }}>Stale ({'>'}90 days)</div>
              </div>
              <div style={{ padding: '10px 16px', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: '#f87171' }}>{reenrichPreview.low_confidence_enrich}</div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginTop: '2px' }}>Low Confidence ({'<'}0.5)</div>
              </div>
              <div style={{ padding: '10px 16px', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: "'Barlow', sans-serif", color: 'rgba(255,255,255,0.4)' }}>{reenrichPreview.skipped_contacted}</div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginTop: '2px' }}>Skipped (Active)</div>
              </div>
            </div>

            {/* Expandable prospect lists */}
            {reenrichPreview.prospects?.stale?.length > 0 && (
              <details style={{ marginBottom: '8px' }}>
                <summary style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', marginBottom: '6px' }}>
                  {reenrichPreview.prospects.stale.length} prospects to re-crawl
                </summary>
                <div style={{ maxHeight: '150px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', borderRadius: '6px', padding: '8px' }}>
                  {reenrichPreview.prospects.stale.map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '11px' }}>
                      <span style={{ color: 'rgba(255,255,255,0.7)' }}>{p.company_name || p.website}</span>
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>{p.reason}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {reenrichPreview.prospects?.low_confidence?.length > 0 && (
              <details style={{ marginBottom: '8px' }}>
                <summary style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', marginBottom: '6px' }}>
                  {reenrichPreview.prospects.low_confidence.length} prospects to re-enrich
                </summary>
                <div style={{ maxHeight: '150px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', borderRadius: '6px', padding: '8px' }}>
                  {reenrichPreview.prospects.low_confidence.map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '11px' }}>
                      <span style={{ color: 'rgba(255,255,255,0.7)' }}>{p.company_name || p.website}</span>
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>{p.reason}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {(reenrichPreview.stale_recrawl > 0 || reenrichPreview.low_confidence_enrich > 0) ? (
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <button
                  onClick={handleReenrichExecute}
                  disabled={reenrichLoading}
                  style={{
                    padding: '8px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: 'linear-gradient(135deg, #9015ed, #245ef9)', color: '#fff',
                    opacity: reenrichLoading ? 0.5 : 1,
                  }}
                >
                  {reenrichLoading ? 'Processing...' : `Re-enrich ${reenrichPreview.stale_recrawl + reenrichPreview.low_confidence_enrich} Prospects`}
                </button>
                <button
                  onClick={() => setReenrichPreview(null)}
                  style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '12px',
                    border: '1px solid rgba(255,255,255,0.15)', background: 'transparent',
                    color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#4ade80', marginTop: '4px' }}>All prospect data is fresh.</div>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="pipeline-filters" style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          type="text" placeholder="Search prospects..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="search-input" style={{ flex: 1, minWidth: '180px' }}
        />
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }} className="filter-select">
          <option value="">All Statuses</option>
          {['new', 'enriching', 'enriched', 'qualified', 'contacted', 'engaged', 'disqualified'].map(s => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)} ({stats?.byStatus?.[s] || 0})</option>
          ))}
        </select>
        <select value={industryFilter} onChange={(e) => { setIndustryFilter(e.target.value); setPage(0); }} className="filter-select">
          <option value="">All Industries</option>
          {(stats?.byIndustry || []).map(i => (
            <option key={i.industry} value={i.industry}>{i.industry} ({i.count})</option>
          ))}
        </select>
        <select value={businessModelFilter} onChange={(e) => { setBusinessModelFilter(e.target.value); setPage(0); }} className="filter-select">
          <option value="">All Models</option>
          {(stats?.byBusinessModel || []).map(m => (
            <option key={m.model} value={m.model}>{m.model} ({m.count})</option>
          ))}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>Min conf:</span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={minConfidence}
            onChange={(e) => { setMinConfidence(parseFloat(e.target.value)); setPage(0); }}
            style={{ width: '80px', accentColor: '#9015ed' }}
          />
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontFamily: "'JetBrains Mono', monospace", minWidth: '30px' }}>{minConfidence.toFixed(2)}</span>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <th style={{ ...thStyle, textAlign: 'left', padding: '10px 12px' }}>Company</th>
              <th style={thStyle}>Website</th>
              <th style={thStyle}>Industry</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Confidence</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Last Enriched</th>
            </tr>
          </thead>
          <tbody>
            {loading && prospects.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>Loading...</td></tr>
            ) : prospects.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>No prospects found</td></tr>
            ) : prospects.map(p => (
              <tr key={p.id}
                onClick={() => openDetail(p)}
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ padding: '10px 12px', fontSize: '13px', fontWeight: 500 }}>{p.company_name || '—'}</td>
                <td style={{ padding: '10px 8px', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{p.website}</td>
                <td style={{ padding: '10px 8px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{p.industry_primary || '—'}</td>
                <td style={{ padding: '10px 8px' }}>
                  <span style={{
                    padding: '2px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                    background: `${statusColors[p.status] || '#6b7280'}20`,
                    color: statusColors[p.status] || '#6b7280',
                  }}>{p.status}</span>
                </td>
                <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                  {p.confidence_score != null ? (
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: 600,
                      color: confColor(p.confidence_score),
                    }}>{p.confidence_score.toFixed(2)}</span>
                  ) : <span style={{ color: 'rgba(255,255,255,0.25)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 8px', textAlign: 'center', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)' }}>
                  {p.last_enriched_at
                    ? new Date(p.last_enriched_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalCount > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '20px' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>
            Previous
          </button>
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', lineHeight: '36px' }}>
            Page {page + 1} of {Math.ceil(totalCount / PAGE_SIZE)}
          </span>
          <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= totalCount}
            style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', color: 'inherit', cursor: 'pointer' }}>
            Next
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {selectedProspect && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={closeDetail}>
          <div style={{
            backgroundColor: '#0d1530', borderRadius: '18px', padding: '32px',
            maxWidth: '800px', width: '90%', maxHeight: '80vh', overflowY: 'auto',
            border: '1px solid rgba(255,255,255,0.08)',
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <h3 style={{ fontFamily: "'Barlow', sans-serif", fontSize: '18px', fontWeight: 700, marginBottom: '4px' }}>
                  {selectedProspect.company_name || selectedProspect.website}
                </h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{
                    padding: '2px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
                    textTransform: 'uppercase',
                    background: `${statusColors[selectedProspect.status] || '#6b7280'}20`,
                    color: statusColors[selectedProspect.status] || '#6b7280',
                  }}>{selectedProspect.status}</span>
                  {selectedProspect.confidence_score != null && (
                    <span style={{ fontSize: '12px', color: confColor(selectedProspect.confidence_score), fontWeight: 600 }}>
                      Confidence: {selectedProspect.confidence_score.toFixed(2)}
                    </span>
                  )}
                  <a href={`https://${selectedProspect.website}`} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: '12px', color: '#245ef9' }}>{selectedProspect.website}</a>
                </div>
              </div>
              <button onClick={closeDetail}
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '20px', cursor: 'pointer', padding: '4px 8px' }}>
                X
              </button>
            </div>

            {/* Firmographic details */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
              {[
                { label: 'Industry', value: selectedProspect.industry_primary },
                { label: 'Sub-Industry', value: selectedProspect.industry_sub },
                { label: 'Business Model', value: selectedProspect.business_model },
                { label: 'Target Market', value: selectedProspect.target_market },
                { label: 'Employees', value: selectedProspect.employee_range },
                { label: 'Revenue', value: selectedProspect.revenue_annual ? `$${(selectedProspect.revenue_annual / 1000000).toFixed(1)}M` : null },
              ].filter(f => f.value).map(f => (
                <div key={f.label} style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: '4px' }}>{f.label}</div>
                  <div style={{ fontSize: '13px' }}>{f.value}</div>
                </div>
              ))}
            </div>

            {/* Tags */}
            {(selectedProspect.keywords?.length > 0 || selectedProspect.technographics?.length > 0) && (
              <div style={{ marginBottom: '20px' }}>
                {selectedProspect.keywords?.length > 0 && (
                  <div style={{ marginBottom: '8px' }}>
                    <span style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Keywords: </span>
                    {selectedProspect.keywords.map(k => (
                      <span key={k} style={{ display: 'inline-block', padding: '2px 8px', margin: '2px', borderRadius: '10px', fontSize: '11px', background: 'rgba(144,21,237,0.12)', color: '#c6beee' }}>{k}</span>
                    ))}
                  </div>
                )}
                {selectedProspect.technographics?.length > 0 && (
                  <div>
                    <span style={{ fontSize: '10px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Tech: </span>
                    {selectedProspect.technographics.map(t => (
                      <span key={t} style={{ display: 'inline-block', padding: '2px 8px', margin: '2px', borderRadius: '10px', fontSize: '11px', background: 'rgba(36,94,249,0.12)', color: '#93b4fd' }}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {detailLoading ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>Loading details...</div>
            ) : detailData && (
              <>
                {/* Contacts */}
                {detailData.contacts.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Contacts ({detailData.contacts.length})
                    </div>
                    {detailData.contacts.map(c => (
                      <div key={c.id} style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', marginBottom: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 500 }}>{c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()}</div>
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>{c.title || '—'}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{c.email}</div>
                          {c.match_score != null && (
                            <div style={{ fontSize: '10px', color: confColor(c.match_score / 100), fontWeight: 600 }}>Score: {c.match_score}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Crawl Data */}
                {detailData.crawls.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Crawl Data ({detailData.crawls.length} pages)
                    </div>
                    {detailData.crawls.map(cr => (
                      <div key={cr.id} style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '12px', color: '#245ef9' }}>{cr.url_crawled}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>{cr.word_count || 0} words</span>
                        </div>
                        {cr.meta_description && (
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>{cr.meta_description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Search Signals */}
                {detailData.signals.length > 0 && (
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>
                      Search Signals ({detailData.signals.length})
                    </div>
                    {detailData.signals.map(sig => (
                      <div key={sig.id} style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 500 }}>{sig.signal_type || sig.query}</div>
                          {sig.snippet && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>{sig.snippet}</div>}
                        </div>
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' }}>
                          {sig.created_at ? new Date(sig.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
