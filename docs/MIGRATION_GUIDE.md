"""
   Import 500k contact database CSV into Supabase
   
   Usage:
       python import_contacts.py contacts.csv
   """
   
   import sys
   import csv
   import os
   from supabase import create_client
   from dotenv import load_dotenv
   
   load_dotenv()
   
   SUPABASE_URL = os.getenv("SUPABASE_URL")
   SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
   
   supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
   
   def import_contacts(csv_file: str):
       """Import contacts from CSV to Supabase"""
       
       print(f"📂 Reading {csv_file}...")
       
       with open(csv_file, 'r', encoding='utf-8') as f:
           reader = csv.DictReader(f)
           
           batch = []
           total = 0
           
           for i, row in enumerate(reader, 1):
               # Map CSV columns to database columns
               contact = {
                   "website": row.get("Website", "").strip(),
                   "account_name": row.get("Account Name", "").strip(),
                   "first_name": row.get("First Name", "").strip(),
                   "last_name": row.get("Last Name", "").strip(),
                   "title": row.get("Title", "").strip(),
                   "email": row.get("Email", "").strip(),
                   "linkedin_url": row.get("LinkedIn", "").strip() if "LinkedIn" in row else None
               }
               
               # Skip if no email
               if not contact["email"]:
                   continue
               
               batch.append(contact)
               
               # Insert in batches of 1000
               if len(batch) >= 1000:
                   try:
                       supabase.table("contact_database").insert(batch).execute()
                       total += len(batch)
                       print(f"✅ Imported {total} contacts...")
                       batch = []
                   except Exception as e:
                       print(f"❌ Error at row {i}: {e}")
                       # Continue with next batch
                       batch = []
           
           # Insert remaining
           if batch:
               try:
                   supabase.table("contact_database").insert(batch).execute()
                   total += len(batch)
               except Exception as e:
                   print(f"❌ Error with final batch: {e}")
       
       print(f"\n🎉 Import complete! Total contacts imported: {total}")
   
   if __name__ == "__main__":
       if len(sys.argv) != 2:
           print("Usage: python import_contacts.py <csv_file>")
           sys.exit(1)
       
       csv_file = sys.argv[1]
       
       if not os.path.exists(csv_file):
           print(f"❌ File not found: {csv_file}")
           sys.exit(1)
       
       import_contacts(csv_file)
