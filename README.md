# 🤖 AI SDR Agent for Onsite Affiliate

An AI-powered Sales Development Representative tool that automates lead research, email generation, and pipeline management for your Onsite Affiliate outreach.

## ✨ Features

- **🔍 AI-Powered Research**: Automatically research companies and identify decision makers
- **✉️ Smart Email Generation**: Generate personalized cold emails, follow-ups, and breakup emails
- **📊 Pipeline Management**: Track leads through your sales funnel
- **💾 Local Storage**: All data persists in browser (no backend database needed)
- **🚀 One-Click Deploy**: Deploy to Netlify in minutes

## 🎯 What It Does

1. **Import Leads**: Upload your CSV of ecommerce companies
2. **AI Research**: Click to research each company with Claude AI
3. **Generate Emails**: Create personalized outreach based on company context
4. **Track Pipeline**: Move leads through stages (New → Contacted → Qualified → Demo)
5. **Email History**: Keep track of all communications per lead

## 🛠️ Tech Stack

- **Frontend**: React + Vite
- **AI**: Claude Sonnet 4 via Anthropic API
- **Hosting**: Netlify (Static + Serverless Functions)
- **Storage**: Browser LocalStorage

## 📋 Prerequisites

- Node.js 18+ installed
- GitHub account
- Netlify account (free tier works)
- Anthropic API key ([get one here](https://console.anthropic.com/))

## 🚀 Quick Start

### 1. Clone and Install

```bash
# Clone this repo
git clone <your-repo-url>
cd ai-sdr-agent

# Install dependencies
npm install
```

### 2. Set Up Environment Variables

Create a `.env` file in the root directory:

```env
ANTHROPIC_API_KEY=your_api_key_here
```

### 3. Run Locally

```bash
# Start dev server
npm run dev

# Open http://localhost:3000
```

### 4. Deploy to Netlify

#### Option A: Deploy via GitHub (Recommended)

1. Push your code to GitHub:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

2. Go to [Netlify](https://app.netlify.com/)
3. Click "Add new site" → "Import an existing project"
4. Connect your GitHub repo
5. Build settings:
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
6. Add environment variable:
   - Go to Site Settings → Environment Variables
   - Add `ANTHROPIC_API_KEY` with your API key
7. Click "Deploy"

#### Option B: Deploy via Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Deploy
netlify deploy --prod
```

## 📊 How to Use

### Connect Google Sheets (Recommended)

**First-time setup:**
1. Import `google_sheets_template.csv` into a new Google Sheet
2. Go to **File** → **Share** → **Publish to web**
3. Select **CSV format** and click **Publish**
4. Copy the published URL
5. In the app, paste the URL and click **Connect**
6. Your leads load automatically!

**See `GOOGLE_SHEETS_GUIDE.md` for detailed instructions**

### Or Import CSV Manually

1. Click "Upload CSV" in the sidebar
2. Upload your ecommerce leads CSV (should have columns: Website, Revenue, Description)
3. Leads will appear in the left sidebar

### Research a Company

1. Select a lead from the sidebar
2. Switch to "Email Generator" tab
3. Click "🔍 Research Company with AI"
4. Claude will analyze the company and provide insights

### Generate Personalized Emails

1. After researching (optional but recommended), click:
   - **Initial Outreach**: First touch email
   - **Follow-up**: Second or third touch
   - **Breakup Email**: Final attempt before moving on
2. Copy the generated email
3. Mark the lead status (Contacted, Replied, Qualified, etc.)

### Track Your Pipeline

1. Switch to "Pipeline" tab to see overview
2. View lead counts by stage
3. Click on individual leads to see full history

## 📁 CSV Format

Your CSV should look like this:

```csv
Website,Revenue,Source,Description
lululemon.com,$1.2b+,Direct,"Athletic apparel retailer"
patagonia.com,$1.0b+,Direct,"Outdoor clothing and gear"
```

**💡 Tip:** Use the included `google_sheets_template.csv` to get started with 100 pre-loaded ecommerce leads!

## 🔧 Configuration

### Customize Email Prompts

Edit the `systemPrompt` in `src/App.jsx` to change the AI's behavior:

```javascript
const systemPrompt = `You are an expert SDR...`;
```

### Adjust Lead Statuses

Modify the status options in the `updateLeadStatus` function to match your sales process.

## 🎨 Customization

### Change Colors

Edit CSS variables in `src/App.css`:

```css
:root {
  --primary: #6366f1;
  --secondary: #8b5cf6;
  /* ... */
}
```

### Add New Features

The app uses React state for all data management. To add features:
1. Update the lead object structure in `src/App.jsx`
2. Add new UI components
3. Update localStorage save/load logic

## 🔒 Security Notes

- **API Key**: Never commit your `.env` file or expose your API key
- **Netlify Functions**: API calls go through serverless functions to keep keys secure
- **Local Storage**: All lead data is stored in browser (clear browser data = lost leads)

## 📈 Best Practices

1. **Research First**: Always research before generating emails for better personalization
2. **Track Everything**: Update lead status after each interaction
3. **Follow Up**: Use the breakup email strategy after 3-5 touches
4. **Batch Processing**: Import leads in batches by industry or revenue tier

## 🐛 Troubleshooting

**API Key Error**: Make sure your Anthropic API key is set in Netlify environment variables

**Emails Not Generating**: Check browser console for errors. Verify API key is valid.

**Leads Not Saving**: Check browser storage settings. Make sure cookies/storage aren't disabled.

**Build Fails**: Run `npm install` to ensure all dependencies are installed

## 📚 Resources

- [Anthropic API Docs](https://docs.anthropic.com/)
- [Netlify Functions](https://docs.netlify.com/functions/overview/)
- [React Documentation](https://react.dev/)

## 🤝 Contributing

This is your tool - customize it however you like! Some ideas:
- Add email scheduling
- Integrate with your CRM (HubSpot, Salesforce)
- Add webhook notifications
- Build email templates library
- Add A/B testing for subject lines

## 📄 License

MIT - Use it however you want!

## 🎯 Built For

This tool is specifically designed for selling **Onsite Affiliate** - an AI-powered creator UGC platform for ecommerce brands. The email generation is optimized for this use case, but you can easily adapt it for any B2B SaaS product.

---

Made with ❤️ and Claude AI
