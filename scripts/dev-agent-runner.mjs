#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';

const execFileAsync = promisify(execFile);

// --- CONFIG ---
const API_URL = process.env.DEV_AGENT_API_URL || 'https://sdr.onsiteaffiliate.com';
const SECRET = process.env.DEV_AGENT_SECRET;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const REPO_DIR = path.resolve(process.env.REPO_DIR || process.cwd());
const LLM_URL = process.env.LLM_API_URL || 'http://localhost:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:7b';
const MAX_CONTEXT_FILES = parseInt(process.env.MAX_CONTEXT_FILES || '12', 10);

if (!SECRET) { console.error('DEV_AGENT_SECRET is required'); process.exit(1); }
const authHeaders = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };

async function apiFetch(path, options = {}) {
  const url = `${API_URL}/.netlify/functions/dev-agent${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders, ...options.headers },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Use raw http.request for Ollama to avoid fetch/undici timeout issues
function ollamaRequest(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${LLM_URL}/api/chat`);
    const postData = JSON.stringify(body);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 0  // no timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timed out'));
    });

    req.write(postData);
    req.end();
  });
}

async function getFileContext(spec) {
  const files = await fs.readdir(REPO_DIR, { recursive: true });

  // Extract keywords from the task spec for relevance scoring
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'it', 'fix', 'implement', 'add', 'update', 'create']);
  const taskWords = spec.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Filter to code files, exclude junk
  const codeFiles = files.filter(f =>
    !f.includes('node_modules') &&
    !f.includes('.git') &&
    !f.includes('package-lock') &&
    /\.(mjs|js|ts|py|json|md)$/.test(f)
  );

  // Score each file by relevance to the task
  const scored = codeFiles.map(f => {
    const lower = f.toLowerCase();
    const nameParts = lower.replace(/[^a-z0-9]/g, ' ').split(/\s+/);

    let score = 0;

    // Boost for keyword matches in file path
    for (const word of taskWords) {
      if (lower.includes(word)) score += 3;
      // Partial matches (e.g. "email" matches "email_service")
      for (const part of nameParts) {
        if (part.includes(word) || word.includes(part)) score += 1;
      }
    }

    // Boost actual code files over docs
    if (/\.(mjs|js|ts|py)$/.test(f)) score += 2;
    // Boost files in relevant-sounding directories
    if (lower.includes('service') || lower.includes('api') || lower.includes('function') || lower.includes('netlify')) score += 1;
    // Slight penalty for deeply nested files
    const depth = f.split(path.sep).length;
    if (depth > 4) score -= 1;

    return { file: f, score };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, MAX_CONTEXT_FILES);

  console.log(`  Selected ${relevant.length} files for context:`);
  for (const { file, score } of relevant) {
    console.log(`    [score:${score}] ${file}`);
  }

  let ctx = "";
  let totalChars = 0;
  const MAX_CHARS = 60000; // ~15k tokens, safe for num_ctx: 16384

  for (const { file } of relevant) {
    try {
      const content = await fs.readFile(path.join(REPO_DIR, file), 'utf8');
      // Skip files that would blow the context budget
      if (totalChars + content.length > MAX_CHARS) {
        console.log(`    ⏭️  Skipping ${file} (${content.length} chars would exceed budget)`);
        continue;
      }
      ctx += `\n--- FILE: ${file} ---\n${content}\n`;
      totalChars += content.length;
    } catch (e) {}
  }

  console.log(`  Total context: ${totalChars} chars`);
  return ctx;
}

async function runLocalLLM(spec) {
  const branchName = `dev-agent/fix-${Date.now()}`;
  let filesChanged = [];

  try {
    await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR });
    await execFileAsync('git', ['checkout', '-b', branchName], { cwd: REPO_DIR });

    console.log(`  Scanning repo for context...`);
    const codeContext = await getFileContext(spec);

    console.log(`  Asking Qwen2.5-Coder (Chat Mode)...`);
    console.log('  LLM_URL:', LLM_URL);

    const res = await ollamaRequest({
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a professional software engineer robot. You ONLY output updates in the requested format. No conversational text. No preamble. You MUST only reference files that exist in the CONTEXT FILES provided. Do NOT invent new file paths."
        },
        {
          role: "user",
          content: `TASK: ${spec}\n\nCONTEXT FILES:\n${codeContext}\n\nREQUIRED OUTPUT FORMAT:\nFILEPATH: (path)\nCONTENT:\n(full file code)`
        }
      ],
      stream: false,
      options: {
        temperature: 0.1,
        num_ctx: 16384,
        num_predict: 4096
      }
    });

    if (res.statusCode !== 200) {
      throw new Error(`Ollama API error (${res.statusCode}): ${JSON.stringify(res.body)}`);
    }

    const output = res.body?.message?.content || "";

    console.log('  Ollama responded:', output.length, 'chars');

    if (!output || output.trim().length === 0) {
      console.log("  ⚠️ DEBUG: Received empty message from Qwen. Check Ollama logs (journalctl -u ollama).");
      return { status: 'failed', error_message: "Empty LLM response" };
    }

    const upperOutput = output.toUpperCase();
    if (upperOutput.includes('FILEPATH:') && upperOutput.includes('CONTENT:')) {
      const filePathIndex = upperOutput.indexOf('FILEPATH:');
      const contentIndex = upperOutput.indexOf('CONTENT:');

      const filePathPart = output.substring(filePathIndex + 9, contentIndex).trim().split('\n')[0];
      let newContent = output.substring(contentIndex + 8).trim();

      // Clean up markdown code fences
      newContent = newContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '');

      const safePath = path.resolve(REPO_DIR, filePathPart);
      if (!safePath.startsWith(REPO_DIR + path.sep)) {
        throw new Error(`Security Alert: Path traversal attempted to ${filePathPart}`);
      }

      // Auto-create directories if needed
      await fs.mkdir(path.dirname(safePath), { recursive: true });

      await fs.writeFile(safePath, newContent);
      filesChanged.push(filePathPart);
      console.log(`  ✍️  Modified: ${filePathPart}`);
    } else {
      console.log(`  ⚠️ DEBUG: Format mismatch. Output received:\n${output}`);
    }

    if (filesChanged.length > 0) {
      console.log(`  Committing and Pushing...`);
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR });
      await execFileAsync('git', ['commit', '-m', `dev-agent: fix implemented`], { cwd: REPO_DIR });
      await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_DIR });
    } else {
      console.log(`  ℹ️  No files modified by Agent.`);
    }

    return { status: 'completed', branch_name: branchName, files_changed: filesChanged };
  } catch (error) {
    console.error('  ❌ Error:', error.message);
    console.error('  Cause:', error.cause || 'none');
    return { status: 'failed', error_message: error.message };
  }
}

async function main() {
  console.log(`Hardened Qwen Agent Active on ${REPO_DIR}`);
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
