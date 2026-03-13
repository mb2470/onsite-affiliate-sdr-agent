import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const { DEV_AGENT_SECRET, LLM_API_URL, LLM_MODEL, REPO_DIR } = process.env;

if (!DEV_AGENT_SECRET || !LLM_API_URL || !LLM_MODEL || !REPO_DIR) {
  console.error('❌ Missing env vars.');
  process.exit(1);
}

const API_BASE = 'https://sdr.onsiteaffiliate.com/.netlify/functions/dev-agent';
const AUTH_HEADERS = { 'Authorization': `Bearer ${DEV_AGENT_SECRET}`, 'Content-Type': 'application/json' };

function validatePath(filePath) {
  const resolved = path.resolve(REPO_DIR, filePath);
  if (!resolved.startsWith(path.resolve(REPO_DIR))) throw new Error(`Path traversal: ${filePath}`);
  return resolved;
}

async function chatWithLLM(messages, options = {}) {
  const response = await fetch(`${LLM_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.1, ...options })
  });
  const data = await response.json();
  if (!data.choices?.[0]?.message?.content) throw new Error("LLM returned empty response");
  return data.choices[0].message.content;
}

async function updateTaskStatus(id, action, result = {}) {
  try {
    await fetch(`${API_BASE}?action=${action}`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ id, ...result })
    });
    console.log(`  🔹 Status updated: ${action}`);
  } catch (e) { console.error(`  ⚠️ Lifecycle error: ${e.message}`); }
}

async function run() {
  console.log(`🚀 Agent active. Repository: ${REPO_DIR}`);
  
  while (true) {
    try {
      const res = await fetch(`${API_BASE}?action=poll`, { headers: AUTH_HEADERS });
      const data = await res.json();
      const task = data.request;

      if (task?.id) {
        console.log(`\n📬 Task: ${task.id}`);
        await updateTaskStatus(task.id, 'claim');

        try {
          // Cross-platform structure fetch
          const structure = execSync(process.platform === 'win32' ? 'dir /s /b' : 'find . -maxdepth 2 -not -path "*/.*"', { cwd: REPO_DIR }).toString();
          
          const planRes = await chatWithLLM([{ role: 'system', content: "Return ONLY JSON" }, { role: 'user', content: `Task: ${task.instruction}\nStructure:\n${structure}\nReturn JSON: {"files_to_read":["string"]}` }]);
          const planMatch = planRes.match(/\{[\s\S]*\}/);
          if (!planMatch) throw new Error("Invalid Plan JSON");
          const plan = JSON.parse(planMatch[0]);

          const filesContent = {};
          for (const file of (plan.files_to_read || [])) {
            const fullPath = validatePath(file);
            if (fs.existsSync(fullPath)) filesContent[file] = fs.readFileSync(fullPath, 'utf8');
          }

          const editRes = await chatWithLLM([{ role: 'system', content: "Return ONLY JSON" }, { role: 'user', content: `Task: ${task.instruction}\nFiles:\n${JSON.stringify(filesContent)}\nReturn JSON: {"edits":[{"file":"string","original":"string","replacement":"string"}]}` }], { maxTokens: 8192 });
          const editMatch = editRes.match(/\{[\s\S]*\}/);
          if (!editMatch) throw new Error("Invalid Edit JSON");
          const result = JSON.parse(editMatch[0]);

          if (result?.edits) {
            for (const edit of result.edits) {
              const fullPath = validatePath(edit.file);
              const content = fs.readFileSync(fullPath, 'utf8');
              const parts = content.split(edit.original);
              if (parts.length < 2) throw new Error(`Match not found in ${edit.file}`);
              fs.writeFileSync(fullPath, parts.join(edit.replacement));
            }

            // Sanitized Git Ops
            const safeMsg = task.instruction.slice(0, 50).replace(/["'`$\\]/g, '');
            console.log("  git: syncing changes...");
            execSync(`git add . && git commit -m "agent: ${safeMsg}" && git push origin main`, { cwd: REPO_DIR, stdio: 'inherit' });
            
            await updateTaskStatus(task.id, 'complete', { status: 'success' });
            console.log(`  🎉 Finished.`);
          }
        } catch (taskErr) {
          console.error(`  ❌ Task Failed: ${taskErr.message}`);
          await updateTaskStatus(task.id, 'fail', { error: taskErr.message });
        }
      }
    } catch (err) {
      if (!err.message.includes('Unexpected token')) console.error(`❌ Loop Error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}
run();
