import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const {
  DEV_AGENT_SECRET,
  LLM_API_URL,
  LLM_MODEL,
  REPO_DIR
} = process.env;

// 1. Environment Validation
if (!DEV_AGENT_SECRET || !LLM_API_URL || !LLM_MODEL || !REPO_DIR) {
  console.error('❌ Missing required environment variables: Ensure DEV_AGENT_SECRET, LLM_API_URL, LLM_MODEL, and REPO_DIR are set.');
  process.exit(1);
}

const API_BASE = 'https://sdr.onsiteaffiliate.com/.netlify/functions/dev-agent';
const AUTH_HEADERS = { 
  'Authorization': `Bearer ${DEV_AGENT_SECRET}`,
  'Content-Type': 'application/json' 
};

async function chatWithLLM(messages, options = {}) {
  const response = await fetch(`${LLM_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: 0.1,
      ...options
    })
  });
  const data = await response.json();
  return data.choices[0].message.content;
}

const SYSTEM_PROMPT = `You are an expert full-stack developer agent.
You follow instructions perfectly and provide code edits in the requested JSON format.`;

// 2. Task Polling
async function getTask() {
  try {
    const res = await fetch(`${API_BASE}?action=poll`, { headers: AUTH_HEADERS });
    const text = await res.text();
    if (!text || res.status !== 200) return null;
    const data = JSON.parse(text);
    return data.request || null;
  } catch (err) {
    return null;
  }
}

// 3. Task Lifecycle Management (Claim/Complete/Fail)
async function updateTaskStatus(id, action, result = {}) {
  try {
    await fetch(`${API_BASE}?action=${action}`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ id, ...result })
    });
    console.log(`  🔹 Task ${id} status updated to: ${action}`);
  } catch (e) {
    console.error(`  ⚠️ Lifecycle sync failed for ${id} (${action}):`, e.message);
  }
}

async function analyzeAndPlan(task, projectStructure) {
  const planPrompt = `Task: ${task.instruction}\nStructure:\n${projectStructure}\nReturn ONLY JSON: {"analysis":"string","files_to_read":["string"],"files_to_modify":["string"]}`;
  const response = await chatWithLLM([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: planPrompt }]);
  try {
    const match = response.match(/\{[\s\S]*\}/);
    return JSON.parse(match[0]);
  } catch (e) { 
    console.error("  ❌ Failed to parse plan JSON");
    return null; 
  }
}

async function generateEdits(task, filesContent) {
  const contentContext = Object.entries(filesContent).map(([p, c]) => `=== ${p} ===\n${c}`).join('\n\n');
  const editPrompt = `Task: ${task.instruction}\nFiles:\n${contentContext}\nReturn ONLY JSON: {"edits":[{"file":"string","original":"string","replacement":"string"}]}`;
  const response = await chatWithLLM([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: editPrompt }], { maxTokens: 8192 });
  try {
    const match = response.match(/\{[\s\S]*\}/);
    return JSON.parse(match[0]);
  } catch (e) { 
    console.error("  ❌ Failed to parse edit JSON");
    return null; 
  }
}

async function run() {
  console.log(`🚀 Agent active. Connecting to ${LLM_MODEL} at ${LLM_API_URL}`);
  
  // Health Check
  try {
    await chatWithLLM([{ role: 'user', content: 'hi' }]);
    console.log('✅ LLM Connection: OK');
  } catch (e) {
    console.error('❌ LLM Connection: FAILED. Check Ollama/VPN.');
    process.exit(1);
  }

  while (true) {
    const task = await getTask();
    if (task && task.id) {
      console.log(`\n📬 New Task Received: ${task.id}`);
      
      // Claim the task so other agents don't grab it
      await updateTaskStatus(task.id, 'claim');

      try {
        const structure = execSync('find . -maxdepth 2 -not -path "*/.*"', { cwd: REPO_DIR }).toString();
        const plan = await analyzeAndPlan(task, structure);
        if (!plan) throw new Error("LLM failed to generate a valid plan.");

        const filesContent = {};
        for (const file of plan.files_to_read) {
          const fullPath = path.join(REPO_DIR, file);
          if (fs.existsSync(fullPath)) {
            filesContent[file] = fs.readFileSync(fullPath, 'utf8');
          }
        }

        const result = await generateEdits(task, filesContent);
        if (result?.edits) {
          for (const edit of result.edits) {
            const fullPath = path.join(REPO_DIR, edit.file);
            if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${edit.file}`);
            
            const content = fs.readFileSync(fullPath, 'utf8');
            
            // Bulletproof replacement: ensures exact match and replaces all occurrences
            const parts = content.split(edit.original);
            if (parts.length < 2) throw new Error(`Could not find exact match in ${edit.file} for the requested edit.`);
            
            const updatedContent = parts.join(edit.replacement);
            fs.writeFileSync(fullPath, updatedContent);
            console.log(`  💾 Applied edits to ${edit.file}`);
          }
          
          // Finalize task on server
          await updateTaskStatus(task.id, 'complete', { status: 'success' });
          console.log(`  🎉 Task ${task.id} finished successfully.`);
        }
      } catch (err) {
        console.error(`  ❌ Task Error: ${err.message}`);
        await updateTaskStatus(task.id, 'fail', { error: err.message });
      }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

run();

