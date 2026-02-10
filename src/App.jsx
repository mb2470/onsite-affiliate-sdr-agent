import { useState, useEffect } from 'react';
import './App.css';

// Main App Component
function App() {
  const [leads, setLeads] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  const [generatedEmail, setGeneratedEmail] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState('leads');
  const [searchTerm, setSearchTerm] = useState('');
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [catalogAnalysis, setCatalogAnalysis] = useState(null);
  const [isAnalyzingCatalog, setIsAnalyzingCatalog] = useState(false);
  const [isLoadingSheets, setIsLoadingSheets] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  // Load spreadsheet ID from localStorage on mount
  useEffect(() => {
    const savedSpreadsheetId = localStorage.getItem('spreadsheetId');
    if (savedSpreadsheetId) {
      setSpreadsheetId(savedSpreadsheetId);
      loadFromGoogleSheets(savedSpreadsheetId);
    }
  }, []);

  // Save leads to localStorage whenever they change (backup)
  useEffect(() => {
    if (leads.length > 0) {
      localStorage.setItem('sdrLeads', JSON.stringify(leads));
    }
  }, [leads]);

  // Load leads from private Google Sheets via API
  const loadFromGoogleSheets = async (sheetId) => {
    setIsLoadingSheets(true);
    try {
      const response = await fetch('/.netlify/functions/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'read',
          spreadsheetId: sheetId,
          range: 'Sheet1!A:G' // Read columns A-G (including Research and Catalog)
        })
      });

      if (!response.ok) {
        throw new Error('Failed to load from Google Sheets');
      }

      const data = await response.json();
      const rows = data.values || [];

      // Skip header row
      const dataRows = rows.slice(1);

const importedLeads = dataRows
  .filter(row => row[0]) // Has website
  .map((row, index) => ({
    id: row[0], // Use website as ID
    website: row[0] || '',
    revenue: row[1] || 'Unknown',
    source: row[2] || '',
    description: row[3] || '',
    status: row[4] || 'new', // Status from sheet (column E)
    notes: row[5] || '', // Research notes from sheet (column F) ← NEW!
    catalogInfo: row[6] || '', // Catalog info from sheet (column G) ← NEW!
    lastContact: null,
    emails: [],
    rowIndex: index + 2 // Track which row this is (for writing back)
  }));

      setLeads(importedLeads);
      setLastSync(new Date());
      localStorage.setItem('spreadsheetId', sheetId);

    } catch (error) {
      console.error('Error loading from Google Sheets:', error);
      alert('Failed to load from Google Sheets. Make sure your service account has access.');
    } finally {
      setIsLoadingSheets(false);
    }
  };

  // Write status back to Google Sheets
  const syncStatusToSheet = async (lead, newStatus) => {
    if (!spreadsheetId) return;

    try {
      await fetch('/.netlify/functions/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          spreadsheetId: spreadsheetId,
          range: `Sheet1!E${lead.rowIndex}`, // Update status column (E) for this row
          values: [[newStatus]]
        })
      });
    } catch (error) {
      console.error('Error syncing to Google Sheets:', error);
      // Don't alert - just log it, local state is still updated
    }
  };

  // Import leads from CSV
  const handleImportLeads = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const rows = text.split('\n').slice(1); // Skip header
      
      const importedLeads = rows
        .filter(row => row.trim())
        .map((row, index) => {
          const [website, revenue, source, description] = row.split(',');
          return {
            id: Date.now() + index,
            website: website?.trim() || '',
            revenue: revenue?.trim() || 'Unknown',
            description: description?.trim() || '',
            status: 'new',
            lastContact: null,
            emails: [],
            notes: ''
          };
        });

      setLeads(prev => [...prev, ...importedLeads]);
    };
    reader.readAsText(file);
  };

  // Call Claude API via Netlify function
  const callClaudeAPI = async (prompt, systemPrompt) => {
    const response = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt, systemPrompt })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate content');
    }

    const data = await response.json();
    return data.content[0].text;
  };

  // Generate personalized email with AI
  const generateEmail = async (lead, emailType = 'initial') => {
    setIsGenerating(true);
    setGeneratedEmail('');

    try {
      const systemPrompt = `You are an expert SDR (Sales Development Representative) for Onsite Affiliate, 
a revolutionary AI-powered platform that helps ecommerce brands monetize creator UGC content on their product pages.

Key value propositions:
- Guarantees incrementality (only pay for actual sales lift, not just any sales)
- No upfront creator costs - pay based on performance
- Scales to entire product catalog automatically
- 3-month pilot to prove ROI before full commitment
- Case study: Brand with $141 AOV saw 6.2x ROCS (Return on Commission Spend)

Your job is to write compelling, personalized cold outreach emails that:
1. Reference the specific company and industry
2. Lead with a relevant pain point (scaling UGC, measuring creator ROI, slow manual processes)
3. Present Onsite Affiliate as the solution
4. Include a clear CTA (usually booking a 15-min demo)
5. Keep it concise (under 150 words)
6. Sound human and conversational, not salesy

Write emails that would get responses from eCommerce Directors, Digital Marketing Leads, and CMOs.`;

      const prompt = `Write a ${emailType} outreach email for this lead:

Company: ${lead.website}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}

${emailType === 'followup' ? 'This is a follow-up email. Reference that you reached out before and add a new angle or insight.' : ''}
${emailType === 'breakup' ? 'This is a final "breakup" email. Create urgency by suggesting you\'ll move on if they\'re not interested.' : ''}

Include a subject line at the top in this format:
Subject: [your subject line]

Then the email body.`;

      const emailContent = await callClaudeAPI(prompt, systemPrompt);
      setGeneratedEmail(emailContent);

      // Add to lead's email history
      const updatedLeads = leads.map(l => {
        if (l.id === lead.id) {
          return {
            ...l,
            emails: [...(l.emails || []), {
              type: emailType,
              content: emailContent,
              timestamp: new Date().toISOString(),
              sent: false
            }]
          };
        }
        return l;
      });
      setLeads(updatedLeads);

    } catch (error) {
      console.error('Error generating email:', error);
      setGeneratedEmail(`Error: ${error.message}. Please make sure your Anthropic API key is set in Netlify environment variables.`);
    } finally {
      setIsGenerating(false);
    }
  };

 // Research company with AI
const researchCompany = async (lead) => {
  setIsGenerating(true);
  
  try {
    const systemPrompt = `You are a B2B sales researcher. Analyze the company and provide key insights for SDRs.`;
    
    const prompt = `Research this ecommerce company for B2B sales outreach:

Company: ${lead.website}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}

Provide:
1. Industry/vertical
2. Likely tech stack (ecommerce platform)
3. Estimated company size
4. Key decision makers (titles to target)
5. Pain points related to creator UGC and onsite conversion
6. Relevant talking points for outreach

Keep it concise and actionable.`;

    const research = await callClaudeAPI(prompt, systemPrompt);
    
    const updatedLeads = leads.map(l => {
      if (l.id === lead.id) {
        return { ...l, notes: research };
      }
      return l;
    });
    setLeads(updatedLeads);
    setSelectedLead({ ...lead, notes: research });

    // Write research back to Google Sheets (Column F)
    if (spreadsheetId && lead.rowIndex) {
      try {
        await fetch('/.netlify/functions/sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'write',
            spreadsheetId: spreadsheetId,
            range: `Sheet1!F${lead.rowIndex}`,
            values: [[research]]
          })
        });
        console.log('Research saved to Google Sheets');
      } catch (error) {
        console.error('Error saving research to Sheets:', error);
      }
    }

  } catch (error) {
    console.error('Error researching company:', error);
  } finally {
    setIsGenerating(false);
  }
};

  // Estimate product catalog size
const estimateCatalogSize = async (lead) => {
  setIsAnalyzingCatalog(true);
  setCatalogAnalysis(null);
  
  try {
    const response = await fetch('/.netlify/functions/catalog-estimator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        website: lead.website
      })
    });

    if (!response.ok) {
      throw new Error('Failed to estimate catalog size');
    }

    const analysis = await response.json();
    setCatalogAnalysis(analysis);
    
    // Update lead with catalog info
    const updatedLeads = leads.map(l => {
      if (l.id === lead.id) {
        return { 
          ...l, 
          catalogSize: analysis.estimatedProducts,
          platform: analysis.platform,
          catalogAnalysis: analysis
        };
      }
      return l;
    });
    setLeads(updatedLeads);

    // Write catalog info back to Google Sheets (Column G)
    if (spreadsheetId && lead.rowIndex) {
      try {
        const catalogInfo = `${analysis.platform} | ${analysis.estimatedProducts} products`;
        await fetch('/.netlify/functions/sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'write',
            spreadsheetId: spreadsheetId,
            range: `Sheet1!G${lead.rowIndex}`,
            values: [[catalogInfo]]
          })
        });
        console.log('Catalog info saved to Google Sheets');
      } catch (error) {
        console.error('Error saving catalog to Sheets:', error);
      }
    }

  } catch (error) {
    console.error('Error estimating catalog:', error);
    setCatalogAnalysis({
      error: true,
      message: error.message
    });
  } finally {
    setIsAnalyzingCatalog(false);
  }
};
  
  // Update lead status (and sync to Google Sheets)
  const updateLeadStatus = (leadId, newStatus) => {
    const updatedLeads = leads.map(lead => {
      if (lead.id === leadId) {
        const updated = {
          ...lead,
          status: newStatus,
          lastContact: newStatus !== 'new' ? new Date().toISOString() : lead.lastContact
        };
        
        // Sync status back to Google Sheets
        syncStatusToSheet(updated, newStatus);
        
        return updated;
      }
      return lead;
    });
    
    setLeads(updatedLeads);
    if (selectedLead?.id === leadId) {
      const updated = updatedLeads.find(l => l.id === leadId);
      setSelectedLead(updated);
    }
  };

  // Filter leads by search term
  const filteredLeads = leads.filter(lead => 
    lead.website.toLowerCase().includes(searchTerm.toLowerCase()) ||
    lead.status.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Get lead count by status
  const getStatusCount = (status) => leads.filter(l => l.status === status).length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>🤖 AI SDR Agent</h1>
          <p>Onsite Affiliate Outreach Platform</p>
        </div>
        <div className="header-stats">
          <div className="stat">
            <span className="stat-value">{leads.length}</span>
            <span className="stat-label">Total Leads</span>
          </div>
          <div className="stat">
            <span className="stat-value">{getStatusCount('contacted')}</span>
            <span className="stat-label">Contacted</span>
          </div>
          <div className="stat">
            <span className="stat-value">{getStatusCount('qualified')}</span>
            <span className="stat-label">Qualified</span>
          </div>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar">
          <nav className="nav-tabs">
            <button 
              className={activeTab === 'leads' ? 'active' : ''} 
              onClick={() => setActiveTab('leads')}
            >
              📋 Leads
            </button>
            <button 
              className={activeTab === 'email' ? 'active' : ''} 
              onClick={() => setActiveTab('email')}
            >
              ✉️ Email Generator
            </button>
            <button 
              className={activeTab === 'pipeline' ? 'active' : ''} 
              onClick={() => setActiveTab('pipeline')}
            >
              📊 Pipeline
            </button>
          </nav>

          {activeTab === 'leads' && (
            <div className="leads-section">
              <div className="section-header">
                <h2>Lead Management</h2>
                <div className="header-actions">
                  <label className="import-btn secondary">
                    Upload CSV
                    <input 
                      type="file" 
                      accept=".csv" 
                      onChange={handleImportLeads}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              </div>

              {!spreadsheetId ? (
                <div className="sheets-setup">
                  <h3>📊 Connect Private Google Sheets</h3>
                  <p>Enter your Google Spreadsheet ID to sync leads securely</p>
                  <div className="sheets-input-group">
                    <input
                      type="text"
                      className="sheets-url-input"
                      placeholder="1ABC...XYZ (from spreadsheet URL)"
                      value={spreadsheetId}
                      onChange={(e) => setSpreadsheetId(e.target.value)}
                    />
                    <button 
                      className="connect-btn"
                      onClick={() => loadFromGoogleSheets(spreadsheetId)}
                      disabled={!spreadsheetId || isLoadingSheets}
                    >
                      {isLoadingSheets ? '⏳ Loading...' : '🔗 Connect'}
                    </button>
                  </div>
                  <div className="sheets-instructions">
                    <p><strong>Setup Instructions:</strong></p>
                    <ol>
                      <li>Open your Google Sheet</li>
                      <li>Copy the <strong>Spreadsheet ID</strong> from the URL<br/>
                          <code>https://docs.google.com/spreadsheets/d/<strong>YOUR_SHEET_ID</strong>/edit</code></li>
                      <li>Make sure you've shared the sheet with your service account email</li>
                      <li>Paste the Spreadsheet ID above</li>
                    </ol>
                    <p className="tip">💡 Required columns: Website, Revenue, Source, Description, Status</p>
                    <p className="tip">🔒 This uses Google Sheets API with service account authentication - fully private!</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="sheets-connected">
                    <div className="connection-info">
                      <span className="connected-badge">✓ Connected to Google Sheets</span>
                      {lastSync && (
                        <span className="sync-time">
                          Last synced: {lastSync.toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    <div className="connection-actions">
                      <button 
                        className="refresh-btn"
                        onClick={() => loadFromGoogleSheets(spreadsheetId)}
                        disabled={isLoadingSheets}
                      >
                        {isLoadingSheets ? '⏳' : '🔄'} Refresh
                      </button>
                      <button 
                        className="disconnect-btn"
                        onClick={() => {
                          setSpreadsheetId('');
                          localStorage.removeItem('spreadsheetId');
                        }}
                      >
                        🔌 Disconnect
                      </button>
                    </div>
                  </div>

                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search leads..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />

                  <div className="leads-list">
                    {filteredLeads.map(lead => (
                      <div 
                        key={lead.id} 
                        className={`lead-card ${selectedLead?.id === lead.id ? 'selected' : ''}`}
                        onClick={() => setSelectedLead(lead)}
                      >
                        <div className="lead-header">
                          <h3>{lead.website}</h3>
                          <span className={`status-badge ${lead.status}`}>
                            {lead.status}
                          </span>
                        </div>
                        <p className="lead-revenue">{lead.revenue}</p>
                        {lead.lastContact && (
                          <p className="lead-date">
                            Last: {new Date(lead.lastContact).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'pipeline' && (
            <div className="pipeline-section">
              <h2>Pipeline Overview</h2>
              <div className="pipeline-stats">
                <div className="pipeline-stage">
                  <div className="stage-label">New</div>
                  <div className="stage-count">{getStatusCount('new')}</div>
                </div>
                <div className="pipeline-stage">
                  <div className="stage-label">Contacted</div>
                  <div className="stage-count">{getStatusCount('contacted')}</div>
                </div>
                <div className="pipeline-stage">
                  <div className="stage-label">Replied</div>
                  <div className="stage-count">{getStatusCount('replied')}</div>
                </div>
                <div className="pipeline-stage">
                  <div className="stage-label">Qualified</div>
                  <div className="stage-count">{getStatusCount('qualified')}</div>
                </div>
                <div className="pipeline-stage">
                  <div className="stage-label">Demo Booked</div>
                  <div className="stage-count">{getStatusCount('demo')}</div>
                </div>
              </div>
            </div>
          )}
        </aside>

        <main className="main-content">
          {activeTab === 'email' && selectedLead ? (
            <div className="email-generator">
              <div className="lead-details">
                <h2>{selectedLead.website}</h2>
                <p className="revenue-badge">{selectedLead.revenue}</p>
                
                {!selectedLead.notes ? (
                  <button 
                    className="research-btn"
                    onClick={() => researchCompany(selectedLead)}
                    disabled={isGenerating}
                  >
                    {isGenerating ? '🔍 Researching...' : '🔍 Research Company with AI'}
                  </button>
                ) : (
                  <div className="research-notes">
                    <h3>🎯 Research Insights</h3>
                    <pre>{selectedLead.notes}</pre>
                  </div>
                )}
                {/* Catalog Size Estimator */}
<div className="catalog-estimator">
  <button 
    className="research-btn"
    onClick={() => estimateCatalogSize(selectedLead)}
    disabled={isAnalyzingCatalog}
  >
    {isAnalyzingCatalog ? '🛍️ Analyzing...' : '🛍️ Estimate Catalog Size'}
  </button>
  
  {catalogAnalysis && !catalogAnalysis.error && (
    <div className="catalog-results">
      <h3>📊 Product Catalog Analysis</h3>
      <div className="catalog-grid">
        <div className="catalog-stat">
          <span className="catalog-label">Platform</span>
          <span className="catalog-value">{catalogAnalysis.platform}</span>
        </div>
        <div className="catalog-stat">
          <span className="catalog-label">Estimated Products</span>
          <span className="catalog-value">{catalogAnalysis.estimatedProducts}</span>
        </div>
        {catalogAnalysis.categories > 0 && (
          <div className="catalog-stat">
            <span className="catalog-label">Categories</span>
            <span className="catalog-value">{catalogAnalysis.categories}</span>
          </div>
        )}
        {catalogAnalysis.productUrlPattern && (
          <div className="catalog-stat full-width">
            <span className="catalog-label">URL Pattern</span>
            <span className="catalog-value">{catalogAnalysis.productUrlPattern}</span>
          </div>
        )}
      </div>
      
      <div className={`qualification-badge ${catalogAnalysis.confidence}`}>
        <strong>Qualification:</strong> {catalogAnalysis.qualification}
      </div>
      
      {catalogAnalysis.details && catalogAnalysis.details.length > 0 && (
        <div className="catalog-details">
          <p><strong>Analysis Details:</strong></p>
          <ul>
            {catalogAnalysis.details.map((detail, idx) => (
              <li key={idx}>{detail}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )}
  
  {catalogAnalysis && catalogAnalysis.error && (
    <div className="catalog-error">
      <p>⚠️ Could not analyze catalog: {catalogAnalysis.message}</p>
      <p>The website may be blocking crawlers or not be an ecommerce site.</p>
    </div>
  )}
</div>
              </div>

              
              <div className="email-actions">
                <h3>Generate Personalized Email</h3>
                <div className="button-group">
                  <button 
                    onClick={() => generateEmail(selectedLead, 'initial')}
                    disabled={isGenerating}
                  >
                    Initial Outreach
                  </button>
                  <button 
                    onClick={() => generateEmail(selectedLead, 'followup')}
                    disabled={isGenerating}
                  >
                    Follow-up
                  </button>
                  <button 
                    onClick={() => generateEmail(selectedLead, 'breakup')}
                    disabled={isGenerating}
                  >
                    Breakup Email
                  </button>
                </div>
              </div>

              {generatedEmail && (
                <div className="generated-email">
                  <div className="email-header">
                    <h3>Generated Email</h3>
                    <button 
                      onClick={() => navigator.clipboard.writeText(generatedEmail)}
                      className="copy-btn"
                    >
                      📋 Copy
                    </button>
                  </div>
                  <pre>{generatedEmail}</pre>
                  
                  <div className="status-actions">
                    <p>Mark lead as:</p>
                    <div className="button-group">
                      <button onClick={() => updateLeadStatus(selectedLead.id, 'contacted')}>
                        Contacted
                      </button>
                      <button onClick={() => updateLeadStatus(selectedLead.id, 'replied')}>
                        Replied
                      </button>
                      <button onClick={() => updateLeadStatus(selectedLead.id, 'qualified')}>
                        Qualified
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {selectedLead.emails?.length > 0 && (
                <div className="email-history">
                  <h3>📧 Email History</h3>
                  {selectedLead.emails.map((email, idx) => (
                    <div key={idx} className="history-item">
                      <div className="history-header">
                        <span className="email-type">{email.type}</span>
                        <span className="email-date">
                          {new Date(email.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <pre>{email.content}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'email' && !selectedLead ? (
            <div className="empty-state">
              <h2>Select a lead to generate personalized emails</h2>
              <p>Choose a lead from the sidebar to get started with AI-powered outreach</p>
            </div>
          ) : activeTab === 'leads' && selectedLead ? (
            <div className="lead-detail-view">
              <h2>{selectedLead.website}</h2>
              <div className="detail-grid">
                <div className="detail-item">
                  <label>Revenue</label>
                  <p>{selectedLead.revenue}</p>
                </div>
                <div className="detail-item">
                  <label>Status</label>
                  <select 
                    value={selectedLead.status}
                    onChange={(e) => updateLeadStatus(selectedLead.id, e.target.value)}
                  >
                    <option value="new">New</option>
                    <option value="contacted">Contacted</option>
                    <option value="replied">Replied</option>
                    <option value="qualified">Qualified</option>
                    <option value="demo">Demo Booked</option>
                    <option value="lost">Lost</option>
                  </select>
                </div>
                <div className="detail-item full-width">
                  <label>Description</label>
                  <p>{selectedLead.description || 'No description available'}</p>
                </div>
              </div>
              <button 
                className="primary-btn"
                onClick={() => setActiveTab('email')}
              >
                Generate Email for this Lead
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <h2>Welcome to AI SDR Agent</h2>
              <p>Import your leads CSV to get started with AI-powered outreach</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
