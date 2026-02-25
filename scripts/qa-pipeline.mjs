#!/usr/bin/env node

// ── Two-Agent QA Pipeline ─────────────────────────────────────────────────────
// Build → Review → Feed issues back → Rebuild. Cap at 3 retries.
//
// Usage:
//   node scripts/qa-pipeline.mjs "Add input validation to send-email.js"
//   node scripts/qa-pipeline.mjs "Fix the chatbot stats query" --max-retries 5
//
// Requires: claude CLI, ANTHROPIC_API_KEY env var, git

import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const QA_SYSTEM_PROMPT = `You are a senior code reviewer and QA engineer for an SDR automation platform.
Your job is to review code changes and flag real issues. This codebase uses:
- React 18 (Vite) frontend
- Supabase (PostgreSQL + RLS) for data
- Netlify Functions (Node.js, CommonJS) for serverless backend
- Anthropic Claude API for AI features
- Gmail API for sending emails

## Review Checklist
- **Bugs**: Logic errors, off-by-one, null refs, race conditions, unhandled promise rejections
- **Security**: XSS, injection, auth gaps, exposed secrets, missing input validation
- **Supabase**: Missing RLS considerations, wrong table references, missing org_id filters
- **Performance**: N+1 queries, memory leaks, unnecessary re-renders, unbounded selects
- **API**: Missing error handling on fetch calls, wrong HTTP methods, missing CORS headers
- **Edge cases**: Empty states, error handling, boundary values, null/undefined data

## Response Format
Respond with JSON only:
{
  "passed": boolean,
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "file": "path/to/file",
      "line": number | null,
      "description": "What's wrong",
      "fix": "Suggested fix"
    }
  ],
  "summary": "One-line overall assessment"
}

Be thorough but pragmatic. Focus on things that will actually break in production.`;

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const maxRetriesIdx = args.indexOf('--max-retries');
const MAX_RETRIES = maxRetriesIdx !== -1 ? parseInt(args[maxRetriesIdx + 1], 10) || 3 : 3;
const task = args.filter((a, i) => a !== '--max-retries' && i !== maxRetriesIdx + 1).join(' ');

if (!task) {
  console.error('Usage: node scripts/qa-pipeline.mjs "your task description"');
  process.exit(1);
}

// ── QA Agent ──────────────────────────────────────────────────────────────────

const client = new Anthropic();

async function reviewCode(diff, context) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2048,
    system: QA_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Review this code change.\n\n## Context\n${context || 'No additional context.'}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\nRespond with JSON only.`,
      },
    ],
  });

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(clean);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function run() {
  let attempt = 0;
  let feedback = '';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Two-Agent QA Pipeline`);
  console.log(`  Task: ${task}`);
  console.log(`  Max retries: ${MAX_RETRIES}`);
  console.log(`${'═'.repeat(60)}\n`);

  while (attempt < MAX_RETRIES) {
    attempt++;
    console.log(`\n--- Attempt ${attempt}/${MAX_RETRIES} ---\n`);

    // Step 1: Run Claude Code with the task (+ any prior QA feedback)
    const prompt = feedback
      ? `${task}\n\nPrevious QA feedback to address:\n${feedback}`
      : task;

    console.log('Building with Claude Code...');
    try {
      execSync(`claude -p "${prompt.replace(/"/g, '\\"')}" --allowedTools Edit,Write,Read,Glob,Grep,Bash`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    } catch (e) {
      console.error('Claude Code exited with error:', e.message);
      // Continue anyway — there might still be useful changes
    }

    // Step 2: Capture the diff
    const diff = execSync('git diff', { encoding: 'utf-8' });
    if (!diff.trim()) {
      console.log('No changes detected. Claude Code may not have modified any files.');
      break;
    }

    console.log(`\nDiff captured (${diff.split('\n').length} lines)`);

    // Step 3: Send to QA agent
    console.log('\nRunning QA review...');
    let review;
    try {
      review = await reviewCode(diff, task);
    } catch (e) {
      console.error('QA review failed:', e.message);
      break;
    }

    console.log(`\nQA verdict: ${review.summary}`);

    if (review.issues?.length > 0) {
      for (const issue of review.issues) {
        const icon = issue.severity === 'critical' ? '!!!' : issue.severity === 'warning' ? '(!)' : '(i)';
        const loc = issue.file ? `[${issue.file}${issue.line ? `:${issue.line}` : ''}]` : '';
        console.log(`  ${icon} ${issue.severity.toUpperCase()} ${loc}: ${issue.description}`);
        if (issue.fix) console.log(`      Fix: ${issue.fix}`);
      }
    }

    // Step 4: Check results
    if (review.passed) {
      console.log('\nQA PASSED. Changes are ready to commit.');
      return { success: true, attempts: attempt, review };
    }

    // Step 5: Format feedback for next attempt
    const criticals = (review.issues || []).filter((i) => i.severity === 'critical');
    const warnings = (review.issues || []).filter((i) => i.severity === 'warning');

    feedback = [
      'Fix these issues:',
      ...criticals.map(
        (i) => `CRITICAL [${i.file || 'unknown'}]: ${i.description} -> ${i.fix || 'No fix suggested'}`
      ),
      ...warnings.map(
        (i) => `WARNING [${i.file || 'unknown'}]: ${i.description} -> ${i.fix || 'No fix suggested'}`
      ),
    ].join('\n');

    console.log(`\n${criticals.length} critical, ${warnings.length} warnings — looping back to Claude Code`);

    // Reset changes so Claude Code starts fresh
    execSync('git checkout .', { stdio: 'inherit' });
  }

  console.log('\nMax retries reached. Needs human review.');
  return { success: false, attempts: attempt, message: 'Max retries hit — escalate to human' };
}

run()
  .then((result) => {
    console.log('\n' + JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  })
  .catch((e) => {
    console.error('Pipeline error:', e);
    process.exit(1);
  });
