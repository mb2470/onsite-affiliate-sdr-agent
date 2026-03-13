#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

// --- CONFIG ---
const API_URL = process.env.DEV_AGENT_API_URL || 'https://sdr.onsiteaffiliate.com';
const SECRET = process.env.DEV_AGENT_SECRET;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const LLM_URL = process.env.LLM_API_URL || 'http://localhost:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.2:3b';

if (!SECRET) { console.error('DEV_AGENT_SECRET is required'); process.exit(1); }
const authHeaders = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };

// --- UTILS ---
async function apiFetch(path, options = {}) {
  const url = `${API_URL}/.netlify/functions/dev-agent${path}`;
  const res = await fetch(url, { ...options, headers: { ...authHeaders, ...options.headers } });
  return res.json();
}

/**
 * Pro-Mode: Helper to read relevant files for context
 */
async function getFileContext(instruction) {
  // Simple logic: If the instruction mentions "search" or "timeout", look for related files
  const files = await fs.readdir(REPO_DIR, { recursive: true });
  const relevantFiles = files.filter(f => 
    !f.includes('node_modules') && !f.includes('.git') && 
    (f.includes('search') || f.includes('chat') || f.includes('api'))
  ).slice(0, 3); // Take top 3 relevant files

  let context = "";
  for (const f of relevantFiles) {
    const content = await fs.readFile(path.join(REPO_DIR, f), 'utf8');
    context += `\n--- FILE: ${f} ---\n${content}\n`;
  }
  return context;
}

// --- CORE ENGINE ---
async function runLocalLLM(spec) {
  const branchName = `dev-agent/fix-${Date.now()}`;
  let filesChanged = [];

  try {
    await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR });
    await execFileAsync('git', ['checkout', '-b', branchName], { cwd: REPO_DIR });

    console.log(`  Scanning repo for context...`);
    const codeContext = await getFileContext(spec);

    console.log(`  Asking Llama to write the code...`);
    const prompt = `
      CONTEXT FROM FILES:
      ${codeContext}

      TASK:
      ${spec}

      INSTRUCTIONS:
      Provide ONLY the corrected code for the file that needs fixing. 
      Format: [FILENAME]:[FULL CODE CONTENT]
    `;

    const response = await fetch(`${LLM_URL}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: LLM_MODEL, prompt: prompt, stream: false })
    });

    const data = await response.json();
    const output = data.response;

    // --- FILE WRITING LOGIC ---
    if (output.includes(':')) {
      const [fileName, ...contentParts] = output.split(':');
      const cleanFileName = fileName.trim().replace(/\[|\]/g, '');
      const newContent = contentParts.join(':').trim();
      
      const fullPath = path.join(REPO_DIR, cleanFileName);
      if (await fs.stat(fullPath).catch(() => false)) {
        await fs.writeFile(fullPath, newContent);
        filesChanged.push(cleanFileName);
        console.log(`  ✍️  Modified: ${cleanFileName}`);
      }
    }

    // --- GIT PUSH ---
    console.log(`  Committing and Pushing...`);
    await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR });
    await execFileAsync('git', ['commit', '-m', `dev-agent: implemented ${spec.substring(0, 30)}`], { cwd: REPO_DIR });
    await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_DIR });

    return { status: 'completed', result_summary: output, branch_name: branchName, files_changed: filesChanged };
  } catch (error) {
    return { status: 'failed', error_message: error.message };
  }
}

// --- MAIN LOOP ---
async function main() {
  console.log(`GOD MODE ACTIVE: Local Agent Reading/Writing Files...`);
  while (true) {
    try {
      const data = await apiFetch('?action=poll');
      if (data.request) {
        console.log(`\n[${new Date().toLocaleTimeString()}] 🚀 Task: ${data.request.title}`);
        await apiFetch(`?action=claim&id=${data.request.id}`, { method: 'POST' });
        const result = await runLocalLLM(data.request.spec);
        await apiFetch('?action=complete', { method: 'POST', body: JSON.stringify({ id: data.request.id, ...result }) });
        console.log(`  ✅ Task Finalized.`);
      }
    } catch (err) { console.error('Poll Error:', err.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main();
