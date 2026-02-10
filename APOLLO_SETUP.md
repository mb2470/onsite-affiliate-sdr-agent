# 🚀 Apollo.io Contact Finder Setup

This feature finds decision makers at target companies with verified emails using Apollo.io's API.

---

## 📋 What You Get

After generating an AI email, click **"🔍 Find Contacts"** to:
- Search for decision makers (CMO, VP Marketing, Director Ecommerce, etc.)
- Get verified email addresses
- See LinkedIn profiles
- Auto-personalize emails with contact names

---

## 🔑 Step 1: Get Apollo.io API Key

### Option A: Free Trial (Recommended to Start)
1. Go to [Apollo.io](https://www.apollo.io/)
2. Sign up for free account
3. You get **50 free credits** to test
4. Go to Settings → API
5. Copy your API key

### Option B: Paid Plan (For Production)
- **Basic**: $49/month - 500 credits
- **Professional**: $99/month - 2,000 credits
- **Organization**: $149/month - 10,000 credits

**Note**: Each contact search uses ~1 credit

---

## ⚙️ Step 2: Add API Key to Netlify

1. **Go to Netlify** → Your site → **Site configuration** → **Environment variables**

2. **Click "Add a variable"**

3. **Add:**
   - Key: `APOLLO_API_KEY`
   - Value: Your API key from Apollo.io
   - Scopes: All

4. **Save**

5. **Redeploy** (Deploys → Trigger deploy)

---

## 📁 Step 3: Add Files to GitHub

### A. Add the Function

1. Go to: `netlify/functions/`
2. Upload: `apollo-contacts.js`
3. Commit: "Add Apollo.io contact finder function"

### B. Update App.jsx

Add the code from `APP_JSX_ADDITIONS.txt`:

1. Add 3 state variables (line ~16)
2. Add `findContacts()` function (after `enrichLead`)
3. Add `selectContact()` function
4. Add the UI component (after generated email section)

### C. Add CSS

Copy styles from `APOLLO_CSS.css` to `src/App.css`

### D. Deploy

Netlify → Trigger deploy

---

## 🎯 How to Use

### Workflow:

1. **Select a lead** (e.g., lululemon.com)
2. **Click "Generate Email"** → AI creates personalized email
3. **Click "🔍 Find Contacts"** → Apollo searches for decision makers
4. **Review contacts** → See names, titles, verified emails
5. **Click "Select"** on your preferred contact
6. **Email auto-updates** with contact's first name
7. **Copy email** → Paste into Gmail
8. **Copy email address** → Add to "To" field

---

## 📊 Example Output

```
🎯 Find Decision Maker
[🔍 Find Contacts (Apollo.io)]

Found 3 decision makers:

┌─────────────────────────────────────────────────┐
│ 📸 Sarah Johnson                                │
│ VP of Digital Marketing                         │
│ ✉️ sarah.johnson@lululemon.com ✓ Verified     │
│ 🔗 LinkedIn                                     │
│                                    [Select]     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ 📸 Mike Chen                                    │
│ Director of Ecommerce                           │
│ ✉️ mchen@lululemon.com ✓ Verified             │
│ 🔗 LinkedIn                                     │
│                                    [Select]     │
└─────────────────────────────────────────────────┘

✉️ Sending to: Sarah Johnson (sarah.johnson@lululemon.com)
[📋 Copy Email Address]
```

---

## 💰 Cost Estimate

**Apollo.io Credits:**
- 1 contact search = 1 credit
- Free trial: 50 searches
- Basic plan ($49/mo): 500 searches (~$0.10 per search)

**Combined with AI:**
- Email generation: ~$0.02
- Apollo search: ~$0.10
- **Total per lead: ~$0.12**

For 100 qualified leads: ~$12 total

---

## 🔧 Troubleshooting

### "Failed to find contacts"

**Check:**
1. Is `APOLLO_API_KEY` set in Netlify?
2. Did you redeploy after adding the key?
3. Do you have credits remaining? (Check Apollo dashboard)
4. Is the website domain correct?

### "No contacts found"

**Try:**
1. Company might not be in Apollo's database
2. Try manual LinkedIn search as backup
3. Check if company has a different domain

### Apollo API errors

**Common issues:**
- Invalid API key → Check key in Apollo settings
- Rate limit exceeded → Wait 1 minute or upgrade plan
- Credits depleted → Add more credits or upgrade

---

## 🎯 Search Customization

**Default titles searched:**
- VP Digital Marketing
- Director Digital Marketing
- VP Marketing
- Director Marketing
- VP Ecommerce
- Director Ecommerce
- CMO / Chief Marketing Officer
- Head of Digital
- Head of Ecommerce

**To customize:** Edit the `titles` array in the `findContacts()` function

---

## ✅ Success Checklist

Before using in production:

- [ ] Apollo.io account created
- [ ] API key obtained
- [ ] API key added to Netlify
- [ ] Function file uploaded to GitHub
- [ ] App.jsx updated with code
- [ ] CSS added to App.css
- [ ] Site redeployed
- [ ] Tested with 1-2 leads
- [ ] Verified contacts appear
- [ ] Verified email personalization works

---

## 🚀 Pro Tips

1. **Use after enrichment** - Enrich lead first to get better context
2. **Verify on LinkedIn** - Double-check titles on LinkedIn before sending
3. **Track credits** - Monitor Apollo usage in their dashboard
4. **Batch searches** - Search multiple companies in one session
5. **Save contacts** - Copy results to your Google Sheet for future reference

---

**Ready to find decision makers?** Follow the setup steps and you'll be able to find verified contacts in seconds! 🎯
