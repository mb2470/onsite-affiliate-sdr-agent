"""
AI SDR Agent for Onsite Affiliate
Autonomous agent that enriches leads, finds contacts, drafts emails, and sends via Gmail

Usage:
  python ai_sdr_agent.py enrich <lead_id>
  python ai_sdr_agent.py contacts <lead_id>
  python ai_sdr_agent.py draft <lead_id> <contact_id>
  python ai_sdr_agent.py send <email_id>
  python ai_sdr_agent.py workflow <lead_id>
  python ai_sdr_agent.py auto                      # Autonomous mode - processes all pending leads
"""

import os
import json
import time
import random
from datetime import datetime, timezone
from typing import List, Dict, Optional
from supabase import create_client, Client
from anthropic import Anthropic
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from email.mime.text import MIMEText
import base64
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
GMAIL_CREDENTIALS = os.getenv("GMAIL_OAUTH_CREDENTIALS")
GMAIL_FROM_EMAIL = os.getenv("GMAIL_FROM_EMAIL")

# Initialize clients
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)


class GmailService:
    """Handles Gmail API with automatic token refresh"""
    
    def __init__(self):
        self._service = None
        self._creds = None
    
    def _get_credentials(self) -> Credentials:
        """Get valid Gmail credentials, refreshing if needed"""
        if self._creds and self._creds.valid:
            return self._creds
        
        if not GMAIL_CREDENTIALS:
            raise Exception(
                "GMAIL_OAUTH_CREDENTIALS not set. "
                "Run authorize_gmail.py locally first to generate it."
            )
        
        creds_data = json.loads(GMAIL_CREDENTIALS.strip("'\""))
        
        self._creds = Credentials(
            token=creds_data.get("token"),
            refresh_token=creds_data.get("refresh_token"),
            token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=creds_data.get("client_id"),
            client_secret=creds_data.get("client_secret"),
            scopes=creds_data.get("scopes", ["https://www.googleapis.com/auth/gmail.send"])
        )
        
        # Refresh if expired
        if self._creds.expired or not self._creds.valid:
            if self._creds.refresh_token:
                print("🔄 Refreshing Gmail token...")
                self._creds.refresh(Request())
                print("✅ Token refreshed")
            else:
                raise Exception(
                    "Gmail token expired and no refresh token available. "
                    "Run authorize_gmail.py again."
                )
        
        return self._creds
    
    def get_service(self):
        """Get Gmail API service, creating/refreshing as needed"""
        creds = self._get_credentials()
        if not self._service:
            self._service = build('gmail', 'v1', credentials=creds)
        return self._service
    
    def send_message(self, to: str, subject: str, body: str, from_email: str = None) -> Dict:
        """Send an email via Gmail API"""
        service = self.get_service()
        
        message = MIMEText(body)
        message['To'] = to
        message['From'] = from_email or GMAIL_FROM_EMAIL
        message['Subject'] = subject
        
        raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
        
        sent = service.users().messages().send(
            userId='me',
            body={'raw': raw_message}
        ).execute()
        
        return sent
    
    def verify(self) -> str:
        """Verify Gmail connection and return email address"""
        service = self.get_service()
        profile = service.users().getProfile(userId='me').execute()
        return profile['emailAddress']


class AISDRAgent:
    """Autonomous AI SDR agent"""
    
    def __init__(self):
        self.supabase = supabase
        self.anthropic = anthropic_client
        self.gmail = GmailService()
        self._settings = None
    
    def _get_settings(self) -> Dict:
        """Load agent settings from Supabase"""
        if not self._settings:
            result = self.supabase.table("agent_settings").select("*").eq(
                "id", "00000000-0000-0000-0000-000000000001"
            ).single().execute()
            self._settings = result.data or {}
        return self._settings
    
    def _log_activity(self, activity_type: str, lead_id: str = None, 
                      contact_id: str = None, email_id: str = None,
                      summary: str = "", status: str = "success", details: Dict = None):
        """Log activity to Supabase"""
        try:
            self.supabase.table("activity_log").insert({
                "activity_type": activity_type,
                "lead_id": lead_id,
                "contact_id": contact_id,
                "email_id": email_id,
                "summary": summary,
                "status": status,
                "details": json.dumps(details) if details else None
            }).execute()
        except Exception as e:
            print(f"⚠️  Failed to log activity: {e}")
    
    # ============================================
    # STEP 1: ENRICH LEAD
    # ============================================
    
    def enrich_lead(self, lead_id: str) -> Dict:
        """Enrich a lead with AI research"""
        print(f"\n{'='*60}")
        print(f"🔍 ENRICHING LEAD: {lead_id}")
        print(f"{'='*60}\n")
        
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        if not lead.data:
            raise Exception(f"Lead {lead_id} not found")
        
        website = lead.data["website"]
        print(f"📍 Website: {website}")
        
        self.supabase.table("leads").update({
            "enrichment_status": "in_progress"
        }).eq("id", lead_id).execute()
        
        research_prompt = f"""Research this ecommerce company for Onsite Affiliate outreach:

Company: {website}

Provide a qualification report with these sections:

1. INDUSTRY/VERTICAL
What do they sell? Be specific.

2. ICP FIT SCORE: HIGH / MEDIUM / LOW
- HIGH: Perfect industry + right size + visible UGC activity
- MEDIUM: Right industry + right size, unclear creator activity
- LOW: Wrong industry OR wrong size OR no e-commerce

Justify your score.

3. DECISION MAKERS TO TARGET
Based on company size, which titles should we target?
List 2-3 specific titles (e.g., Director of Influencer Marketing, VP E-Commerce)

4. KEY PAIN POINTS
- Can't afford $500-2k upfront per creator post
- Gifting/seeding products is a logistics nightmare
- Need to prove ROI on creator content

5. TALKING POINTS
Reference their specific business, product categories, social presence.

Return as JSON:
{{
  "industry": "...",
  "icp_fit": "HIGH/MEDIUM/LOW",
  "decision_makers": ["title1", "title2"],
  "pain_points": "...",
  "talking_points": "...",
  "research_notes": "Full summary"
}}"""
        
        print("🤖 Calling Claude for research...")
        
        response = self.anthropic.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            messages=[{"role": "user", "content": research_prompt}]
        )
        
        research_text = response.content[0].text
        
        try:
            research_text_clean = research_text.strip().replace("```json", "").replace("```", "")
            research_data = json.loads(research_text_clean)
        except:
            research_data = {
                "research_notes": research_text,
                "icp_fit": "MEDIUM"
            }
        
        self.supabase.table("leads").update({
            "industry": research_data.get("industry", ""),
            "icp_fit": research_data.get("icp_fit", "MEDIUM"),
            "research_notes": research_data.get("research_notes", ""),
            "decision_makers": research_data.get("decision_makers", []),
            "pain_points": research_data.get("pain_points", ""),
            "talking_points": research_data.get("talking_points", ""),
            "enrichment_status": "completed",
            "status": "enriched"
        }).eq("id", lead_id).execute()
        
        self._log_activity(
            "lead_enriched", lead_id=lead_id,
            summary=f"Enriched {website} - ICP: {research_data.get('icp_fit', 'Unknown')}"
        )
        
        print(f"✅ Enrichment complete! ICP: {research_data.get('icp_fit')}")
        return research_data
    
    # ============================================
    # STEP 2: FIND CONTACTS
    # ============================================
    
    def find_contacts(self, lead_id: str, max_contacts: int = 15) -> List[Dict]:
        """Find decision maker contacts from database"""
        print(f"\n{'='*60}")
        print(f"👥 FINDING CONTACTS: {lead_id}")
        print(f"{'='*60}\n")
        
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        if not lead.data:
            raise Exception(f"Lead {lead_id} not found")
        
        website = lead.data["website"]
        decision_makers = lead.data.get("decision_makers", [])
        
        print(f"🔍 Searching for: {website}")
        print(f"🎯 Target titles: {', '.join(decision_makers[:3]) if decision_makers else 'Any'}")
        
        domain = website.lower().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0]
        company_name = domain.split(".")[0]
        
        print(f"📊 Querying contact database...")
        
        contacts = self.supabase.table("contact_database").select("*").or_(
            f"email.ilike.%@{domain}%,"
            f"account_name.ilike.%{company_name}%"
        ).limit(100).execute()
        
        all_contacts = contacts.data or []
        print(f"📋 Found {len(all_contacts)} potential contacts")
        
        scored_contacts = []
        for contact in all_contacts:
            score = self._score_contact(contact, decision_makers)
            if score > 0:
                contact["match_score"] = score
                contact["match_level"] = self._get_match_level(score)
                scored_contacts.append(contact)
        
        scored_contacts.sort(key=lambda x: x["match_score"], reverse=True)
        top_contacts = scored_contacts[:max_contacts]
        
        print(f"⭐ Top {len(top_contacts)} contacts selected")
        
        for contact in top_contacts:
            try:
                self.supabase.table("contacts").insert({
                    "lead_id": lead_id,
                    "first_name": contact.get("first_name"),
                    "last_name": contact.get("last_name"),
                    "full_name": f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip(),
                    "email": contact["email"],
                    "title": contact.get("title"),
                    "company_name": contact.get("account_name"),
                    "company_website": website,
                    "match_score": contact["match_score"],
                    "match_level": contact["match_level"],
                    "source": "csv_database"
                }).execute()
            except Exception as e:
                print(f"⚠️  Duplicate or error saving contact: {e}")
        
        self._log_activity(
            "contacts_found", lead_id=lead_id,
            summary=f"Found {len(top_contacts)} contacts for {website}"
        )
        
        print(f"💾 Saved {len(top_contacts)} contacts to database")
        return top_contacts
    
    def _score_contact(self, contact: Dict, recommended_titles: List[str]) -> int:
        """Score contact based on title relevance"""
        title = (contact.get("title") or "").lower()
        score = 0
        
        for rec_title in recommended_titles:
            if rec_title.lower() in title:
                score += 100
                break
        
        if "chief" in title or "cmo" in title:
            score += 40
        elif "vp" in title:
            score += 35
        elif "head of" in title:
            score += 30
        elif "director" in title:
            score += 25
        elif "senior" in title:
            score += 15
        elif "manager" in title:
            score += 10
        
        keywords = {
            "influencer": 30, "creator": 30, "affiliate": 25,
            "partnership": 25, "brand marketing": 20, "ecommerce": 20,
            "e-commerce": 20, "growth": 15
        }
        
        for keyword, points in keywords.items():
            if keyword in title:
                score += points
        
        return score
    
    def _get_match_level(self, score: int) -> str:
        """Convert score to match level"""
        if score >= 120:
            return "Best Match"
        elif score >= 70:
            return "Great Match"
        elif score >= 40:
            return "Good Match"
        else:
            return "Possible Match"
    
    # ============================================
    # STEP 3: DRAFT EMAIL
    # ============================================
    
    def draft_email(self, lead_id: str, contact_id: str) -> Dict:
        """Draft personalized email"""
        print(f"\n{'='*60}")
        print(f"✉️  DRAFTING EMAIL")
        print(f"{'='*60}\n")
        
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        contact = self.supabase.table("contacts").select("*").eq("id", contact_id).single().execute()
        
        if not lead.data or not contact.data:
            raise Exception("Lead or contact not found")
        
        print(f"👤 To: {contact.data['full_name']} ({contact.data['title']})")
        print(f"🏢 Company: {lead.data['website']}")
        
        email_prompt = f"""Write an initial outreach email:

Company: {lead.data['website']}
Industry: {lead.data.get('industry', 'eCommerce')}

Contact:
Name: {contact.data['full_name']}
Title: {contact.data['title']}

Research:
{lead.data.get('research_notes', '')}

REQUIREMENTS:
1. MAXIMUM 90 WORDS
2. MUST mention Amazon Influencer Onsite Commissions
3. FOCUS: Can't grow upfront creator costs OR gifting and seeding is a headache
4. Casual Slack-style tone
5. Start with first name only (no "Hi")
6. End with just your name
7. Simple question CTA

KEY MESSAGE: Amazon proved you don't need upfront creator payments or product gifting. Performance commissions after sales. We do this for D2C brands.

Return JSON:
{{
  "subject": "Subject (5-7 words)",
  "body": "Email body (under 90 words)",
  "word_count": 75
}}"""
        
        print("🤖 Calling Claude to draft email...")
        
        response = self.anthropic.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": email_prompt}]
        )
        
        email_text = response.content[0].text.strip().replace("```json", "").replace("```", "")
        email_data = json.loads(email_text)
        
        email_record = self.supabase.table("emails").insert({
            "lead_id": lead_id,
            "contact_id": contact_id,
            "subject": email_data["subject"],
            "body": email_data["body"],
            "email_type": "initial",
            "word_count": email_data.get("word_count", 0),
            "includes_amazon_proof": "amazon" in email_data["body"].lower(),
            "status": "draft"
        }).execute()
        
        self._log_activity(
            "email_drafted", lead_id=lead_id, contact_id=contact_id,
            summary=f"Drafted email to {contact.data['full_name']} at {lead.data['website']}"
        )
        
        print(f"✅ Email drafted ({email_data['word_count']} words)")
        print(f"📧 Subject: {email_data['subject']}")
        
        return email_record.data[0]
    
    # ============================================
    # STEP 4: SEND EMAIL (Gmail API)
    # ============================================
    
    def send_email(self, email_id: str) -> Dict:
        """Send email via Gmail API with auto token refresh"""
        print(f"\n{'='*60}")
        print(f"📤 SENDING EMAIL: {email_id}")
        print(f"{'='*60}\n")
        
        email = self.supabase.table("emails").select("*, contacts(*)").eq("id", email_id).single().execute()
        
        if not email.data:
            raise Exception(f"Email {email_id} not found")
        
        if email.data["status"] == "sent":
            print("⚠️  Email already sent, skipping")
            return {"success": True, "message": "Already sent"}
        
        self.supabase.table("emails").update({"status": "sending"}).eq("id", email_id).execute()
        
        to_email = email.data["contacts"]["email"]
        subject = email.data["subject"]
        body = email.data["body"]
        
        print(f"📧 To: {to_email}")
        print(f"📝 Subject: {subject}")
        
        try:
            sent = self.gmail.send_message(
                to=to_email,
                subject=subject,
                body=body
            )
            
            # Update email record
            self.supabase.table("emails").update({
                "status": "sent",
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "gmail_message_id": sent['id'],
                "gmail_thread_id": sent.get('threadId')
            }).eq("id", email_id).execute()
            
            # Update contact
            self.supabase.table("contacts").update({
                "contacted": True,
                "contacted_at": datetime.now(timezone.utc).isoformat()
            }).eq("id", email.data["contact_id"]).execute()
            
            # Update lead status
            self.supabase.table("leads").update({
                "status": "contacted"
            }).eq("id", email.data["lead_id"]).execute()
            
            self._log_activity(
                "email_sent", lead_id=email.data["lead_id"],
                contact_id=email.data["contact_id"], email_id=email_id,
                summary=f"Sent email to {to_email}: {subject}"
            )
            
            print(f"✅ Email sent! Message ID: {sent['id']}")
            return {"success": True, "message_id": sent['id']}
            
        except Exception as e:
            error_msg = str(e)
            print(f"❌ Error sending: {error_msg}")
            
            self.supabase.table("emails").update({
                "status": "failed",
                "error_message": error_msg
            }).eq("id", email_id).execute()
            
            self._log_activity(
                "email_failed", lead_id=email.data["lead_id"],
                contact_id=email.data["contact_id"], email_id=email_id,
                summary=f"Failed to send to {to_email}: {error_msg}",
                status="failed"
            )
            
            return {"success": False, "error": error_msg}
    
    # ============================================
    # FULL WORKFLOW (single lead)
    # ============================================
    
    def run_full_workflow(self, lead_id: str) -> Dict:
        """Run complete SDR workflow for one lead"""
        print(f"\n{'='*80}")
        print(f"🤖 STARTING FULL SDR WORKFLOW")
        print(f"{'='*80}\n")
        
        try:
            # Step 1: Enrich
            research = self.enrich_lead(lead_id)
            
            if research.get("icp_fit") == "LOW":
                print("\n⚠️  LOW ICP FIT - Stopping workflow")
                self._log_activity("workflow_skipped", lead_id=lead_id,
                                   summary="Skipped - Low ICP fit")
                return {"success": False, "reason": "Low ICP fit"}
            
            # Step 2: Find contacts
            contacts = self.find_contacts(lead_id, max_contacts=3)
            
            if not contacts:
                print("\n⚠️  No contacts found")
                return {"success": False, "reason": "No contacts"}
            
            # Step 3: Draft email for best contact
            db_contacts = self.supabase.table("contacts").select("*").eq(
                "lead_id", lead_id
            ).order("match_score", desc=True).limit(1).execute()
            
            if not db_contacts.data:
                return {"success": False, "reason": "No contacts in DB"}
            
            best_contact = db_contacts.data[0]
            email = self.draft_email(lead_id, best_contact["id"])
            
            # Step 4: Check if auto-send is enabled
            settings = self._get_settings()
            if settings.get("auto_send", False):
                result = self.send_email(email["id"])
                if result["success"]:
                    print(f"\n✅ WORKFLOW COMPLETE - Email sent!")
                    return {"success": True, "email_sent": True, "message_id": result.get("message_id")}
                else:
                    return {"success": False, "reason": "Send failed", "error": result.get("error")}
            else:
                print(f"\n✅ WORKFLOW COMPLETE - Email drafted (auto-send OFF)")
                return {"success": True, "email_sent": False, "email_id": email["id"]}
                
        except Exception as e:
            print(f"\n❌ WORKFLOW FAILED: {str(e)}")
            self._log_activity("workflow_failed", lead_id=lead_id,
                               summary=f"Workflow failed: {str(e)}", status="failed")
            return {"success": False, "error": str(e)}
    
    # ============================================
    # AUTONOMOUS MODE
    # ============================================
    
    def run_autonomous(self):
        """Run the agent autonomously - processes all pending leads"""
        print(f"\n{'='*80}")
        print(f"🤖 AUTONOMOUS MODE STARTED")
        print(f"   Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
        print(f"{'='*80}\n")
        
        # Verify Gmail connection first
        try:
            email_address = self.gmail.verify()
            print(f"✅ Gmail verified: {email_address}")
        except Exception as e:
            print(f"❌ Gmail verification failed: {e}")
            print("   Run authorize_gmail.py to fix credentials")
            return
        
        # Load settings
        settings = self._get_settings()
        if not settings.get("agent_enabled", False):
            print("⏸️  Agent is PAUSED. Enable in the dashboard first.")
            return
        
        max_emails_per_day = settings.get("max_emails_per_day", 50)
        min_minutes_between = settings.get("min_minutes_between_emails", 15)
        send_hours_start = settings.get("send_hours_start", 9)
        send_hours_end = settings.get("send_hours_end", 17)
        allowed_icp_fits = settings.get("allowed_icp_fits", ["HIGH"])
        min_match_score = settings.get("min_match_score", 40)
        max_contacts_per_lead = settings.get("max_contacts_per_lead", 3)
        
        print(f"⚙️  Settings:")
        print(f"   Max emails/day: {max_emails_per_day}")
        print(f"   Min gap: {min_minutes_between} min")
        print(f"   Send hours: {send_hours_start}-{send_hours_end} EST")
        print(f"   ICP fits: {allowed_icp_fits}")
        print(f"   Min match score: {min_match_score}")
        
        # Check how many emails sent today
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        today_emails = self.supabase.table("emails").select("id", count="exact").eq(
            "status", "sent"
        ).gte("sent_at", f"{today}T00:00:00Z").execute()
        
        emails_sent_today = today_emails.count or 0
        remaining_budget = max_emails_per_day - emails_sent_today
        
        print(f"\n📊 Today: {emails_sent_today}/{max_emails_per_day} emails sent")
        print(f"   Budget remaining: {remaining_budget}")
        
        if remaining_budget <= 0:
            print("🛑 Daily email limit reached. Stopping.")
            return
        
        # PHASE 1: Send any pending drafted emails
        print(f"\n{'='*60}")
        print("📤 PHASE 1: Sending drafted emails...")
        print(f"{'='*60}")
        
        pending_emails = self.supabase.table("emails").select(
            "*, contacts!inner(match_score)"
        ).eq("status", "draft").gte(
            "contacts.match_score", min_match_score
        ).order("created_at").limit(remaining_budget).execute()
        
        for email in (pending_emails.data or []):
            if remaining_budget <= 0:
                break
            
            # Check send hours
            from datetime import timezone as tz
            import pytz
            est = pytz.timezone('US/Eastern')
            current_hour = datetime.now(est).hour
            if current_hour < send_hours_start or current_hour >= send_hours_end:
                print(f"⏰ Outside send hours ({send_hours_start}-{send_hours_end} EST). Current: {current_hour} EST")
                break
            
            result = self.send_email(email["id"])
            if result["success"]:
                remaining_budget -= 1
                emails_sent_today += 1
            
            # Wait between emails (with jitter)
            wait_time = (min_minutes_between * 60) + random.randint(30, 120)
            print(f"⏳ Waiting {wait_time // 60}m {wait_time % 60}s before next email...")
            time.sleep(wait_time)
        
        # PHASE 2: Process unenriched leads
        print(f"\n{'='*60}")
        print("🔍 PHASE 2: Enriching new leads...")
        print(f"{'='*60}")
        
        new_leads = self.supabase.table("leads").select("*").eq(
            "status", "new"
        ).is_("enrichment_status", "null").order("created_at").limit(20).execute()
        
        enriched_count = 0
        for lead in (new_leads.data or []):
            try:
                research = self.enrich_lead(lead["id"])
                enriched_count += 1
                time.sleep(3)  # Rate limit Claude API calls
            except Exception as e:
                print(f"❌ Error enriching {lead['website']}: {e}")
                continue
        
        print(f"✅ Enriched {enriched_count} leads")
        
        # PHASE 3: Find contacts for enriched leads without contacts
        print(f"\n{'='*60}")
        print("👥 PHASE 3: Finding contacts...")
        print(f"{'='*60}")
        
        # Get enriched leads that match ICP and don't have contacts yet
        enriched_leads = self.supabase.table("leads").select("*").eq(
            "status", "enriched"
        ).in_("icp_fit", allowed_icp_fits).order("created_at").limit(10).execute()
        
        contacts_found_count = 0
        for lead in (enriched_leads.data or []):
            # Check if already has contacts
            existing = self.supabase.table("contacts").select("id", count="exact").eq(
                "lead_id", lead["id"]
            ).execute()
            
            if (existing.count or 0) > 0:
                continue
            
            try:
                contacts = self.find_contacts(lead["id"], max_contacts=max_contacts_per_lead)
                contacts_found_count += len(contacts)
                time.sleep(1)
            except Exception as e:
                print(f"❌ Error finding contacts for {lead['website']}: {e}")
                continue
        
        print(f"✅ Found {contacts_found_count} new contacts")
        
        # PHASE 4: Draft emails for contacts without emails
        print(f"\n{'='*60}")
        print("✉️  PHASE 4: Drafting emails...")
        print(f"{'='*60}")
        
        # Get contacts without emails, above min match score
        contacts_needing_emails = self.supabase.table("contacts").select(
            "*, leads!inner(status, icp_fit)"
        ).is_("contacted", False).gte(
            "match_score", min_match_score
        ).in_("leads.icp_fit", allowed_icp_fits).order(
            "match_score", desc=True
        ).limit(remaining_budget).execute()
        
        drafted_count = 0
        for contact in (contacts_needing_emails.data or []):
            # Check if email already exists for this contact
            existing_email = self.supabase.table("emails").select("id", count="exact").eq(
                "contact_id", contact["id"]
            ).execute()
            
            if (existing_email.count or 0) > 0:
                continue
            
            try:
                email = self.draft_email(contact["lead_id"], contact["id"])
                drafted_count += 1
                
                # Auto-send if enabled
                if settings.get("auto_send", False) and remaining_budget > 0:
                    # Check send hours
                    current_hour = datetime.now(pytz.timezone('US/Eastern')).hour
                    if send_hours_start <= current_hour < send_hours_end:
                        result = self.send_email(email["id"])
                        if result["success"]:
                            remaining_budget -= 1
                        
                        wait_time = (min_minutes_between * 60) + random.randint(30, 120)
                        print(f"⏳ Waiting {wait_time // 60}m {wait_time % 60}s...")
                        time.sleep(wait_time)
                
                time.sleep(3)  # Rate limit
            except Exception as e:
                print(f"❌ Error drafting email: {e}")
                continue
        
        print(f"✅ Drafted {drafted_count} emails")
        
        # Summary
        print(f"\n{'='*80}")
        print(f"🏁 AUTONOMOUS RUN COMPLETE")
        print(f"   Enriched: {enriched_count} leads")
        print(f"   Contacts found: {contacts_found_count}")
        print(f"   Emails drafted: {drafted_count}")
        print(f"   Emails sent today: {emails_sent_today}/{max_emails_per_day}")
        print(f"{'='*80}\n")


# ============================================
# CLI
# ============================================

if __name__ == "__main__":
    import sys
    
    agent = AISDRAgent()
    
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python ai_sdr_agent.py enrich <lead_id>")
        print("  python ai_sdr_agent.py contacts <lead_id>")
        print("  python ai_sdr_agent.py draft <lead_id> <contact_id>")
        print("  python ai_sdr_agent.py send <email_id>")
        print("  python ai_sdr_agent.py workflow <lead_id>")
        print("  python ai_sdr_agent.py auto          # Autonomous mode")
        print("  python ai_sdr_agent.py verify-gmail   # Test Gmail connection")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "enrich" and len(sys.argv) == 3:
        agent.enrich_lead(sys.argv[2])
    elif command == "contacts" and len(sys.argv) == 3:
        agent.find_contacts(sys.argv[2])
    elif command == "draft" and len(sys.argv) == 4:
        agent.draft_email(sys.argv[2], sys.argv[3])
    elif command == "send" and len(sys.argv) == 3:
        agent.send_email(sys.argv[2])
    elif command == "workflow" and len(sys.argv) == 3:
        agent.run_full_workflow(sys.argv[2])
    elif command == "auto":
        agent.run_autonomous()
    elif command == "verify-gmail":
        try:
            email = agent.gmail.verify()
            print(f"✅ Gmail connected: {email}")
        except Exception as e:
            print(f"❌ Gmail error: {e}")
    else:
        print("Invalid command. Run without arguments to see usage.")
        sys.exit(1)
