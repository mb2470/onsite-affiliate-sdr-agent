#!/usr/bin/env node

/**
 * dev-agent-local.mjs
 *
 * Local dev-agent runner that uses OpenWebUI (OpenAI-compatible API)
 * with a local Llama 3 model instead of Claude Code.
 *
 * Polls the dev-agent API for pending dev requests, sends the spec
 * to your local LLM for analysis/planning, then applies the changes.
 *
 * Usage:
 *   DEV_AGENT_SECRET=xxx node scripts/dev-agent-local.mjs
 *
 * Environment variables:
 *   DEV_AGENT_SECRET    — Bearer token for the dev-agent API
 *   DEV_AGENT_API_URL   — Base URL (default: https://sdr.onsiteaffiliate.com)
 *   LLM_API_URL         — OpenWebUI API base URL (default: http://localhost:3000)
 *   LLM_API_KEY         — API key for OpenWebUI (default: none)
 *   LLM_MODEL           — Model name (default: llama3.1)
 *   POLL_INTERVAL_MS    — Polling interval in ms (default: 30000)
 *   REPO_DIR            — Path to the git repo (default: cwd)
 *   MAX_TASK_TIME_MS    — Max time per task in ms (default: 300000 / 5 min)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const execFileAsync = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────────────

const API_URL = process.env.DEV_AGENT_API_URL || 'https://sdr.onsiteaffiliate.com';
const SECRET = process.env.DEV_AGENT_SECRET;
const LLM_URL = process.env.LLM_API_URL || 'http://localhost:3000';
const LLM_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen:latest';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const MAX_TASK_TIME = parseInt(process.env.MAX_TASK_TIME_MS || '300000', 10);

if (!SECRET) {
  console.error('DEV_AGENT_SECRET is required');
  process.exit(1);
}

// ── Dev Agent API helpers ────────────────────────────────────────────────────

const authHeaders = {
  Authorization: `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
};

async function apiFetch(path, options = {}) {
  const url = `${API_URL}/.netlify/functions/dev-agent${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders, ...options.headers },
  });
  return res.json();
}

async function pollForRequest() {
  const data = await apiFetch('?action=poll');
  return data.request || null;
}

async function claimRequest(id) {
  const data = await apiFetch(`?action=claim&id=${id}`, { method: 'POST' });
  return data.success;
}

async function completeRequest(id, result) {
  return apiFetch('?action=complete', {
    method: 'POST',
    body: JSON.stringify({ id, ...result }),
  });
}

// ── Local LLM helpers ────────────────────────────────────────────────────────

async function chatWithLLM(messages, { temperature = 0.1, maxTokens = 4096 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (LLM_KEY) headers.Authorization = `Bearer ${LLM_KEY}`;

  const res = await fetch(`${LLM_URL}/api/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── File reading helpers ─────────────────────────────────────────────────────

function readFile(filePath) {
  const fullPath = join(REPO_DIR, filePath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

function writeFile(filePath, content) {
  const fullPath = join(REPO_DIR, filePath);
  writeFileSync(fullPath, content, 'utf-8');
}

async function getRepoTree() {
  const { stdout } = await execFileAsync(
    'git', ['ls-files'],
    { cwd: REPO_DIR, maxBuffer: 5 * 1024 * 1024 }
  );
  return stdout.trim().split('\n').filter(Boolean);
}

async function getClaudeMd() {
  const claudeMd = readFile('CLAUDE.md');
  return claudeMd || '';
}

// ── Agentic loop: plan → act → verify ────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software engineer working on a codebase.
You receive development tasks and must produce file changes to implement them.

Rules:
- Only modify files that exist in the repository
- Respond with structured JSON when asked for plans or edits
- Be precise with file paths — they must match exactly
- Follow the project's coding standards (provided in CLAUDE.md)
- Keep changes minimal and focused on the task`;

async function analyzeAndPlan(spec, claudeMd, repoTree) {
  const fileList = repoTree.join('\n');

  const planPrompt = `Here is the project structure:
\`\`\`
${fileList}
\`\`\`

Here are the project standards (CLAUDE.md):
\`\`\`
${claudeMd}
\`\`\`

Here is the development task:
\`\`\`
${spec}
\`\`\`

Analyze this task and return a JSON response with this exact structure:
{
  "analysis": "Brief analysis of what needs to change",
  "files_to_read": ["list", "of", "file/paths", "to", "read"],
  "files_to_modify": ["list", "of", "file/paths", "to", "modify"]
}

Only include files that exist in the project structure above. Return ONLY valid JSON, no markdown.`;

  const response = await chatWithLLM([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: planPrompt },
  ]);

  try {
    const match = response.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    console.error('  Failed to parse plan:', response.substring(0, 500));
    return null;
  }
}

async function generateEdits(spec, claudeMd, fileContents) {
  const filesContext = Object.entries(fileContents)
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n');

  const editPrompt = `Here are the project standards (CLAUDE.md):
\`\`\`
${claudeMd}
\`\`\`

Here are the current file contents:

${filesContext}

Here is the development task:
\`\`\`
${spec}
\`\`\`

Generate the file edits needed. Return a JSON response with this exact structure:
{
  "edits": [
    {
      "file": "path/to/file.js",
      "action": "modify",
      "content": "full new file content here"
    }
  ],
  "summary": "Brief summary of changes made"
}

Rules:
- For "modify" actions, include the COMPLETE new file content (not a diff)
- Only include files that actually need changes
- Do NOT create new files unless the task explicitly requires it
- Return ONLY valid JSON, no markdown`;

const response = await chatWithLLM([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: editPrompt },
  ], { maxTokens: 8192 });

  // --- EXACT UPDATE START ---
  try {
    // This regex extracts the JSON object even if the LLM includes markdown backticks or conversational text
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('  No JSON found in LLM response');
      return null;
    }
    
    const parsed = JSON.parse(match[0]);
    return parsed;
  } catch (err) {
    console.error('  Failed to parse edits. Raw response snippet:', response.substring(0, 200));
    return null;
  }
  // --- EXACT UPDATE END ---

async function reviewChanges(spec, fileChanges) {
  const changesContext = Object.entries(fileChanges)
    .map(([path, { before, after }]) => {
      if (!before) return `=== ${path} (NEW) ===\n${after}`;
      return `=== ${path} ===\nBEFORE:\n${before}\n\nAFTER:\n${after}`;
    })
    .join('\n\n');

  const reviewPrompt = `Review these changes against the task spec.

Task:
\`\`\`
${spec}
\`\`\`

Changes:
${changesContext}

Return a JSON response:
{
  "approved": true or false,
  "issues": ["list of issues if not approved"],
  "summary": "Brief summary of the review"
}

Approve if the changes correctly address the task without introducing bugs. Return ONLY valid JSON.`;

  const response = await chatWithLLM([
    { role: 'system', content: 'You are a code reviewer. Be concise and practical.' },
    { role: 'user', content: reviewPrompt },
  ]);

  try {
    const match = response.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { approved: false, issues: ['Failed to parse review'], summary: '' };
  } catch {
    return { approved: false, issues: ['Failed to parse review response'], summary: '' };
  }
}

// ── Task execution ───────────────────────────────────────────────────────────

async function executeTask(spec) {
  const branchName = `dev-agent/${Date.now()}`;

  // Ensure we start from main
  try {
    await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR });
    await execFileAsync('git', ['pull', 'origin', 'main'], { cwd: REPO_DIR });
  } catch (e) {
    console.warn('  Warning: could not update main:', e.message);
  }

  try {
    await execFileAsync('git', ['checkout', '-b', branchName], { cwd: REPO_DIR });
  } catch (e) {
    throw new Error(`Failed to create branch: ${e.message}`);
  }

  try {
    // Step 1: Get context
    console.log('  Step 1: Reading project context...');
    const [claudeMd, repoTree] = await Promise.all([
      getClaudeMd(),
      getRepoTree(),
    ]);

    // Step 2: Plan
    console.log('  Step 2: Analyzing task and planning...');
    const plan = await analyzeAndPlan(spec, claudeMd, repoTree);
    if (!plan) throw new Error('LLM failed to produce a valid plan');

    console.log(`  Analysis: ${plan.analysis}`);
    console.log(`  Files to read: ${plan.files_to_read?.join(', ') || 'none'}`);
    console.log(`  Files to modify: ${plan.files_to_modify?.join(', ') || 'none'}`);

    // Step 3: Read relevant files
    console.log('  Step 3: Reading source files...');
    const allFiles = [...new Set([...(plan.files_to_read || []), ...(plan.files_to_modify || [])])];
    const fileContents = {};
    for (const filePath of allFiles) {
      const content = readFile(filePath);
      if (content !== null) {
        fileContents[filePath] = content;
      } else {
        console.warn(`  Warning: File not found: ${filePath}`);
      }
    }

    // Step 4: Generate edits
    console.log('  Step 4: Generating edits...');
    const edits = await generateEdits(spec, claudeMd, fileContents);
    if (!edits?.edits?.length) throw new Error('LLM produced no edits');

    console.log(`  Generated ${edits.edits.length} file edit(s)`);

    // Step 5: Apply edits
    console.log('  Step 5: Applying edits...');
    const fileChanges = {};
    for (const edit of edits.edits) {
      const before = readFile(edit.file);
      writeFile(edit.file, edit.content);
      fileChanges[edit.file] = { before, after: edit.content };
      console.log(`  Wrote: ${edit.file}`);
    }

    // Step 6: Self-review
    console.log('  Step 6: Self-reviewing changes...');
    const review = await reviewChanges(spec, fileChanges);
    console.log(`  Review: ${review.approved ? 'APPROVED' : 'ISSUES FOUND'}`);
    if (!review.approved) {
      console.log(`  Issues: ${review.issues?.join('; ')}`);
    }

    // Step 7: Syntax check JS files
    console.log('  Step 7: Syntax checking...');
    const jsFiles = edits.edits.filter(e => e.file.endsWith('.js') || e.file.endsWith('.mjs'));
    for (const edit of jsFiles) {
      try {
        await execFileAsync('node', ['-c', edit.file], { cwd: REPO_DIR });
        console.log(`  Syntax OK: ${edit.file}`);
      } catch (e) {
        console.error(`  Syntax ERROR in ${edit.file}: ${e.message}`);
        throw new Error(`Syntax error in ${edit.file}: ${e.stderr || e.message}`);
      }
    }

    // Step 8: Get changed files and commit
    const { stdout: diffOutput } = await execFileAsync(
      'git', ['diff', '--name-only'],
      { cwd: REPO_DIR }
    );
    const filesChanged = diffOutput.trim().split('\n').filter(Boolean);

    if (filesChanged.length > 0) {
      await execFileAsync('git', ['add', '-A'], { cwd: REPO_DIR });
      const commitMsg = `dev-agent: ${spec.split('\n')[0].substring(0, 72)}`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: REPO_DIR });
      await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_DIR });
      console.log(`  Pushed to branch: ${branchName}`);
    }

    return {
      status: 'completed',
      result_summary: [
        edits.summary || '',
        review.summary || '',
        review.approved ? '' : `Review issues: ${review.issues?.join('; ')}`,
      ].filter(Boolean).join('\n').substring(0, 5000),
      branch_name: filesChanged.length > 0 ? branchName : null,
      files_changed: filesChanged,
    };
  } catch (error) {
    // Cleanup on failure
    try {
      await execFileAsync('git', ['checkout', '.'], { cwd: REPO_DIR });
      await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR });
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: REPO_DIR });
    } catch (_) { /* best effort */ }

    return {
      status: 'failed',
      error_message: error.message?.substring(0, 2000),
    };
  }
}

// ── Request processing ───────────────────────────────────────────────────────

async function processRequest(request) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`[${new Date().toISOString()}] Processing: ${request.title}`);
  console.log(`  ID: ${request.id}`);
  console.log(`  Type: ${request.type} | Priority: ${request.priority}`);
  console.log(`${'─'.repeat(70)}`);

  const claimed = await claimRequest(request.id);
  if (!claimed) {
    console.log('  Could not claim — skipping.');
    return;
  }

  console.log('  Claimed. Starting local LLM agent...');
  const result = await executeTask(request.spec);

  console.log(`\n  Result: ${result.status}`);
  if (result.branch_name) console.log(`  Branch: ${result.branch_name}`);
  if (result.files_changed?.length) console.log(`  Files changed: ${result.files_changed.join(', ')}`);
  if (result.error_message) console.log(`  Error: ${result.error_message}`);
  if (result.result_summary) console.log(`  Summary: ${result.result_summary.substring(0, 200)}`);

  await completeRequest(request.id, result);
  console.log('  Marked complete in dev_requests table.');
  console.log(`${'═'.repeat(70)}\n`);
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // Verify LLM connectivity
  console.log('Dev Agent Runner (Local LLM)');
  console.log(`  Platform API: ${API_URL}`);
  console.log(`  LLM API:      ${LLM_URL}`);
  console.log(`  LLM Model:    ${LLM_MODEL}`);
  console.log(`  Repo:         ${REPO_DIR}`);
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log('');

  // Quick health check
  try {
    const test = await chatWithLLM([
      { role: 'user', content: 'Respond with just the word "ok".' },
    ], { maxTokens: 10 });
    console.log(`  LLM health check: ${test.trim().toLowerCase().includes('ok') ? 'PASS' : 'WARN — unexpected response'}`);
  } catch (e) {
    console.error(`  LLM health check FAILED: ${e.message}`);
    console.error('  Make sure OpenWebUI is running at', LLM_URL);
    process.exit(1);
  }

  console.log('\nPolling for dev requests...\n');

  while (true) {
    try {
      const request = await pollForRequest();
      if (request) {
        await processRequest(request);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
