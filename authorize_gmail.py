"""
Gmail OAuth Authorization Script
Run this ONCE on your local machine to generate the refresh token.
Then copy the GMAIL_OAUTH_CREDENTIALS value to your cloud server's .env file.
"""

from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import json
import os

SCOPES = ['https://www.googleapis.com/auth/gmail.send']

def authorize():
    print("=" * 60)
    print("🔐 Gmail OAuth Authorization for AI SDR Agent")
    print("=" * 60)
    
    creds = None
    
    # Check for existing token
    if os.path.exists('gmail_token.json'):
        print("\n📄 Found existing gmail_token.json, loading...")
        creds = Credentials.from_authorized_user_file('gmail_token.json', SCOPES)
    
    # If no valid creds, do the OAuth flow
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            print("🔄 Token expired, refreshing...")
            creds.refresh(Request())
        else:
            if not os.path.exists('credentials.json'):
                print("❌ ERROR: credentials.json not found!")
                print("Download it from Google Cloud Console → Credentials → Your OAuth Client → Download JSON")
                return
            
            print("\n📂 Loading credentials.json...")
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            
            print("🌐 Opening browser for authorization...")
            print("   → Sign in with the Gmail account you want to send FROM")
            print("   → Click 'Allow' to grant send permission\n")
            
            creds = flow.run_local_server(port=8080)
        
        # Save token locally
        with open('gmail_token.json', 'w') as token:
            token.write(creds.to_json())
        print("💾 Token saved to gmail_token.json")
    
    # Build the credentials JSON for .env
    creds_dict = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes) if creds.scopes else SCOPES
    }
    
    creds_json = json.dumps(creds_dict)
    
    print("\n" + "=" * 60)
    print("✅ Gmail authorized successfully!")
    print("=" * 60)
    
    # Verify it works
    try:
        from googleapiclient.discovery import build
        service = build('gmail', 'v1', credentials=creds)
        profile = service.users().getProfile(userId='me').execute()
        print(f"\n📧 Authorized email: {profile['emailAddress']}")
        print(f"   Total messages: {profile.get('messagesTotal', 'N/A')}")
    except Exception as e:
        print(f"\n⚠️  Could not verify (might still work): {e}")
    
    print("\n" + "=" * 60)
    print("📋 COPY THESE TO YOUR CLOUD SERVER .env FILE:")
    print("=" * 60)
    print(f"\nGMAIL_OAUTH_CREDENTIALS='{creds_json}'")
    print(f"\nGMAIL_FROM_EMAIL={profile['emailAddress'] if 'profile' in dir() else 'YOUR_EMAIL@gmail.com'}")
    print("\n" + "=" * 60)
    
    # Also save to a file for easy copying
    with open('env_gmail_values.txt', 'w') as f:
        f.write(f"GMAIL_OAUTH_CREDENTIALS='{creds_json}'\n")
        f.write(f"GMAIL_FROM_EMAIL={profile['emailAddress'] if 'profile' in dir() else 'YOUR_EMAIL@gmail.com'}\n")
    
    print("📄 Also saved to env_gmail_values.txt for easy copying")
    print("\n⚠️  IMPORTANT: Never commit gmail_token.json or env_gmail_values.txt to git!")

if __name__ == '__main__':
    authorize()
