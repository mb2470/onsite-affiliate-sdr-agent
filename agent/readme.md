# AI SDR Agent
   
   Autonomous agent that handles the complete SDR workflow:
   - Lead enrichment
   - Contact discovery
   - Email drafting
   - Email sending via Gmail
   
   ## Files
   - `ai_sdr_agent.py` - Main agent code
   - `requirements.txt` - Python dependencies
   - `.env.example` - Environment variables template
   
   ## Usage
```bash
   # Run full workflow
   python ai_sdr_agent.py workflow <lead-id>
   
   # Process job queue
   python ai_sdr_agent.py process-jobs
```
   
   See `/docs/MIGRATION_GUIDE.md` for setup instructions.
```

4. Click **"Commit new file"**

---

### **Step 4: Add ai_sdr_agent.py**

1. Click **"Add file"** → **"Create new file"**

2. Filename: `agent/ai_sdr_agent.py`

3. **Copy the entire ai_sdr_agent.py content** I created earlier

4. Paste it in

5. Commit message: `Add autonomous AI SDR agent`

6. Click **"Commit new file"**

---

### **Step 5: Add requirements.txt**

1. Click **"Add file"** → **"Create new file"**

2. Filename: `agent/requirements.txt`

3. Paste this:
```
   supabase>=2.0.0
   anthropic>=0.20.0
   google-api-python-client>=2.100.0
   google-auth-httplib2>=0.1.1
   google-auth-oauthlib>=1.1.0
   python-dotenv>=1.0.0
