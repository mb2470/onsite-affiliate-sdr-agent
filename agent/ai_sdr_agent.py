"""
AI SDR Agent for Onsite Affiliate
Autonomous agent that processes leads, drafts emails, sends via Gmail, and checks bounces.

Usage:
  python ai_sdr_agent.py auto                  # Full autonomous run
  python ai_sdr_agent.py send-batch N          # Send N emails to HIGH leads with contacts
  python ai_sdr_agent.py check-bounces         # Check Gmail for bounced emails
  python ai_sdr_agent.py verify-gmail          # Test Gmail connection
  python ai_sdr_agent.py status                # Show current pipeline stats
"""

import os
import json
import time
import random
import re
import base64
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from typing import List, Dict, Optional
from supabase import create_client, Client
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

# Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
GMAIL_CREDENTIALS = os.getenv("GMAIL_OAUTH_CREDENTIALS")
GMAIL_FROM_EMAIL = os.getenv("GMAIL_FROM_EMAIL", "sam@onsiteaffiliate.com")

# Initialize clients
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)


# ═══════════════════════════════════════════════════════════
# GMAIL SERVICE (raw HTTP, no googleapis dependency)
# ═══════════════════════════════════════════════════════════

class GmailService:
    def __init__(self):
        self._access_token = None
        self._creds = None

    def _load_creds(self):
        if not GMAIL_CREDENTIALS:
            raise Exception("GMAIL_OAUTH_CREDENTIALS not set")
        self._creds = json.loads(GMAIL_CREDENTIALS.strip("'\""))

    def _refresh_token(self) -> str:
        if not self._creds:
            self._load_creds()

        data = urllib.parse.urlencode({
            'client_id': self._creds['client_id'],
            'client_secret': self._creds['client_secret'],
            'refresh_token': self._creds['refresh_token'],
            'grant_type': 'refresh_token',
        }).encode()

        req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')

        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode())

        if 'access_token' not in result:
            raise Exception(f"Token refresh failed: {result}")

        self._access_token = result['access_token']
        return self._access_token

    def _get_token(self) -> str:
        if not self._access_token:
            self._refresh_token()
        return self._access_token

    def _gmail_request(self, method, endpoint, body=None, retry=True):
        url = f"https://gmail.googleapis.com/gmail/v1/users/me/{endpoint}"
        token = self._get_token()

        req = urllib.request.Request(url, method=method)
        req.add_header('Authorization', f'Bearer {token}')

        if body:
            req.add_header('Content-Type', 'application/json')
            req.data = json.dumps(body).encode()

        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                self._refresh_token()
                return self._gmail_request(method, endpoint, body, retry=False)
            raise

    def send_email(self, to: str, subject: str, body: str, bcc: List[str] = None) -> Dict:
        lines = [
            f"From: Sam Reid <{GMAIL_FROM_EMAIL}>",
            f"To: {to}",
        ]
        if bcc:
            lines.append(f"Bcc: {', '.join(bcc)}")
        lines.extend([
            f"Subject: {subject}",
            "Content-Type: text/plain; charset=utf-8",
            "",
            body,
        ])

        raw = '\r\n'.join(lines)
        raw_b64 = base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')

        return self._gmail_request('POST', 'messages/send', {'raw': raw_b64})

    def check_bounces(self, days=7) -> List[str]:
        query = urllib.parse.quote(f'from:mailer-daemon@googlemail.com newer_than:{days}d')
        search = self._gmail_request('GET', f'messages?q={query}&maxResults=50')
        messages = search.get('messages', [])

        bounced_emails = []
        for msg in messages:
            try:
                detail = self._gmail_request('GET', f"messages/{msg['id']}?format=full")
                body_text = self._extract_body(detail)

                patterns = [
                    r"wasn'?t delivered to\s+(\S+@\S+\.\S+)",
                    r"delivery to.*?(\S+@\S+\.\S+).*?failed",
                    r"could not be delivered to\s+(\S+@\S+\.\S+)",
                    r"(\S+@\S+\.\S+).*?address not found",
                ]

                for h in (detail.get('payload', {}).get('headers', [])):
                    if h['name'].lower() == 'x-failed-recipients':
                        bounced_emails.append(h['value'].strip().lower())

                for pattern in patterns:
                    for match in re.finditer(pattern, body_text, re.IGNORECASE):
                        email = re.sub(r'[<>.,;\'\"()]', '', match.group(1)).lower()
                        if '@' in email and 'mailer-daemon' not in email and 'googlemail' not in email:
                            bounced_emails.append(email)
            except Exception as e:
                print(f"  ⚠️ Error reading bounce: {e}")

        return list(set(bounced_emails))

    def _extract_body(self, message):
        body = ''
        payload = message.get('payload', {})

        if payload.get('body', {}).get('data'):
            body = base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace')

        for part in payload.get('parts', []):
            if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                body += base64.urlsafe_b64decode(part['body']['data']).decode('utf-8', errors='replace')
            for subpart in part.get('parts', []):
                if subpart.get('mimeType') == 'text/plain' and subpart.get('body', {}).get('data'):
                    body += base64.urlsafe_b64decode(subpart['body']['data']).decode('utf-8', errors='replace')

        return body

    def verify(self) -> str:
        profile = self._gmail_request('GET', 'profile')
        return profile['emailAddress']


# ═══════════════════════════════════════════════════════════
# EMAIL GENERATION
# ═══════════════════════════════════════════════════════════

SYSTEM_PROMPT = """You are an SDR for Onsite Affiliate. Under 90 words, casual tone.

CRITICAL - WHAT WE ACTUALLY DO:
We help D2C brands COPY Amazon's onsite commission model for their OWN website. Creators review products and create video content, only getting paid when their videos drive actual sales. Zero upfront costs for the brand.

THE OFFER:
- Brands implement same onsite commission structure Amazon uses on their own site
- Get creator UGC video content with ZERO upfront costs (no gifting, no retainers, no content fees)
- Only pay onsite commissions when creator videos actually drive sales

CORRECT MESSAGING:
✓ "onsite commissions" (ALWAYS say "onsite" not "performance")
✓ "creators review products"
✓ "creator UGC" (not just "UGC" alone)
✓ "Copy Amazon's onsite commission model for your site"

NEVER SAY:
✗ "performance commissions"
✗ "Tap into Amazon's creators"
✗ "Hey there" — ALWAYS use the contact's first name

SIGNATURE: Always end with exactly:
Sam Reid
OnsiteAffiliate.com

TONE: Conversational, direct, no fluff. Like messaging a coworker on Slack."""


def generate_email(lead: Dict, contact_name: str) -> Dict:
    first_name = contact_name.split(' ')[0] if contact_name else 'there'

    prompt = f"""Write a casual outreach email for {lead['website']}.
The contact's first name is "{first_name}" — ALWAYS address them as "Hey {first_name} -"

{f"Context: {lead.get('research_notes', '')[:300]}" if lead.get('research_notes') else ''}
{f"Industry: {lead.get('industry', '')}" if lead.get('industry') else ''}

Requirements:
- Under 90 words total
- Start with "Hey {first_name} -"
- Ask about upfront creator costs OR gifting logistics
- Explain: Amazon proved onsite commissions eliminate upfront costs
- Key point: We help brands COPY that model for their OWN site
- End with: Sam Reid / OnsiteAffiliate.com
- Include subject line

Format:
Subject: [subject]

[body]"""

    response = anthropic_client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}]
    )

    email_text = response.content[0].text

    subject_match = re.search(r'Subject:\s*(.+)', email_text, re.IGNORECASE)
    subject = subject_match.group(1).strip() if subject_match else f"Creator UGC for {lead['website']}"

    body_start = email_text.find('\n', email_text.find('Subject:'))
    body = email_text[body_start:].strip() if body_start > -1 else email_text

    return {'subject': subject, 'body': body}


# ═══════════════════════════════════════════════════════════
# CONTACT SCORING (matches contactService.js)
# ═══════════════════════════════════════════════════════════

def score_contact(title: str) -> int:
    t = (title or '').lower()

    for kw in ['creator', 'influencer', 'ugc', 'affiliate', 'partnership']:
        if kw in t: return 95
    for kw in ['cmo', 'chief marketing', 'vp marketing', 'vp of marketing', 'head of marketing']:
        if kw in t: return 100
    for kw in ['vp digital', 'vp ecommerce', 'vp e-commerce', 'head of ecommerce', 'head of digital', 'head of growth']:
        if kw in t: return 90
    for kw in ['brand', 'content', 'communications', 'comms']:
        if kw in t: return 70
    for kw in ['ceo', 'founder', 'co-founder', 'president', 'owner']:
        if kw in t: return 60
    for kw in ['manager', 'coordinator', 'specialist']:
        if kw in t: return 30
    return 10


def find_best_contact(website: str) -> Optional[Dict]:
    domain = website.lower().replace('www.', '').replace('https://', '').replace('http://', '')

    result = supabase.table('contact_database').select('*').or_(
        f"website.ilike.%{domain}%,email_domain.ilike.%{domain}%"
    ).limit(50).execute()

    contacts = result.data or []
    if not contacts:
        return None

    scored = sorted(contacts, key=lambda c: score_contact(c.get('title', '')), reverse=True)
    best = scored[0]

    return {
        'name': f"{best.get('first_name', '')} {best.get('last_name', '')}".strip(),
        'email': best.get('email'),
        'title': best.get('title'),
        'score': score_contact(best.get('title', '')),
    }


# ═══════════════════════════════════════════════════════════
# AI SDR AGENT
# ═══════════════════════════════════════════════════════════

class AISDRAgent:

    def __init__(self):
        self.gmail = GmailService()
        self._settings = None

    def _get_settings(self) -> Dict:
        if not self._settings:
            result = supabase.table("agent_settings").select("*").eq(
                "id", "00000000-0000-0000-0000-000000000001"
            ).single().execute()
            self._settings = result.data or {}
        return self._settings

    def _log(self, activity_type, lead_id=None, summary="", status="success"):
        try:
            row = {"activity_type": activity_type, "summary": summary, "status": status}
            if lead_id:
                row["lead_id"] = lead_id
            supabase.table("activity_log").insert(row).execute()
        except Exception as e:
            print(f"  ⚠️ Log error: {e}")

    # ─── STATUS ────────────────────────────────────

    def show_status(self):
        print(f"\n{'=' * 60}")
        print("📊 PIPELINE STATUS")
        print(f"{'=' * 60}")

        total = supabase.table("leads").select("*", count="exact", head=True).execute().count
        enriched = supabase.table("leads").select("*", count="exact", head=True).eq("status", "enriched").execute().count
        contacted = supabase.table("leads").select("*", count="exact", head=True).eq("status", "contacted").execute().count
        high = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").execute().count
        high_contacts = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").eq("has_contacts", True).execute().count
        high_ready = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").eq("has_contacts", True).eq("status", "enriched").execute().count
        outreach = supabase.table("outreach_log").select("*", count="exact", head=True).execute().count

        print(f"  Total leads:        {total}")
        print(f"  Enriched:           {enriched}")
        print(f"  Contacted:          {contacted}")
        print(f"  HIGH fit:           {high}")
        print(f"  HIGH + contacts:    {high_contacts}")
        print(f"  HIGH ready to send: {high_ready}")
        print(f"  Outreach emails:    {outreach}")
        print(f"{'=' * 60}\n")

    # ─── SEND BATCH ────────────────────────────────

    def send_batch(self, count: int = 10):
        print(f"\n{'=' * 60}")
        print(f"📤 SENDING BATCH: up to {count} emails")
        print(f"{'=' * 60}\n")

        settings = self._get_settings()
        if not settings.get('agent_enabled', False):
            print("⏸️  Agent is PAUSED. Enable in dashboard first.")
            return

        # Check send days (Mon=1, Sun=7)
        send_days = settings.get('send_days', [1, 2, 3, 4, 5])
        try:
            import pytz
            now_est = datetime.now(pytz.timezone('US/Eastern'))
            current_dow = now_est.isoweekday()  # Mon=1, Sun=7
        except ImportError:
            now_est = datetime.now(timezone.utc)
            current_dow = now_est.isoweekday()

        if current_dow not in send_days:
            day_names = {1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat',7:'Sun'}
            print(f"📅 Today is {day_names.get(current_dow, '?')} — not a send day. Skipping.")
            return

        allowed_fits = settings.get('allowed_icp_fits', ['HIGH'])
        max_contacts_per_lead_per_day = settings.get('max_contacts_per_lead_per_day', 1)

        # Get leads that match ICP, have contacts, and are enriched OR contacted (for multi-contact)
        leads = supabase.table("leads").select("*").in_(
            "icp_fit", allowed_fits
        ).eq("has_contacts", True).in_(
            "status", ["enriched", "contacted"]
        ).order("created_at", desc=False).limit(count * 3).execute()

        if not leads.data:
            print(f"📭 No {'/'.join(allowed_fits)} leads with contacts ready.")
            return

        # Get today's outreach to track per-lead limits
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        today_outreach = supabase.table("outreach_log").select(
            "website, contact_email"
        ).gte("sent_at", f"{today}T00:00:00Z").execute()

        today_by_website = {}
        all_emailed = set()
        for o in (today_outreach.data or []):
            today_by_website.setdefault(o['website'], []).append(o['contact_email'])
            all_emailed.add(o['contact_email'])

        # Also get ALL previously emailed contacts
        all_outreach = supabase.table("outreach_log").select("contact_email").execute()
        for o in (all_outreach.data or []):
            all_emailed.add(o['contact_email'])

        print(f"📋 Found {len(leads.data)} candidate leads")
        print(f"📧 {len(all_emailed)} contacts already emailed globally\n")

        sent = 0
        failed = 0
        skipped = 0
        min_gap = settings.get('min_minutes_between_emails', 2)

        for i, lead in enumerate(leads.data):
            if sent >= count:
                break

            print(f"\n{'─' * 50}")
            print(f"[{sent + 1}/{count}] {lead['website']}")

            # Check per-lead daily limit
            today_contacts_for_lead = today_by_website.get(lead['website'], [])
            if len(today_contacts_for_lead) >= max_contacts_per_lead_per_day:
                print(f"  ⏭️  Already sent {len(today_contacts_for_lead)} today (limit: {max_contacts_per_lead_per_day})")
                skipped += 1
                continue

            # Find contacts not yet emailed
            domain = lead['website'].lower().replace('www.', '')
            result = supabase.table('contact_database').select('*').or_(
                f"website.ilike.%{domain}%,email_domain.ilike.%{domain}%"
            ).limit(50).execute()

            contacts = result.data or []
            if not contacts:
                print(f"  ❌ No contacts in database")
                failed += 1
                continue

            # Score, filter already emailed, pick best available
            scored = sorted(contacts, key=lambda c: score_contact(c.get('title', '')), reverse=True)
            available = [c for c in scored if c.get('email') and c['email'].lower() not in all_emailed]

            if not available:
                print(f"  ⏭️  All contacts already emailed")
                skipped += 1
                continue

            contact_raw = available[0]
            contact = {
                'name': f"{contact_raw.get('first_name', '')} {contact_raw.get('last_name', '')}".strip(),
                'email': contact_raw['email'],
                'title': contact_raw.get('title', ''),
                'score': score_contact(contact_raw.get('title', '')),
            }

            print(f"  👤 {contact['name']} — {contact['title']} (score: {contact['score']})")
            print(f"  📧 {contact['email']}")
            print(f"  📊 {len(available) - 1} more contacts available at this company")

            # Generate email
            try:
                email_data = generate_email(lead, contact['name'])
                print(f"  ✍️  Subject: {email_data['subject']}")
            except Exception as e:
                print(f"  ❌ Email gen failed: {e}")
                failed += 1
                continue

            # Send
            try:
                result = self.gmail.send_email(
                    to=contact['email'],
                    subject=email_data['subject'],
                    body=email_data['body'],
                )
                print(f"  ✅ SENT! ID: {result.get('id', '?')}")
                sent += 1
            except Exception as e:
                print(f"  ❌ Send failed: {e}")
                self._log('email_failed', lead['id'], f"Failed: {contact['email']} - {e}", 'failed')
                failed += 1
                continue

            # Log outreach
            supabase.table("outreach_log").insert({
                "lead_id": lead['id'],
                "website": lead['website'],
                "contact_email": contact['email'],
                "contact_name": contact['name'],
                "email_subject": email_data['subject'],
                "email_body": email_data['body'],
            }).execute()

            # Mark contacted
            supabase.table("leads").update({
                "status": "contacted",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", lead['id']).execute()

            # Track so we don't re-email
            all_emailed.add(contact['email'].lower())
            today_by_website.setdefault(lead['website'], []).append(contact['email'])

            self._log('email_sent', lead['id'],
                       f"Sent to {contact['name']} <{contact['email']}> at {lead['website']}")

            # Wait between sends
            if sent < count:
                wait = (min_gap * 60) + random.randint(10, 60)
                print(f"  ⏳ Waiting {wait // 60}m {wait % 60}s...")
                time.sleep(wait)

        print(f"\n{'=' * 60}")
        print(f"🏁 BATCH COMPLETE: {sent} sent, {failed} failed, {skipped} skipped")
        print(f"{'=' * 60}\n")

    # ─── CHECK BOUNCES ─────────────────────────────

    def check_bounces(self):
        print(f"\n{'=' * 60}")
        print("🔄 CHECKING BOUNCES")
        print(f"{'=' * 60}\n")

        bounced = self.gmail.check_bounces(days=7)

        if not bounced:
            print("✅ No bounces found!")
            return

        print(f"🚫 Found {len(bounced)} bounced: {', '.join(bounced)}\n")

        cleaned = 0
        for email in bounced:
            deleted = supabase.table("contact_database").delete().eq("email", email).execute()
            if deleted.data:
                print(f"  🗑️ Removed {email}")
                cleaned += 1

            outreach = supabase.table("outreach_log").select("website").eq("contact_email", email).execute()
            for o in (outreach.data or []):
                other = supabase.table("outreach_log").select(
                    "id", count="exact", head=True
                ).eq("website", o['website']).neq("contact_email", email).execute()

                if not other.count or other.count == 0:
                    supabase.table("leads").update({"status": "enriched"}).eq("website", o['website']).execute()
                    print(f"  ↩️ Reset {o['website']} to enriched")

            self._log('email_bounced', summary=f"Bounced: {email}", status='failed')

        print(f"\n✅ Cleaned {cleaned} contacts")

    # ─── FULL AUTO ─────────────────────────────────

    def run_autonomous(self):
        print(f"\n{'=' * 80}")
        print(f"🤖 AUTONOMOUS MODE")
        print(f"   {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
        print(f"{'=' * 80}\n")

        try:
            email = self.gmail.verify()
            print(f"✅ Gmail: {email}")
        except Exception as e:
            print(f"❌ Gmail error: {e}")
            return

        # Update heartbeat so dashboard shows agent is alive
        supabase.table("agent_settings").update({
            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
        }).eq("id", "00000000-0000-0000-0000-000000000001").execute()

        settings = self._get_settings()
        if not settings.get('agent_enabled', False):
            print("⏸️  Agent PAUSED.")
            return

        max_per_day = settings.get('max_emails_per_day', 50)
        send_start = settings.get('send_hours_start', 9)
        send_end = settings.get('send_hours_end', 17)

        try:
            import pytz
            now_est = datetime.now(pytz.timezone('US/Eastern'))
            current_hour = now_est.hour
            current_dow = now_est.isoweekday()
        except ImportError:
            now_est = datetime.now(timezone.utc)
            current_hour = (now_est.hour - 5) % 24
            current_dow = now_est.isoweekday()

        # Check send days
        send_days = settings.get('send_days', [1, 2, 3, 4, 5])
        if current_dow not in send_days:
            day_names = {1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat',7:'Sun'}
            print(f"📅 Today is {day_names.get(current_dow)} — not a send day.")
            return

        if current_hour < send_start or current_hour >= send_end:
            print(f"⏰ Outside hours ({send_start}-{send_end} EST). Now: {current_hour}")
            return

        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        today_count = supabase.table("outreach_log").select(
            "id", count="exact", head=True
        ).gte("sent_at", f"{today}T00:00:00Z").execute()

        sent_today = today_count.count or 0
        remaining = max_per_day - sent_today

        print(f"📊 Today: {sent_today}/{max_per_day} — Budget: {remaining}")

        if remaining <= 0:
            print("🛑 Daily limit reached.")
            return

        # Phase 1: Bounces
        print("\n📬 Phase 1: Bounces...")
        try:
            self.check_bounces()
        except Exception as e:
            print(f"  ⚠️ {e}")

        # Phase 2: Send
        print(f"\n📤 Phase 2: Sending up to {remaining}...")
        self.send_batch(count=remaining)

        self.show_status()
        self._log('autonomous_run', summary=f"Auto complete. {sent_today}/{max_per_day} today")


# ═══════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys

    agent = AISDRAgent()

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python ai_sdr_agent.py auto              # Full autonomous run")
        print("  python ai_sdr_agent.py send-batch 10     # Send N emails")
        print("  python ai_sdr_agent.py check-bounces     # Check bounced emails")
        print("  python ai_sdr_agent.py verify-gmail      # Test Gmail")
        print("  python ai_sdr_agent.py status             # Pipeline stats")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "auto":
        agent.run_autonomous()
    elif cmd == "send-batch":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        agent.send_batch(n)
    elif cmd == "check-bounces":
        agent.check_bounces()
    elif cmd == "verify-gmail":
        try:
            print(f"✅ Gmail: {agent.gmail.verify()}")
        except Exception as e:
            print(f"❌ {e}")
    elif cmd == "status":
        agent.show_status()
    else:
        print(f"Unknown: {cmd}")
        sys.exit(1)
