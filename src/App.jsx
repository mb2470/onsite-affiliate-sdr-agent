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

  // Generate personalized email with AI (BULLETPROOF VERSION with AMAZON proof point)
  const generateEmail = async (lead, emailType = 'initial') => {
    setIsGenerating(true);
    setGeneratedEmail('');

    try {
      const systemPrompt = `You are an expert SDR writing ultra-concise, casual emails for Onsite Affiliate.

CRITICAL WRITING RULES (NEVER BREAK THESE):
1. MAXIMUM 90 WORDS TOTAL (subject line doesn't count toward limit)
2. ALWAYS mention Amazon Onsite Associates program as social proof
3. Write like you're emailing a COWORKER, not a prospect - casual, direct, no formality

THE CORE PAIN POINT (FOCUS ON THIS):
Most brands can't afford to pay creators $500-2k upfront for UGC. And gifting/seeding products to get free content is a logistical nightmare - tracking shipments, hoping they post, chasing creators for content rights.

Amazon Onsite Associates solved this: NO upfront costs. Creators get performance commissions AFTER they drive sales. No gifting headaches, no tracking, no chasing. Just results.

TONE GUIDELINES:
✓ Write like Slack messages - short, punchy, casual
✓ Use contractions (you're, we're, it's)
✓ Drop unnecessary pleasantries ("Hope this finds you well" etc.)
✓ Get straight to the point
✓ Sound like you're helping a colleague solve a problem
✓ End with simple question, not formal CTA

BAD (too formal, too long):
"I hope this email finds you well. I wanted to reach out to discuss an exciting opportunity..."

GOOD (casual, direct, <90 words):
"Sarah -

Can you afford to pay creators $1k upfront for every post?

Amazon Onsite Associates figured out how to fix this. No upfront costs - UGC creators get performance commissions after they drive sales.

We can enable this same model for you and get 1000's of creators participating.

Worth a quick chat?

Mike"

TARGET BUYER PERSONAS:

1. DIRECTOR OF INFLUENCER MARKETING (PRIMARY)
Real Pain: Can't afford $500-2k upfront per creator. Gifting products is a nightmare - tracking, hoping they post, chasing for content rights, no guarantee of results.
What They Want: UGC content without upfront costs or gifting headaches
Hook: Amazon's model - UGC performance commissions AFTER sales, no upfront costs

2. VP E-COMMERCE
Real Pain: Need authentic UGC creator content but don't have budget for creator fees upfront
What They Want: UGC at scale that pays for itself
Hook: Zero upfront cost, Amazon proved it works and scales with creators

3. DIRECTOR BRAND MARKETING
Real Pain: Studio content is expensive, creator content requires upfront payment they don't have
What They Want: Scalable content without breaking budget
Hook: High quality creator UGC with no upfront costs, Amazon's proven onsite commission model

4. VP GROWTH
Real Pain: Can't prove ROI on upfront creator payments, need performance-based model
What They Want: Pay for UGC results, not promises
Hook: Scale creator UGC on performance commissions like Amazon, guaranteed sales incrementality

AMAZON SOCIAL PROOF (REQUIRED IN EVERY EMAIL):
Focus on what Amazon figured out:
✓ "Amazon Onsite Associates - no upfront creator costs"
✓ "Amazon figured out how to do this without paying creators upfront"
✓ "Same model Amazon uses - UGC pay for performance commissions, not onupfront fees"
✓ "Amazon proved you can scale UGC without gifting products or paying upfront"

KEY MESSAGES TO HIT:
✓ NO upfront creator costs ($500-2k per post)
✓ NO gifting/seeding headaches (tracking orders, chasing updates, hoping for posts)
✓ UGC performance commissions AFTER sales (Amazon's model)
✓ Creators earn more long-term, brands pay nothing upfront
✓ All the logistics handled - no tracking shipments, no chasing content

DO NOT:
✗ Use "Dear" or "Hi [Name]," - just start with their name
✗ Say "I hope this finds you well" or similar pleasantries
✗ Use formal sign-offs like "Best regards" - just your name
✗ Make fake case studies or fabricate ROI numbers
✗ Use buzzwords (synergy, leverage, paradigm shift)
✗ Write more than 90 words
✗ Sound salesy or pitchy

EMAIL STRUCTURE (ULTRA SHORT):

Subject: [5-7 words referencing upfront costs or gifting pain]

[Name] -

[1 sentence: question about upfront creator costs OR gifting headaches]

[1-2 sentences: Amazon figured this out - no upfront costs, performance commissions]

[1 sentence: same model for D2C brands]

[1 sentence: simple question CTA]

[Your name]

WORD COUNT ENFORCEMENT:
- Count every word after the subject line
- If you hit 90 words, STOP
- 90 words is the ABSOLUTE MAXIMUM
- Shorter is better (aim for 50-60 words)

EXAMPLES OF GOOD EMAILS:

Example 1:
Subject: Is budget limiting creator UGC?

Sarah -

Can you afford to pay creators $1k upfront for every UGC post?

Amazon figured out how to fix this through an onsite commission program. No upfront costs - creators get UGC performance commissions after they drive sales.

With one line of code we can enable Amazon's creator UGC model for your site.

Worth a quick chat?

Mike

Example 2:
Subject: Gifting products for UGC is a nightmare

Mike -

Quick Q: How much time do you spend tracking gifted products, hoping creators post, then chasing them for content rights?

Amazon figured out how to skip all that with an onsite commission program. Creator UGC performance commissions, no gifting, no tracking.

Our platform does the same for D2C brands like yours.

15 min to explain?

Mike

Example 3:
Subject: Limited budget for upfront creator fees

Jessica -

Most brands have limited budget for upfront pay per post campaigns.

Amazon's onsite commission program proved you don't need to pay upfront. The only pay for creator UGC after sales. No upfront costs, no gifting headaches.

We can launch Amazon's exact same creator UGC model for your site.

Quick call?

Mike

Example 4:
Subject: Stop paying creators upfront fees

David -

You're probably paying UGC content creators $500+ upfront or dealing with gifting/seeding nightmares.

Amazon solved this with an onsite commission program. Creators earn after their UGC drives sales. No upfront costs, no logistics headaches.

With one line of code we can luanch the same program for your site.

Worth discussing?

Mike

QUALITY CHECKLIST:
✓ Under 90 words? (COUNT THEM)
✓ Mentions Amazon Onsite Commissions?
✓ References NO UPFRONT COSTS or GIFTING HEADACHES?
✓ Sounds casual, like Slack message?
✓ No formal greetings/sign-offs?
✓ Gets straight to the point?
✓ Simple question CTA?`;

      const prompt = `Write a ${emailType} outreach email for this lead:

Company: ${lead.website}
Industry: ${lead.notes ? lead.notes.match(/Industry[:\s]+([^\n]+)/)?.[1] || 'eCommerce' : 'eCommerce'}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}
ICP Fit: ${lead.icpFit || lead.notes?.match(/ICP FIT[:\s]+([^\n]+)/)?.[1] || 'Unknown'}

${lead.notes ? `Research Insights:\n${lead.notes.substring(0, 500)}` : ''}

${emailType === 'followup' ? `
FOLLOW-UP EMAIL (even shorter - 75 words max):
- Reference you reached out before
- New angle: mention Amazon's success
- Create curiosity
- Even more casual
` : ''}

${emailType === 'breakup' ? `
BREAKUP EMAIL (shortest - 40 words max):
- Final attempt
- Reference Amazon insight
- Suggest moving on
- Leave door open
` : ''}

CRITICAL REQUIREMENTS:
1. MAXIMUM 90 WORDS (count them!)
2. MUST mention Amazon Onsite Associates program
3. FOCUS ON: Can't afford upfront creator costs OR gifting/seeding is a headache
4. Write like a casual Slack message to a coworker
5. Start with just their first name (no "Hi" or "Dear")
6. End with just your name (no "Best" or "Regards")
7. Get straight to the point - no pleasantries
8. Simple question CTA at the end

KEY MESSAGE: Amazon proved you don't need to pay creators upfront or deal with gifting. Performance commissions after sales. That's what we do for D2C brands.

Write the email now (COUNT to make sure it's under 90 words):`;

3. Write like a casual Slack message to a coworker
4. Start with just their first name (no "Hi" or "Dear")
5. End with just your name (no "Best" or "Regards")
6. Get straight to the point - no pleasantries
7. Reference their industry: ${lead.description || 'eCommerce'}
8. Simple question CTA at the end

Write the email now (and COUNT to make sure it's under 90 words):`;

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

  // Research company with AI (BULLETPROOF VERSION)
  const researchCompany = async (lead) => {
    setIsGenerating(true);
    
    try {
      const systemPrompt = `You are an expert B2B sales researcher specializing in e-commerce brands and their influencer/affiliate marketing strategies.

RESEARCH METHODOLOGY:
1. Analyze the company's actual website and product offerings
2. Verify their industry by examining what they sell (not company name)
3. Look for signs of existing creator/influencer programs
4. Identify their tech stack and existing marketing tools
5. Research their social media presence and content strategy
6. Be accurate and specific - no generic insights

ICP CRITERIA FOR ONSITE AFFILIATE:
✓ Industries: Fashion, Apparel, Outdoor, Lifestyle, Home Goods, Kitchenware, Beauty, Pet
✓ Size: Mid-Market to Enterprise (100+ employees, $10M+ revenue)
✓ Signals: High SKU count (100+), active social media, uses UGC
✓ Existing Tools: Shopify/Salesforce, affiliate networks (Impact/Rakuten/CJ), creator platforms (CreatorIQ/Grin)

DISQUALIFIERS (Mark as LOW FIT):
✗ Pure B2B companies
✗ Service businesses
✗ Software/SaaS companies
✗ Single-product brands
✗ No e-commerce presence`;
      
      const prompt = `Research this ecommerce company for Onsite Affiliate outreach qualification:

Company: ${lead.website}
Revenue: ${lead.revenue}
Description: ${lead.description || 'eCommerce company'}

Provide a detailed qualification report with these exact sections:

1. INDUSTRY/VERTICAL
What do they actually sell? Be specific (e.g., "Premium kitchenware and cookware" not just "Home Goods")

2. ICP FIT SCORE: HIGH / MEDIUM / LOW
- HIGH: Perfect industry match + right size + visible UGC/creator activity
- MEDIUM: Right industry + right size, but unclear creator activity
- LOW: Wrong industry OR wrong size OR no e-commerce

Justify your score:
• Industry match? (Yes/No)
• Company size? (Too small/Perfect/Too large)
• Active social/UGC presence? (Yes/No/Unknown)
• High SKU count (100+)? (Yes/No/Unknown)

3. TECH STACK
- E-commerce platform: (Verify from page source, Wappalyzer data, or visible indicators)
- Likely affiliate networks: (Impact, Rakuten, CJ, ShareASale - based on company size)
- Creator/influencer tools: (CreatorIQ, Grin, AspireIQ, #paid - look for "creator program" or "influencer" pages)
- Email/marketing: (Klaviyo, Mailchimp, etc.)

4. DECISION MAKERS TO TARGET
Based on company size and industry, which titles should we target?
- Primary: (Most important buyer)
- Secondary: (Technical/budget approver)
- Tertiary: (Influencer if relevant)

For mid-market (100-500 employees): Director-level titles
For enterprise (500+ employees): VP/C-level titles

5. KEY PAIN POINTS THEY LIKELY FACE
Be specific to their industry and business model:
• Leaky bucket: (How does this apply to them specifically?)
• Content ROI: (What's their creator content challenge?)
• Attribution: (Why can't they prove influencer ROI?)
• Catalog scale: (How many SKUs do they need content for?)

6. TALKING POINTS FOR OUTREACH
Reference their specific business:
• Product category examples
• SKU count estimates
• Social channels they're active on
• Creator content opportunities
• Integration points with their tech stack

Format: Be concise but specific. Each section should be 2-3 sentences maximum except ICP FIT which needs justification.`;

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
      alert(`Research failed: ${error.message}`);
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

  // Enrich lead - automatically fill all columns from website (BULLETPROOF VERSION)
  const enrichLead = async (lead) => {
    if (!spreadsheetId || !lead.rowIndex) {
      alert('Google Sheets must be connected to enrich leads');
      return;
    }

    setIsGenerating(true);
    
    try {
      console.log(`Enriching lead: ${lead.website}`);

      const systemPrompt = `You are a B2B sales researcher analyzing e-commerce companies for Onsite Affiliate qualification.

CRITICAL RESEARCH INSTRUCTIONS:
1. You MUST research the actual website URL provided
2. Verify what products they ACTUALLY sell by looking at their homepage and product pages
3. Check their "About" page, product categories, and main navigation
4. Do NOT guess based on company name alone - many companies have misleading names
5. If you cannot determine something with confidence, mark it as "Unknown"
6. Be CONSERVATIVE with ICP fit scoring - when in doubt, rate lower

IDEAL CUSTOMER PROFILE (ICP):
Industries (HIGH FIT):
- Fashion/Apparel (clothing, footwear, accessories)
- Outdoor/Lifestyle (camping, hiking, sports gear)
- Home Goods (furniture, decor, housewares)
- Kitchenware (cookware, kitchen tools, dining)
- Beauty/Personal Care (cosmetics, skincare)
- Pet Products (pet supplies, accessories)

Company Characteristics:
- Size: Mid-Market to Enterprise ($10M-$1B+ revenue)
- SKU Count: 100+ products (ideally 500+)
- Social Presence: Active on Instagram/TikTok/YouTube with UGC
- Creator Programs: Uses influencers, affiliates, or brand ambassadors
- Tech Stack: Shopify, Salesforce Commerce, Magento, BigCommerce

LOW FIT (Do NOT qualify as HIGH):
- Pure B2B companies
- Single-product brands
- Service businesses
- Software/SaaS companies
- No ecommerce presence

KEY DECISION MAKER ROLES BY COMPANY SIZE:
Small (<100 employees): Director of Marketing, Head of E-Commerce
Mid (100-500): Director of Influencer Marketing, VP E-Commerce, Director Brand Marketing
Large (500+): VP Influencer Marketing, VP E-Commerce, Director Performance Marketing, VP Growth

IMPORTANT: Your response must be valid JSON in this exact format:
{
  "revenue": "Estimated annual revenue range (e.g., '$50M-$100M', '$500M-$1B+', 'Unknown')",
  "description": "One sentence describing what they ACTUALLY sell based on website analysis (e.g., 'Premium cookware and kitchenware retailer featuring chef-quality pots, pans, and kitchen essentials')",
  "industry": "Primary industry - verify on website: Fashion/Apparel/Outdoor/Home Goods/Kitchenware/Beauty/Pet/Lifestyle/Unknown",
  "platform": "E-commerce platform detected (Shopify/Salesforce Commerce/Magento/BigCommerce/WooCommerce/Custom/Unknown)",
  "companySize": "Employee count estimate (e.g., '50-100', '500-1000', '1000+')",
  "decisionMakers": "Relevant decision maker titles based on company size and industry (comma-separated)",
  "painPoints": "3-4 specific pain points they likely face related to creator content, UGC, and conversion optimization",
  "talkingPoints": "3-4 specific outreach hooks based on their ACTUAL products, catalog size, and social presence",
  "icpFit": "HIGH (perfect fit) / MEDIUM (some fit) / LOW (poor fit) - Be conservative. HIGH requires: correct industry + right size + visible UGC/social presence"
}

ACCURACY VALIDATION CHECKLIST:
Before responding, verify:
✓ Industry matches what they actually sell (not company name)
✓ Description is accurate to their homepage
✓ ICP fit is conservative and justified
✓ Decision makers match their company size
✓ Pain points are relevant to their specific industry
✓ Talking points reference their actual products/business

Only return the JSON, no other text.`;
      
      const prompt = `Research this ecommerce company and provide detailed qualification:

Website: ${lead.website}

IMPORTANT: 
1. Visit this exact URL and analyze what they sell
2. Look at their homepage, navigation menu, and product categories
3. Check their About page if visible
4. Be specific and accurate about their industry and products
5. Only mark as HIGH ICP fit if they truly match all criteria

Provide all information in the JSON format specified above.`;

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
      let platform = researchData.platform || 'Unknown';
      
      try {
        const catalogResponse = await fetch('/.netlify/functions/catalog-estimator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website: lead.website })
        });

        if (catalogResponse.ok) {
          const catalogData = await catalogResponse.json();
          platform = catalogData.platform || researchData.platform || 'Unknown';
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

DECISION MAKERS:
${researchData.decisionMakers}

PAIN POINTS:
${researchData.painPoints}

TALKING POINTS:
${researchData.talkingPoints}`;

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

      alert(`✅ Successfully enriched ${lead.website}!\n\nICP Fit: ${researchData.icpFit}\nIndustry: ${researchData.industry}\nRevenue: ${researchData.revenue}`);

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

  // Find contacts using CSV Database
  const findContacts = async (lead) => {
    setIsLoadingContacts(true);
    setContacts([]);
    
    try {
      console.log(`Finding contacts for: ${lead.website}`);

      const response = await fetch('/.netlify/functions/csv-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          website: lead.website,
          spreadsheetId: spreadsheetId,
          leadRowIndex: lead.rowIndex,
          titles: [
            'Director of Influencer Marketing',
            'Head of Partnerships',
            'Senior Manager of Affiliate Marketing',
            'Director of Brand Advocacy',
            'VP Influencer Marketing',
            'Manager Influencer Marketing',
            'VP of E-Commerce',
            'Director of E-Commerce',
            'Head of Digital Product',
            'VP Ecommerce',
            'Director Ecommerce',
            'Director of Brand Marketing',
            'Head of Social Media',
            'Director of Content Strategy',
            'VP Brand Marketing',
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
        console.log(`Found ${data.contacts.length} contacts from CSV database`);
        
        // Show success message with database info
        if (data.savedToSheets) {
          alert(`✅ Found ${data.contacts.length} contacts in ${data.searchTime}ms!\n\n📊 Saved to "Contacts" sheet in Google Sheets\n💰 FREE - No credits used!\n⚡ Source: Your 500k CSV Database`);
        } else {
          alert(`✅ Found ${data.contacts.length} contacts in ${data.searchTime}ms!\n\n💰 FREE - No credits used!\n⚡ Source: Your 500k CSV Database`);
        }
      } else {
        alert(`No contacts found for ${lead.website} in the CSV database.\n\nThis company may not be in your 500k contact list, or no contacts match the ICP criteria.`);
      }

    } catch (error) {
      console.error('Error finding contacts:', error);
      alert(`Failed to find contacts: ${error.message}\n\nMake sure CONTACTS_SPREADSHEET_ID is set in Netlify environment variables.`);
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

  // Send via Gmail (Quick Link Option)
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
                      {isLoadingContacts ? '🔍 Searching 500k contacts...' : '🔍 Find Contacts (CSV Database)'}
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
                      <div className="button-group">
                        <button 
                          className="copy-email-address-btn"
                          onClick={() => navigator.clipboard.writeText(selectedContact.email)}
                        >
                          📋 Copy Email Address
                        </button>
                        <button 
                          className="send-gmail-btn"
                          onClick={sendViaGmail}
                        >
                          📧 Send via Gmail
                        </button>
                      </div>
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
