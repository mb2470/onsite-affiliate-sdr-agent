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
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [isLoadingSheets, setIsLoadingSheets] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  // Load Google Sheets URL and lead metadata from localStorage on mount
  useEffect(() => {
    const savedUrl = localStorage.getItem('googleSheetsUrl');
    const savedMetadata = localStorage.getItem('leadsMetadata');
    
    if (savedUrl) {
      setSheetsUrl(savedUrl);
      loadFromGoogleSheets(savedUrl);
    }
    
    if (savedMetadata) {
      // Metadata contains status, notes, emails for each lead
      const metadata = JSON.parse(savedMetadata);
      // Will merge with sheet data when loaded
      window.leadsMetadata = metadata;
    }
  }, []);

  // Save lead metadata (status, notes, emails) to localStorage
  const saveLeadsMetadata = (updatedLeads) => {
    const metadata = {};
    updatedLeads.forEach(lead => {
      metadata[lead.website] = {
        status: lead.status,
        notes: lead.notes,
        emails: lead.emails,
        lastContact: lead.lastContact
      };
    });
    localStorage.setItem('leadsMetadata', JSON.stringify(metadata));
  };

  // Save leads metadata whenever they change
  useEffect(() => {
    if (leads.length > 0) {
      saveLeadsMetadata(leads);
    }
  }, [leads]);

  // Load leads from Google Sheets CSV export URL
  const loadFromGoogleSheets = async (url) => {
    setIsLoadingSheets(true);
    try {
      // Convert Google Sheets URL to CSV export URL if needed
      let csvUrl = url;
      if (url.includes('/edit')) {
        // Convert: https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=0
        // To: https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv
        const sheetId = url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
        if (sheetId) {
          csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        }
      }

      const response = await fetch(csvUrl);
      const text = await response.text();
      
      // Parse CSV
      const rows = text.split('\n').slice(1); // Skip header
      const metadata = window.leadsMetadata || {};
      
      const importedLeads = rows
        .filter(row => row.trim())
        .map((row, index) => {
          // Handle CSV with quoted fields
          const values = row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
          const website = values[0]?.replace(/"/g, '').trim() || '';
          const revenue = values[1]?.replace(/"/g, '').trim() || 'Unknown';
          const source = values[2]?.replace(/"/g, '').trim() || '';
          const description = values[3]?.replace(/"/g, '').trim() || '';
          
          // Merge with saved metadata (status, emails, notes)
          const saved = metadata[website] || {};
          
          return {
            id: website, // Use website as stable ID
            website,
            revenue,
            source,
            description,
            status: saved.status || 'new',
            lastContact: saved.lastContact || null,
            emails: saved.emails || [],
            notes: saved.notes || ''
          };
        })
        .filter(lead => lead.website); // Remove empty rows

      setLeads(importedLeads);
      setLastSync(new Date());
      localStorage.setItem('googleSheetsUrl', url);
      
    } catch (error) {
      console.error('Error loading from Google Sheets:', error);
      alert('Failed to load from Google Sheets. Make sure the sheet is publicly accessible and the URL is correct.');
    } finally {
      setIsLoadingSheets(false);
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
    const response = await fetch('/api/claude', {
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

    } catch (error) {
      console.error('Error researching company:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Update lead status
  const updateLeadStatus = (leadId, newStatus) => {
    const updatedLeads = leads.map(lead => {
      if (lead.id === leadId) {
        return {
          ...lead,
          status: newStatus,
          lastContact: newStatus !== 'new' ? new Date().toISOString() : lead.lastContact
        };
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

              {!sheetsUrl ? (
                <div className="sheets-setup">
                  <h3>📊 Connect Google Sheets</h3>
                  <p>Enter your public Google Sheets URL to sync leads automatically</p>
                  <div className="sheets-input-group">
                    <input
                      type="text"
                      className="sheets-url-input"
                      placeholder="https://docs.google.com/spreadsheets/d/..."
                      value={sheetsUrl}
                      onChange={(e) => setSheetsUrl(e.target.value)}
                    />
                    <button 
                      className="connect-btn"
                      onClick={() => loadFromGoogleSheets(sheetsUrl)}
                      disabled={!sheetsUrl || isLoadingSheets}
                    >
                      {isLoadingSheets ? '⏳ Loading...' : '🔗 Connect'}
                    </button>
                  </div>
                  <div className="sheets-instructions">
                    <p><strong>Setup Instructions:</strong></p>
                    <ol>
                      <li>Open your Google Sheet with leads</li>
                      <li>Click <strong>File → Share → Publish to web</strong></li>
                      <li>Choose "Entire Document" and "Comma-separated values (.csv)"</li>
                      <li>Click "Publish" and copy the URL</li>
                      <li>Paste the URL above</li>
                    </ol>
                    <p className="tip">💡 Your sheet should have columns: Website, Revenue, Source, Description</p>
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
                        onClick={() => loadFromGoogleSheets(sheetsUrl)}
                        disabled={isLoadingSheets}
                      >
                        {isLoadingSheets ? '⏳' : '🔄'} Refresh
                      </button>
                      <button 
                        className="disconnect-btn"
                        onClick={() => {
                          setSheetsUrl('');
                          localStorage.removeItem('googleSheetsUrl');
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
