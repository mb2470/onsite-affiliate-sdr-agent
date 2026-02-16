## 🚀 Supabase Migration (NEW!)
   
   This project is being migrated to **Supabase + AI Agent** for fully autonomous SDR workflow.
   
   ### New Features
   - ✅ Autonomous lead enrichment with Claude
   - ✅ Automatic contact discovery from 500k database
   - ✅ AI-powered email drafting (90 words, Amazon proof point)
   - ✅ Automatic sending via Gmail API
   - ✅ Real-time status tracking in Supabase
   - ✅ Queue-based job processing
   
   ### Migration Status
   - [x] Database schema created
   - [ ] Contact database imported
   - [ ] Gmail workspace configured
   - [ ] AI agent deployed
   - [ ] Automation enabled
   
   📖 **See [Migration Guide](/docs/MIGRATION_GUIDE.md) for setup instructions**
   
   ---
   
   ## Legacy Frontend (React App)
   
   The original React app is still functional for manual workflows.
```

4. Scroll down and commit: `Update README with Supabase migration info`

---

### **Step 10: Add .gitignore for Agent**

1. Click **"Add file"** → **"Create new file"**

2. Filename: `agent/.gitignore`

3. Paste this:
```
   # Environment variables
   .env
   
   # Python
   __pycache__/
   *.py[cod]
   *$py.class
   *.so
   .Python
   venv/
   env/
   ENV/
   
   # Credentials
   gmail_token.json
   credentials.json
   
   # Logs
   *.log
   
   # IDE
   .vscode/
   .idea/
   *.swp
   *.swo
```

4. Commit message: `Add .gitignore for agent directory`

5. Click **"Commit new file"**

---

## ✅ Final Repository Structure

After all these steps, your repo will look like this:
```
onsite-affiliate-sdr-agent/
├── README.md (updated)
├── package.json
├── src/
│   ├── App.jsx
│   ├── App.css
│   └── ...
├── netlify/
│   └── functions/
│       ├── csv-contacts.js
│       ├── claude.js
│       └── ...
├── supabase/                    ← NEW
│   ├── README.md
│   └── schema.sql
├── agent/                       ← NEW
│   ├── README.md
│   ├── ai_sdr_agent.py
│   ├── import_contacts.py
│   ├── requirements.txt
│   ├── .env.example
│   └── .gitignore
└── docs/                        ← NEW
    └── MIGRATION_GUIDE.md
