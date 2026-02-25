const Anthropic = require('@anthropic-ai/sdk');
const { QA_SYSTEM_PROMPT } = require('./lib/qa-prompt.js');

// ── QA Review endpoint ────────────────────────────────────────────────────────
// POST { diff, context? }
// Returns { passed, issues, summary }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { diff, context, files } = JSON.parse(event.body);

    if (!diff && !files) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Either "diff" or "files" is required' }),
      };
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 25_000,
    });

    // Build the review request
    let userContent = 'Review this code change.\n\n';

    if (context) {
      userContent += `## Context\n${context}\n\n`;
    }

    if (diff) {
      userContent += `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
    }

    if (files && Array.isArray(files)) {
      userContent += '## Changed Files\n';
      for (const f of files) {
        userContent += `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
      }
    }

    userContent += 'Respond with JSON only.';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      system: QA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Parse JSON from response (handle markdown code fences)
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    let review;
    try {
      review = JSON.parse(clean);
    } catch {
      // If Claude didn't return clean JSON, wrap it
      review = {
        passed: false,
        issues: [{ severity: 'warning', file: null, line: null, description: text, fix: null }],
        summary: 'QA response was not structured JSON — raw output included as issue',
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(review),
    };
  } catch (error) {
    console.error('QA review error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'QA review failed' }),
    };
  }
};
