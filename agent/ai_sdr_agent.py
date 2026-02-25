"""
AI SDR Agent for Onsite Affiliate
Autonomous agent that processes leads, drafts emails, sends via Gmail, checks bounces,
and sends automated follow-up sequences.

Follow-up strategy:
  - Follow-up #1: 3 days after initial email (gentle nudge, micro-value, low-friction CTA)
  - Follow-up #2: 5 days after follow-up #1 (new perspective, social proof, opinion ask)
  - All follow-ups are threaded as replies to the original email

Usage:
  python ai_sdr_agent.py auto                  # Full autonomous run (loops until end of send window)
  python ai_sdr_agent.py send-batch N          # Send N emails to HIGH leads with contacts
  python ai_sdr_agent.py process-followups     # Send due follow-up emails
  python ai_sdr_agent.py check-bounces         # Check Gmail for bounced emails
  python ai_sdr_agent.py batch-verify N [S]    # Pre-verify N emails (min score S, default 60)
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
from datetime import datetime, timezone, timedelta
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
ELV_API_KEY = os.getenv("EMAILLISTVERIFY_API_KEY")

# Initialize clients (defer crash to runtime with clear error messages)
try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as _init_err:
    print(f"❌ Supabase init failed (check SUPABASE_URL and SUPABASE_SERVICE_KEY): {_init_err}")
    raise SystemExit(1)

try:
    anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
except Exception as _init_err:
    print(f"❌ Anthropic init failed (check ANTHROPIC_API_KEY): {_init_err}")
    raise SystemExit(1)

# GitHub Actions timeout buffer — stop 10 min before the hard limit
GH_ACTIONS_TIMEOUT_MINUTES = 350

# Safe email statuses from EmailListVerify
SAFE_STATUSES = ['ok', 'ok_for_all', 'accept_all']
BAD_STATUSES = ['invalid', 'email_disabled', 'dead_server', 'syntax_error']

# Verification is valid for 30 days
VERIFICATION_MAX_AGE_DAYS = 30


def _save_verification(email: str, status: str):
    """Cache verification result on both contacts and contact_database tables."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        supabase.table('contacts').update({
            'elv_status': status,
            'elv_verified_at': now,
        }).eq('email', email).execute()
    except Exception as e:
        print(f"    ⚠️ Could not update contacts table: {e}")
    try:
        supabase.table('contact_database').update({
            'elv_status': status,
            'elv_verified_at': now,
        }).eq('email', email).execute()
    except Exception as e:
        print(f"    ⚠️ Could not update contact_database table: {e}")


def get_cached_contact_verification(email: str) -> Optional[Dict]:
    """Check the contacts table for a valid (non-expired) verification."""
    try:
        result = supabase.table('contacts').select(
            'elv_status, elv_verified_at'
        ).eq('email', email).not_.is_('elv_status', 'null').not_.is_(
            'elv_verified_at', 'null'
        ).limit(1).execute()

        if not result.data:
            return None

        row = result.data[0]
        verified_at = datetime.fromisoformat(row['elv_verified_at'].replace('Z', '+00:00'))
        age = datetime.now(timezone.utc) - verified_at

        if age.days > VERIFICATION_MAX_AGE_DAYS:
            print(f"    📧 Cached verification for {email} expired ({age.days}d old)")
            return None

        safe = row['elv_status'] in SAFE_STATUSES
        print(f"    📧 Using cached verification for {email}: {row['elv_status']} ({age.days}d old)")
        return {
            'email': email,
            'status': row['elv_status'],
            'safe': safe,
            'cached': True,
            'verified_at': row['elv_verified_at'],
        }
    except Exception as e:
        print(f"    ⚠️ Cache lookup error for {email}: {e}")
        return None


def verify_email(email: str, save_result: bool = True) -> Dict:
    """Verify email via EmailListVerify API and optionally cache the result.

    Checks the contacts table for a cached result first.  If the cached
    verification is less than 30 days old, it is reused.  Otherwise a live
    API call is made and the result is cached on both contacts and
    contact_database tables.
    """
    # 1. Check for a valid cached verification
    cached = get_cached_contact_verification(email)
    if cached:
        return cached

    # 2. No valid cache — do a live verification
    if not ELV_API_KEY:
        return {'email': email, 'status': 'skipped', 'safe': True}

    try:
        url = f"https://apps.emaillistverify.com/api/verifyEmail?secret={urllib.parse.quote(ELV_API_KEY)}&email={urllib.parse.quote(email)}&timeout=15"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = resp.read().decode().strip().lower()

        print(f"    📧 Verify {email}: {status}")
        safe = status in SAFE_STATUSES

        if not safe and status in BAD_STATUSES:
            print(f"    🗑️ Removing invalid email {email}")
            supabase.table('contact_database').delete().eq('email', email).execute()
        elif save_result:
            _save_verification(email, status)

        return {
            'email': email,
            'status': status,
            'safe': safe,
            'cached': False,
            'verified_at': datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        print(f"    ⚠️ Verify error {email}: {e}")
        return {'email': email, 'status': 'error', 'safe': True}


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

        with urllib.request.urlopen(req, timeout=30) as resp:
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
            with urllib.request.urlopen(req, timeout=30) as resp:
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

    def send_reply(self, to: str, subject: str, body: str, thread_id: str,
                   original_message_id: str) -> Dict:
        """Send a reply that threads under the original email."""
        reply_subject = subject if subject.lower().startswith('re:') else f"Re: {subject}"

        lines = [
            f"From: Sam Reid <{GMAIL_FROM_EMAIL}>",
            f"To: {to}",
            f"Subject: {reply_subject}",
            f"In-Reply-To: {original_message_id}",
            f"References: {original_message_id}",
            "Content-Type: text/plain; charset=utf-8",
            "",
            body,
        ]

        raw = '\r\n'.join(lines)
        raw_b64 = base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')

        return self._gmail_request('POST', 'messages/send', {
            'raw': raw_b64,
            'threadId': thread_id,
        })

    def get_message_headers(self, message_id: str) -> Dict:
        """Get headers from a sent message (Message-ID, threadId, etc.)."""
        detail = self._gmail_request('GET', f"messages/{message_id}?format=metadata"
                                     "&metadataHeaders=Message-ID&metadataHeaders=Subject")
        headers = {}
        for h in detail.get('payload', {}).get('headers', []):
            headers[h['name']] = h['value']
        headers['threadId'] = detail.get('threadId', '')
        return headers

    def check_thread_for_replies(self, thread_id: str, our_email: str) -> bool:
        """Check if a thread has any replies from someone other than us."""
        try:
            thread = self._gmail_request('GET', f"threads/{thread_id}?format=metadata"
                                         "&metadataHeaders=From")
            messages = thread.get('messages', [])
            our_addr = (our_email or GMAIL_FROM_EMAIL).lower()

            for msg in messages:
                for h in msg.get('payload', {}).get('headers', []):
                    if h['name'].lower() == 'from':
                        sender = h['value'].lower()
                        if our_addr not in sender:
                            return True
            return False
        except Exception:
            return False

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
        """Recursively extract all text from a Gmail message (handles deeply nested bounce emails)."""
        parts = []

        def _walk(payload):
            if not payload:
                return
            if payload.get('body', {}).get('data'):
                parts.append(base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace'))
            for part in payload.get('parts', []):
                _walk(part)

        _walk(message.get('payload', {}))

        body = '\n'.join(parts)
        # Include snippet as fallback — contains the bounce summary
        snippet = message.get('snippet', '')
        if snippet:
            body += '\n' + snippet
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
        messages=[{"role": "user", "content": prompt}],
        timeout=30.0,
    )

    email_text = response.content[0].text

    subject_match = re.search(r'Subject:\s*(.+)', email_text, re.IGNORECASE)
    subject = subject_match.group(1).strip() if subject_match else f"Creator UGC for {lead['website']}"

    body_start = email_text.find('\n', email_text.find('Subject:'))
    body = email_text[body_start:].strip() if body_start > -1 else email_text

    return {'subject': subject, 'body': body}


# ═══════════════════════════════════════════════════════════
# FOLLOW-UP EMAIL GENERATION
# ═══════════════════════════════════════════════════════════

FOLLOWUP_1_SYSTEM_PROMPT = """You are an SDR for Onsite Affiliate writing a BRIEF follow-up email.

CONTEXT: You sent an initial email a few days ago and got no response. This is your first follow-up.

STRATEGY — "The Gentle Nudge":
- Be VERY brief (under 60 words for the body)
- Acknowledge they are busy — do NOT guilt-trip
- Add ONE micro-value nugget: a specific pain point or quick win for their role
- Low-friction CTA: "Is this on your radar for this quarter?" or similar
- NEVER say "just checking in" or "just circling back" — these add zero value
- Instead reference your previous email: "I'm following up on my note regarding [Goal]."

CORRECT MESSAGING:
✓ "onsite commissions" (ALWAYS say "onsite" not "performance")
✓ "creators review products"
✓ "creator UGC" (not just "UGC" alone)

NEVER SAY:
✗ "performance commissions"
✗ "Tap into Amazon's creators"
✗ "Hey there" — ALWAYS use the contact's first name
✗ "just checking in" / "just circling back"

SIGNATURE: Always end with exactly:
Sam Reid
OnsiteAffiliate.com

TONE: Conversational, direct, empathetic. Like a quick follow-up to a coworker."""


FOLLOWUP_2_SYSTEM_PROMPT = """You are an SDR for Onsite Affiliate writing a second follow-up email.

CONTEXT: You sent an initial email and one follow-up with no response. This is your FINAL follow-up. Change the angle — your initial approach may not have landed.

STRATEGY — "The New Perspective":
- Use ONE of these approaches:
  a) Social Proof: Mention that Amazon's onsite commission program resulted in a 10-20% lift in conversions for product page scrollers
  b) Educational Content: Share a specific insight about how onsite commissions eliminate the gifting/retainer model
  c) The "Opinion" Ask: Ask if eliminating upfront creator costs is even a priority for them right now
- Keep it under 70 words for the body
- This is NOT a re-pitch — offer a fresh lens
- Soft close: Make it easy to say "not right now" — that's OK

CORRECT MESSAGING:
✓ "onsite commissions" (ALWAYS say "onsite" not "performance")
✓ "creators review products"
✓ "creator UGC" (not just "UGC" alone)

NEVER SAY:
✗ "performance commissions"
✗ "Tap into Amazon's creators"
✗ "Hey there" — ALWAYS use the contact's first name
✗ "just checking in" / "just circling back"

SIGNATURE: Always end with exactly:
Sam Reid
OnsiteAffiliate.com

TONE: Conversational, confident, offering value. Not pushy."""


def generate_followup_email(lead: Dict, contact_name: str, followup_number: int,
                            original_subject: str, original_body: str) -> Dict:
    """Generate a follow-up email (1 or 2) based on the original outreach."""
    first_name = contact_name.split(' ')[0] if contact_name else 'there'

    if followup_number == 1:
        system = FOLLOWUP_1_SYSTEM_PROMPT
        prompt = f"""Write a brief first follow-up email for {lead['website']}.
The contact's first name is "{first_name}" — address them by first name.

Original email subject: {original_subject}
Original email body (for context — do NOT repeat it):
{original_body[:400]}

{f"Industry: {lead.get('industry', '')}" if lead.get('industry') else ''}

Requirements:
- Under 60 words for the body
- Reference your previous email naturally (e.g., "I'm following up on my note regarding...")
- Add one micro-value point relevant to their role
- Low-friction CTA like "Is this on your radar for this quarter?"
- Do NOT include a subject line (this will be sent as a reply in the same thread)
- Do NOT re-pitch the whole product
- End with: Sam Reid / OnsiteAffiliate.com

Format:
[body only, no subject line]"""

    else:
        system = FOLLOWUP_2_SYSTEM_PROMPT
        prompt = f"""Write a second (final) follow-up email for {lead['website']}.
The contact's first name is "{first_name}" — address them by first name.

Original email subject: {original_subject}
Original email body (for context — do NOT repeat it):
{original_body[:400]}

{f"Industry: {lead.get('industry', '')}" if lead.get('industry') else ''}

Requirements:
- Under 70 words for the body
- Change the angle from the original pitch
- Use social proof: "Amazon's onsite commission program resulted in a 10-20% lift in conversions for product page scrollers"
- OR ask for their opinion: "Is eliminating upfront creator costs even a priority right now?"
- Make it easy to say "not right now"
- Do NOT include a subject line (this will be sent as a reply in the same thread)
- End with: Sam Reid / OnsiteAffiliate.com

Format:
[body only, no subject line]"""

    response = anthropic_client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=400,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        timeout=30.0,
    )

    body = response.content[0].text.strip()

    # Clean up any accidental subject line the model might include
    if body.lower().startswith('subject:'):
        body = body[body.find('\n'):].strip()

    return {'body': body}


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
    domain = website.lower().replace('https://', '').replace('http://', '').replace('www.', '').rstrip('/')

    result = supabase.table('contact_database').select('*').or_(
        f"website.eq.{domain},website.eq.www.{domain},email_domain.eq.{domain}"
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

    @staticmethod
    def _parse_send_days(raw) -> List[int]:
        """Safely parse send_days from Supabase (handles list, string, or mixed types)."""
        default = [1, 2, 3, 4, 5]
        if raw is None:
            return default
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return default
        if isinstance(raw, list):
            return [int(d) for d in raw]
        return default

    def _get_settings(self, refresh=False) -> Dict:
        if not self._settings or refresh:
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

    def _update_heartbeat(self):
        supabase.table("agent_settings").update({
            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
        }).eq("id", "00000000-0000-0000-0000-000000000001").execute()

    def _is_within_send_hours(self, settings) -> bool:
        send_start = settings.get('send_hour_start', 9)
        send_end = settings.get('send_hour_end', 17)
        send_days = self._parse_send_days(settings.get('send_days'))

        try:
            import pytz
            now_est = datetime.now(pytz.timezone('US/Eastern'))
        except ImportError:
            now_est = datetime.now(timezone.utc) - timedelta(hours=5)

        current_hour = now_est.hour
        current_dow = now_est.isoweekday()

        if current_dow not in send_days:
            return False
        if current_hour < send_start or current_hour > send_end:
            return False
        return True

    def _get_remaining_today(self, max_per_day: int) -> int:
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        today_count = supabase.table("outreach_log").select(
            "id", count="exact", head=True
        ).gte("sent_at", f"{today}T00:00:00Z").execute()
        sent_today = today_count.count or 0
        return max_per_day - sent_today

    # ─── STATUS ────────────────────────────────────

    def show_status(self):
        print(f"\n{'=' * 60}")
        print("📊 PIPELINE STATUS")
        print(f"{'=' * 60}")

        total = supabase.table("leads").select("*", count="exact", head=True).execute().count
        enriched = supabase.table("leads").select("*", count="exact", head=True).eq("status", "enriched").execute().count
        contacted = supabase.table("leads").select("*", count="exact", head=True).eq("status", "contacted").execute().count
        replied = supabase.table("leads").select("*", count="exact", head=True).eq("status", "replied").execute().count
        high = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").execute().count
        high_contacts = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").eq("has_contacts", True).execute().count
        high_ready = supabase.table("leads").select("*", count="exact", head=True).eq("icp_fit", "HIGH").eq("has_contacts", True).eq("status", "enriched").execute().count
        outreach = supabase.table("outreach_log").select("*", count="exact", head=True).execute().count

        # Follow-up stats (may fail if columns not yet migrated)
        try:
            fu1_count = supabase.table("outreach_log").select("*", count="exact", head=True).eq("followup_number", 1).execute().count
            fu2_count = supabase.table("outreach_log").select("*", count="exact", head=True).eq("followup_number", 2).execute().count
        except Exception:
            fu1_count = 0
            fu2_count = 0

        print(f"  Total leads:        {total}")
        print(f"  Enriched:           {enriched}")
        print(f"  Contacted:          {contacted}")
        print(f"  Replied:            {replied}")
        print(f"  HIGH fit:           {high}")
        print(f"  HIGH + contacts:    {high_contacts}")
        print(f"  HIGH ready to send: {high_ready}")
        print(f"  Outreach emails:    {outreach}")
        print(f"    Follow-up #1:     {fu1_count}")
        print(f"    Follow-up #2:     {fu2_count}")
        print(f"{'=' * 60}\n")

    # ─── SEND ONE EMAIL ────────────────────────────

    def _send_one(self, lead, all_emailed, today_by_website, settings) -> str:
        """Try to send one email for a lead. Returns: 'sent', 'skipped', 'failed'."""
        max_contacts_per_lead_per_day = settings.get('max_contacts_per_lead_per_day', 1)

        # Check per-lead daily limit
        today_contacts = today_by_website.get(lead['website'], [])
        if len(today_contacts) >= max_contacts_per_lead_per_day:
            return 'skipped'

        # Find contacts — use exact matches so B-tree indexes are used
        domain = lead['website'].lower().replace('https://', '').replace('http://', '').replace('www.', '').rstrip('/')
        result = supabase.table('contact_database').select('*').or_(
            f"website.eq.{domain},website.eq.www.{domain},email_domain.eq.{domain}"
        ).limit(50).execute()

        contacts = result.data or []
        if not contacts:
            # No contacts found — mark lead so it's excluded from future queries
            print(f"  ⚠️ No contacts in DB for {lead['website']} — clearing has_contacts")
            try:
                supabase.table("leads").update({"has_contacts": False}).eq("id", lead['id']).execute()
            except Exception:
                pass
            return 'failed'

        # Score and filter already emailed
        scored = sorted(contacts, key=lambda c: score_contact(c.get('title', '')), reverse=True)
        available = [c for c in scored if c.get('email') and c['email'].lower() not in all_emailed]

        if not available:
            print(f"  ⏭️  All {len(scored)} contacts already emailed for {lead['website']}")
            return 'skipped'

        contact_raw = available[0]
        contact = {
            'name': f"{contact_raw.get('first_name', '')} {contact_raw.get('last_name', '')}".strip(),
            'email': contact_raw['email'],
            'title': contact_raw.get('title', ''),
            'score': score_contact(contact_raw.get('title', '')),
        }

        print(f"  👤 {contact['name']} — {contact['title']} (score: {contact['score']})")
        print(f"  📧 {contact['email']}")

        # Verify email — checks contacts table cache first (30-day expiry)
        verification = verify_email(contact['email'])
        if not verification['safe']:
            print(f"  🚫 Failed verification: {verification['status']}")
            all_emailed.add(contact['email'].lower())
            return 'failed'

        # Log fresh verifications to activity log
        if not verification.get('cached') and verification['status'] not in ('skipped', 'error'):
            self._log('email_verified', lead['id'],
                       f"Verified {contact['email']}: {verification['status']}")

        # Generate email
        try:
            email_data = generate_email(lead, contact['name'])
            print(f"  ✍️  Subject: {email_data['subject']}")
        except Exception as e:
            print(f"  ❌ Email gen failed: {e}")
            return 'failed'

        # Send
        try:
            result = self.gmail.send_email(
                to=contact['email'],
                subject=email_data['subject'],
                body=email_data['body'],
            )
            gmail_msg_id = result.get('id', '')
            print(f"  ✅ SENT! ID: {gmail_msg_id}")
        except Exception as e:
            print(f"  ❌ Send failed: {e}")
            self._log('email_failed', lead['id'], f"Failed: {contact['email']} - {e}", 'failed')
            return 'failed'

        # Retrieve thread ID and Message-ID header for follow-up threading
        gmail_thread_id = result.get('threadId', '')
        rfc_message_id = ''
        if gmail_msg_id:
            try:
                headers = self.gmail.get_message_headers(gmail_msg_id)
                gmail_thread_id = gmail_thread_id or headers.get('threadId', '')
                rfc_message_id = headers.get('Message-ID', headers.get('Message-Id', ''))
            except Exception as e:
                print(f"  ⚠️ Could not fetch message headers: {e}")

        # Log outreach
        supabase.table("outreach_log").insert({
            "lead_id": lead['id'],
            "website": lead['website'],
            "contact_email": contact['email'],
            "contact_name": contact['name'],
            "email_subject": email_data['subject'],
            "email_body": email_data['body'],
            "followup_number": 0,
            "gmail_message_id": gmail_msg_id,
            "gmail_thread_id": gmail_thread_id,
            "rfc_message_id": rfc_message_id,
        }).execute()

        # Mark contacted
        supabase.table("leads").update({
            "status": "contacted",
            "has_contacts": True,
            "contact_name": contact['name'],
            "contact_email": contact['email'],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", lead['id']).execute()

        # Track
        all_emailed.add(contact['email'].lower())
        today_by_website.setdefault(lead['website'], []).append(contact['email'])

        self._log('email_sent', lead['id'],
                   f"Sent to {contact['name']} <{contact['email']}> at {lead['website']}")

        return 'sent'

    # ─── SEND BATCH ────────────────────────────────

    def send_batch(self, count: int = 10, deadline: datetime = None):
        print(f"\n{'=' * 60}")
        print(f"📤 SENDING BATCH: up to {count} emails")
        print(f"{'=' * 60}\n")

        settings = self._get_settings(refresh=True)
        if not settings.get('agent_enabled', False):
            print("⏸️  Agent is PAUSED.")
            return 0

        allowed_fits = settings.get('allowed_icp_fits', ['HIGH'])

        # Two-pass query: prioritize fresh enriched leads over contacted ones
        enriched_leads = supabase.table("leads").select("*").in_(
            "icp_fit", allowed_fits
        ).eq("has_contacts", True).eq(
            "status", "enriched"
        ).order("created_at", desc=False).limit(50).execute()

        contacted_leads = supabase.table("leads").select("*").in_(
            "icp_fit", allowed_fits
        ).eq("has_contacts", True).eq(
            "status", "contacted"
        ).order("created_at", desc=False).limit(50).execute()

        # Enriched first — they always have un-emailed contacts
        all_leads = (enriched_leads.data or []) + (contacted_leads.data or [])

        if not all_leads:
            print(f"📭 No {'/'.join(allowed_fits)} leads ready.")
            return 0

        n_enriched = len(enriched_leads.data or [])
        n_contacted = len(contacted_leads.data or [])

        # Load already-emailed contacts
        all_outreach = supabase.table("outreach_log").select("contact_email").execute()
        all_emailed = set(o['contact_email'].lower() for o in (all_outreach.data or []) if o.get('contact_email'))

        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        today_outreach = supabase.table("outreach_log").select(
            "website, contact_email"
        ).gte("sent_at", f"{today}T00:00:00Z").execute()

        today_by_website = {}
        for o in (today_outreach.data or []):
            today_by_website.setdefault(o['website'], []).append(o['contact_email'])

        print(f"📋 {len(all_leads)} candidate leads ({n_enriched} enriched, {n_contacted} contacted), {len(all_emailed)} contacts already emailed\n")

        sent = 0
        failed = 0
        skipped = 0
        min_gap = settings.get('min_minutes_between_emails', 2)

        for lead in all_leads:
            if sent >= count:
                break

            if deadline and datetime.now(timezone.utc) >= deadline:
                print(f"\n⏰ Deadline reached — stopping batch.")
                break

            print(f"\n{'─' * 50}")
            print(f"[{sent + 1}/{count}] {lead['website']}")

            result = self._send_one(lead, all_emailed, today_by_website, settings)

            if result == 'sent':
                sent += 1
                # Wait between sends
                if sent < count:
                    wait = (min_gap * 60) + random.randint(10, 60)
                    if deadline:
                        secs_left = (deadline - datetime.now(timezone.utc)).total_seconds()
                        if secs_left <= wait + 60:
                            print(f"  ⏰ Only {secs_left:.0f}s left — skipping wait.")
                            continue
                    print(f"  ⏳ Waiting {wait // 60}m {wait % 60}s...")
                    time.sleep(wait)
            elif result == 'failed':
                failed += 1
            else:
                skipped += 1

        print(f"\n🏁 BATCH: {sent} sent, {failed} failed, {skipped} skipped")
        return sent

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

    # ─── BATCH VERIFY EMAILS ─────────────────────

    def batch_verify(self, limit: int = 500, min_score: int = 60):
        """Pre-verify emails for high-scoring contacts on HIGH ICP leads.

        Only verifies contacts that:
          - Belong to a HIGH ICP-fit lead
          - Have a title score >= min_score (default 60)
          - Have NOT been verified yet OR verification is older than 30 days
          - Have NOT already been emailed

        Args:
            limit: Max emails to verify (budget your ELV credits).
            min_score: Minimum contact title score to verify.
        """
        print(f"\n{'=' * 60}")
        print(f"📧 BATCH EMAIL VERIFICATION")
        print(f"   Budget: {limit} credits  |  Min score: {min_score}")
        print(f"{'=' * 60}\n")

        # Get all HIGH ICP leads with contacts
        leads = supabase.table("leads").select("website").eq(
            "icp_fit", "HIGH"
        ).eq("has_contacts", True).execute()
        lead_websites = [l['website'] for l in (leads.data or [])]

        if not lead_websites:
            print("  No HIGH leads with contacts found.")
            return

        print(f"  Found {len(lead_websites)} HIGH leads with contacts")

        # Get already-emailed addresses so we skip those
        outreach = supabase.table("outreach_log").select("contact_email").execute()
        already_emailed = set(
            o['contact_email'].lower() for o in (outreach.data or []) if o.get('contact_email')
        )

        # Collect unverified or expired contacts from HIGH leads, scored and filtered
        expiry_cutoff = (datetime.now(timezone.utc) - timedelta(days=VERIFICATION_MAX_AGE_DAYS)).isoformat()
        candidates = []
        for website in lead_websites:
            domain = website.lower().replace('https://', '').replace('http://', '').replace('www.', '').rstrip('/')
            # Get contacts that are unverified OR whose verification has expired
            result = supabase.table('contact_database').select('*').or_(
                f"website.eq.{domain},website.eq.www.{domain},email_domain.eq.{domain}"
            ).or_(
                f"elv_status.is.null,elv_verified_at.lt.{expiry_cutoff}"
            ).limit(50).execute()

            for c in (result.data or []):
                email = c.get('email', '')
                if not email or email.lower() in already_emailed:
                    continue
                score = score_contact(c.get('title', ''))
                if score >= min_score:
                    candidates.append({**c, '_score': score})

        # Deduplicate by email (same contact may match multiple leads)
        seen = set()
        unique = []
        for c in candidates:
            if c['email'].lower() not in seen:
                seen.add(c['email'].lower())
                unique.append(c)
        candidates = unique

        # Sort by score descending so we verify the best contacts first
        candidates.sort(key=lambda c: c['_score'], reverse=True)
        to_verify = candidates[:limit]

        print(f"  Candidates found:   {len(candidates)}")
        print(f"  Will verify:        {len(to_verify)}")
        if not to_verify:
            print("  Nothing to verify!")
            return

        # Verify each one
        verified = 0
        safe_count = 0
        bad_count = 0
        error_count = 0

        for i, contact in enumerate(to_verify, 1):
            email = contact['email']
            score = contact['_score']
            name = f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip()

            print(f"\n  [{i}/{len(to_verify)}] {name} ({email}) score={score}")

            result = verify_email(email, save_result=True)
            verified += 1

            if result['status'] in BAD_STATUSES:
                bad_count += 1
            elif result['safe']:
                safe_count += 1
            else:
                error_count += 1

            # Small delay to stay under ELV rate limits
            if i < len(to_verify):
                time.sleep(0.5)

        print(f"\n{'=' * 60}")
        print(f"  BATCH VERIFY COMPLETE")
        print(f"  Verified: {verified}")
        print(f"  Safe:     {safe_count}")
        print(f"  Bad:      {bad_count} (removed)")
        print(f"  Other:    {error_count}")
        print(f"{'=' * 60}\n")

    # ─── FOLLOW-UP EMAILS ─────────────────────────

    def process_followups(self, deadline: datetime = None) -> int:
        """Send follow-up emails for outreach that hasn't gotten replies.

        Follow-up #1: 3 days after initial email.
        Follow-up #2: 5 days after follow-up #1.
        All follow-ups are sent as replies in the original thread.
        """
        print(f"\n{'=' * 60}")
        print("🔄 PROCESSING FOLLOW-UPS")
        print(f"{'=' * 60}\n")

        settings = self._get_settings(refresh=True)
        if not settings.get('agent_enabled', False):
            print("⏸️  Agent is PAUSED.")
            return 0

        now = datetime.now(timezone.utc)
        followup_1_cutoff = (now - timedelta(days=3)).isoformat()
        followup_2_cutoff = (now - timedelta(days=5)).isoformat()

        # ── Find candidates for Follow-up #1 ──
        # Initial emails (followup_number=0) sent ≥ 3 days ago,
        # that don't already have a follow-up #1 row.
        try:
            initial_emails = supabase.table("outreach_log").select("*").eq(
                "followup_number", 0
            ).lte("sent_at", followup_1_cutoff).execute()
        except Exception as e:
            print(f"  ❌ Error querying initial emails: {e}")
            initial_emails = type('obj', (object,), {'data': []})()

        # ── Find candidates for Follow-up #2 ──
        # Follow-up #1 emails sent ≥ 5 days ago,
        # that don't already have a follow-up #2 row.
        try:
            followup1_emails = supabase.table("outreach_log").select("*").eq(
                "followup_number", 1
            ).lte("sent_at", followup_2_cutoff).execute()
        except Exception as e:
            print(f"  ❌ Error querying follow-up #1 emails: {e}")
            followup1_emails = type('obj', (object,), {'data': []})()

        # Build a set of (contact_email, website) that already have follow-ups
        try:
            existing_followups = supabase.table("outreach_log").select(
                "contact_email, website, followup_number"
            ).gt("followup_number", 0).execute()
        except Exception as e:
            print(f"  ❌ Error querying existing follow-ups: {e}")
            existing_followups = type('obj', (object,), {'data': []})()

        has_followup1 = set()
        has_followup2 = set()
        for row in (existing_followups.data or []):
            key = (row['contact_email'].lower(), row['website'].lower())
            if row['followup_number'] == 1:
                has_followup1.add(key)
            elif row['followup_number'] == 2:
                has_followup2.add(key)

        # Merge candidates: (outreach_row, followup_number_to_send)
        candidates = []

        for row in (initial_emails.data or []):
            key = (row['contact_email'].lower(), row['website'].lower())
            if key not in has_followup1:
                candidates.append((row, 1))

        for row in (followup1_emails.data or []):
            key = (row['contact_email'].lower(), row['website'].lower())
            if key not in has_followup2:
                # Need the original email for context — find the initial outreach
                try:
                    original = supabase.table("outreach_log").select("*").eq(
                        "contact_email", row['contact_email']
                    ).eq("website", row['website']).eq(
                        "followup_number", 0
                    ).limit(1).execute()
                    if original.data:
                        candidates.append((original.data[0], 2))
                except Exception:
                    pass

        if not candidates:
            print("✅ No follow-ups due right now.")
            return 0

        print(f"📋 {len(candidates)} follow-up(s) ready to send\n")

        sent = 0
        min_gap = settings.get('min_minutes_between_emails', 2)

        for outreach_row, fu_number in candidates:
            if deadline and datetime.now(timezone.utc) >= deadline:
                print(f"\n⏰ Deadline reached — stopping follow-ups.")
                break

            contact_email = outreach_row['contact_email']
            contact_name = outreach_row.get('contact_name', '')
            website = outreach_row['website']
            original_subject = outreach_row.get('email_subject', '')
            original_body = outreach_row.get('email_body', '')
            gmail_thread_id = outreach_row.get('gmail_thread_id', '')
            rfc_message_id = outreach_row.get('rfc_message_id', '')

            print(f"{'─' * 50}")
            print(f"  📩 Follow-up #{fu_number} → {contact_name} <{contact_email}> ({website})")

            # Check if prospect already replied (via Gmail thread)
            if gmail_thread_id:
                try:
                    has_reply = self.gmail.check_thread_for_replies(
                        gmail_thread_id, GMAIL_FROM_EMAIL
                    )
                    if has_reply:
                        print(f"  💬 Prospect already replied — skipping!")
                        # Mark the lead as replied
                        supabase.table("leads").update({
                            "status": "replied",
                            "updated_at": now.isoformat(),
                        }).eq("website", website).execute()
                        self._log('reply_detected', summary=f"Reply detected from {contact_email}")
                        continue
                except Exception as e:
                    print(f"  ⚠️ Could not check replies: {e}")

            # Load the lead for context
            try:
                lead_result = supabase.table("leads").select("*").eq(
                    "id", outreach_row['lead_id']
                ).single().execute()
                lead = lead_result.data or {}
            except Exception:
                lead = {'website': website}

            # Skip if lead status has moved beyond 'contacted'
            if lead.get('status') in ('replied', 'qualified', 'demo'):
                print(f"  ⏭️  Lead status is '{lead.get('status')}' — skipping follow-up.")
                continue

            # Generate follow-up email
            try:
                followup_data = generate_followup_email(
                    lead, contact_name, fu_number, original_subject, original_body
                )
                print(f"  ✍️  Generated follow-up #{fu_number}")
            except Exception as e:
                print(f"  ❌ Follow-up generation failed: {e}")
                continue

            # Send as threaded reply (or fallback to regular send)
            try:
                if gmail_thread_id and rfc_message_id:
                    result = self.gmail.send_reply(
                        to=contact_email,
                        subject=original_subject,
                        body=followup_data['body'],
                        thread_id=gmail_thread_id,
                        original_message_id=rfc_message_id,
                    )
                else:
                    # Fallback: send as new email with "Re:" prefix
                    re_subject = f"Re: {original_subject}" if not original_subject.lower().startswith('re:') else original_subject
                    result = self.gmail.send_email(
                        to=contact_email,
                        subject=re_subject,
                        body=followup_data['body'],
                    )

                fu_gmail_msg_id = result.get('id', '')
                fu_gmail_thread_id = result.get('threadId', gmail_thread_id)
                print(f"  ✅ Follow-up #{fu_number} SENT! ID: {fu_gmail_msg_id}")
            except Exception as e:
                print(f"  ❌ Send failed: {e}")
                self._log('followup_failed', outreach_row.get('lead_id'),
                          f"Follow-up #{fu_number} failed: {contact_email} - {e}", 'failed')
                continue

            # Retrieve RFC Message-ID for potential future threading
            fu_rfc_message_id = ''
            if fu_gmail_msg_id:
                try:
                    headers = self.gmail.get_message_headers(fu_gmail_msg_id)
                    fu_rfc_message_id = headers.get('Message-ID', headers.get('Message-Id', ''))
                except Exception:
                    pass

            # Log the follow-up in outreach_log
            supabase.table("outreach_log").insert({
                "lead_id": outreach_row.get('lead_id'),
                "website": website,
                "contact_email": contact_email,
                "contact_name": contact_name,
                "email_subject": f"Re: {original_subject}",
                "email_body": followup_data['body'],
                "followup_number": fu_number,
                "gmail_message_id": fu_gmail_msg_id,
                "gmail_thread_id": fu_gmail_thread_id,
                "rfc_message_id": fu_rfc_message_id,
                "parent_outreach_id": outreach_row.get('id'),
            }).execute()

            self._log('followup_sent', outreach_row.get('lead_id'),
                       f"Follow-up #{fu_number} sent to {contact_name} <{contact_email}> at {website}")

            sent += 1

            # Wait between sends
            if sent < len(candidates):
                wait = (min_gap * 60) + random.randint(10, 60)
                if deadline:
                    secs_left = (deadline - datetime.now(timezone.utc)).total_seconds()
                    if secs_left <= wait + 60:
                        print(f"  ⏰ Only {secs_left:.0f}s left — skipping wait.")
                        continue
                print(f"  ⏳ Waiting {wait // 60}m {wait % 60}s...")
                time.sleep(wait)

        print(f"\n🏁 FOLLOW-UPS: {sent} sent out of {len(candidates)} due")
        return sent

    # ─── FULL AUTO (CONTINUOUS LOOP) ───────────────

    def run_autonomous(self):
        run_start = datetime.now(timezone.utc)
        hard_deadline = run_start + timedelta(minutes=GH_ACTIONS_TIMEOUT_MINUTES)

        print(f"\n{'=' * 80}")
        print(f"🤖 AUTONOMOUS MODE — CONTINUOUS LOOP")
        print(f"   Started: {run_start.strftime('%Y-%m-%d %H:%M UTC')}")
        print(f"   Hard deadline: {hard_deadline.strftime('%H:%M UTC')} ({GH_ACTIONS_TIMEOUT_MINUTES} min)")
        print(f"{'=' * 80}\n")

        # Verify Gmail
        try:
            email = self.gmail.verify()
            print(f"✅ Gmail: {email}")
        except Exception as e:
            print(f"❌ Gmail error: {e}")
            self._log('autonomous_run', summary=f"Gmail auth failed: {e}", status='failed')
            return

        # Phase 1: Check bounces once at start
        print("\n📬 Phase 1: Checking bounces...")
        try:
            self.check_bounces()
        except Exception as e:
            print(f"  ⚠️ Bounce check error: {e}")

        # Phase 2: Process follow-ups once at start
        print(f"\n{'=' * 80}")
        print(f"📩 Phase 2: Processing follow-up emails")
        print(f"{'=' * 80}")
        total_followups_this_run = 0
        try:
            followups_sent = self.process_followups(deadline=hard_deadline)
            total_followups_this_run += followups_sent
        except Exception as e:
            print(f"  ⚠️ Follow-up processing error: {e}")

        # Phase 3: Continuous send loop
        print(f"\n{'=' * 80}")
        print(f"📤 Phase 3: Continuous sending loop")
        print(f"{'=' * 80}")

        total_sent_this_run = 0
        loop_count = 0
        # Process follow-ups again every N loops (roughly every ~30 min)
        followup_check_interval = 6

        while datetime.now(timezone.utc) < hard_deadline:
            loop_count += 1

            # Refresh settings each loop (so dashboard changes take effect live)
            settings = self._get_settings(refresh=True)

            # Update heartbeat so dashboard shows agent is alive
            self._update_heartbeat()

            # Check if agent is paused
            if not settings.get('agent_enabled', False):
                print(f"\n⏸️  Agent PAUSED. Sleeping 60s then rechecking...")
                time.sleep(60)
                continue

            # Check send hours
            if not self._is_within_send_hours(settings):
                try:
                    import pytz
                    now_est = datetime.now(pytz.timezone('US/Eastern'))
                except ImportError:
                    now_est = datetime.now(timezone.utc) - timedelta(hours=5)

                print(f"\n⏰ Outside send hours (now: {now_est.strftime('%I:%M %p EST')}). Sleeping 5 min...")
                for _ in range(5):
                    time.sleep(60)
                    self._update_heartbeat()
                continue

            # Check daily limit
            max_per_day = settings.get('max_emails_per_day', 50)
            remaining = self._get_remaining_today(max_per_day)

            if remaining <= 0:
                print(f"\n🛑 Daily limit reached ({max_per_day}/{max_per_day}). Sleeping 30 min then rechecking...")
                # Sleep in intervals with heartbeat — the date might roll over
                for _ in range(30):
                    time.sleep(60)
                    self._update_heartbeat()
                continue

            # Periodically process follow-ups during the send loop
            if loop_count % followup_check_interval == 0:
                print(f"\n📩 Periodic follow-up check (loop #{loop_count})...")
                try:
                    fu_sent = self.process_followups(deadline=hard_deadline)
                    total_followups_this_run += fu_sent
                    total_sent_this_run += fu_sent
                except Exception as e:
                    print(f"  ⚠️ Follow-up error: {e}")

            # Send a small batch (5 at a time to allow frequent settings checks)
            batch_size = min(remaining, 5)
            print(f"\n🔄 Loop #{loop_count} — Budget: {remaining}/{max_per_day}, sending up to {batch_size}")

            sent = self.send_batch(count=batch_size, deadline=hard_deadline)
            total_sent_this_run += sent

            if sent == 0:
                # No leads to send — sleep in short intervals with heartbeat
                print(f"  📭 Nothing to send. Sleeping 5 min...")
                for _ in range(5):
                    time.sleep(60)
                    self._update_heartbeat()

        # Final summary
        print(f"\n{'=' * 80}")
        print(f"🏁 AUTONOMOUS RUN COMPLETE")
        print(f"   Total initial emails sent: {total_sent_this_run - total_followups_this_run}")
        print(f"   Total follow-ups sent:     {total_followups_this_run}")
        print(f"   Total emails this run:     {total_sent_this_run}")
        print(f"   Loops: {loop_count}")
        print(f"   Runtime: {(datetime.now(timezone.utc) - run_start).total_seconds() / 60:.0f} min")
        print(f"{'=' * 80}\n")

        self.show_status()
        self._log('autonomous_run',
                   summary=f"Auto complete: {total_sent_this_run} sent ({total_followups_this_run} follow-ups) in {loop_count} loops")


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
        print("  python ai_sdr_agent.py process-followups  # Send due follow-up emails")
        print("  python ai_sdr_agent.py check-bounces     # Check bounced emails")
        print("  python ai_sdr_agent.py batch-verify 500  # Pre-verify N emails for HIGH leads")
        print("  python ai_sdr_agent.py verify-gmail      # Test Gmail")
        print("  python ai_sdr_agent.py status             # Pipeline stats")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "auto":
        agent.run_autonomous()
    elif cmd == "send-batch":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        agent.send_batch(n)
    elif cmd == "process-followups":
        agent.process_followups()
    elif cmd == "check-bounces":
        agent.check_bounces()
    elif cmd == "batch-verify":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 500
        min_score = int(sys.argv[3]) if len(sys.argv) > 3 else 60
        agent.batch_verify(limit=n, min_score=min_score)
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
