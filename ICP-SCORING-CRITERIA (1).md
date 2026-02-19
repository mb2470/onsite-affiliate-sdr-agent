# ICP Scoring Criteria — Onsite Affiliate

## Overview

Leads are scored as **HIGH**, **MEDIUM**, or **LOW** based on how well they match our Ideal Customer Profile (ICP). Scoring uses data from StoreLeads (firmographic) and optionally Claude AI (qualitative research).

---

## Data Sources

| Source | What it provides | Speed |
|--------|-----------------|-------|
| **StoreLeads API** | Product count, estimated monthly sales, category/vertical, country, platform, rank | ~50 leads/second (bulk) |
| **Claude AI + Web Search** | Pain points, decision makers, UGC program analysis | ~1 lead per 5 seconds |

StoreLeads is the primary scoring engine. Claude is used selectively for deep research on promising leads that StoreLeads can't find (non-Shopify brands, etc.).

---

## Scoring Factors

Three factors are evaluated, each worth 1 point:

### Factor 1: Product Count
- **✅ 1 point** — 250 or more products in their online catalog
- **❌ 0 points** — Fewer than 250 products

### Factor 2: Estimated Monthly Sales
- **✅ 1 point** — $1,000,000/month or more in estimated revenue
- **❌ 0 points** — Less than $1,000,000/month or unknown

### Factor 3: Target Category
- **✅ 1 point** — Primary category is one of:
  - Fashion / Apparel (clothing, shoes, footwear, accessories, formal wear, athletic apparel)
  - Home Goods (home & garden, furniture, kitchen, decor, bed & bath, laundry)
  - Outdoor / Lifestyle (sporting, sports, recreation, fitness, travel)
  - Electronics (consumer electronics, computers, phones, networking)
- **❌ 0 points** — Non-target category (beauty, food, health, pets, jewelry, B2B, etc.)

---

## Location Gate

**US or Canada location is required for HIGH.** This is a hard gate, not a point.

Location is determined by:
1. StoreLeads `country` field (most reliable)
2. StoreLeads `state` field mapped to US states or Canadian provinces
3. TLD-based inference (.com → US assumed, .ca → Canada, .co.uk → UK, etc.)

---

## Score Matrix

| Location | 3/3 Factors | 2/3 Factors | 1/3 Factors | 0/3 Factors |
|----------|:-----------:|:-----------:|:-----------:|:-----------:|
| **US / Canada** | **HIGH** | MEDIUM | LOW | LOW |
| **Outside US/CA** | MEDIUM | MEDIUM | LOW | LOW |
| **Unknown location** | MEDIUM | LOW | LOW | LOW |

---

## Fit Reason Format

Each scored lead gets a `fit_reason` showing which factors passed or failed:

```
✅ 8221 products | ✅ $22,544,138/mo sales | ✅ /Apparel/Casual Apparel
```

```
✅ 594 products | ✅ $2,305,206/mo sales | ❌ /Beauty & Fitness/Face & Body Care
```

```
❌ 68 products (<250) | ✅ $10,366,764/mo sales | ✅ /Travel
```

---

## Examples

| Website | Products | Sales | Category | Country | Score | ICP |
|---------|----------|-------|----------|---------|-------|-----|
| fashionnova.com | 232,832 | $77.9M/mo | Apparel | US | 3/3 | **HIGH** |
| skims.com | 475 | $58.2M/mo | Apparel | US | 3/3 | **HIGH** |
| edikted.com | 8,221 | $22.5M/mo | Apparel | US | 3/3 | **HIGH** |
| jansport.com | 68 | $10.4M/mo | Travel | US | 2/3 | **MEDIUM** |
| halara.com | — | — | Apparel | HK | N/A | **LOW** (no StoreLeads data) |
| nordstrom.com | — | — | — | — | N/A | **LOW** (not on tracked platform) |

---

## Leads Without StoreLeads Data

Some brands are not tracked by StoreLeads (non-Shopify platforms, custom builds, etc.). These include major brands like Nordstrom, Coach, Wayfair, and Nike.

For these leads:
- They are marked as `LOW` by default with note: "No StoreLeads data — not on tracked ecommerce platform"
- They can be manually selected for **Claude AI enrichment** which uses web search to research the company
- Claude scores based on the same criteria but with estimated/inferred data

---

## Future: Learning Loop

As outreach progresses, we plan to track:
- Which ICP scores respond to outreach
- Which email templates get replies
- Which contact titles convert best
- Response rates by category, company size, and revenue

This data will be used to refine scoring weights and thresholds over time.
