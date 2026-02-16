"""
AI SDR Agent for Onsite Affiliate
Autonomous agent that enriches leads, finds contacts, drafts emails, and sends via Gmail
"""

import os
import json
from datetime import datetime
from typing import List, Dict, Optional
from supabase import create_client, Client
from anthropic import Anthropic
from google.oauth2.credentials import Credentials
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
anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)

class AISDRAgent:
    """Autonomous AI SDR agent"""
    
    def __init__(self):
        self.supabase = supabase
        self.anthropic = anthropic
        
    # ============================================
    # STEP 1: ENRICH LEAD
    # ============================================
    
    def enrich_lead(self, lead_id: str) -> Dict:
        """Enrich a lead with AI research"""
        print(f"\n{'='*60}")
        print(f"🔍 ENRICHING LEAD: {lead_id}")
        print(f"{'='*60}\n")
        
        # Get lead
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        if not lead.data:
            raise Exception(f"Lead {lead_id} not found")
        
        website = lead.data["website"]
        print(f"📍 Website: {website}")
        
        # Update status
        self.supabase.table("leads").update({
            "enrichment_status": "in_progress"
        }).eq("id", lead_id).execute()
        
        # AI Research
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
        
        # Parse JSON
        try:
            research_text_clean = research_text.strip().replace("```json", "").replace("```", "")
            research_data = json.loads(research_text_clean)
        except:
            research_data = {
                "research_notes": research_text,
                "icp_fit": "MEDIUM"
            }
        
        # Update lead
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
        
        print(f"\n✅ Enrichment complete!")
        print(f"📊 ICP Fit: {research_data.get('icp_fit')}")
        print(f"🎯 Decision Makers: {', '.join(research_data.get('decision_makers', []))}")
        
        return research_data
    
    # ============================================
    # STEP 2: FIND CONTACTS
    # ============================================
    
    def find_contacts(self, lead_id: str, max_contacts: int = 15) -> List[Dict]:
        """Find decision maker contacts from database"""
        print(f"\n{'='*60}")
        print(f"👥 FINDING CONTACTS: {lead_id}")
        print(f"{'='*60}\n")
        
        # Get lead
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        if not lead.data:
            raise Exception(f"Lead {lead_id} not found")
        
        website = lead.data["website"]
        decision_makers = lead.data.get("decision_makers", [])
        
        print(f"🔍 Searching for: {website}")
        print(f"🎯 Target titles: {', '.join(decision_makers[:3])}")
        
        # Extract domain
        domain = website.lower().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0]
        company_name = domain.split(".")[0]
        
        # Search contact database - match by email domain OR account name
        print(f"📊 Querying contact database...")
        
        contacts = self.supabase.table("contact_database").select("*").or_(
            f"email.ilike.%@{domain}%,"
            f"account_name.ilike.%{company_name}%"
        ).limit(100).execute()
        
        all_contacts = contacts.data or []
        print(f"📋 Found {len(all_contacts)} potential contacts")
        
        # Score contacts
        scored_contacts = []
        for contact in all_contacts:
            score = self._score_contact(contact, decision_makers)
            if score > 0:
                contact["match_score"] = score
                contact["match_level"] = self._get_match_level(score)
                scored_contacts.append(contact)
        
        # Sort by score
        scored_contacts.sort(key=lambda x: x["match_score"], reverse=True)
        
        # Take top N
        top_contacts = scored_contacts[:max_contacts]
        
        print(f"⭐ Top {len(top_contacts)} contacts selected")
        
        # Save to database
        for contact in top_contacts:
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
        
        print(f"💾 Saved {len(top_contacts)} contacts to database")
        
        return top_contacts
    
    def _score_contact(self, contact: Dict, recommended_titles: List[str]) -> int:
        """Score contact based on title relevance"""
        title = (contact.get("title") or "").lower()
        score = 0
        
        # Match against recommended titles
        for rec_title in recommended_titles:
            if rec_title.lower() in title:
                score += 100
                break
        
        # Seniority
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
        
        # ICP keywords
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
        print(f"✉️ DRAFTING EMAIL")
        print(f"{'='*60}\n")
        
        # Get lead and contact
        lead = self.supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        contact = self.supabase.table("contacts").select("*").eq("id", contact_id).single().execute()
        
        if not lead.data or not contact.data:
            raise Exception("Lead or contact not found")
        
        print(f"👤 To: {contact.data['full_name']} ({contact.data['title']})")
        print(f"🏢 Company: {lead.data['website']}")
        
        # Email generation
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
        
        # Save to database
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
        
        print(f"\n✅ Email drafted ({email_data['word_count']} words)")
        print(f"📧 Subject: {email_data['subject']}")
        
        return email_record.data[0]
    
    # ============================================
    # STEP 4: SEND EMAIL
    # ============================================
    
    def send_email(self, email_id: str) -> Dict:
        """Send email via Gmail API"""
        print(f"\n{'='*60}")
        print(f"📤 SENDING EMAIL: {email_id}")
        print(f"{'='*60}\n")
        
        # Get email
        email = self.supabase.table("emails").select("*, contacts(*)").eq("id", email_id).single().execute()
        
        if not email.data:
            raise Exception(f"Email {email_id} not found")
        
        # Update status
        self.supabase.table("emails").update({"status": "sending"}).eq("id", email_id).execute()
        
        try:
            # Build Gmail service
            creds = Credentials.from_authorized_user_info(json.loads(GMAIL_CREDENTIALS))
            service = build('gmail', 'v1', credentials=creds)
            
            # Create message
            message = MIMEText(email.data["body"])
            message['To'] = email.data["contacts"]["email"]
            message['From'] = GMAIL_FROM_EMAIL
            message['Subject'] = email.data["subject"]
            
            # Encode
            raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
            
            # Send
            print(f"📧 Sending to: {email.data['contacts']['email']}")
            sent_message = service.users().messages().send(
                userId='me',
                body={'raw': raw_message}
            ).execute()
            
            # Update database
            self.supabase.table("emails").update({
                "status": "sent",
                "sent_at": datetime.utcnow().isoformat(),
                "gmail_message_id": sent_message['id'],
                "gmail_thread_id": sent_message.get('threadId')
            }).eq("id", email_id).execute()
            
            # Update contact
            self.supabase.table("contacts").update({
                "contacted": True,
                "contacted_at": datetime.utcnow().isoformat()
            }).eq("id", email.data["contact_id"]).execute()
            
            # Update lead
            self.supabase.table("leads").update({
                "status": "contacted"
            }).eq("id", email.data["lead_id"]).execute()
            
            print(f"✅ Email sent successfully!")
            print(f"📬 Message ID: {sent_message['id']}")
            
            return {"success": True, "message_id": sent_message['id']}
            
        except Exception as e:
            print(f"❌ Error sending email: {str(e)}")
            
            self.supabase.table("emails").update({
                "status": "failed",
                "error_message": str(e)
            }).eq("id", email_id).execute()
            
            return {"success": False, "error": str(e)}
    
    # ============================================
    # FULL WORKFLOW
    # ============================================
    
    def run_full_workflow(self, lead_id: str) -> Dict:
        """Run complete SDR workflow"""
        print(f"\n{'='*80}")
        print(f"🤖 STARTING FULL SDR WORKFLOW")
        print(f"{'='*80}\n")
        
        try:
            # Step 1: Enrich
            research = self.enrich_lead(lead_id)
            
            # Check ICP fit
            if research.get("icp_fit") == "LOW":
                print("\n⚠️  LOW ICP FIT - Stopping workflow")
                return {"success": False, "reason": "Low ICP fit"}
            
            # Step 2: Find contacts
            contacts = self.find_contacts(lead_id, max_contacts=3)
            
            if not contacts:
                print("\n⚠️  No contacts found")
                return {"success": False, "reason": "No contacts"}
            
            # Step 3: Draft email for best contact
            # Get contact ID from database
            db_contacts = self.supabase.table("contacts").select("*").eq("lead_id", lead_id).order("match_score", desc=True).limit(1).execute()
            
            if not db_contacts.data:
                print("\n⚠️  No contacts in database")
                return {"success": False, "reason": "No contacts"}
            
            best_contact_id = db_contacts.data[0]["id"]
            email = self.draft_email(lead_id, best_contact_id)
            
            # Step 4: Send email
            result = self.send_email(email["id"])
            
            if result["success"]:
                print(f"\n{'='*80}")
                print("✅ WORKFLOW COMPLETED SUCCESSFULLY")
                print(f"{'='*80}\n")
                return {"success": True, "email_sent": True, "message_id": result["message_id"]}
            else:
                return {"success": False, "reason": "Email sending failed", "error": result["error"]}
                
        except Exception as e:
            print(f"\n{'='*80}")
            print(f"❌ WORKFLOW FAILED: {str(e)}")
            print(f"{'='*80}\n")
            return {"success": False, "error": str(e)}


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
    else:
        print("Invalid command")
        sys.exit(1)