# 📊 Google Sheets Integration Guide

This guide shows you how to use Google Sheets as your live lead database for the AI SDR Agent.

## 🎯 How It Works

**Two-Way Sync Architecture:**
1. **Google Sheets → App**: Lead data (Website, Revenue, Description) syncs automatically
2. **App → LocalStorage**: Status changes, notes, and email history save locally
3. **Best of Both**: Update leads in Sheets, manage workflow in the app

### What Syncs from Sheets:
- ✅ Website URL
- ✅ Revenue estimate
- ✅ Company description
- ✅ Any custom columns you add

### What Stays Local:
- ✅ Lead status (New, Contacted, Qualified, etc.)
- ✅ Research notes from AI
- ✅ Generated email history
- ✅ Last contact date

## 🚀 Quick Setup (5 minutes)

### Step 1: Create Your Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new spreadsheet
3. Name it: "SDR Leads - Onsite Affiliate"

### Step 2: Set Up Your Columns

**Required columns (exact names):**
- `Website` - Company domain (e.g., lululemon.com)
- `Revenue` - Estimated revenue (e.g., $1.2M+)
- `Source` - Where you found them (optional)
- `Description` - Brief company description

**Example spreadsheet:**
```
Website              | Revenue  | Source     | Description
---------------------|----------|------------|----------------------------------
lululemon.com        | $1.2B+   | Direct     | Athletic apparel and accessories
patagonia.com        | $1.0B+   | Partner    | Outdoor clothing and gear
allbirds.com         | $300M+   | Research   | Sustainable footwear brand
```

### Step 3: Publish Your Sheet

1. In your Google Sheet, click **File** → **Share** → **Publish to web**
2. Choose:
   - **Entire Document** (or specific sheet if you have multiple tabs)
   - **Comma-separated values (.csv)**
3. Click **Publish**
4. Copy the published URL (looks like: `https://docs.google.com/spreadsheets/d/1ABC.../export?format=csv`)
5. Click "OK" to confirm

**⚠️ Important:** This makes your sheet publicly readable. Don't include sensitive data like emails, phone numbers, or internal notes.

### Step 4: Connect to the App

1. Open your deployed AI SDR Agent
2. On the Leads tab, you'll see "Connect Google Sheets"
3. Paste your published URL
4. Click **Connect**
5. Your leads will load automatically! 🎉

## 📝 Managing Your Leads

### Adding New Leads
1. Add a new row in Google Sheets
2. Click **Refresh** button in the app
3. New lead appears instantly

### Updating Lead Info
1. Edit Website, Revenue, or Description in Sheets
2. Click **Refresh** in the app
3. Changes sync (your status/notes remain intact)

### Organizing Your Sheet
You can add additional columns for your own reference:
- Industry
- Employee Count
- Tech Stack
- Priority (High/Medium/Low)
- Contact Name

The app will ignore extra columns - it only reads the 4 required ones.

## 🔄 Workflow Example

**Monday Morning:**
1. Research 20 new ecommerce brands
2. Add them to your Google Sheet
3. Click Refresh in the app
4. Start generating personalized emails

**Throughout the Week:**
1. Generate emails for each lead
2. Mark status as "Contacted"
3. Track responses and update to "Replied"
4. Move qualified leads to "Demo Booked"

**Friday Review:**
1. Export your Google Sheet for reporting
2. Check Pipeline tab in app for conversion rates
3. Identify top performers by revenue tier

## 💡 Pro Tips

### 1. Use Multiple Sheets for Segmentation
Create tabs in your Google Sheet for different lead tiers:
- **Tier 1 - Enterprise** ($1M+ revenue)
- **Tier 2 - Mid-Market** ($100k-$1M)
- **Tier 3 - SMB** (Under $100k)

Publish each separately and switch between them in the app.

### 2. Import Your Existing CSV
1. In Google Sheets: **File** → **Import** → Upload your CSV
2. Follow the publish steps above
3. All 4,000 leads are now in Sheets!

### 3. Use Google Sheets Formulas
Add calculated columns:
- `=IF(B2>1000000, "Enterprise", "Mid-Market")` for auto-tiering
- `=HYPERLINK("https://"&A2, "Visit Site")` for clickable links
- `=GOOGLETRANSLATE(D2, "en", "es")` to translate descriptions

### 4. Share with Your Team
- Keep your published sheet as read-only (public)
- Share the actual edit link with team members
- Everyone can add leads, but only you control the app workflow

### 5. Backup Your Data
Your local app data (status, notes, emails) is in browser localStorage:
- Export it occasionally via browser dev tools
- Or manually copy important notes back to a Sheets tab

## 🔧 Troubleshooting

### "Failed to load from Google Sheets"
**Problem**: Can't connect to your sheet
**Solutions**:
1. Verify sheet is published to web (File → Share → Publish to web)
2. Make sure you selected "CSV" format, not "Web page"
3. Try pasting the URL in a new browser tab - it should download a CSV file
4. Check that your sheet has the header row: Website, Revenue, Source, Description

### "Leads not updating"
**Problem**: Changed sheet but app shows old data
**Solutions**:
1. Click the Refresh button (🔄) in the app
2. Clear browser cache and reload
3. Sometimes Google Sheets takes 1-2 minutes to update the published CSV

### "Missing columns" error
**Problem**: App can't find required columns
**Solutions**:
1. Ensure first row has: `Website`, `Revenue`, `Source`, `Description`
2. Column names are case-sensitive
3. No extra spaces in column headers

### Lost status/notes after refresh
**Problem**: Lead statuses reset to "New"
**Solutions**:
1. This shouldn't happen - metadata is stored separately
2. Check browser localStorage isn't being cleared
3. Don't use incognito/private mode (no localStorage)

## 🔐 Privacy & Security

### What's Safe to Put in Sheets:
- ✅ Company names and websites
- ✅ Public revenue estimates
- ✅ Industry/category
- ✅ Public descriptions

### What to Keep in the App Only:
- ❌ Contact emails
- ❌ Phone numbers
- ❌ Internal notes about decision makers
- ❌ Specific outreach strategies
- ❌ Email copy and messaging

Remember: Published Sheets are **publicly accessible**. Anyone with the URL can view it.

## 📊 Alternative: Private Sheets API (Advanced)

If you need private sheets with write-back capability:

1. Set up Google Sheets API
2. Create OAuth credentials
3. Modify `netlify/functions/` to include Sheets API calls
4. Two-way sync: App can write status back to Sheets

This requires more setup but gives you:
- Private sheets (not publicly published)
- Write status/notes back to columns
- Full team collaboration

See `ADVANCED_SHEETS_API.md` for implementation guide (coming soon).

## 🎬 Video Tutorial

[Coming Soon: 5-minute setup walkthrough]

## 📚 Additional Resources

- [Google Sheets API Documentation](https://developers.google.com/sheets/api)
- [CSV Format Specification](https://tools.ietf.org/html/rfc4180)
- [Netlify Functions Guide](https://docs.netlify.com/functions/overview/)

---

**Questions?** Open an issue on GitHub or check the main README.md
