# 🎯 ICP-Informed SDR Agent Updates

Based on your Onsite Affiliate Ideal Customer Profile document, I've updated all the key functions to target the right buyers with the right messaging.

---

## 📋 What Changed

### **1. Target Titles (Apollo Contact Finder)**

**OLD** (Generic marketing titles):
- VP Digital Marketing
- Director Marketing
- CMO

**NEW** (ICP-specific buyers):
- **PRIMARY**: Director of Influencer Marketing, Head of Partnerships
- **SECONDARY**: VP of E-Commerce, Director of E-Commerce
- **TERTIARY**: Director of Brand Marketing, Head of Social Media
- **QUATERNARY**: VP of Growth, Director of Performance Marketing

---

### **2. Email Generation Prompts**

**Now includes:**
- **Buyer personas** with specific motivations
- **Pain points** from ICP (leaky bucket, content ROI, attribution)
- **Value props** tailored to each buyer type
- **Integration points** for technical buyers
- **Industry context** (fashion, outdoor, home goods)

**Example improvements:**

❌ **Before**: "We help ecommerce brands with marketing"

✅ **After**: "Solving your 'leaky bucket' problem - keeping social traffic converting onsite instead of losing them to Instagram. Plus you're already paying creators - extend that ROI by hosting their content permanently on your PDPs."

---

### **3. Company Research**

**Now focuses on:**
- ✅ ICP fit qualification (HIGH/MEDIUM/LOW)
- ✅ Signs of creator/influencer programs
- ✅ Tech stack identification
- ✅ Specific decision maker roles to target
- ✅ Pain points they likely face

**Output includes:**
```
ICP FIT: HIGH
- Fashion/Apparel brand
- ~500 SKUs
- Active Instagram/TikTok presence
- Likely using Impact or CJ for affiliates

DECISION MAKERS TO TARGET:
- Director of Influencer Marketing (PRIMARY)
- VP of E-Commerce (for PDP integration)

PAIN POINTS:
- Content fatigue - need high volume of UGC
- Attribution - can't prove influencer ROI
```

---

### **4. Lead Enrichment**

**Now captures:**
- ICP fit score (HIGH/MEDIUM/LOW)
- Industry vertical (Fashion, Outdoor, Home Goods)
- Relevant decision maker titles
- Specific pain points
- Talking points for outreach

---

## 🚀 How to Implement

### **Step 1: Update App.jsx Functions**

Replace these 4 functions in your App.jsx:

1. **generateEmail** → Use: `UPDATED_GENERATE_EMAIL_FUNCTION.js`
2. **researchCompany** → Use: `UPDATED_RESEARCH_FUNCTION.js`
3. **enrichLead** → Update systemPrompt using: `UPDATED_ENRICH_PROMPT.js`
4. **findContacts** → Use: `UPDATED_FIND_CONTACTS_FUNCTION.js`

### **Step 2: Update Apollo Function**

Replace the title list in `netlify/functions/apollo-contacts.js` (already done in the file I provided)

### **Step 3: Deploy**

Commit and deploy to Netlify

---

## 📊 Before vs After Examples

### **Email Example - Before:**
```
Subject: Improve your marketing

Hi,

We help ecommerce companies with digital marketing. 
Would you be interested in a demo?

Best,
Your SDR
```

### **Email Example - After:**
```
Subject: Your creators' content is going to waste

Hi {FirstName},

Quick question: What happens to all the TikToks and Instagram 
Reels your creators make after they post them?

Most brands pay $500-2k per creator video that gets maybe 
48 hours of shelf-life on social. Then it's gone.

We help brands like J.Crew and Backcountry host that content 
permanently on their PDPs - extending ROI and proving actual 
incremental sales (not just awareness).

Worth a 15-min chat to see if it fits your creator strategy?

Best,
Your SDR
```

---

## 🎯 Target Company Examples

**HIGH FIT:**
- J.Crew (fashion, apparel)
- Backcountry (outdoor, lifestyle)
- Wayfair (home goods)
- Under Armour (athletic apparel)
- Allbirds (sustainable footwear)
- Patagonia (outdoor apparel)

**MEDIUM FIT:**
- Mid-market fashion brands
- DTC home goods
- Lifestyle brands with 100-1000 SKUs

**LOW FIT:**
- B2B companies
- Pure software companies
- Single-product brands
- No social presence

---

## ✅ What This Achieves

1. **Better targeting** - Finding the actual decision makers
2. **Higher response rates** - Speaking their language
3. **Faster qualification** - ICP fit scoring
4. **More relevant messaging** - Addressing real pain points
5. **Shorter sales cycle** - Reaching the right buyer persona

---

## 🔄 Continuous Improvement

As you get feedback from prospects, you can:
- Update pain points based on actual objections
- Add new buyer titles you discover
- Refine messaging based on what resonates
- Add industry-specific talking points

---

**Ready to deploy these updates?** This will make your SDR agent significantly more effective at reaching and converting your ICP! 🚀
