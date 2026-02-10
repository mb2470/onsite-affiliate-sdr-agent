# 🎯 CORRECT Apollo API Implementation

## ✅ What Was Wrong

**Wrong endpoint:**
- ❌ We were using: `/api/v1/mixed_people/search`
- ✅ Correct endpoint: `/api/v1/mixed_people/api_search`

**Wrong header:**
- ❌ We had: `X-Api-Key` (capital X)
- ✅ Correct: `x-api-key` (lowercase x)

**Missing enrichment step:**
Apollo API works in 2 steps:
1. Search for people (returns obfuscated data)
2. Enrich to get actual emails (uses credits)

---

## 📊 How Apollo API Works

### **Step 1: Search (api_search endpoint)**

**Request:**
```bash
POST https://api.apollo.io/api/v1/mixed_people/api_search
Headers:
  - Content-Type: application/json
  - x-api-key: YOUR_KEY
Body:
  {
    "organization_domains": ["jcrew.com"],
    "person_titles": ["Director of Marketing"]
  }
```

**Response:**
```json
{
  "people": [
    {
      "id": "abc123",
      "first_name": "Sarah",
      "last_name_obfuscated": "Jo***n",  // ← Obfuscated!
      "title": "Director of Marketing",
      "has_email": true,                  // ← Email exists but not shown
      "organization": {
        "name": "J.Crew"
      }
    }
  ]
}
```

**Notice:**
- ❌ Last name is obfuscated: `Jo***n`
- ❌ Email is not included
- ✅ But we know email exists: `has_email: true`

---

### **Step 2: Enrich (bulk_match endpoint)**

To get actual emails, we need a second API call:

**Request:**
```bash
POST https://api.apollo.io/api/v1/people/bulk_match
Headers:
  - Content-Type: application/json
  - x-api-key: YOUR_KEY
Body:
  {
    "details": [
      { "id": "abc123" }
    ]
  }
```

**Response:**
```json
{
  "matches": [
    {
      "id": "abc123",
      "first_name": "Sarah",
      "last_name": "Johnson",           // ← Full name!
      "email": "sarah.j@jcrew.com",     // ← Actual email!
      "email_status": "verified",
      "linkedin_url": "...",
      "photo_url": "..."
    }
  ]
}
```

**Now we have:**
- ✅ Full name: Sarah Johnson
- ✅ Actual email: sarah.j@jcrew.com
- ✅ Email status: verified

---

## 💰 Credit Usage

**Search (api_search):**
- Cost: **1 credit** per search
- Returns: List of people (obfuscated)

**Enrich (bulk_match):**
- Cost: **1 credit PER PERSON** enriched
- Returns: Full contact details with email

**Example:**
- Search for "jcrew.com" → 1 credit → finds 10 people
- Enrich 5 people → 5 credits → get 5 full emails
- **Total: 6 credits**

**Your Apollo Basic plan:**
- 100 credits/month
- That's ~16 full searches (search + enrich 5 people each)

---

## 🔧 Implementation Strategy

Our function does:

1. **Search** for people at the company (1 credit)
2. Filter to only people with `has_email: true`
3. **Enrich** up to 5 people to get actual emails (5 credits)
4. Return the enriched contacts

**Why limit to 5?**
- Saves credits (6 credits per company vs 11 credits)
- 5 contacts is usually enough for outreach
- You can adjust this number

---

## 📝 Updated Function Features

**New apollo-contacts.js includes:**

✅ Correct endpoint: `api_search`
✅ Correct header: `x-api-key` (lowercase)
✅ Two-step process: search → enrich
✅ Credit-efficient: only enriches 5 people
✅ Graceful fallback: if enrichment fails, returns basic info
✅ Better error messages

---

## 🚀 Deploy & Test

### **Step 1: Update Function**

Replace `/netlify/functions/apollo-contacts.js` with the new version.

### **Step 2: Test**

Try these companies:
- `jcrew.com` - Should find marketing people
- `wayfair.com` - Large catalog, many contacts
- `backcountry.com` - Outdoor brand

### **Expected Result:**

```
Found 3 decision makers:

Sarah Johnson
Director of Influencer Marketing
✉️ sarah.j@jcrew.com ✓ Verified
🔗 LinkedIn

Mike Chen
VP of E-Commerce
✉️ mchen@jcrew.com ✓ Verified
🔗 LinkedIn

Jessica Brown
Head of Partnerships
✉️ jbrown@jcrew.com
🔗 LinkedIn
```

---

## ⚠️ Important Notes

### **Credit Management:**

With 100 credits/month on Basic plan:
- Search 1 company + enrich 5 people = **6 credits**
- You can do this for **~16 companies/month**
- After that, you'll need to upgrade or wait for next month

### **If You Run Out of Credits:**

Function will still work, but returns:
```
Found contacts but email enrichment requires higher plan
```

You'll see names and titles, but not emails.

### **To See Your Credit Usage:**

Go to: https://app.apollo.io/#/settings/credits

---

## 🎯 Optimization Tips

**If you want to conserve credits:**

Change line 90 in the function:
```javascript
const personIds = peopleWithEmails.slice(0, 5).map(p => p.id);
```

To:
```javascript
const personIds = peopleWithEmails.slice(0, 3).map(p => p.id); // Only enrich 3
```

This reduces cost to 4 credits per company (search + 3 enrichments).

---

**Deploy this and it should work perfectly!** 🚀
