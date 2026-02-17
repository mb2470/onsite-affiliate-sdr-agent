# 🔌 MCP Integration for AI SDR Agent

**Model Context Protocol** integration that gives Claude direct access to your Supabase database and agent controls.

---

## 🎯 **What This Enables:**

With MCP, you can chat with Claude and ask things like:

- *"Show me all HIGH ICP leads that haven't been contacted yet"*
- *"What emails failed today and why?"*
- *"Update the agent to only process HIGH and MEDIUM leads"*
- *"Get details on revolut.com including all contacts and emails"*
- *"What are my pipeline stats for this week?"*
- *"Pause the agent"*

Claude will use the MCP tools to query Supabase and execute actions!

---

## 📦 **Installation**

### **Step 1: Create MCP Directory**

```bash
# In your project root
mkdir mcp
cd mcp

# Copy files
cp /path/to/mcp-server.js ./server.js
cp /path/to/mcp-package.json ./package.json

# Create .env
cp ../.env .env
# Or create new .env with:
# SUPABASE_URL=https://vzghstujcvjmcqndtchb.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### **Step 2: Install Dependencies**

```bash
npm install
```

### **Step 3: Test the Server**

```bash
npm start
```

You should see:
```
AI SDR Agent MCP server running on stdio
```

Press Ctrl+C to stop.

---

## 🖥️ **Claude Desktop Configuration**

### **For macOS:**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-sdr-agent": {
      "command": "node",
      "args": ["/absolute/path/to/your/project/mcp/server.js"],
      "env": {
        "SUPABASE_URL": "https://vzghstujcvjmcqndtchb.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your_service_role_key_here"
      }
    }
  }
}
```

### **For Windows:**

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-sdr-agent": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\path\\to\\project\\mcp\\server.js"],
      "env": {
        "SUPABASE_URL": "https://vzghstujcvjmcqndtchb.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your_service_role_key_here"
      }
    }
  }
}
```

**Important:** Use absolute paths!

---

## 🚀 **Usage**

### **Restart Claude Desktop**

After configuring, fully quit and restart Claude Desktop.

### **Verify Connection**

In Claude Desktop, you should see a 🔌 icon indicating MCP is connected.

### **Example Queries:**

```
You: Show me all HIGH ICP leads that are enriched but not contacted yet

Claude: [Uses get_leads tool with status=enriched and icp_fit=HIGH]
```

```
You: What are today's stats?

Claude: [Uses get_pipeline_stats tool]
```

```
You: Get full details on halara.com

Claude: [Uses get_lead_details tool]
```

```
You: Turn off the agent

Claude: [Uses update_agent_settings tool with agent_enabled=false]
```

```
You: Show me recent failed activities

Claude: [Uses get_activity_log with status=failed]
```

---

## 🛠️ **Available Tools**

The MCP server provides these tools to Claude:

### **Data Query Tools:**
- `get_leads` - Query leads with filters (status, ICP, search)
- `get_lead_details` - Get full details for a specific lead
- `get_contacts` - Get contacts with filters
- `get_emails` - Get drafted/sent emails
- `get_activity_log` - Get agent activity history
- `get_pipeline_stats` - Get pipeline metrics

### **Management Tools:**
- `get_agent_settings` - View current agent configuration
- `update_agent_settings` - Change agent settings
- `update_lead` - Update lead status/ICP/notes
- `search_pipeline` - Natural language search across all data

---

## 🔐 **Security Notes**

- ✅ Uses SERVICE_ROLE_KEY for full database access
- ⚠️ Only install on your personal machine
- ⚠️ Don't share the config file (contains secrets)
- ✅ MCP runs locally, data doesn't leave your machine

---

## 🧪 **Testing**

### **Test Individual Tools:**

Create a test script `test-mcp.js`:

```javascript
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Test query
const { data, error } = await supabase
  .from('leads')
  .select('*')
  .limit(5);

console.log('Leads:', data);
console.log('Error:', error);
```

Run:
```bash
node test-mcp.js
```

---

## 📊 **Example Workflows**

### **Morning Briefing:**
```
You: Give me a morning briefing on the agent

Claude will:
- Check agent health status
- Show today's stats
- List recent activities
- Highlight any failures
```

### **Pipeline Review:**
```
You: Show me all HIGH ICP leads ready for outreach

Claude will:
- Query enriched HIGH ICP leads
- Show contact counts
- Display email status
```

### **Quick Updates:**
```
You: Change max emails per day to 75

Claude will:
- Update agent settings
- Confirm the change
```

---

## 🐛 **Troubleshooting**

### **MCP Not Showing in Claude Desktop**

1. Check config file syntax (valid JSON)
2. Use absolute paths
3. Restart Claude Desktop completely
4. Check logs: `~/Library/Logs/Claude/mcp.log` (macOS)

### **"Connection Failed" Error**

1. Test server runs: `npm start` in mcp directory
2. Verify Node.js installed: `node --version`
3. Check environment variables are set

### **Database Errors**

1. Verify SUPABASE_URL is correct
2. Confirm SERVICE_ROLE_KEY (not anon key!)
3. Test Supabase connection with test script

---

## 🔄 **Updating**

When you update the MCP server code:

1. Save new `server.js`
2. Restart Claude Desktop
3. That's it!

---

## 🎓 **Advanced: Custom Tools**

Want to add more tools? Edit `server.js`:

```javascript
{
  name: 'my_custom_tool',
  description: 'Does something useful',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string' }
    },
    required: ['param']
  }
}
```

Then add handler in `CallToolRequestSchema`.

---

## ✅ **Success Checklist**

- [ ] MCP directory created with server.js and package.json
- [ ] Dependencies installed (`npm install`)
- [ ] .env file configured with credentials
- [ ] Claude Desktop config updated
- [ ] Claude Desktop restarted
- [ ] 🔌 icon visible in Claude Desktop
- [ ] Test query works (e.g., "show me leads")

---

**You can now manage your entire AI SDR agent through conversation with Claude!** 🎉
