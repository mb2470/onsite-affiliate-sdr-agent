"""
Export up to 100 contacts for HIGH-fit leads to CSV.

Pulls contacts from contact_database whose website matches a HIGH icp_fit lead.

Usage:
    python export_high_fit_contacts.py              # writes high_fit_contacts.csv
    python export_high_fit_contacts.py output.csv   # writes to custom path
"""

import sys
import csv
import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def export_contacts(output_path: str = "high_fit_contacts.csv", limit: int = 100):
    # 1. Get all HIGH icp_fit leads with contacts
    print("📋 Fetching HIGH-fit leads...")
    leads_result = supabase.table("leads").select("website").eq(
        "icp_fit", "HIGH"
    ).eq("has_contacts", True).execute()

    leads = leads_result.data or []
    print(f"   Found {len(leads)} HIGH-fit leads with contacts")

    if not leads:
        print("⚠️ No HIGH-fit leads with contacts found.")
        return

    # 2. Pull contacts matching those lead websites
    contacts = []
    for lead in leads:
        if len(contacts) >= limit:
            break

        website = lead["website"].lower().replace("https://", "").replace("http://", "").replace("www.", "").rstrip("/")
        result = supabase.table("contact_database").select(
            "first_name, last_name, title, account_name, email"
        ).or_(
            f"website.eq.{website},website.eq.www.{website},email_domain.eq.{website}"
        ).limit(limit - len(contacts)).execute()

        for row in (result.data or []):
            if row.get("email"):
                contacts.append(row)

    print(f"   Matched {len(contacts)} contacts")

    if not contacts:
        print("⚠️ No contacts found for HIGH-fit leads.")
        return

    # 3. Write CSV
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["First Name", "Last Name", "Title", "Company Name", "Email"])
        for c in contacts:
            writer.writerow([
                c.get("first_name", ""),
                c.get("last_name", ""),
                c.get("title", ""),
                c.get("account_name", ""),
                c.get("email", ""),
            ])

    print(f"✅ Exported {len(contacts)} contacts → {output_path}")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "high_fit_contacts.csv"
    export_contacts(out)
