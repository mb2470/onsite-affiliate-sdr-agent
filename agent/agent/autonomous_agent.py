#!/usr/bin/env python3
"""
Autonomous AI SDR Agent
Runs continuously, processing leads from Supabase based on agent settings
"""

import os
import sys
import time
import json
import csv
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional
import anthropic
from supabase import create_client, Client
from dotenv import load_dotenv
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('agent.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# Initialize clients
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")  # Use service role for full access
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
CONTACTS_CSV_PATH = os.getenv("CONTACTS_CSV_PATH", "contacts_500k.csv")

if not all([SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY]):
    logger.error("Missing required environment variables!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

class AutonomousSDRAgent:
    def __init__(self):
        self.settings = None
        self.running = False
        self.heartbeat_interval = 60  # seconds
        self.last_heartbeat = None
        
    def log_activity(self, activity_type: str, lead_id: str = None, contact_id: str = None,
                     email_id: str = None, summary: str = "", details: dict = None, status: str = "success"):
        """Log activity to Supabase"""
        try:
            supabase.table('activity_log').insert({
                'activity_type': activity_type,
                'lead_id': lead_id,
                'contact_id': contact_id,
                'email_id': email_id,
                'summary': summary,
                'details': details or {},
                'status': status
            }).execute()
            logger.info(f"✅ {summary}")
        except Exception as e:
            logger.error(f"❌ Failed to log activity: {e}")
    
    def send_heartbeat(self):
        """Update agent heartbeat in database"""
        try:
            supabase.table('agent_settings').update({
                'last_heartbeat': datetime.utcnow().isoformat()
            }).eq('id', '00000000-0000-0000-0000-000000000001').execute()
            self.last_heartbeat = datetime.utcnow()
            logger.debug("💓 Heartbeat sent")
        except Exception as e:
            logger.error(f"❌ Heartbeat failed: {e}")
    
    def load_settings(self) -> bool:
        """Load agent settings from Supabase"""
        try:
            response = supabase.table('agent_settings').select('*').single().execute()
            self.settings = response.data
            
            if not self.settings:
                logger.error("No settings found in database")
                return False
            
            logger.info(f"📋 Settings loaded: enabled={self.settings.get('agent_enabled')}, "
                       f"auto_send={self.settings.get('auto_send')}, "
                       f"max_emails={self.settings.get('max_emails_per_day')}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to load settings: {e}")
            return False
    
    def is_within_send_hours(self) -> bool:
        """Check if current time is within allowed send hours (EST)"""
        if not self.settings:
            return False
        
        # EST is UTC-5
        est_offset = timedelta(hours=-5)
        est_tz = timezone(est_offset)
        current_hour_est = datetime.now(est_tz).hour
        
        start_hour = self.settings.get('send_hours_start', 9)
        end_hour = self.settings.get('send_hours_end', 17)
        
        within_hours = start_hour <= current_hour_est < end_hour
        
        if not within_hours:
            logger.debug(f"⏰ Outside send hours (current EST hour: {current_hour_est})")
        
        return within_hours
    
    def get_emails_sent_today(self) -> int:
        """Get count of emails sent today"""
        try:
            today = datetime.utcnow().date().isoformat()
            response = supabase.table('activity_log').select('id', count='exact').eq(
                'activity_type', 'email_sent'
            ).gte('created_at', today).execute()
            
            count = response.count if hasattr(response, 'count') else 0
            return count
        except Exception as e:
            logger.error(f"❌ Failed to get email count: {e}")
            return 0
    
    def can_send_more_emails(self) -> bool:
        """Check if we can send more emails today"""
        if not self.settings:
            return False
        
        max_emails = self.settings.get('max_emails_per_day', 50)
        sent_today = self.get_emails_sent_today()
        
        can_send = sent_today < max_emails
        
        if not can_send:
            logger.info(f"📊 Daily limit reached: {sent_today}/{max_emails}")
        
        return can_send
    
    def get_leads_to_process(self) -> List[Dict]:
        """Get leads that are ready for processing"""
        try:
            allowed_fits = self.settings.get('allowed_icp_fits', ['HIGH'])
            
            # Get enriched leads with allowed ICP fits that haven't been processed
            response = supabase.table('leads').select('*').eq(
                'status', 'enriched'
            ).in_('icp_fit', allowed_fits).is_(
                'agent_processed', 'false'
            ).limit(10).execute()
            
            leads = response.data or []
            logger.info(f"📋 Found {len(leads)} leads ready for processing")
            return leads
        except Exception as e:
            logger.error(f"❌ Failed to get leads: {e}")
            return []
    
    def find_contacts_for_lead(self, lead: Dict) -> List[Dict]:
        """Find contacts for a lead from CSV database"""
        try:
            website = lead.get('website', '').lower()
            contacts_found = []
            
            logger.info(f"🔍 Searching contacts for {website}...")
            
            with open(CONTACTS_CSV_PATH, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    contact_domain = row.get('email', '').split('@')[-1].lower()
                    
                    if website in contact_domain or contact_domain in website:
                        # Score the contact
                        title = row.get('title', '').lower()
                        score = self.score_contact(title)
                        
                        if score >= self.settings.get('min_match_score', 40):
                            contacts_found.append({
                                'name': row.get('full_name'),
                                'title': row.get('title'),
                                'email': row.get('email'),
                                'company': row.get('company'),
                                'score': score
                            })
                        
                        # Limit per lead
                        if len(contacts_found) >= self.settings.get('max_contacts_per_lead', 3):
                            break
            
            # Sort by score descending
            contacts_found.sort(key=lambda x: x['score'], reverse=True)
            
            logger.info(f"✅ Found {len(contacts_found)} qualifying contacts for {website}")
            return contacts_found
        except Exception as e:
            logger.error(f"❌ Failed to find contacts: {e}")
            return []
    
    def score_contact(self, title: str) -> int:
        """Score a contact based on title keywords"""
        title_lower = title.lower()
        score = 0
        
        # High value titles
        if any(word in title_lower for word in ['ceo', 'founder', 'owner', 'president']):
            score += 100
        elif any(word in title_lower for word in ['vp', 'vice president', 'director', 'head']):
            score += 80
        elif any(word in title_lower for word in ['manager', 'lead']):
            score += 60
        
        # Marketing/Growth specific
        if any(word in title_lower for word in ['marketing', 'growth', 'digital', 'ecommerce', 'acquisition']):
            score += 50
        
        # Negative signals
        if any(word in title_lower for word in ['intern', 'assistant', 'junior', 'coordinator']):
            score -= 30
        
        return max(0, score)
    
    def generate_email(self, lead: Dict, contact: Dict) -> Dict:
        """Generate personalized email using Claude"""
        try:
            logger.info(f"✨ Generating email for {contact['name']} at {lead['website']}...")
            
            prompt = f"""Write a casual outreach email for {lead['website']}.

Contact: {contact['name']}, {contact['title']}

{f"Context: {lead.get('research_notes', '')[:300]}" if lead.get('research_notes') else ''}

Requirements:
- Under 90 words total
- Ask about upfront creator costs OR gifting logistics
- Explain: Amazon proved performance commissions eliminate upfront costs
- Key point: We help brands COPY that model for their OWN site
- Tone: Casual, like a Slack message
- Use contact's first name only
- Include subject line

Format:
Subject: [subject]

[body]"""

            system_prompt = """You are an SDR for Onsite Affiliate. Under 90 words, casual tone.

CRITICAL - WHAT WE DO:
We help D2C brands COPY Amazon's Influencer commission model for their OWN website. We provide the platform to run performance-based creator programs.

THE OFFER:
- Brands implement same commission structure Amazon uses on their own site
- Get UGC video content with ZERO upfront costs
- Only pay performance commissions when videos drive sales

CORRECT MESSAGING:
✓ "Copy Amazon's commission model for your site"
✓ "Build what Amazon built for your brand"

NEVER SAY:
✗ "Tap into Amazon's creators"
✗ "Access Amazon influencers"
✗ "Our network"

TONE: Conversational, direct, no fluff."""

            message = anthropic_client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=1500,
                system=system_prompt,
                messages=[{"role": "user", "content": prompt}]
            )
            
            email_content = message.content[0].text
            
            # Parse subject
            subject_match = email_content.split('\n')[0]
            if 'Subject:' in subject_match:
                subject = subject_match.replace('Subject:', '').strip()
                body = '\n'.join(email_content.split('\n')[1:]).strip()
            else:
                subject = "Quick question about creator costs"
                body = email_content
            
            logger.info(f"✅ Email generated: {subject}")
            
            return {
                'subject': subject,
                'body': body,
                'full_content': email_content
            }
        except Exception as e:
            logger.error(f"❌ Failed to generate email: {e}")
            return None
    
    def save_email_draft(self, lead: Dict, contact: Dict, email: Dict) -> Optional[str]:
        """Save email draft to Supabase"""
        try:
            # First, save contact if not exists
            contact_response = supabase.table('contacts').upsert({
                'lead_id': lead['id'],
                'full_name': contact['name'],
                'title': contact['title'],
                'email': contact['email'],
                'match_score': contact['score']
            }, on_conflict='email').execute()
            
            contact_id = contact_response.data[0]['id'] if contact_response.data else None
            
            # Save email
            email_response = supabase.table('emails').insert({
                'lead_id': lead['id'],
                'contact_id': contact_id,
                'subject': email['subject'],
                'body': email['body'],
                'email_type': 'initial',
                'status': 'draft' if not self.settings.get('auto_send') else 'sending'
            }).execute()
            
            email_id = email_response.data[0]['id'] if email_response.data else None
            
            logger.info(f"💾 Email draft saved (auto_send={self.settings.get('auto_send')})")
            
            return email_id
        except Exception as e:
            logger.error(f"❌ Failed to save email: {e}")
            return None
    
    def process_lead(self, lead: Dict):
        """Process a single lead: find contacts, generate emails"""
        try:
            logger.info(f"\n{'='*60}")
            logger.info(f"🎯 Processing: {lead['website']} (ICP: {lead.get('icp_fit')})")
            logger.info(f"{'='*60}")
            
            # Find contacts
            contacts = self.find_contacts_for_lead(lead)
            
            if not contacts:
                self.log_activity(
                    'contacts_found',
                    lead_id=lead['id'],
                    summary=f"No qualifying contacts found for {lead['website']}",
                    status='failed'
                )
                
                # Mark as processed
                supabase.table('leads').update({
                    'agent_processed': True,
                    'status': 'no_contacts'
                }).eq('id', lead['id']).execute()
                
                return
            
            # Log contacts found
            self.log_activity(
                'contacts_found',
                lead_id=lead['id'],
                summary=f"Found {len(contacts)} contacts for {lead['website']}",
                details={'contact_count': len(contacts), 'contacts': contacts}
            )
            
            # Process each contact
            emails_created = 0
            for contact in contacts:
                # Generate email
                email = self.generate_email(lead, contact)
                
                if not email:
                    continue
                
                # Save draft
                email_id = self.save_email_draft(lead, contact, email)
                
                if email_id:
                    emails_created += 1
                    
                    self.log_activity(
                        'email_drafted',
                        lead_id=lead['id'],
                        email_id=email_id,
                        summary=f"Drafted email to {contact['name']} at {lead['website']}",
                        details={'subject': email['subject'], 'contact': contact['name']}
                    )
                    
                    # If auto-send is enabled, mark for sending
                    # (Actual sending would happen via separate Gmail integration)
                    if self.settings.get('auto_send'):
                        logger.info(f"📧 Email queued for sending (auto_send=True)")
                
                # Respect rate limiting
                time.sleep(2)
            
            # Mark lead as processed
            supabase.table('leads').update({
                'agent_processed': True,
                'status': 'contacted' if emails_created > 0 else 'processed'
            }).eq('id', lead['id']).execute()
            
            logger.info(f"✅ Lead processed: {emails_created} emails created")
            
        except Exception as e:
            logger.error(f"❌ Failed to process lead {lead.get('website')}: {e}")
            self.log_activity(
                'lead_processed',
                lead_id=lead.get('id'),
                summary=f"Failed to process {lead.get('website')}: {str(e)}",
                status='failed'
            )
    
    def run_cycle(self):
        """Run one processing cycle"""
        try:
            # Load settings
            if not self.load_settings():
                logger.error("❌ Failed to load settings, skipping cycle")
                return
            
            # Check if agent is enabled
            if not self.settings.get('agent_enabled'):
                logger.info("⏸️  Agent is paused (agent_enabled=false)")
                return
            
            # Check send hours
            if not self.is_within_send_hours():
                logger.info("⏰ Outside send hours, skipping cycle")
                return
            
            # Check daily limit
            if not self.can_send_more_emails():
                logger.info("📊 Daily email limit reached, skipping cycle")
                return
            
            # Get leads to process
            leads = self.get_leads_to_process()
            
            if not leads:
                logger.info("📭 No leads to process")
                return
            
            # Process each lead
            for lead in leads:
                self.process_lead(lead)
                
                # Check if we hit limits
                if not self.can_send_more_emails():
                    logger.info("📊 Daily limit reached during processing")
                    break
                
                # Pause between leads
                time.sleep(self.settings.get('min_minutes_between_emails', 15) * 60)
        
        except Exception as e:
            logger.error(f"❌ Cycle failed: {e}")
    
    def run(self):
        """Main loop - run continuously"""
        self.running = True
        logger.info("🚀 AI SDR Agent starting...")
        logger.info(f"📍 Using contacts DB: {CONTACTS_CSV_PATH}")
        
        cycle_count = 0
        
        while self.running:
            try:
                cycle_count += 1
                logger.info(f"\n{'#'*60}")
                logger.info(f"🔄 Cycle #{cycle_count} - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                logger.info(f"{'#'*60}\n")
                
                # Send heartbeat
                self.send_heartbeat()
                
                # Run processing cycle
                self.run_cycle()
                
                # Wait before next cycle (5 minutes)
                logger.info(f"\n⏳ Waiting 5 minutes before next cycle...")
                time.sleep(300)
                
            except KeyboardInterrupt:
                logger.info("\n⚠️  Shutdown signal received")
                self.running = False
                break
            except Exception as e:
                logger.error(f"❌ Unexpected error in main loop: {e}")
                time.sleep(60)  # Wait 1 minute before retry
        
        logger.info("👋 AI SDR Agent stopped")

def main():
    agent = AutonomousSDRAgent()
    agent.run()

if __name__ == "__main__":
    main()
