# Gmail Integration Setup Guide

## Overview

Your AI SDR Agent sends emails autonomously via the Gmail API using OAuth2.
The setup is a **one-time local authorization** that generates a refresh token,
which your cloud server uses to send emails indefinitely.

## Step-by-Step Setup

### 1. Google Cloud Console (already done ✅)

Your project: `ai-sdr-agent-487801`

**⚠️ IMPORTANT: Rotate your OAuth client secret!**
Your credentials.json was shared in chat. Go to:
- Google Cloud Console → APIs & Services → Credentials
- Click your OAuth client → Reset Secret → Download new credentials.json

### 2. Ensure Gmail API is Enabled

- Go to: https://console.cloud.google.com/apis/library/gmail.googleapis.com
- Make sure it says "Enabled"

### 3. Configure OAuth Consent Screen

- Go to: APIs & Services → OAuth consent screen
- User type: **External** (or Internal if using Google Workspace)
- Add scope: `https://www.googleapis.com/auth/gmail.send`
- Add your Gmail address as a **Test user** (required while app is in "Testing" status)

### 4. Run Authorization Locally (one-time)

On your local machine (NOT the cloud server):

```bash
# Navigate to agent directory
cd agent

# Install dependencies
pip install google-auth google-auth-oauthlib google-api-python-client

# Place your credentials.json in this directory
# Then run:
python authorize_gmail.py
```

This will:
1. Open your browser
2. Ask you to sign in with the Gmail account you want to send from
3. Ask you to grant "Send email" permission
4. Print the `GMAIL_OAUTH_CREDENTIALS` value for your .env file
5. Save it to `env_gmail_values.txt` for easy copying

### 5. Set Environment Variables on Cloud Server

Add these to your cloud server's environment:

```
SUPABASE_URL=https://vzghstujcvjmcqndtchb.supabase.co
SUPABASE_SERVICE_KEY=<your service_role key from Supabase>
ANTHROPIC_API_KEY=sk-ant-<your key>
GMAIL_OAUTH_CREDENTIALS='<the JSON string from step 4>'
GMAIL_FROM_EMAIL=your-sending-email@gmail.com
```

### 6. Verify Gmail Connection

```bash
python ai_sdr_agent.py verify-gmail
# Should print: ✅ Gmail connected: your-email@gmail.com
```

### 7. Run the Agent

```bash
# Process all pending leads autonomously
python ai_sdr_agent.py auto

# Or run individual steps
python ai_sdr_agent.py enrich <lead_id>
python ai_sdr_agent.py workflow <lead_id>
```

## How Auto Mode Works

When you run `python ai_sdr_agent.py auto`, the agent:

1. **Checks settings** from your Supabase `agent_settings` table
2. **Sends pending drafts** - any emails in "draft" status get sent
3. **Enriches new leads** - researches up to 20 unenriched leads
4. **Finds contacts** - searches your contact database for decision makers
5. **Drafts & sends emails** - creates personalized emails and sends them

All behavior is controlled by your dashboard settings:
- Max emails per day
- Send hours (EST)
- Minutes between emails
- ICP fit filter
- Minimum match score
- Auto-send on/off

## Running on a Schedule

### Railway / Render (Cron Job)
Set up a cron job to run every 30-60 minutes during business hours:
```
0 9-17 * * 1-5 cd /app/agent && python ai_sdr_agent.py auto
```

### GitHub Actions (free option)
Create `.github/workflows/sdr-agent.yml`:
```yaml
name: Run SDR Agent
on:
  schedule:
    - cron: '0 14-22 * * 1-5'  # 9am-5pm EST, weekdays
  workflow_dispatch:  # Manual trigger

jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install -r agent/requirements.txt
      - run: python agent/ai_sdr_agent.py auto
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GMAIL_OAUTH_CREDENTIALS: ${{ secrets.GMAIL_OAUTH_CREDENTIALS }}
          GMAIL_FROM_EMAIL: ${{ secrets.GMAIL_FROM_EMAIL }}
```

## Token Refresh

The Gmail OAuth refresh token **does not expire** as long as:
- The Google Cloud project stays active
- The OAuth consent screen remains configured
- You don't revoke access

The agent automatically refreshes the access token when it expires (every ~1 hour).
You should never need to re-authorize unless you revoke permissions.

## Troubleshooting

| Error | Fix |
|-------|-----|
| "GMAIL_OAUTH_CREDENTIALS not set" | Add the env var from authorize_gmail.py output |
| "Token expired and no refresh token" | Re-run authorize_gmail.py locally |
| "Access Not Configured" | Enable Gmail API in Google Cloud Console |
| "User not in test users" | Add your email to OAuth consent screen test users |
| 403 Forbidden | Check that gmail.send scope is configured |
