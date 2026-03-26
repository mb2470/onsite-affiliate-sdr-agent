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
APOLLO_API_KEY = os.getenv("APOLLO_API_KEY")
GMAIL_CREDENTIALS = os.getenv("GMAIL_OAUTH_CREDENTIALS")
GMAIL_FROM_EMAIL = os.getenv("GMAIL_FROM_EMAIL")
ELV_API_KEY = os.getenv("EMAILLISTVERIFY_API_KEY")
ORG_ID = os.getenv("ORG_ID")

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
# APOLLO EMAIL VERIFICATION (People Match API)
# ═══════════════════════════════════════════════════════════

# Apollo statuses
APOLLO_SAFE_STATUSES = ['verified']
APOLLO_NEEDS_SECONDARY = ['extrapolated', 'unavailable']
APOLLO_BAD_STATUSES = ['invalid']
APOLLO_CATCHALL_STATUSES = ['catch_all', 'accept_all']


def _classify_apollo_status(status: str) -> str:
    """Classify an Apollo email_status into a waterfall action."""
    if status in APOLLO_SAFE_STATUSES:
        return 'send'
    if status in APOLLO_NEEDS_SECONDARY:
        return 'verify_secondary'
    if status in APOLLO_CATCHALL_STATUSES:
        return 'catchall'
    if status in APOLLO_BAD_STATUSES:
        return 'discard'
    return 'verify_secondary'


def _get_cached_apollo_verification(email: str) -> Optional[Dict]:
    """Check the contacts table for a valid (non-expired) Apollo verification."""
    try:
        result = supabase.table('contacts').select(
            'apollo_email_status, apollo_verified_at'
        ).eq('email', email).not_.is_('apollo_email_status', 'null').not_.is_(
            'apollo_verified_at', 'null'
        ).limit(1).execute()

        if not result.data:
            return None

        row = result.data[0]
        verified_at = datetime.fromisoformat(row['apollo_verified_at'].replace('Z', '+00:00'))
        age = datetime.now(timezone.utc) - verified_at

        if age.days > VERIFICATION_MAX_AGE_DAYS:
            print(f"    🔶 Cached Apollo verification for {email} expired ({age.days}d old)")
            return None

        status = row['apollo_email_status']
        action = _classify_apollo_status(status)
        print(f"    🔶 Using cached Apollo verification for {email}: {status} ({age.days}d old)")
        return {
            'email': email,
            'apollo_status': status,
            'action': action,
            'cached': True,
            'verified_at': row['apollo_verified_at'],
        }
    except Exception as e:
        print(f"    ⚠️ Apollo cache lookup error for {email}: {e}")
        return None


def _save_apollo_verification(email: str, status: str):
    """Cache Apollo verification result on both contacts and contact_database."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        supabase.table('contacts').update({
            'apollo_email_status': status,
            'apollo_verified_at': now,
        }).eq('email', email).execute()
    except Exception:
        pass
    try:
        supabase.table('contact_database').update({
            'apollo_email_status': status,
            'apollo_verified_at': now,
        }).eq('email', email).execute()
    except Exception:
        pass


def verify_via_apollo(email: str, first_name: str = None, last_name: str = None,
                      domain: str = None) -> Dict:
    """Verify an email via Apollo People Match API.

    Returns a dict with apollo_status and action:
      - send:             Apollo verified, safe to send immediately
      - verify_secondary: Needs ELV secondary check (extrapolated/unknown)
      - catchall:         Catch-all domain, route to ELV
      - discard:          Invalid email, do not send
    """
    # 1. Check cache first
    cached = _get_cached_apollo_verification(email)
    if cached:
        return cached

    # 2. No valid cache — call Apollo
    if not APOLLO_API_KEY:
        print(f"    ⚠️ No APOLLO_API_KEY set, skipping Apollo verification for {email}")
        return {'email': email, 'apollo_status': 'skipped', 'action': 'verify_secondary', 'cached': False}

    try:
        payload = {'email': email}
        if first_name:
            payload['first_name'] = first_name
        if last_name:
            payload['last_name'] = last_name
        if domain:
            payload['domain'] = domain

        req_data = json.dumps(payload).encode()
        req = urllib.request.Request(
            'https://api.apollo.io/v1/people/match',
            data=req_data,
            method='POST',
        )
        req.add_header('Content-Type', 'application/json')
        req.add_header('x-api-key', APOLLO_API_KEY)

        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())

        person = data.get('person') or {}
        email_status = (person.get('email_status') or 'unavailable').lower()
        verification_status = (person.get('verification_status') or '').lower()

        # Use the most specific status available
        effective_status = verification_status or email_status

        print(f"    🔶 Apollo verify {email}: email_status={email_status}, "
              f"verification_status={verification_status}, effective={effective_status}")

        action = _classify_apollo_status(effective_status)

        # Cache the result
        _save_apollo_verification(email, effective_status)

        return {
            'email': email,
            'apollo_status': effective_status,
            'action': action,
            'cached': False,
            'verified_at': datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        print(f"    ⚠️ Apollo verify error for {email}: {e}")
        return {'email': email, 'apollo_status': 'error', 'action': 'verify_secondary', 'cached': False}


# ═══════════════════════════════════════════════════════════
# GMAIL SERVICE (raw HTTP, no googleapis dependency)
# ═══════════════════════════════════════════════════════════

class GmailService:
    def __init__(self):
        self._access_token = None
        self._send_as_aliases = None
        self._resolved_from_email = None
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

    def _get_send_as_aliases(self) -> List[Dict]:
        if self._send_as_aliases is not None:
            return self._send_as_aliases

        try:
            data = self._gmail_request('GET', 'settings/sendAs')
            aliases = data.get('sendAs', []) if isinstance(data, dict) else []
            self._send_as_aliases = aliases
            return aliases
        except Exception as e:
            print(f"    ⚠️ Could not fetch Gmail sendAs aliases: {e}")
            self._send_as_aliases = []
            return []

    def get_from_email(self) -> str:
        if self._resolved_from_email:
            return self._resolved_from_email

        configured = (GMAIL_FROM_EMAIL or '').strip().lower()
        aliases = self._get_send_as_aliases()
        accepted = [
            (a.get('sendAsEmail') or '').strip().lower()
            for a in aliases
            if a.get('verificationStatus') == 'accepted' and a.get('sendAsEmail')
        ]

        if configured and configured in accepted:
            self._resolved_from_email = configured
            return configured

        primary = next(
            ((a.get('sendAsEmail') or '').strip().lower()
             for a in aliases
             if a.get('isPrimary') and a.get('verificationStatus') == 'accepted' and a.get('sendAsEmail')),
            None,
        )
        fallback = primary or (accepted[0] if accepted else configured or GMAIL_FROM_EMAIL)

        if configured and fallback != configured:
            print(
                f"    ⚠️ Configured GMAIL_FROM_EMAIL ({configured}) is not an accepted Gmail sendAs alias; using {fallback}"
            )

        self._resolved_from_email = fallback
        return fallback
    def get_accepted_aliases(self) -> set:
        aliases = self._get_send_as_aliases()
        return {
            (a.get('sendAsEmail') or '').strip().lower()
            for a in aliases
            if a.get('verificationStatus') == 'accepted' and a.get('sendAsEmail')
        }


    def send_email(self, to: str, subject: str, body: str, bcc: List[str] = None, from_email: str = None, from_name: str = 'Sam Reid') -> Dict:
        lines = [
            f"From: {from_name} <{from_email or self.get_from_email()}>",
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
                   original_message_id: str, from_email: str = None, from_name: str = 'Sam Reid') -> Dict:
        """Send a reply that threads under the original email."""
        reply_subject = subject if subject.lower().startswith('re:') else f"Re: {subject}"

        lines = [
            f"From: {from_name} <{from_email or self.get_from_email()}>",
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

    @staticmethod
    def _extract_email_address(header_value: str) -> str:
        """Extract a plain email address from a From header value."""
        if not header_value:
            return ''
        match = re.search(r'<([^>]+)>', header_value)
        if match:
            return match.group(1).strip().lower()
        return header_value.strip().lower()

    @staticmethod
    def _canonicalize_email(email: str) -> str:
        """Canonicalize addresses so plus-aliases don't look like different senders."""
        if not email or '@' not in email:
            return (email or '').strip().lower()
        local, domain = email.strip().lower().split('@', 1)
        local = local.split('+', 1)[0]
        return f"{local}@{domain}"

    def check_thread_for_replies(self, thread_id: str, our_email: str) -> bool:
        """Check if a thread has any replies from someone other than us."""
        try:
            thread = self._gmail_request('GET', f"threads/{thread_id}?format=metadata"
                                         "&metadataHeaders=From")
            messages = thread.get('messages', [])
            accepted_aliases = self.get_accepted_aliases()
            all_our_addresses = {
                self._canonicalize_email(our_email or ''),
                self._canonicalize_email(self.get_from_email() or ''),
                self._canonicalize_email(GMAIL_FROM_EMAIL or ''),
            }
            all_our_addresses.update(
                self._canonicalize_email(addr)
                for addr in accepted_aliases
                if addr
            )
            all_our_addresses.discard('')

            for msg in messages:
                label_ids = set(msg.get('labelIds', []))

                # Ignore our own sent messages even when their "From" alias differs.
                if {'SENT', 'DRAFT'}.intersection(label_ids):
                    continue

                for h in msg.get('payload', {}).get('headers', []):
                    if h['name'].lower() == 'from':
                        sender = self._canonicalize_email(
                            self._extract_email_address(h.get('value', ''))
                        )
                        if sender and sender not in all_our_addresses:
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


def generate_email_prospect(prospect: Dict, contact_name: str) -> Dict:
    """Generate email using richer prospect firmographic data for personalization."""
    first_name = contact_name.split(' ')[0] if contact_name else 'there'

    # Build rich context from prospect data
    context_parts = []
    if prospect.get('industry_primary'):
        context_parts.append(f"Industry: {prospect['industry_primary']}")
    if prospect.get('industry_sub'):
        context_parts.append(f"Sub-industry: {prospect['industry_sub']}")
    if prospect.get('business_model'):
        context_parts.append(f"Business model: {prospect['business_model']}")
    if prospect.get('target_market'):
        context_parts.append(f"Target market: {prospect['target_market']}")
    if prospect.get('employee_range'):
        context_parts.append(f"Company size: {prospect['employee_range']} employees")
    if prospect.get('technographics'):
        techs = prospect['technographics']
        if isinstance(techs, list):
            context_parts.append(f"Tech stack: {', '.join(techs[:5])}")
    if prospect.get('keywords'):
        kws = prospect['keywords']
        if isinstance(kws, list):
            context_parts.append(f"Keywords: {', '.join(kws[:5])}")

    context_block = '\n'.join(context_parts) if context_parts else ''

    prompt = f"""Write a casual outreach email for {prospect['website']}.
The contact's first name is "{first_name}" — ALWAYS address them as "Hey {first_name} -"

Company: {prospect.get('company_name', prospect['website'])}
{context_block}

Requirements:
- Under 90 words total
- Start with "Hey {first_name} -"
- Personalize based on their industry and business model above
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
    subject = subject_match.group(1).strip() if subject_match else f"Creator UGC for {prospect['website']}"

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

    def _log(self, activity_type, lead_id=None, summary="", status="success", prospect_id=None):
        try:
            row = {"activity_type": activity_type, "summary": summary, "status": status}
            if lead_id:
                row["lead_id"] = lead_id
            if prospect_id:
                row["prospect_id"] = prospect_id
            org_id = self._resolve_org_id()
            if org_id:
                row["org_id"] = org_id
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
        """Return remaining global daily capacity from outreach_log (single source of truth)."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        query = supabase.table("outreach_log").select(
            "id", count="exact", head=True
        ).gte("sent_at", f"{today}T00:00:00Z")
        org_id = self._resolve_org_id()
        if org_id:
            query = query.eq("org_id", org_id)
        today_count = query.execute()

        sent_today = today_count.count or 0
        return max_per_day - sent_today

    def _resolve_org_id(self, settings: Optional[Dict] = None) -> Optional[str]:
        cfg = settings or self._get_settings()
        return cfg.get('org_id') or ORG_ID

    def _get_sender_sent_today(self, org_id: Optional[str]) -> Dict[str, int]:
        """Get per-sender sent counts for today from outreach_log (single source of truth)."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        query = supabase.table('outreach_log').select(
            'sender_email'
        ).not_.is_('sender_email', 'null').gte('sent_at', f'{today}T00:00:00Z')
        if org_id:
            query = query.eq('org_id', org_id)

        try:
            rows = query.execute().data or []
        except Exception as e:
            print(f"  ⚠️ Could not query outreach_log for sender counts: {e}")
            return {}

        counts: Dict[str, int] = {}
        for row in rows:
            addr = (row.get('sender_email') or '').strip().lower()
            if addr:
                counts[addr] = counts.get(addr, 0) + 1
        return counts

    def _load_sender_pool(self, settings: Dict) -> List[Dict]:
        accepted_aliases = self.gmail.get_accepted_aliases()
        max_per_day = int(settings.get('max_emails_per_day', 50) or 50)

        org_id = self._resolve_org_id(settings)
        if not org_id:
            print("  ⚠️ No org_id configured in agent_settings or ORG_ID env; skipping email_accounts sender pool lookup.")
            rows = []
        else:
            query = supabase.table('email_accounts').select(
                'id, org_id, email_address, display_name, daily_send_limit, status'
            ).eq('org_id', org_id).in_('status', ['active', 'ready', 'warming']).order('created_at', desc=False)

            try:
                rows = query.execute().data or []
            except Exception as e:
                print(f"  ⚠️ Could not load email_accounts sender pool: {e}")
                rows = []

        # Derive per-sender sent-today from outreach_log (single source of truth)
        sender_sent_today = self._get_sender_sent_today(org_id)

        pool = []
        for row in rows:
            email = (row.get('email_address') or '').strip().lower()
            if not email:
                continue
            if accepted_aliases and email not in accepted_aliases:
                continue

            raw_limit = row.get('daily_send_limit')
            try:
                limit = int(raw_limit)
            except Exception:
                limit = 0

            sent_today = sender_sent_today.get(email, 0)
            remaining = max(0, limit - sent_today)
            if remaining <= 0:
                continue

            pool.append({
                'id': row.get('id'),
                'email_address': email,
                'from_name': row.get('display_name') or 'Sam Reid',
                'daily_send_limit': limit,
                'current_daily_sent': sent_today,
                'remaining': remaining,
                'sent_in_run': 0,
            })

        if pool:
            return pool

        if rows:
            print("  ⚠️ Sender accounts found, but none currently have accepted aliases and remaining daily capacity.")
            return []

        fallback_email = self.gmail.get_from_email()
        fallback_sent = sender_sent_today.get(fallback_email, 0)
        return [{
            'id': None,
            'email_address': fallback_email,
            'from_name': 'Sam Reid',
            'daily_send_limit': max_per_day,
            'current_daily_sent': fallback_sent,
            'remaining': max(0, max_per_day - fallback_sent),
            'sent_in_run': 0,
        }]

    @staticmethod
    def _pick_sender(sender_pool: List[Dict]) -> Optional[Dict]:
        available = [s for s in sender_pool if s.get('remaining', 0) > 0]
        if not available:
            return None
        available.sort(key=lambda s: (s.get('sent_in_run', 0), -s.get('remaining', 0)))
        return available[0]

    def _record_sender_success(self, sender: Dict):
        """Update in-memory sender pool counters after a successful send.

        Per-sender daily counts are derived from outreach_log (the single
        source of truth), so there is no need to update email_accounts here.
        We only update the in-memory pool for within-run round-robin fairness.
        """
        if not sender:
            return

        sender['remaining'] = max(0, int(sender.get('remaining', 0)) - 1)
        sender['sent_in_run'] = int(sender.get('sent_in_run', 0)) + 1
        sender['current_daily_sent'] = int(sender.get('current_daily_sent', 0)) + 1

    def _get_sender_capacity_remaining(self, settings: Dict) -> int:
        pool = self._load_sender_pool(settings)
        return sum(int(s.get('remaining', 0)) for s in pool)


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

        # Show prospect stats if use_prospect_db is enabled
        settings = self._get_settings()
        if settings.get('use_prospect_db', False):
            self._show_prospect_stats()

    # ─── SEND ONE EMAIL ────────────────────────────

    def _send_one(self, lead, all_emailed, today_by_website, settings, sender: Dict, bounced_set: set = None) -> str:
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

        # Score and filter already emailed + bounced
        scored = sorted(contacts, key=lambda c: score_contact(c.get('title', '')), reverse=True)
        _bounced = bounced_set or set()
        available = [c for c in scored if c.get('email')
                     and c['email'].lower() not in all_emailed
                     and c['email'].lower() not in _bounced]

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

        # ── Step 1: Apollo email verification ──────────────────
        email_domain = contact['email'].split('@')[1] if '@' in contact['email'] else ''
        apollo_result = verify_via_apollo(
            contact['email'],
            first_name=contact_raw.get('first_name'),
            last_name=contact_raw.get('last_name'),
            domain=email_domain,
        )

        if apollo_result['action'] == 'discard':
            print(f"  🚫 Apollo blocked: {apollo_result['apollo_status']}")
            # Remove invalid email from contact_database
            try:
                supabase.table('contact_database').delete().eq('email', contact['email']).execute()
            except Exception:
                pass
            all_emailed.add(contact['email'].lower())
            self._log('email_verified', lead['id'],
                       f"Apollo BLOCKED {contact['email']}: {apollo_result['apollo_status']}")
            return 'failed'

        # ── Step 2: ELV final verification (ALWAYS required before send) ──
        if apollo_result['action'] == 'send':
            print(f"  ✅ Apollo verified — running final ELV check")
        else:
            print(f"  🔶 Apollo: {apollo_result['apollo_status']} — running ELV verification")

        verification = verify_email(contact['email'])
        if not verification['safe']:
            print(f"  🚫 ELV final verification failed: {verification['status']}")
            all_emailed.add(contact['email'].lower())
            self._log('email_verified', lead['id'],
                       f"ELV BLOCKED {contact['email']}: Apollo={apollo_result['apollo_status']}, ELV={verification['status']}")
            return 'failed'
        print(f"  ✅ ELV verified: {verification['status']}")

        self._log('email_verified', lead['id'],
                   f"Verified {contact['email']}: Apollo={apollo_result['apollo_status']}, ELV={verification['status']}")

        # Generate email
        try:
            email_data = generate_email(lead, contact['name'])
            print(f"  ✍️  Subject: {email_data['subject']}")
        except Exception as e:
            print(f"  ❌ Email gen failed: {e}")
            return 'failed'

        # Pre-send dedup: verify outreach_log one more time right before sending.
        # Catches edge cases where a previous run sent the email but the
        # in-memory all_emailed set was lost (process crash, restart, etc.).
        try:
            dedup_check = supabase.table('outreach_log').select(
                'id', count='exact', head=True
            ).eq('contact_email', contact['email']).eq('lead_id', lead['id']).execute()
            if dedup_check.count and dedup_check.count > 0:
                print(f"  ⏭️  Dedup: {contact['email']} already has outreach for this lead — skipping")
                all_emailed.add(contact['email'].lower())
                return 'skipped'
        except Exception as e:
            print(f"  ⚠️ Dedup check failed (proceeding with send): {e}")

        # Send
        try:
            result = self.gmail.send_email(
                to=contact['email'],
                subject=email_data['subject'],
                body=email_data['body'],
                from_email=sender.get('email_address'),
                from_name=sender.get('from_name', 'Sam Reid'),
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

        # Log outreach — sender_email is written so outreach_log is the single
        # source of truth for per-sender daily capacity.
        # CRITICAL: If this insert fails, the email WAS already sent by Gmail.
        # Retry to avoid a "ghost send" with no record (which could cause double-sends).
        org_id = self._resolve_org_id()
        outreach_row_data = {
            "lead_id": lead['id'],
            "website": lead['website'],
            "contact_email": contact['email'],
            "contact_name": contact['name'],
            "email_subject": email_data['subject'],
            "email_body": email_data['body'],
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "followup_number": 0,
            "gmail_message_id": gmail_msg_id,
            "gmail_thread_id": gmail_thread_id,
            "rfc_message_id": rfc_message_id,
            "sender_email": sender.get('email_address', ''),
        }
        if org_id:
            outreach_row_data["org_id"] = org_id

        for attempt in range(3):
            try:
                supabase.table("outreach_log").insert(outreach_row_data).execute()
                break
            except Exception as e:
                if attempt < 2:
                    print(f"  ⚠️ outreach_log insert failed (attempt {attempt + 1}/3), retrying: {e}")
                    time.sleep(1)
                else:
                    print(f"  ❌ CRITICAL: outreach_log insert failed after 3 attempts for gmail_message_id={gmail_msg_id}. "
                          f"Email WAS sent but has no DB record. Manual reconciliation needed.")
                    self._log('outreach_log_write_failed', lead['id'],
                              f"CRITICAL: Sent email {gmail_msg_id} to {contact['email']} but DB write failed: {e}",
                              'failed')

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
                   f"Sent from {sender.get('email_address')} to {contact['name']} <{contact['email']}> at {lead['website']}")

        return 'sent'

    # ─── SEND BATCH ────────────────────────────────

    def send_batch(self, count: int = 10, deadline: datetime = None, sender_pool: list = None):
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

        # Load bounce suppression list as a fallback safety net
        bounced_set = self._load_bounce_suppression()

        print(f"📋 {len(all_leads)} candidate leads ({n_enriched} enriched, {n_contacted} contacted), {len(all_emailed)} contacts already emailed\n")

        sent = 0
        failed = 0
        skipped = 0
        min_gap = settings.get('min_minutes_between_emails', 2)

        if sender_pool is None:
            sender_pool = self._load_sender_pool(settings)
        total_sender_remaining = sum(int(s.get('remaining', 0)) for s in sender_pool)
        print(f"📮 Sender pool: {len(sender_pool)} inbox(es), {total_sender_remaining} remaining sends today")

        for lead in all_leads:
            if sent >= count:
                break

            if deadline and datetime.now(timezone.utc) >= deadline:
                print(f"\n⏰ Deadline reached — stopping batch.")
                break

            print(f"\n{'─' * 50}")
            print(f"[{sent + 1}/{count}] {lead['website']}")

            sender = self._pick_sender(sender_pool)
            if not sender:
                print("  🛑 No sender accounts with remaining daily capacity.")
                break

            print(f"  ✉️ Using sender: {sender.get('email_address')} ({sender.get('remaining')} left)")
            result = self._send_one(lead, all_emailed, today_by_website, settings, sender, bounced_set)

            if result == 'sent':
                sent += 1
                self._record_sender_success(sender)
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

    # ─── BOUNCE SUPPRESSION ─────────────────────────

    def _load_bounce_suppression(self) -> set:
        """Load set of bounced email addresses from activity_log.bounced_email column."""
        try:
            org_id = self._resolve_org_id()
            query = supabase.table('activity_log').select('bounced_email').eq(
                'activity_type', 'email_bounced'
            ).not_.is_('bounced_email', 'null')
            if org_id:
                query = query.eq('org_id', org_id)
            rows = query.execute().data or []
            suppressed = set(r['bounced_email'].lower() for r in rows if r.get('bounced_email'))
            if suppressed:
                print(f"🚫 Loaded {len(suppressed)} bounced email(s) for suppression")
            return suppressed
        except Exception as e:
            print(f"  ⚠️ Could not load bounce suppression list: {e}")
            return set()

    # ─── CHECK BOUNCES ─────────────────────────────

    def check_bounces(self):
        print(f"\n{'=' * 60}")
        print("🔄 CHECKING BOUNCES")
        print(f"{'=' * 60}\n")

        bounced = self.gmail.check_bounces(days=7)

        if not bounced:
            print("✅ No bounces found!")
            return

        # Dedup: skip emails already processed (matches JS check-bounces.js behavior)
        already_processed = self._load_bounce_suppression()
        new_bounces = [e for e in bounced if e.lower() not in already_processed]
        if not new_bounces:
            print(f"✅ {len(bounced)} bounce(s) found but all already processed.")
            return

        print(f"🚫 Found {len(new_bounces)} new bounced (skipped {len(bounced) - len(new_bounces)} already processed): {', '.join(new_bounces)}\n")

        org_id = self._resolve_org_id()
        cleaned = 0
        for email in new_bounces:
            # Remove from contact_database to prevent re-discovery
            q = supabase.table("contact_database").delete().eq("email", email)
            if org_id:
                q = q.eq("org_id", org_id)
            deleted = q.execute()
            if deleted.data:
                print(f"  🗑️ Removed {email}")
                cleaned += 1

            # Reset leads to 'enriched' if this was their only contact
            outreach = supabase.table("outreach_log").select("website").eq("contact_email", email).execute()
            for o in (outreach.data or []):
                other = supabase.table("outreach_log").select(
                    "id", count="exact", head=True
                ).eq("website", o['website']).neq("contact_email", email).execute()

                if not other.count or other.count == 0:
                    supabase.table("leads").update({"status": "enriched"}).eq("website", o['website']).execute()
                    print(f"  ↩️ Reset {o['website']} to enriched")

            # Mark outreach_log rows for this email as bounced
            try:
                supabase.table('outreach_log').update({
                    'bounced': True,
                    'bounced_at': datetime.now(timezone.utc).isoformat(),
                }).eq('contact_email', email).execute()
            except Exception as e:
                print(f"  ⚠️ Could not mark outreach_log bounced for {email}: {e}")

            # Log bounce with dedicated bounced_email column for suppression lookup
            try:
                row = {
                    "activity_type": "email_bounced",
                    "summary": f"Bounced: {email} — removed from contacts",
                    "status": "failed",
                    "bounced_email": email,
                }
                if org_id:
                    row["org_id"] = org_id
                supabase.table("activity_log").insert(row).execute()
            except Exception as e:
                print(f"  ⚠️ Log error: {e}")

        print(f"\n✅ Cleaned {cleaned} contacts")

    # ─── CHECK REPLIES ──────────────────────────

    def check_replies(self, lookback_days: int = 60) -> int:
        """Scan sent email threads for real replies and record them.

        Only checks threads sent within the last `lookback_days` days (default 60)
        that have not yet been marked as replied. Deduplicates by gmail_thread_id
        so each thread triggers at most one Gmail API call.

        Updates outreach_log.replied_at, leads.status='replied', and logs
        activity_type='email_reply' for any thread where the prospect replied.
        """
        print(f"\n{'=' * 60}")
        print("💬 CHECKING REPLIES")
        print(f"{'=' * 60}\n")

        cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

        # Only check threads not yet marked as replied, within the lookback window
        results = supabase.table('outreach_log').select(
            'id, lead_id, contact_email, contact_name, website, gmail_thread_id, replied_at'
        ).is_('replied_at', 'null').not_.is_('gmail_thread_id', 'null').neq(
            'gmail_thread_id', ''
        ).gte('sent_at', cutoff).order('sent_at', desc=True).execute()

        rows = results.data or []
        if not rows:
            print("  📭 No unreplied threads to check.")
            return 0

        print(f"  Checking {len(rows)} threads...")
        our_email = self.gmail.get_from_email()
        new_replies = 0
        now_iso = datetime.now(timezone.utc).isoformat()

        # Deduplicate by thread_id — one DB write per unique thread
        seen_threads: set = set()
        for row in rows:
            thread_id = row.get('gmail_thread_id', '')
            if not thread_id or thread_id in seen_threads:
                continue
            seen_threads.add(thread_id)

            try:
                has_reply = self.gmail.check_thread_for_replies(thread_id, our_email)
            except Exception as e:
                print(f"  ⚠️ Thread check error ({row.get('contact_email')}): {e}")
                continue

            if not has_reply:
                continue

            contact_email = row.get('contact_email', '')
            website = row.get('website', '')
            lead_id = row.get('lead_id')
            print(f"  💬 Reply detected: {contact_email} ({website})")
            new_replies += 1

            # Update all outreach rows for this thread
            try:
                supabase.table('outreach_log').update({
                    'replied_at': now_iso,
                }).eq('gmail_thread_id', thread_id).is_('replied_at', 'null').execute()
            except Exception as e:
                print(f"  ⚠️ Could not update outreach_log replied_at: {e}")

            # Mark lead as replied
            try:
                update_q = supabase.table('leads').update({
                    'status': 'replied',
                    'updated_at': now_iso,
                })
                if lead_id:
                    update_q = update_q.eq('id', lead_id)
                else:
                    update_q = update_q.eq('website', website)
                update_q.execute()
            except Exception as e:
                print(f"  ⚠️ Could not update lead status: {e}")

            self._log('email_reply', lead_id,
                      f"Reply from {contact_email} at {website}")

        print(f"\n  ✅ Found {new_replies} new {'reply' if new_replies == 1 else 'replies'}")
        return new_replies

    # ─── PROSPECT-BASED METHODS ─────────────────────

    def discover_prospect_contacts(self, prospect_id: str) -> int:
        """Discover contacts for a prospect: check contact_database, then Apollo.

        Mirrors the Netlify prospect-discover-contacts.js flow:
        1. Check contact_database by matching website/email_domain
        2. If none found, call Apollo mixed_people search + bulk_match
        3. Insert discovered contacts into prospect_contacts

        Returns number of contacts inserted.
        """
        org_id = self._resolve_org_id()

        # Fetch the prospect
        result = supabase.table('prospects').select('id, website, company_name').eq(
            'id', prospect_id).eq('org_id', org_id).single().execute()
        prospect = result.data
        if not prospect:
            print(f"  ⚠️ Prospect {prospect_id} not found")
            return 0

        website = prospect['website']
        domain = website.lower().replace('https://', '').replace('http://', '').replace('www.', '').rstrip('/')
        print(f"  🔍 Discovering contacts for {domain} (prospect {prospect_id})")

        # Check if prospect already has contacts
        existing = supabase.table('prospect_contacts').select(
            '*', count='exact'
        ).eq('prospect_id', prospect_id).eq('org_id', org_id).execute()
        if existing.count and existing.count > 0:
            print(f"  ⏭️ Already has {existing.count} contacts, skipping")
            return existing.count

        contacts = []

        # Step 1: Check contact_database
        db_result = supabase.table('contact_database').select('*').or_(
            f"website.eq.{domain},website.eq.www.{domain},email_domain.eq.{domain}"
        ).eq('org_id', org_id).limit(50).execute()

        if db_result.data:
            print(f"  📋 Found {len(db_result.data)} contacts in contact_database")
            for c in db_result.data:
                contacts.append({
                    'first_name': c.get('first_name', ''),
                    'last_name': c.get('last_name', ''),
                    'email': c['email'],
                    'title': c.get('title', ''),
                    'linkedin_url': c.get('linkedin_url', ''),
                    'apollo_email_status': c.get('apollo_email_status'),
                    'source': 'contact_database',
                })

        # Step 2: If no contacts in DB, try Apollo
        if not contacts and APOLLO_API_KEY:
            print(f"  📡 No contacts in database, trying Apollo...")
            try:
                titles = [
                    'VP Marketing', 'Head of Marketing', 'Director of Marketing',
                    'VP Ecommerce', 'Head of Ecommerce', 'Director of Ecommerce',
                    'VP Digital', 'Head of Digital', 'Head of Growth',
                    'CMO', 'Chief Marketing Officer',
                    'VP Brand', 'Director of Brand', 'Head of Brand',
                    'Director of Partnerships', 'Head of Partnerships',
                    'Director of Content', 'Head of Content',
                    'CEO', 'Founder', 'Co-Founder', 'President',
                ]
                search_payload = json.dumps({
                    'q_organization_domains_list': [domain],
                    'person_titles': titles,
                    'per_page': 25,
                })
                req = urllib.request.Request(
                    'https://api.apollo.io/api/v1/mixed_people/api_search',
                    data=search_payload.encode(),
                    method='POST',
                )
                req.add_header('Content-Type', 'application/json')
                req.add_header('x-api-key', APOLLO_API_KEY)

                with urllib.request.urlopen(req, timeout=20) as resp:
                    search_data = json.loads(resp.read().decode())

                people = [p for p in (search_data.get('people') or []) if p.get('has_email')]

                if people:
                    # Enrich top 3 to get actual emails
                    top3 = people[:3]
                    enrich_payload = json.dumps({'details': [{'id': p['id']} for p in top3]})
                    req2 = urllib.request.Request(
                        'https://api.apollo.io/api/v1/people/bulk_match',
                        data=enrich_payload.encode(),
                        method='POST',
                    )
                    req2.add_header('Content-Type', 'application/json')
                    req2.add_header('x-api-key', APOLLO_API_KEY)

                    with urllib.request.urlopen(req2, timeout=20) as resp2:
                        enrich_data = json.loads(resp2.read().decode())

                    for m in (enrich_data.get('matches') or []):
                        if not m.get('email'):
                            continue
                        email_status = (m.get('email_status') or 'unavailable').lower()
                        # Skip invalid emails
                        if email_status == 'invalid':
                            print(f"  🗑️ Discarding invalid: {m['email']} ({email_status})")
                            continue
                        contacts.append({
                            'first_name': m.get('first_name', ''),
                            'last_name': m.get('last_name', ''),
                            'email': m['email'].lower(),
                            'title': m.get('title', ''),
                            'linkedin_url': m.get('linkedin_url', ''),
                            'apollo_email_status': email_status,
                            'source': 'apollo',
                        })
                    print(f"  ✅ Apollo found {len(contacts)} usable contacts")
                else:
                    print(f"  ⚠️ Apollo found no people with email for {domain}")
            except Exception as e:
                print(f"  ⚠️ Apollo discovery error for {domain}: {e}")

        if not contacts:
            print(f"  ⚠️ No contacts found for {domain}")
            return 0

        # Step 3: Insert into prospect_contacts
        inserted = 0
        now_iso = datetime.now(timezone.utc).isoformat()
        for c in contacts:
            full_name = ' '.join(filter(None, [c['first_name'], c['last_name']])) or 'Unknown'
            score_info = self._score_prospect_contact_title(c.get('title', ''))

            try:
                supabase.table('prospect_contacts').upsert({
                    'org_id': org_id,
                    'prospect_id': prospect_id,
                    'first_name': c['first_name'],
                    'last_name': c['last_name'],
                    'full_name': full_name,
                    'email': c['email'],
                    'title': c.get('title', ''),
                    'company_name': prospect.get('company_name') or domain,
                    'company_website': domain,
                    'match_score': score_info['match_score'],
                    'match_level': score_info['match_level'],
                    'match_reason': score_info['match_reason'],
                    'linkedin_url': c.get('linkedin_url') or None,
                    'apollo_email_status': c.get('apollo_email_status'),
                    'apollo_verified_at': now_iso if c.get('apollo_email_status') else None,
                    'source': c.get('source', 'apollo'),
                }, on_conflict='prospect_id,email').execute()
                inserted += 1
            except Exception as e:
                print(f"  ⚠️ Insert error for {c['email']}: {e}")

        print(f"  ✅ Inserted {inserted} contacts for {domain}")
        self._log('prospect_contact_discovery', prospect_id=prospect_id,
                  summary=f"Discovered {inserted} contacts for {domain}")
        return inserted

    @staticmethod
    def _score_prospect_contact_title(title: str) -> Dict:
        """Score a contact title for prospect_contacts. Mirrors contactService.js scoring."""
        t = (title or '').lower()
        import re
        if re.search(r'\b(cmo|chief marketing|vp market|head of market|director.*market|svp.*market)\b', t):
            return {'match_score': 100, 'match_level': 'Best Match', 'match_reason': 'Marketing Leader'}
        if re.search(r'\b(creator|influencer|ugc|partnership|affiliate|social media|community)\b', t):
            return {'match_score': 95, 'match_level': 'Best Match', 'match_reason': 'Creator/Social'}
        if re.search(r'\b(ecommerce|e-commerce|digital|growth|head of growth|vp.*digital|director.*digital|director.*ecommerce)\b', t):
            return {'match_score': 90, 'match_level': 'Great Match', 'match_reason': 'Digital/Ecommerce'}
        if re.search(r'\b(brand|content|communications|pr|public relations)\b', t):
            return {'match_score': 70, 'match_level': 'Good Match', 'match_reason': 'Brand/Content'}
        if re.search(r'\b(ceo|coo|founder|co-founder|president|owner|general manager)\b', t):
            return {'match_score': 60, 'match_level': 'Good Match', 'match_reason': 'Executive'}
        if re.search(r'\b(manager|coordinator|specialist|analyst|associate)\b', t):
            return {'match_score': 30, 'match_level': 'Possible Match', 'match_reason': 'Mid-Level'}
        return {'match_score': 10, 'match_level': 'Possible Match', 'match_reason': 'Other'}

    def _send_one_prospect(self, prospect, all_emailed, today_by_website, settings, sender: Dict, bounced_set: set = None) -> str:
        """Try to send one email for a prospect. Returns: 'sent', 'skipped', 'failed'."""
        max_contacts_per_lead_per_day = settings.get('max_contacts_per_lead_per_day', 1)
        org_id = self._resolve_org_id()

        # Check per-prospect daily limit
        today_contacts = today_by_website.get(prospect['website'], [])
        if len(today_contacts) >= max_contacts_per_lead_per_day:
            return 'skipped'

        # Find contacts from prospect_contacts (already scored and linked)
        result = supabase.table('prospect_contacts').select('*').eq(
            'prospect_id', prospect['id']
        ).eq('org_id', org_id).order(
            'match_score', desc=True
        ).limit(50).execute()

        contacts = result.data or []
        if not contacts:
            print(f"  ⚠️ No prospect_contacts for {prospect['website']}")
            return 'failed'

        # Filter already emailed + bounced
        _bounced = bounced_set or set()
        available = [c for c in contacts if c.get('email')
                     and c['email'].lower() not in all_emailed
                     and c['email'].lower() not in _bounced]

        if not available:
            print(f"  ⏭️  All contacts already emailed for {prospect['website']}")
            return 'skipped'

        contact_raw = available[0]
        contact = {
            'name': contact_raw.get('full_name') or f"{contact_raw.get('first_name', '')} {contact_raw.get('last_name', '')}".strip(),
            'email': contact_raw['email'],
            'title': contact_raw.get('title', ''),
            'score': contact_raw.get('match_score', 0),
        }

        print(f"  👤 {contact['name']} — {contact['title']} (score: {contact['score']})")
        print(f"  📧 {contact['email']}")

        # ── Step 1: Apollo email verification ──────────────────
        email_domain = contact['email'].split('@')[1] if '@' in contact['email'] else ''
        apollo_result = verify_via_apollo(
            contact['email'],
            first_name=contact_raw.get('first_name'),
            last_name=contact_raw.get('last_name'),
            domain=email_domain,
        )

        if apollo_result['action'] == 'discard':
            print(f"  🚫 Apollo blocked: {apollo_result['apollo_status']}")
            all_emailed.add(contact['email'].lower())
            self._log('email_verified', summary=f"Apollo BLOCKED {contact['email']}: {apollo_result['apollo_status']}")
            return 'failed'

        # ── Step 2: ELV final verification (ALWAYS required before send) ──
        if apollo_result['action'] == 'send':
            print(f"  ✅ Apollo verified — running final ELV check")
        else:
            print(f"  🔶 Apollo: {apollo_result['apollo_status']} — running ELV verification")

        verification = verify_email(contact['email'])
        if not verification['safe']:
            print(f"  🚫 ELV final verification failed: {verification['status']}")
            all_emailed.add(contact['email'].lower())
            self._log('email_verified',
                       prospect_id=prospect['id'],
                       summary=f"ELV BLOCKED {contact['email']}: Apollo={apollo_result['apollo_status']}, ELV={verification['status']}")
            return 'failed'
        print(f"  ✅ ELV verified: {verification['status']}")

        # Generate email with rich prospect data
        try:
            email_data = generate_email_prospect(prospect, contact['name'])
            print(f"  ✍️  Subject: {email_data['subject']}")
        except Exception as e:
            print(f"  ❌ Email gen failed: {e}")
            return 'failed'

        # Pre-send dedup
        try:
            dedup_check = supabase.table('outreach_log').select(
                'id', count='exact', head=True
            ).eq('contact_email', contact['email']).eq('website', prospect['website']).execute()
            if dedup_check.count and dedup_check.count > 0:
                print(f"  ⏭️  Dedup: {contact['email']} already has outreach for this prospect — skipping")
                all_emailed.add(contact['email'].lower())
                return 'skipped'
        except Exception as e:
            print(f"  ⚠️ Dedup check failed (proceeding with send): {e}")

        # Send
        try:
            result = self.gmail.send_email(
                to=contact['email'],
                subject=email_data['subject'],
                body=email_data['body'],
                from_email=sender.get('email_address'),
                from_name=sender.get('from_name', 'Sam Reid'),
            )
            gmail_msg_id = result.get('id', '')
            print(f"  ✅ SENT! ID: {gmail_msg_id}")
        except Exception as e:
            print(f"  ❌ Send failed: {e}")
            self._log('email_failed', summary=f"Failed: {contact['email']} - {e}", status='failed')
            return 'failed'

        # Retrieve thread ID and Message-ID for follow-up threading
        gmail_thread_id = result.get('threadId', '')
        rfc_message_id = ''
        if gmail_msg_id:
            try:
                headers = self.gmail.get_message_headers(gmail_msg_id)
                gmail_thread_id = gmail_thread_id or headers.get('threadId', '')
                rfc_message_id = headers.get('Message-ID', headers.get('Message-Id', ''))
            except Exception as e:
                print(f"  ⚠️ Could not fetch message headers: {e}")

        # Log outreach (retry on failure — email WAS sent)
        outreach_row_data = {
            "prospect_id": prospect['id'],
            "website": prospect['website'],
            "contact_email": contact['email'],
            "contact_name": contact['name'],
            "email_subject": email_data['subject'],
            "email_body": email_data['body'],
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "followup_number": 0,
            "gmail_message_id": gmail_msg_id,
            "gmail_thread_id": gmail_thread_id,
            "rfc_message_id": rfc_message_id,
            "sender_email": sender.get('email_address', ''),
        }
        if org_id:
            outreach_row_data["org_id"] = org_id

        for attempt in range(3):
            try:
                supabase.table("outreach_log").insert(outreach_row_data).execute()
                break
            except Exception as e:
                if attempt < 2:
                    print(f"  ⚠️ outreach_log insert failed (attempt {attempt + 1}/3), retrying: {e}")
                    time.sleep(1)
                else:
                    print(f"  ❌ CRITICAL: outreach_log insert failed after 3 attempts for gmail_message_id={gmail_msg_id}.")
                    self._log('outreach_log_write_failed',
                              prospect_id=prospect['id'],
                              summary=f"CRITICAL: Sent {gmail_msg_id} to {contact['email']} but DB write failed: {e}",
                              status='failed')

        # Mark prospect as contacted
        supabase.table("prospects").update({
            "status": "contacted",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", prospect['id']).eq("org_id", org_id).execute()

        # Mark prospect_contact as contacted
        try:
            supabase.table("prospect_contacts").update({
                "contacted": True,
                "contacted_at": datetime.now(timezone.utc).isoformat(),
            }).eq("prospect_id", prospect['id']).eq("email", contact['email']).execute()
        except Exception:
            pass

        # Track
        all_emailed.add(contact['email'].lower())
        today_by_website.setdefault(prospect['website'], []).append(contact['email'])

        self._log('email_sent',
                   prospect_id=prospect['id'],
                   summary=f"[prospect] Sent from {sender.get('email_address')} to {contact['name']} <{contact['email']}> at {prospect['website']}")

        return 'sent'

    def send_batch_prospects(self, count: int = 10, sender_pool: list = None, deadline: datetime = None):
        """Send a batch of emails using the prospects pipeline instead of leads."""
        print(f"\n{'=' * 60}")
        print(f"📤 SENDING BATCH (PROSPECTS): up to {count} emails")
        print(f"{'=' * 60}\n")

        settings = self._get_settings(refresh=True)
        if not settings.get('agent_enabled', False):
            print("⏸️  Agent is PAUSED.")
            return 0

        org_id = self._resolve_org_id()

        # Query gold-enriched prospects (high ICP fit with Apollo contacts discovered)
        prospects_result = supabase.table("prospects").select("*").eq(
            "org_id", org_id
        ).eq("enrichment_status", "gold_enriched").in_(
            "status", ["qualified", "enriched"]
        ).order("icp_fit_score", desc=True, nullsfirst=False).limit(50).execute()

        # Also include contacted prospects (may have un-emailed contacts)
        contacted_result = supabase.table("prospects").select("*").eq(
            "org_id", org_id
        ).eq("enrichment_status", "gold_enriched").eq(
            "status", "contacted"
        ).order("created_at", desc=False).limit(50).execute()

        all_prospects = (prospects_result.data or []) + (contacted_result.data or [])

        if not all_prospects:
            print("📭 No gold-enriched prospects ready. Run the pipeline: Scout → Crawl → Analyze → Score → Gold Enrich")
            return 0

        n_qualified = len(prospects_result.data or [])
        n_contacted = len(contacted_result.data or [])

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

        bounced_set = self._load_bounce_suppression()

        # Auto-discover contacts for prospects that have none
        for prospect in all_prospects:
            try:
                existing = supabase.table('prospect_contacts').select(
                    '*', count='exact'
                ).eq('prospect_id', prospect['id']).eq('org_id', org_id).execute()
                if not existing.count or existing.count == 0:
                    self.discover_prospect_contacts(prospect['id'])
            except Exception as e:
                print(f"  ⚠️ Contact discovery error for {prospect['website']}: {e}")

        print(f"📋 {len(all_prospects)} candidate prospects ({n_qualified} qualified, {n_contacted} contacted), {len(all_emailed)} contacts already emailed\n")

        sent = 0
        failed = 0
        skipped = 0
        min_gap = settings.get('min_minutes_between_emails', 2)

        if sender_pool is None:
            sender_pool = self._load_sender_pool(settings)
        total_sender_remaining = sum(int(s.get('remaining', 0)) for s in sender_pool)
        print(f"📮 Sender pool: {len(sender_pool)} inbox(es), {total_sender_remaining} remaining sends today")

        for prospect in all_prospects:
            if sent >= count:
                break

            if deadline and datetime.now(timezone.utc) >= deadline:
                print(f"\n⏰ Deadline reached — stopping batch.")
                break

            print(f"\n{'─' * 50}")
            print(f"[{sent + 1}/{count}] {prospect.get('company_name', prospect['website'])} ({prospect['website']})")

            sender = self._pick_sender(sender_pool)
            if not sender:
                print("  🛑 No sender accounts with remaining daily capacity.")
                break

            print(f"  ✉️ Using sender: {sender.get('email_address')} ({sender.get('remaining')} left)")
            result = self._send_one_prospect(prospect, all_emailed, today_by_website, settings, sender, bounced_set)

            if result == 'sent':
                sent += 1
                self._record_sender_success(sender)
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

        print(f"\n🏁 BATCH (PROSPECTS): {sent} sent, {failed} failed, {skipped} skipped")
        return sent

    def check_replies_prospects(self, lookback_days: int = 60) -> int:
        """Scan sent email threads for replies, updating prospects.status instead of leads.status."""
        print(f"\n{'=' * 60}")
        print("💬 CHECKING REPLIES (PROSPECTS)")
        print(f"{'=' * 60}\n")

        cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
        org_id = self._resolve_org_id()

        # Get unreplied outreach rows — filter to prospect-based rows (prospect_id IS NOT NULL)
        results = supabase.table('outreach_log').select(
            'id, contact_email, contact_name, website, gmail_thread_id, replied_at, prospect_id'
        ).is_('replied_at', 'null').not_.is_('gmail_thread_id', 'null').not_.is_(
            'prospect_id', 'null'
        ).neq(
            'gmail_thread_id', ''
        ).gte('sent_at', cutoff).order('sent_at', desc=True).execute()

        rows = results.data or []
        if not rows:
            print("  📭 No unreplied threads to check.")
            return 0

        print(f"  Checking {len(rows)} threads...")
        our_email = self.gmail.get_from_email()
        new_replies = 0
        now_iso = datetime.now(timezone.utc).isoformat()

        seen_threads: set = set()
        for row in rows:
            thread_id = row.get('gmail_thread_id', '')
            if not thread_id or thread_id in seen_threads:
                continue
            seen_threads.add(thread_id)

            try:
                has_reply = self.gmail.check_thread_for_replies(thread_id, our_email)
            except Exception as e:
                print(f"  ⚠️ Thread check error ({row.get('contact_email')}): {e}")
                continue

            if not has_reply:
                continue

            contact_email = row.get('contact_email', '')
            website = row.get('website', '')
            print(f"  💬 Reply detected: {contact_email} ({website})")
            new_replies += 1

            # Update outreach_log
            try:
                supabase.table('outreach_log').update({
                    'replied_at': now_iso,
                }).eq('gmail_thread_id', thread_id).is_('replied_at', 'null').execute()
            except Exception as e:
                print(f"  ⚠️ Could not update outreach_log replied_at: {e}")

            # Update prospect status to 'engaged'
            try:
                supabase.table('prospects').update({
                    'status': 'engaged',
                    'updated_at': now_iso,
                }).eq('org_id', org_id).eq('website', website).execute()
            except Exception as e:
                print(f"  ⚠️ Could not update prospect status: {e}")

            self._log('email_reply',
                       prospect_id=row.get('prospect_id'),
                       summary=f"[prospect] Reply from {contact_email} at {website}")

        print(f"\n  ✅ Found {new_replies} new {'reply' if new_replies == 1 else 'replies'}")
        return new_replies

    def _show_prospect_stats(self):
        """Show prospect pipeline stats alongside leads stats."""
        org_id = self._resolve_org_id()

        print(f"\n{'─' * 60}")
        print("📊 PROSPECT PIPELINE")
        print(f"{'─' * 60}")

        statuses = ['new', 'enriching', 'enriched', 'qualified', 'contacted', 'engaged', 'disqualified']
        for status in statuses:
            cnt = supabase.table("prospects").select(
                "*", count="exact", head=True
            ).eq("org_id", org_id).eq("status", status).execute().count or 0
            print(f"  {status:15s} {cnt}")

        # Pipeline stage counts
        print(f"\n  {'─' * 40}")
        print("  Pipeline stages:")
        for stage_field, stage_values in [
            ("crawl_status", ["pending", "crawled", "failed"]),
            ("analysis_status", ["pending", "analyzed", "failed"]),
            ("enrichment_status", ["pending", "ready_for_gold", "gold_enriched"]),
        ]:
            for val in stage_values:
                cnt = supabase.table("prospects").select(
                    "*", count="exact", head=True
                ).eq("org_id", org_id).eq(stage_field, val).execute().count or 0
                if cnt > 0:
                    print(f"    {stage_field}={val:20s} {cnt}")

        # ICP fit breakdown
        print(f"\n  ICP fit:")
        for fit in ['HIGH', 'MEDIUM', 'LOW']:
            cnt = supabase.table("prospects").select(
                "*", count="exact", head=True
            ).eq("org_id", org_id).eq("icp_fit", fit).execute().count or 0
            if cnt > 0:
                print(f"    {fit:10s} {cnt}")

        # Average confidence
        try:
            conf_rows = supabase.table("prospects").select(
                "confidence_score"
            ).eq("org_id", org_id).not_.is_("confidence_score", "null").execute()
            scores = [r['confidence_score'] for r in (conf_rows.data or []) if r.get('confidence_score') is not None]
            avg_conf = sum(scores) / len(scores) if scores else 0
            print(f"\n  Avg confidence:   {avg_conf:.2f}")
        except Exception:
            print(f"\n  Avg confidence:   N/A")

        # Stale data (last_enriched_at > 90 days ago)
        try:
            ninety_days_ago = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
            stale = supabase.table("prospects").select(
                "*", count="exact", head=True
            ).eq("org_id", org_id).lt("last_enriched_at", ninety_days_ago).execute().count or 0
            stale_null = supabase.table("prospects").select(
                "*", count="exact", head=True
            ).eq("org_id", org_id).is_("last_enriched_at", "null").execute().count or 0
            print(f"  Stale (>90d):     {stale + stale_null}")
        except Exception:
            print(f"  Stale (>90d):     N/A")

        # Under-crawled (< 3 pages)
        try:
            all_prospects = supabase.table("prospects").select("id").eq("org_id", org_id).execute()
            prospect_ids = [p['id'] for p in (all_prospects.data or [])]
            under_crawled = 0
            # Check crawl counts in batches
            for pid in prospect_ids:
                crawl_cnt = supabase.table("company_crawls").select(
                    "*", count="exact", head=True
                ).eq("prospect_id", pid).execute().count or 0
                if crawl_cnt < 3:
                    under_crawled += 1
            print(f"  Under-crawled:    {under_crawled}")
        except Exception:
            print(f"  Under-crawled:    N/A")

        print(f"{'─' * 60}")

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

                apollo_status = (c.get('apollo_email_status') or '').lower()
                # Opt 1: Skip ELV batch verification for Apollo-verified contacts.
                if apollo_status == 'verified':
                    continue
                # Only run ELV batch verification for risky Apollo statuses.
                if apollo_status and apollo_status not in {'extrapolated', 'catch_all', 'unavailable'}:
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

        # Load bounce suppression list as a fallback safety net
        bounced_set = self._load_bounce_suppression()

        # Merge candidates: (outreach_row, followup_number_to_send)
        candidates = []

        for row in (initial_emails.data or []):
            if row.get('contact_email', '').lower() in bounced_set:
                continue
            key = (row['contact_email'].lower(), row['website'].lower())
            if key not in has_followup1:
                candidates.append((row, 1))

        for row in (followup1_emails.data or []):
            if row.get('contact_email', '').lower() in bounced_set:
                continue
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
                        gmail_thread_id, self.gmail.get_from_email()
                    )
                    if has_reply:
                        print(f"  💬 Prospect already replied — skipping!")
                        # Mark only this lead row as replied (avoid cross-domain/contact bleed).
                        update_q = supabase.table("leads").update({
                            "status": "replied",
                            "updated_at": now.isoformat(),
                        })
                        if outreach_row.get('lead_id'):
                            update_q = update_q.eq("id", outreach_row['lead_id'])
                        else:
                            update_q = update_q.eq("website", website)
                        update_q.execute()
                        # Mark outreach_log replied_at if not already set
                        try:
                            supabase.table('outreach_log').update({
                                'replied_at': now.isoformat(),
                            }).eq('id', outreach_row['id']).is_('replied_at', 'null').execute()
                        except Exception:
                            pass
                        self._log('email_reply', outreach_row.get('lead_id'),
                                  f"Reply from {contact_email} at {website}")
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

            # Only skip terminal CRM stages. "replied" can be stale/misclassified;
            # thread-level reply check above is the authoritative source for follow-up suppression.
            if lead.get('status') in ('qualified', 'demo'):
                print(f"  ⏭️  Lead status is '{lead.get('status')}' — skipping follow-up.")
                continue
            if lead.get('status') == 'replied':
                print("  ℹ️  Lead marked 'replied' in CRM, but no thread reply detected; continuing.")

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

            # Log the follow-up in outreach_log (sender_email for single source of truth)
            # Retry on failure — the email WAS sent, we must record it.
            fu_org_id = self._resolve_org_id()
            fu_outreach_data = {
                "lead_id": outreach_row.get('lead_id'),
                "website": website,
                "contact_email": contact_email,
                "contact_name": contact_name,
                "email_subject": f"Re: {original_subject}",
                "email_body": followup_data['body'],
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "followup_number": fu_number,
                "gmail_message_id": fu_gmail_msg_id,
                "gmail_thread_id": fu_gmail_thread_id,
                "rfc_message_id": fu_rfc_message_id,
                "parent_outreach_id": outreach_row.get('id'),
                "sender_email": self.gmail.get_from_email(),
            }
            if fu_org_id:
                fu_outreach_data["org_id"] = fu_org_id

            for attempt in range(3):
                try:
                    supabase.table("outreach_log").insert(fu_outreach_data).execute()
                    break
                except Exception as e:
                    if attempt < 2:
                        print(f"  ⚠️ Follow-up outreach_log insert failed (attempt {attempt + 1}/3), retrying: {e}")
                        time.sleep(1)
                    else:
                        print(f"  ❌ CRITICAL: Follow-up outreach_log insert failed for gmail_message_id={fu_gmail_msg_id}. "
                              f"Email WAS sent but has no DB record.")
                        self._log('outreach_log_write_failed', outreach_row.get('lead_id'),
                                  f"CRITICAL: Follow-up #{fu_number} sent {fu_gmail_msg_id} to {contact_email} but DB write failed: {e}",
                                  'failed')

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

        # Phase 1: Check bounces and replies once at start
        print("\n📬 Phase 1a: Checking bounces...")
        try:
            self.check_bounces()
        except Exception as e:
            print(f"  ⚠️ Bounce check error: {e}")

        # Determine pipeline mode from settings
        settings = self._get_settings(refresh=True)
        use_prospects = settings.get('use_prospect_db', False)
        if use_prospects:
            print("🔀 Pipeline mode: PROSPECTS")
        else:
            print("🔀 Pipeline mode: LEADS (classic)")

        print("\n💬 Phase 1b: Checking replies...")
        try:
            if use_prospects:
                self.check_replies_prospects()
            else:
                self.check_replies()
        except Exception as e:
            print(f"  ⚠️ Reply check error: {e}")

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

            # Check daily limit — load pool once and reuse for both capacity check
            # and send_batch (avoids double DB round-trip + double reset logic per loop)
            max_per_day = settings.get('max_emails_per_day', 50)
            remaining_global = self._get_remaining_today(max_per_day)
            sender_pool_for_loop = self._load_sender_pool(settings)
            remaining_sender = sum(int(s.get('remaining', 0)) for s in sender_pool_for_loop)
            remaining = min(remaining_global, remaining_sender)

            if remaining <= 0:
                print(f"\n🛑 Daily limit reached ({max_per_day}/{max_per_day}). Sleeping 30 min then rechecking...")
                # Sleep in intervals with heartbeat — the date might roll over
                for _ in range(30):
                    time.sleep(60)
                    self._update_heartbeat()
                continue

            # Periodically process follow-ups and check replies during the send loop
            if loop_count % followup_check_interval == 0:
                print(f"\n📩 Periodic follow-up check (loop #{loop_count})...")
                try:
                    fu_sent = self.process_followups(deadline=hard_deadline)
                    total_followups_this_run += fu_sent
                    total_sent_this_run += fu_sent
                except Exception as e:
                    print(f"  ⚠️ Follow-up error: {e}")
                try:
                    if use_prospects:
                        self.check_replies_prospects()
                    else:
                        self.check_replies()
                except Exception as e:
                    print(f"  ⚠️ Reply check error: {e}")

            # Re-check pipeline mode (may change via dashboard)
            use_prospects = settings.get('use_prospect_db', False)

            # Send a small batch (5 at a time to allow frequent settings checks)
            batch_size = min(remaining, 5)
            print(f"\n🔄 Loop #{loop_count} — Budget: {remaining}/{max_per_day}, sending up to {batch_size} ({'prospects' if use_prospects else 'leads'})")

            if use_prospects:
                sent = self.send_batch_prospects(count=batch_size, sender_pool=sender_pool_for_loop, deadline=hard_deadline)
            else:
                sent = self.send_batch(count=batch_size, deadline=hard_deadline, sender_pool=sender_pool_for_loop)
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
        print("  python ai_sdr_agent.py auto              # Full autonomous run (auto-detects leads/prospects mode)")
        print("  python ai_sdr_agent.py send-batch 10     # Send N emails (leads)")
        print("  python ai_sdr_agent.py send-batch-prospects 10  # Send N emails (prospects)")
        print("  python ai_sdr_agent.py process-followups  # Send due follow-up emails")
        print("  python ai_sdr_agent.py check-bounces     # Check bounced emails")
        print("  python ai_sdr_agent.py check-replies [days]  # Scan threads for replies (leads)")
        print("  python ai_sdr_agent.py check-replies-prospects [days]  # Scan threads for replies (prospects)")
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
    elif cmd == "send-batch-prospects":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        agent.send_batch_prospects(n)
    elif cmd == "process-followups":
        agent.process_followups()
    elif cmd == "check-bounces":
        agent.check_bounces()
    elif cmd == "check-replies":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 60
        agent.check_replies(lookback_days=days)
    elif cmd == "check-replies-prospects":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 60
        agent.check_replies_prospects(lookback_days=days)
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
