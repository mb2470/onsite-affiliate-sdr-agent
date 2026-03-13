import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { spawnSync, execSync } from 'child_process';

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

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
  if (result.status !== 0 && !result.stderr.includes('nothing to commit')) {
    throw new Error(`Git error: ${result.stderr}`);
  }
  return result;
}

async function chatWithLLM(messages, options = {}) {
  const response = await fetch(`${LLM_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.1, ...options })
  });
  const data = await response.json();
  if (data.error || !data.choices?.[0]?.message?.content) {
    throw new Error(`LLM Error: ${data.error?.message || 'Empty response'}`);
  }
  return data.choices[0].message.content;
}

async function updateTaskStatus(id, action, result = {}) {
  try {
    await fetch(`${API_BASE}?action=${action}`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ id, ...result })
    });
  } catch (e) { console.error(`  ⚠️ Lifecycle error: ${e.message}`); }
}

async function run() {
  console.log(`🚀 Agent Securely Active. Repository: ${REPO_DIR}`);
  
  while (true) {
    try {
      const res = await fetch(`${API_BASE}?action=poll`, { headers: AUTH_HEADERS });
      const data = await res.json();
      const task = data.request;

      if (task?.id) {
        console.log(`\n📬 Task: ${task.id}`);
        await updateTaskStatus(task.id, 'claim');

        try {
          // Cross-platform structure fetch with relative path normalization
          let structure = "";
          if (process.platform === 'win32') {
            structure = execSync('dir /s /b /a-d', { cwd: REPO_DIR }).toString()
              .split('\n')
              .map(p => path.relative(REPO_DIR, p.trim()))
              .join('\n');
          } else {
            structure = execSync('find . -maxdepth 3 -not -path "*/.*"', { cwd: REPO_DIR }).toString();
          }
          
          const planRes = await chatWithLLM([{ role: 'system', content: "Return ONLY JSON" }, { role: 'user', content: `Task: ${task.instruction}\nStructure:\n${structure}\nReturn JSON: {"files_to_read":["string"]}` }]);
          const planMatch = planRes.match(/\{[\s\S]*\}/);
          if (!planMatch) throw new Error("LLM returned non-JSON for plan");
          const plan = JSON.parse(planMatch[0]);

          const filesContent = {};
          for (const file of (plan.files_to_read || [])) {
            const fullPath = validatePath(file);
            if (fs.existsSync(fullPath)) filesContent[file] = fs.readFileSync(fullPath, 'utf8');
          }

          const editRes = await chatWithLLM([{ role: 'system', content: "Return ONLY JSON" }, { role: 'user', content: `Task: ${task.instruction}\nFiles:\n${JSON.stringify(filesContent)}\nReturn JSON: {"edits":[{"file":"string","original":"string","replacement":"string"}]}` }], { maxTokens: 8192 });
          const editMatch = editRes.match(/\{[\s\S]*\}/);
          if (!editMatch) throw new Error("LLM returned non-JSON for edits");
          const result = JSON.parse(editMatch[0]);

          if (result?.edits && result.edits.length > 0) {
            for (const edit of result.edits) {
              const fullPath = validatePath(edit.file);
              const content = fs.readFileSync(fullPath, 'utf8');
              const parts = content.split(edit.original);
              if (parts.length < 2) throw new Error(`Match not found in ${edit.file}`);
              fs.writeFileSync(fullPath, parts.join(edit.replacement));
            }

            console.log("  git: syncing changes...");
            runGit(['add', '.']);
            const commitMsg = `agent: ${task.instruction.slice(0, 50).replace(/["\n\r]/g, '')}`;
            runGit(['commit', '-m', commitMsg]);
            runGit(['push', 'origin', 'main']);
            
            await updateTaskStatus(task.id, 'complete', { status: 'success' });
            console.log(`  🎉 Finished.`);
          } else {
             await updateTaskStatus(task.id, 'complete', { status: 'no_changes' });
             console.log(`  ℹ️ No changes required.`);
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
