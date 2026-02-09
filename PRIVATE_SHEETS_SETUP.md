# 🔐 Private Google Sheets Setup Guide

This version uses **Google Sheets API with service account authentication** for fully private, secure access to your lead data with **two-way sync** (read and write).

## 🎯 What You Get

✅ **Private Sheets** - No need to publish to web  
✅ **Two-Way Sync** - App writes status updates back to Google Sheets  
✅ **Secure** - Service account authentication  
✅ **Team Collaboration** - Share sheet with teammates normally  

---

## Part 1: Google Cloud Setup (10 minutes)

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **"Select a project"** → **"New Project"**
3. Project name: **"AI SDR Agent"**
4. Click **"Create"**
5. Wait for project creation (about 30 seconds)

### Step 2: Enable Google Sheets API

1. Make sure your new project is selected (top bar)
2. Go to **"APIs & Services"** → **"Library"** (left sidebar)
3. Search for: **"Google Sheets API"**
4. Click on it
5. Click **"Enable"**
6. Wait for it to enable (~10 seconds)

### Step 3: Create Service Account

1. Go to **"APIs & Services"** → **"Credentials"** (left sidebar)
2. Click **"+ Create Credentials"** (top)
3. Choose **"Service Account"**
4. Fill in:
   - **Service account name**: `sdr-agent`
   - **Service account ID**: (auto-fills, leave it)
   - **Description**: "Service account for AI SDR Agent"
5. Click **"Create and Continue"**
6. **Skip** the optional steps (roles)
7. Click **"Done"**

### Step 4: Generate Service Account Key (JSON)

1. You'll see your service account in the list
2. Click on the **email** (looks like: `sdr-agent@your-project.iam.gserviceaccount.com`)
3. Go to **"Keys"** tab (top)
4. Click **"Add Key"** → **"Create new key"**
5. Choose **"JSON"**
6. Click **"Create"**
7. **A JSON file downloads** - SAVE THIS! You'll need it soon

---

## Part 2: Set Up Your Google Sheet

### Step 1: Create or Open Your Sheet

1. Go to [Google Sheets](https://sheets.google.com/)
2. Create a new sheet or open existing one
3. **Set up columns** (exact names, in this order):
   ```
   Website | Revenue | Source | Description | Status
   ```

### Step 2: Add Your Leads

Example data:
```
Website              | Revenue  | Source  | Description                    | Status
lululemon.com        | $1.2B+   | Direct  | Athletic apparel               | new
patagonia.com        | $1.0B+   | Direct  | Outdoor clothing               | new
allbirds.com         | $300M+   | Partner | Sustainable footwear           | contacted
```

**Important**: The **Status** column (column E) will be updated automatically by the app!

### Step 3: Share Sheet with Service Account

1. **Open the JSON file** you downloaded
2. **Find the "client_email"** field - it looks like:
   ```json
   "client_email": "sdr-agent@your-project-123.iam.gserviceaccount.com"
   ```
3. **Copy that email address**
4. In your Google Sheet, click **"Share"** (top right)
5. **Paste the service account email**
6. Set permission to **"Editor"**
7. **UNCHECK** "Notify people" (it's a bot, not a person)
8. Click **"Share"**

### Step 4: Get Your Spreadsheet ID

1. Look at your Google Sheet URL:
   ```
   https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/edit
   ```
2. **Copy the ID** (the part between `/d/` and `/edit`):
   ```
   1AbCdEfGhIjKlMnOpQrStUvWxYz123456
   ```
3. **Save this ID** - you'll paste it into the app!

---

## Part 3: Deploy to Netlify

### Step 1: Push Code to GitHub

(If you haven't already - see main DEPLOYMENT.md)

### Step 2: Connect to Netlify

1. Go to [Netlify](https://app.netlify.com/)
2. **"Add new site"** → **"Import an existing project"**
3. Choose **GitHub**
4. Select your repo: `mb2470/onsite-affiliate-sdr-agent`
5. Build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
6. Click **"Deploy"**

### Step 3: Add Environment Variables (CRITICAL!)

While it's deploying, add these:

1. Go to **Site settings** → **Environment variables**
2. Click **"Add a variable"**

**Variable 1 - Anthropic API Key:**
- Key: `ANTHROPIC_API_KEY`
- Value: Your API key from [console.anthropic.com](https://console.anthropic.com/)
- Scopes: All

**Variable 2 - Google Service Account (THE IMPORTANT ONE):**
- Key: `GOOGLE_SERVICE_ACCOUNT_KEY`
- Value: **Open your downloaded JSON file**, copy **ENTIRE CONTENTS**, paste here
  - The value should start with `{"type":"service_account"...`
  - Make sure you copy the WHOLE file
- Scopes: All

3. Click **"Save"**

### Step 4: Redeploy

1. Go to **"Deploys"** tab
2. Click **"Trigger deploy"** → **"Deploy site"**
3. Wait 2-3 minutes
4. Your site is live!

---

## Part 4: Use the App

### Connect Your Sheet

1. Open your deployed app
2. On the "Leads" tab, you'll see "Connect Private Google Sheets"
3. **Paste your Spreadsheet ID** (from Part 2, Step 4)
4. Click **"Connect"**
5. Your leads load! 🎉

### How It Works

**Reading Leads:**
- Click 🔄 **Refresh** anytime to pull latest leads from Sheets
- New rows you add will appear in the app

**Writing Status:**
- When you change a lead's status (Contacted, Qualified, etc.)
- The app **automatically updates** the Status column in your Sheet!
- Check your Google Sheet - you'll see the status update

**Email History:**
- Generated emails and notes stay in the app (localStorage)
- Only the status syncs back to Sheets

---

## 🔧 Troubleshooting

### "Failed to access Google Sheets"

**Check:**
1. Did you share the sheet with the service account email?
2. Is the Spreadsheet ID correct? (no extra spaces)
3. Is the service account JSON in Netlify environment variables?
4. Did you redeploy after adding the environment variable?

### "Service account credentials not found"

**Solution:**
1. Go to Netlify → Site settings → Environment variables
2. Make sure `GOOGLE_SERVICE_ACCOUNT_KEY` exists
3. The value should be the ENTIRE JSON file contents
4. Redeploy

### Status not updating in Google Sheets

**Check:**
1. Does your sheet have a "Status" column (column E)?
2. Is it spelled exactly "Status"?
3. Did you give the service account "Editor" permission?

### Can't see the JSON file contents

**Solution:**
1. Right-click the downloaded `.json` file
2. Choose "Open with" → "Notepad" (Windows) or "TextEdit" (Mac)
3. Copy all the text (it's one long line)
4. Paste into Netlify

---

## 🎯 Your Sheet Structure

```
Column A: Website      (e.g., lululemon.com)
Column B: Revenue      (e.g., $1.2B+)
Column C: Source       (e.g., Direct, Partner)
Column D: Description  (e.g., Athletic apparel brand)
Column E: Status       (e.g., new, contacted, qualified) ← AUTO-UPDATED BY APP!
```

---

## 🔐 Security Benefits

✅ **No public URLs** - Sheet stays private  
✅ **Controlled access** - Only service account can access  
✅ **Two-way sync** - Status updates flow back  
✅ **Team collaboration** - Share sheet normally with teammates  
✅ **Audit trail** - See who changed what in Google Sheets history  

---

## 📊 Workflow Example

**Monday:**
1. Add 20 new leads to Google Sheet
2. Click Refresh in app
3. Generate emails for each lead

**Tuesday-Friday:**
1. Mark leads as "Contacted" after sending emails
2. Check Google Sheet - status column updates automatically!
3. Team can see progress in real-time

**Next Monday:**
1. Filter Google Sheet by Status = "contacted"
2. See which leads need follow-ups
3. Generate follow-up emails in app

---

## 🚀 Next Steps

Once deployed:
1. Test the connection with your Spreadsheet ID
2. Try changing a lead status - watch it update in Google Sheets!
3. Add a new row to your sheet - refresh in app to see it appear
4. Generate some emails and track your pipeline

---

**Questions?** Check the main README.md or open a GitHub issue.
