from google_auth_oauthlib.flow import InstalledAppFlow
import json

SCOPES = ['https://www.googleapis.com/auth/gmail.send']

def authorize():
    print("🔐 Starting Gmail authorization...")
    print("📂 Looking for credentials.json...")
    
    try:
        flow = InstalledAppFlow.from_client_secrets_file(
            'credentials.json', SCOPES)
        
        print("🌐 Opening browser for authorization...")
        creds = flow.run_local_server(port=0)
        
        # Save the credentials
        with open('gmail_token.json', 'w') as token:
            token.write(creds.to_json())
        
        print("\n" + "="*60)
        print("✅ Gmail authorized successfully!")
        print("="*60)
        print("📄 Token saved to gmail_token.json")
        print("\n🔐 SAVE THIS FOR YOUR .env FILE:")
        print("-"*60)
        print(f'GMAIL_OAUTH_CREDENTIALS=\'{creds.to_json()}\'')
        print("-"*60)
        
    except FileNotFoundError:
        print("❌ ERROR: credentials.json not found!")
        print("Please download your OAuth credentials and save as credentials.json")
    except Exception as e:
        print(f"❌ ERROR: {e}")

if __name__ == '__main__':
    authorize()