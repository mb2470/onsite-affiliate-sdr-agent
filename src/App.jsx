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
  const [contacts, setContacts] = useState([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [selectedContact, setSelectedContact] = useState(null);

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
          range: 'Sheet1!A:G'
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
        .filter(row => row[0])
        .map((row, index) => ({
          id: row[0],
          website: row[0] || '',
          revenue: row[1] || 'Unknown',
          source: row[2] || '',
          description: row[3] || '',
          status: row[4] || 'new',
          notes: row[5] || '',
          catalogSize: row[6] || '',
          lastContact: null,
          emails: [],
          rowIndex: index + 2
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
          range: `Sheet1!E${lead.rowIndex}`,
          values: [[newStatus]]
        })
      });
    } catch (error) {
      console.error('Error syncing to Google Sheets:', error);
    }
  };

  // Import leads from CSV
  const handleImportLeads = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const rows = text.split('\n').slice(1);
      
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

  // Generate personalized email with AI (ICP-INFORMED)
  const generateEmail = async (lead, emailType = 'initial') => {
    setIsGenerating(true);
    setGeneratedEmail('');

    try {
      const systemPrompt = `You are an expert SDR (Sales Development Representative) for Onsite Affiliate, 
a revolutionary AI-powered platform that helps ecommerce brands monetize creator UGC content on their product pages.

TARGET BUYERS (based on ICP):
1. Directors of Influencer Marketing / Heads of Partnerships (PRIMARY)
   - Managing affiliate programs and influencer relationships
   - Sourcing creators for UGC (TikTok, Instagram, YouTube)
   - Budget for partner commissions and creator fees
   
2. VPs of E-Commerce / Directors of E-Commerce (TECHNICAL BUYER)
   - North Star: Conversion Rate Optimization (CRO)
   - Care about site speed and PDP engagement
   - Budget: E-Commerce Tech Stack
   
3. Directors of Brand Marketing / Heads of Social Media (CONTENT BUYER)
   - Problem: Content fatigue - need high volume of authentic assets
   - Budget: Content Production / Brand Marketing
   
4. VPs of Growth / Directors of Performance Marketing (ROI BUYER)
   - Goal: Lower Customer Acquisition Cost (CAC)
   - Use UGC as ad creative for Meta/TikTok
   - Budget: Paid Media / Ad Creative

KEY PAIN POINTS TO ADDRESS:
- "Leaky Bucket": Traffic goes to social platforms, lost sales opportunity
- Content ROI: Paying creators for content with short social shelf-life
- Attribution: Can't prove influencer ROI beyond awareness
- Content Fatigue: Need high volume of authentic assets
- Site Performance: Concerned about slowing down PDPs

VALUE PROPOSITIONS:
- Guarantees incrementality (only pay for actual sales lift, not just any sales)
- No upfront creator costs - pay based on performance
- Scales to entire product catalog automatically
- Keeps engagement onsite (solves "leaky bucket")
- Extends content value - creator videos live permanently on PDPs
- Clear attribution - prove direct ROI of influencer content
- 3-month pilot to prove ROI before full commitment
- Case study: Brand with $141 AOV saw 6.2x ROCS (Return on Commission Spend)

INTEGRATION POINTS (for technical buyers):
- Direct integration with Shopify, Salesforce Commerce Cloud
- No site speed impact
- Easy implementation on Product Detail Pages

EMAIL WRITING RULES:
1. Lead with their specific pain point based on their likely role
2. Use authentic, conversational language (not salesy)
3. Reference specific workflows they deal with (creator sourcing, PDP optimization, etc.)
4. Mention relevant platforms they likely use (Impact, Rakuten, CreatorIQ, Grin)
5. Include clear CTA (usually booking a 15-min demo)
6. Keep it under 150 words
7. Sound like you understand their day-to-day challenges

INDUSTRY CONTEXT:
Target companies: Retail, Fashion, Apparel, Outdoor/Lifestyle, Home Goods
Company examples: J.Crew, Backcountry, Wayfair, Under Armour
They likely already have: Active social presence, affiliate networks, creator platforms

Write emails that would get responses from these decision makers who already have budget and mandate to work with creators.`;

      const prompt = `Write a ${emailType} outreach email for this lead:

Company: ${lead.website}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}
${lead.notes ? `Research Notes: ${lead.notes.substring(0, 300)}` : ''}

${emailType === 'followup' ? 'This is a follow-up email. Reference that you reached out before and add a new angle or insight about their specific pain point.' : ''}
${emailType === 'breakup' ? 'This is a final "breakup" email. Create urgency by suggesting you\'ll move on if they\'re not interested. Mention a specific insight about their business that makes this relevant.' : ''}

Include a subject line at the top in this format:
Subject: [your subject line]

Then the email body.

IMPORTANT: 
- Personalize based on their industry (fashion, outdoor, home goods, etc.)
- Lead with ONE specific pain point (leaky bucket, content ROI, attribution)
- Keep it conversational and consultative, not pushy`;

      const emailContent = await callClaudeAPI(prompt, systemPrompt);
      setGeneratedEmail(emailContent);

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

  // Research company with AI (ICP-INFORMED)
  const researchCompany = async (lead) => {
    setIsGenerating(true);
    
    try {
      const systemPrompt = `You are a B2B sales researcher specializing in e-commerce brands and their influencer/affiliate marketing strategies.

Focus your research on identifying:
1. Whether they fit the ICP (Ideal Customer Profile) for Onsite Affiliate
2. Signs they're already investing in creator/influencer programs
3. Their tech stack and integration points
4. Decision makers in key roles

ICP CRITERIA:
- Industry: Retail, Fashion, Apparel, Outdoor/Lifestyle, Home Goods
- Size: Mid-Market to Enterprise
- Signs: High SKU count, active social presence, UGC usage
- Likely platforms: Impact, Rakuten, CJ (affiliates), CreatorIQ, Grin (creators)`;
      
      const prompt = `Research this ecommerce company for Onsite Affiliate outreach:

Company: ${lead.website}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}

Provide a qualification report:

1. INDUSTRY/VERTICAL: (Fashion, Apparel, Outdoor, Home Goods, etc.)

2. ICP FIT: (High/Medium/Low)
   - Do they have high SKU count?
   - Active on social media with UGC?
   - Right industry and size?

3. TECH STACK:
   - E-commerce platform (Shopify, Salesforce, Magento)
   - Likely affiliate networks
   - Creator/influencer tools

4. DECISION MAKERS TO TARGET:
   - Director of Influencer Marketing
   - VP of E-Commerce
   - Director of Brand Marketing
   - VP of Growth/Performance Marketing
   (Note which roles they likely have based on company size)

5. KEY PAIN POINTS THEY LIKELY FACE:
   - Leaky bucket (social traffic not converting)
   - Content ROI (short shelf-life)
   - Attribution challenges
   - Content fatigue

6. TALKING POINTS FOR OUTREACH:
   - Specific use cases based on their products
   - How they're currently handling creator content
   - Integration points with their stack

Keep it concise, actionable, and focused on qualifying them for Onsite Affiliate.`;

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

  // Enrich lead - automatically fill all columns from website (ICP-INFORMED)
  const enrichLead = async (lead) => {
    if (!spreadsheetId || !lead.rowIndex) {
      alert('Google Sheets must be connected to enrich leads');
      return;
    }

    setIsGenerating(true);
    
    try {
      console.log(`Enriching lead: ${lead.website}`);

      const systemPrompt = `You are a B2B sales researcher analyzing e-commerce companies for Onsite Affiliate qualification.

IDEAL CUSTOMER PROFILE (ICP):
- Industries: Retail, Fashion, Apparel, Outdoor/Lifestyle, Home Goods
- Size: Mid-Market to Enterprise ($10M-$1B+ revenue)
- Characteristics: High SKU count, active social presence, uses UGC/creator content
- Likely tools: Impact/Rakuten/CJ (affiliates), CreatorIQ/Grin (creators)

KEY DECISION MAKER ROLES:
1. Director of Influencer Marketing / Head of Partnerships (PRIMARY)
2. VP of E-Commerce / Director of E-Commerce (TECHNICAL)
3. Director of Brand Marketing / Head of Social Media (CONTENT)
4. VP of Growth / Director of Performance Marketing (ROI)

IMPORTANT: Your response must be valid JSON in this exact format:
{
  "revenue": "estimated revenue range - focus on $10M-$1B+ (e.g., $50M-$100M or $500M+)",
  "description": "1-sentence description emphasizing product category (e.g., 'Fashion retailer specializing in women's activewear and lifestyle apparel')",
  "industry": "specific vertical - Fashion/Apparel/Outdoor/Home Goods/Lifestyle",
  "platform": "ecommerce platform - Shopify/Salesforce/Magento/etc",
  "companySize": "employee count estimate",
  "decisionMakers": "most relevant titles from ICP list above based on company size",
  "painPoints": "their likely pain points - leaky bucket, content ROI, attribution, content fatigue, etc.",
  "talkingPoints": "specific hooks for outreach - mention SKU count, social presence, creator strategy, etc.",
  "icpFit": "HIGH/MEDIUM/LOW - based on industry, size, and signals of UGC/creator usage"
}

Only return the JSON, no other text.`;
      
      const prompt = `Research this ecommerce company: ${lead.website}

Provide all information in JSON format as specified.`;

      const researchText = await callClaudeAPI(prompt, systemPrompt);
      
      let researchData;
      try {
        const cleanJson = researchText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        researchData = JSON.parse(cleanJson);
      } catch (parseError) {
        console.error('Failed to parse AI response:', researchText);
        throw new Error('AI returned invalid JSON. Raw response: ' + researchText.substring(0, 200));
      }

      // Get catalog size
      let catalogInfo = 'Unknown';
      let platform = 'Unknown';
      
      try {
        const catalogResponse = await fetch('/.netlify/functions/catalog-estimator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website: lead.website })
        });

        if (catalogResponse.ok) {
          const catalogData = await catalogResponse.json();
          platform = catalogData.platform || 'Unknown';
          const productCount = catalogData.estimatedProducts || 'Unknown';
          catalogInfo = `${platform} | ${productCount} products`;
        }
      } catch (catalogError) {
        console.error('Catalog estimation failed:', catalogError);
      }

      const fullResearch = `ICP FIT: ${researchData.icpFit}
Industry: ${researchData.industry}
Platform: ${platform}
Company Size: ${researchData.companySize}
Decision Makers: ${researchData.decisionMakers}
Pain Points: ${researchData.painPoints}
Talking Points: ${researchData.talkingPoints}`;

      const rowData = [
        lead.website,
        researchData.revenue,
        'Auto-enriched',
        researchData.description,
        'new',
        fullResearch,
        catalogInfo
      ];

      await fetch('/.netlify/functions/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          spreadsheetId: spreadsheetId,
          range: `Sheet1!A${lead.rowIndex}:G${lead.rowIndex}`,
          values: [rowData]
        })
      });

      const updatedLeads = leads.map(l => {
        if (l.id === lead.id) {
          return {
            ...l,
            revenue: researchData.revenue,
            source: 'Auto-enriched',
            description: researchData.description,
            status: 'new',
            notes: fullResearch,
            catalogSize: catalogInfo,
            platform: platform,
            icpFit: researchData.icpFit
          };
        }
        return l;
      });
      
      setLeads(updatedLeads);
      setSelectedLead(updatedLeads.find(l => l.id === lead.id));

      alert(`✅ Successfully enriched ${lead.website}!\nICP Fit: ${researchData.icpFit}`);

    } catch (error) {
      console.error('Error enriching lead:', error);
      alert(`❌ Failed to enrich lead: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Bulk enrich all leads that are missing data
  const bulkEnrichLeads = async () => {
    const unenrichedLeads = leads.filter(lead => 
      !lead.revenue || lead.revenue === 'Unknown' || !lead.description
    );

    if (unenrichedLeads.length === 0) {
      alert('All leads are already enriched!');
      return;
    }

    if (!confirm(`Enrich ${unenrichedLeads.length} leads? This will use AI credits.`)) {
      return;
    }

    for (let i = 0; i < unenrichedLeads.length; i++) {
      const lead = unenrichedLeads[i];
      console.log(`Enriching ${i + 1}/${unenrichedLeads.length}: ${lead.website}`);
      
      await enrichLead(lead);
      
      if (i < unenrichedLeads.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    alert(`✅ Enriched ${unenrichedLeads.length} leads!`);
  };

  // Find contacts using Apollo.io (ICP-INFORMED)
  const findContacts = async (lead) => {
    setIsLoadingContacts(true);
    setContacts([]);
    
    try {
      console.log(`Finding contacts for: ${lead.website}`);

      const response = await fetch('/.netlify/functions/apollo-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          website: lead.website,
          titles: [
            // PRIMARY: Influencer/Affiliate Leaders (most common buyer)
            'Director of Influencer Marketing',
            'Head of Partnerships',
            'Senior Manager of Affiliate Marketing',
            'Director of Brand Advocacy',
            'VP Influencer Marketing',
            'Manager Influencer Marketing',
            
            // SECONDARY: E-Commerce Leaders (technical buyer)
            'VP of E-Commerce',
            'Director of E-Commerce',
            'Head of Digital Product',
            'VP Ecommerce',
            'Director Ecommerce',
            
            // TERTIARY: Brand & Social Leaders (content buyer)
            'Director of Brand Marketing',
            'Head of Social Media',
            'Director of Content Strategy',
            'VP Brand Marketing',
            
            // QUATERNARY: Growth/Performance Leaders (ROI buyer)
            'VP of Growth',
            'Director of Performance Marketing',
            'Head of User Acquisition',
            'VP Growth Marketing'
          ]
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to find contacts');
      }

      const data = await response.json();
      
      if (data.contacts && data.contacts.length > 0) {
        setContacts(data.contacts);
        console.log(`Found ${data.contacts.length} contacts`);
      } else {
        alert('No contacts found with verified emails. Try a different search or check Apollo.io credits.');
      }

    } catch (error) {
      console.error('Error finding contacts:', error);
      alert(`Failed to find contacts: ${error.message}. Make sure your Apollo API key is set in Netlify.`);
    } finally {
      setIsLoadingContacts(false);
    }
  };

  // Select a contact and personalize the email
  const selectContact = (contact) => {
    setSelectedContact(contact);
    
    // Personalize the generated email with contact's name
    if (generatedEmail) {
      const personalizedEmail = generatedEmail.replace(
        /Hi there|Hello|Greetings/gi,
        `Hi ${contact.firstName || contact.name.split(' ')[0]}`
      );
      setGeneratedEmail(personalizedEmail);
    }
  };

  // Add this function after selectContact
const sendViaGmail = () => {
  if (!selectedContact || !generatedEmail) {
    alert('Please select a contact and generate an email first');
    return;
  }

  // Parse subject and body from generated email
  const subjectMatch = generatedEmail.match(/Subject:\s*(.+)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Onsite Affiliate Introduction';
  
  // Get body (everything after "Subject: ...")
  const bodyStart = generatedEmail.indexOf('\n', generatedEmail.indexOf('Subject:'));
  const body = bodyStart > -1 ? generatedEmail.substring(bodyStart).trim() : generatedEmail;

  // Create Gmail compose URL
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(selectedContact.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // Open Gmail in new tab
  window.open(gmailUrl, '_blank');

  // Mark lead as contacted
  updateLeadStatus(selectedLead.id, 'contacted');

  // Log sent email
  const updatedLeads = leads.map(l => {
    if (l.id === selectedLead.id) {
      return {
        ...l,
        emails: [...(l.emails || []).map(e => 
          e.timestamp === selectedLead.emails?.[selectedLead.emails.length - 1]?.timestamp 
            ? { ...e, sent: true, sentAt: new Date().toISOString(), sentTo: selectedContact.email }
            : e
        )]
      };
    }
    return l;
  });
  setLeads(updatedLeads);

  alert(`✅ Opening Gmail to send to ${selectedContact.name}!\n\nLead marked as "Contacted"`);
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
                  <button 
                    className="bulk-enrich-btn secondary"
                    onClick={bulkEnrichLeads}
                    disabled={isGenerating || leads.length === 0}
                  >
                    🔬 Bulk Enrich All
                  </button>
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
                    <p className="tip">💡 Required columns: Website, Revenue, Source, Description, Status, Research Notes, Catalog Size</p>
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

                <div className="enrich-section">
                  <button 
                    className="enrich-btn primary-btn"
                    onClick={() => enrichLead(selectedLead)}
                    disabled={isGenerating || isAnalyzingCatalog}
                  >
                    {isGenerating ? '🔬 Enriching...' : '🔬 Enrich Lead (Auto-fill All Data)'}
                  </button>
                  <p className="enrich-description">
                    Automatically research and fill in Revenue, Description, Research Notes, and Catalog Size
                  </p>
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

              {generatedEmail && (
                <div className="contact-finder">
                  <div className="contact-finder-header">
                    <h3>🎯 Find Decision Maker</h3>
                    <button 
                      className="find-contacts-btn"
                      onClick={() => findContacts(selectedLead)}
                      disabled={isLoadingContacts}
                    >
                      {isLoadingContacts ? '🔍 Searching...' : '🔍 Find Contacts (Apollo.io)'}
                    </button>
                  </div>

                  {contacts.length > 0 && (
                    <div className="contacts-list">
                      <p className="contacts-count">Found {contacts.length} decision makers:</p>
                      {contacts.map((contact) => (
                        <div 
                          key={contact.id} 
                          className={`contact-card ${selectedContact?.id === contact.id ? 'selected' : ''}`}
                        >
                          <div className="contact-info">
                            {contact.photoUrl && (
                              <img 
                                src={contact.photoUrl} 
                                alt={contact.name}
                                className="contact-photo"
                              />
                            )}
                            <div className="contact-details">
                              <h4>{contact.name}</h4>
                              <p className="contact-title">{contact.title}</p>
                              <div className="contact-meta">
                                <span className="contact-email">
                                  ✉️ {contact.email}
                                  {contact.emailStatus === 'verified' && (
                                    <span className="verified-badge">✓ Verified</span>
                                  )}
                                </span>
                                {contact.linkedinUrl && (
                                  <a 
                                    href={contact.linkedinUrl} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="linkedin-link"
                                  >
                                    🔗 LinkedIn
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                          <button 
                            className="select-contact-btn"
                            onClick={() => selectContact(contact)}
                          >
                            {selectedContact?.id === contact.id ? '✓ Selected' : 'Select'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {selectedContact && (
                    <div className="selected-contact-banner">
                      <p>
                        ✉️ Sending to: <strong>{selectedContact.name}</strong> ({selectedContact.email})
                      </p>
button 
  className="send-gmail-btn"
  onClick={sendViaGmail}
>
  📧 Send via Gmail
</button>
                    </div>
                  )}
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
