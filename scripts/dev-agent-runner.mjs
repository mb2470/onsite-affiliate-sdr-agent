#!/usr/bin/env node

/**
 * dev-agent-runner.mjs
 *
 * Polls the dev-agent API for pending dev requests, then runs Claude Code
 * (via @anthropic-ai/claude-code SDK) to implement them.
 *
 * Usage:
 *   DEV_AGENT_SECRET=xxx ANTHROPIC_API_KEY=xxx node scripts/dev-agent-runner.mjs
 *
 * Environment variables:
 *   DEV_AGENT_SECRET   — Bearer token for the dev-agent API
 *   ANTHROPIC_API_KEY   — Claude API key (used by Claude Code SDK)
 *   DEV_AGENT_API_URL   — Base URL (default: https://sdr.onsiteaffiliate.com)
 *   POLL_INTERVAL_MS    — Polling interval in ms (default: 30000)
 *   REPO_DIR            — Path to the git repo (default: cwd)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const API_URL = process.env.DEV_AGENT_API_URL || 'https://sdr.onsiteaffiliate.com';
const SECRET = process.env.DEV_AGENT_SECRET;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const REPO_DIR = process.env.REPO_DIR || process.cwd();

if (!SECRET) {
  console.error('DEV_AGENT_SECRET is required');
  process.exit(1);
}

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

async function runClaudeCode(spec) {
  // Create a feature branch
  const branchName = `dev-agent/${Date.now()}`;

  try {
    await execFileAsync('git', ['checkout', '-b', branchName], { cwd: REPO_DIR });
  } catch (e) {
    console.error('Failed to create branch:', e.message);
    throw e;
  }

  try {
    // Use the Claude Code SDK via CLI (npx @anthropic-ai/claude-code)
    // The spec is passed as the prompt
    const prompt = `You are working on a development task. Here is the full spec:\n\n${spec}\n\nImplement this task. Follow the project's CLAUDE.md standards. Make the changes, then summarize what you did.`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['@anthropic-ai/claude-code', '--print', '--dangerously-skip-permissions', prompt],
      {
        cwd: REPO_DIR,
        timeout: 600_000, // 10 min max
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    if (stderr) console.error('Claude Code stderr:', stderr);

    // Get list of changed files
    const { stdout: diffOutput } = await execFileAsync(
      'git',
      ['diff', '--name-only', 'HEAD'],
      { cwd: REPO_DIR }
    );
    const filesChanged = diffOutput.trim().split('\n').filter(Boolean);

    // Stage and commit if there are changes
    if (filesChanged.length > 0) {
      await execFileAsync('git', ['add', '-A'], { cwd: REPO_DIR });
      await execFileAsync('git', ['commit', '-m', `dev-agent: ${spec.split('\n')[0].substring(0, 72)}`], { cwd: REPO_DIR });
      await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_DIR });
    }

    return {
      status: 'completed',
      result_summary: stdout.substring(0, 5000),
      branch_name: filesChanged.length > 0 ? branchName : null,
      files_changed: filesChanged,
    };
  } catch (error) {
    // Try to get back to main on failure
    try {
      await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR });
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: REPO_DIR });
    } catch (_) { /* best effort */ }

    return {
      status: 'failed',
      error_message: error.message?.substring(0, 2000),
    };
  }
}

async function processRequest(request) {
  console.log(`\n[${new Date().toISOString()}] Processing: ${request.title} (${request.id})`);

  const claimed = await claimRequest(request.id);
  if (!claimed) {
    console.log('  Could not claim — skipping.');
    return;
  }

  console.log(`  Claimed. Running Claude Code...`);
  const result = await runClaudeCode(request.spec);

  console.log(`  Result: ${result.status}`);
  if (result.branch_name) console.log(`  Branch: ${result.branch_name}`);
  if (result.files_changed?.length) console.log(`  Files changed: ${result.files_changed.join(', ')}`);
  if (result.error_message) console.log(`  Error: ${result.error_message}`);

  await completeRequest(request.id, result);
  console.log('  Done.');
}

async function main() {
  console.log(`Dev Agent Runner started`);
  console.log(`  API: ${API_URL}`);
  console.log(`  Repo: ${REPO_DIR}`);
  console.log(`  Poll interval: ${POLL_INTERVAL}ms`);
  console.log('');

  // Continuous polling loop
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
