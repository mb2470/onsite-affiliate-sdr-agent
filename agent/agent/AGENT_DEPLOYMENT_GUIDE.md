# 🤖 Autonomous AI SDR Agent - Deployment Guide

Complete guide to deploy and monitor your autonomous AI SDR agent.

---

## 📋 **Prerequisites**

- Python 3.8+
- Node.js & npm (for PM2)
- Supabase project with schema setup
- Anthropic API key
- 500k contacts CSV database

---

## 🚀 **Quick Start**

### **1. Setup Environment Variables**

Create `.env` file in the `agent/` directory:

```bash
cd agent
cp .env.example .env
```

Edit `.env` with your credentials. **Set these in environment only; never commit values.**

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `CONTACTS_CSV_PATH`.

**⚠️ Important:** Use the **SERVICE_ROLE_KEY**, not the anon key!

---

### **2. Run Deployment Script**

```bash
chmod +x deploy.sh
./deploy.sh
```

This will:
- ✅ Install Python dependencies
- ✅ Install PM2 for process management
- ✅ Start the agent
- ✅ Setup auto-restart on failure
- ✅ Configure logging

---

### **3. Verify Agent is Running**

```bash
pm2 status
```

You should see:
```
┌────┬────────────────┬─────────┬─────────┬──────────┬────────┐
│ id │ name           │ mode    │ ↺      │ status   │ cpu    │
├────┼────────────────┼─────────┼─────────┼──────────┼────────┤
│ 0  │ ai-sdr-agent   │ fork    │ 0      │ online   │ 0%     │
└────┴────────────────┴─────────┴─────────┴──────────┴────────┘
```

---

## 📊 **Monitoring**

### **View Logs**

```bash
# Real-time logs
pm2 logs ai-sdr-agent

# Detailed agent log
tail -f agent.log

# Error log
tail -f agent-error.log
```

### **Dashboard Monitoring**

1. Go to your Netlify app
2. Click **"Manage Agent"** tab
3. See **Agent Status** widget showing:
   - 🟢 Active / ⏸️ Paused / 🔴 Offline
   - Last heartbeat timestamp
   - Today's stats (emails sent, leads processed)

### **Check Supabase**

Go to **Supabase → Table Editor**:
- **activity_log** - See all agent actions in real-time
- **emails** - See drafted/sent emails
- **agent_settings** - Check `last_heartbeat` timestamp

---

## 🎛️ **Agent Controls**

### **Via Dashboard**

1. **Turn On/Off**: Click toggle in **Manage Agent** → Agent Status
2. **Adjust Settings**: Change email limits, ICP filters, etc.
3. **Settings take effect**: Next cycle (within 5 minutes)

### **Via Command Line**

```bash
# Stop agent
pm2 stop ai-sdr-agent

# Start agent
pm2 start ai-sdr-agent

# Restart agent (to reload settings)
pm2 restart ai-sdr-agent

# Delete agent
pm2 delete ai-sdr-agent
```

---

## 🔄 **How It Works**

### **Agent Cycle (Every 5 minutes)**

1. **Load Settings** from Supabase
2. **Check if Enabled** (`agent_enabled = true`)
3. **Check Send Hours** (9am-5pm EST by default)
4. **Check Daily Limit** (50 emails/day by default)
5. **Get Leads** with status='enriched' and matching ICP fit
6. **For Each Lead:**
   - Find contacts from CSV database
   - Score contacts by title
   - Generate personalized email with Claude
   - Save as draft (or queue for sending if auto_send=true)
   - Log all activity
   - Wait (min_minutes_between_emails)
7. **Update Heartbeat**
8. **Sleep 5 minutes**, repeat

---

## 🛠️ **Troubleshooting**

### **Agent Not Processing Leads**

**Check logs:**
```bash
tail -f agent.log
```

**Common issues:**
- ❌ Agent disabled in dashboard
- ❌ Outside send hours (9am-5pm EST)
- ❌ Daily limit reached
- ❌ No enriched leads with allowed ICP fit
- ❌ Contacts CSV not found

### **No Heartbeat**

```bash
# Check if process is running
pm2 status

# Check for errors
pm2 logs ai-sdr-agent --err

# Restart
pm2 restart ai-sdr-agent
```

### **Database Errors**

**Verify credentials:**
```bash
# Test Supabase connection
python3 -c "
from supabase import create_client
import os
from dotenv import load_dotenv
load_dotenv()
supabase = create_client(os.getenv('SUPABASE_URL'), os.getenv('SUPABASE_SERVICE_ROLE_KEY'))
print('✅ Connected:', supabase.table('leads').select('count').execute())
"
```

---

## 📈 **Scaling & Performance**

### **Running on Server**

**DigitalOcean / AWS / Linode:**
```bash
# Install dependencies
sudo apt update
sudo apt install python3 python3-pip nodejs npm

# Clone repo
git clone your-repo-url
cd agent

# Deploy
./deploy.sh

# Enable startup on reboot
pm2 startup
pm2 save
```

### **Adjust Processing Speed**

Edit `autonomous_agent.py`:
```python
# Line ~450: Change cycle interval
time.sleep(300)  # 5 minutes (default)
# Change to:
time.sleep(180)  # 3 minutes (faster)
time.sleep(600)  # 10 minutes (slower)
```

### **Increase Email Volume**

In dashboard → **Manage Agent**:
- Max Emails Per Day: 100 (or more)
- Min Minutes Between: 10 (or less)

---

## 🔒 **Security**

- ✅ Never commit `.env` to Git
- ✅ Use SERVICE_ROLE_KEY only on trusted servers
- ✅ Rotate API keys regularly
- ✅ Monitor logs for suspicious activity

---

## 📝 **Maintenance**

### **Update Agent Code**

```bash
git pull origin main
pm2 restart ai-sdr-agent
```

### **Reset Stats**

```sql
-- In Supabase SQL Editor
UPDATE agent_settings 
SET emails_sent_today = 0
WHERE id = '00000000-0000-0000-0000-000000000001';
```

### **Clear Activity Log**

```sql
DELETE FROM activity_log 
WHERE created_at < NOW() - INTERVAL '30 days';
```

---

## 🆘 **Support**

**Check these first:**
1. Agent logs: `tail -f agent.log`
2. PM2 status: `pm2 status`
3. Supabase activity_log table
4. Dashboard heartbeat indicator

**Common Commands:**
```bash
pm2 status              # Check status
pm2 logs ai-sdr-agent   # View logs
pm2 restart ai-sdr-agent # Restart
pm2 monit               # Real-time monitoring
```

---

## ✅ **Success Checklist**

- [ ] `.env` file created with all credentials
- [ ] Contacts CSV accessible at specified path
- [ ] Agent running (`pm2 status` shows "online")
- [ ] Heartbeat updating every minute (check dashboard)
- [ ] Logs showing cycle activity (`tail -f agent.log`)
- [ ] Activity appearing in Supabase activity_log table
- [ ] Dashboard shows agent status as 🟢 Active

---

🎉 **Your autonomous AI SDR agent is now running!**
