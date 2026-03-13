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

const API_BASE = 'https://sdr.onsiteaffiliate.com/.netlify/functions/dev-agent';

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

async function getTask() {
  try {
    const res = await fetch(`${API_BASE}?action=poll`, {
      headers: { 
        'Authorization': `Bearer ${DEV_AGENT_SECRET}`,
        'Content-Type': 'application/json'
      }
    });
    
    const text = await res.text();
    if (!text || res.status !== 200) return null;

    const data = JSON.parse(text);
    if (!data.request) return null;

    return data.request;
  } catch (err) {
    if (err.message.includes('Unexpected token')) return null;
    console.error("  [Polling Error]:", err.message);
    return null;
  }
}

async function analyzeAndPlan(task, projectStructure) {
  const planPrompt = `Task: ${task.instruction}
Project Structure:
${projectStructure}

Analyze the task and return a JSON object with:
{
  "analysis": "string",
  "files_to_read": ["string"],
  "files_to_modify": ["string"]
}
Return ONLY the raw JSON.`;

  const response = await chatWithLLM([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: planPrompt },
  ]);

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    const parsed = JSON.parse(match[0]);
    return {
      analysis: parsed.analysis || "",
      files_to_read: parsed.files_to_read || [],
      files_to_modify: parsed.files_to_modify || []
    };
  } catch (e) {
    console.error("  [Parse Error] Plan response was not valid JSON.");
    return null;
  }
}

async function generateEdits(task, filesContent) {
  const contentContext = Object.entries(filesContent)
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n');

  const editPrompt = `Task: ${task.instruction}
Files Content:
${contentContext}

Return a JSON object:
{
  "edits": [
    { "file": "path/to/file", "original": "exact original code", "replacement": "new code" }
  ]
}
Return ONLY raw JSON.`;

  const response = await chatWithLLM([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: editPrompt },
  ], { maxTokens: 8192 });

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    return JSON.parse(match[0]);
  } catch (e) {
    console.error("  [Parse Error] Edit response was not valid JSON.");
    return null;
  }
}

async function run() {
  console.log(`Checking LLM connection to ${LLM_MODEL}...`);
  try {
    await chatWithLLM([{ role: 'user', content: 'hi' }]);
    console.log('LLM health check: PASS');
  } catch (e) {
    console.error('LLM health check: FAIL. Ensure Ollama is running on your Windows host.');
    process.exit(1);
  }

  while (true) {
    console.log('Polling for tasks...');
    const task = await getTask();
    if (task && task.id) {
      console.log(`Processing task: ${task.id}`);
      
      try {
        const structure = execSync('find . -maxdepth 2 -not -path "*/.*"', { cwd: REPO_DIR }).toString();
        const plan = await analyzeAndPlan(task, structure);
        if (!plan) continue;

        const filesContent = {};
        for (const file of plan.files_to_read) {
          const fullPath = path.join(REPO_DIR, file);
          if (fs.existsSync(fullPath)) {
            filesContent[file] = fs.readFileSync(fullPath, 'utf8');
          }
        }

        const result = await generateEdits(task, filesContent);
        if (result && result.edits) {
          for (const edit of result.edits) {
            const fullPath = path.join(REPO_DIR, edit.file);
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf8');
              const updated = content.replace(edit.original, edit.replacement);
              fs.writeFileSync(fullPath, updated);
              console.log(`  Successfully updated ${edit.file}`);
            }
          }
        }
      } catch (innerErr) {
        console.error("  [Task Error]:", innerErr.message);
      }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

run();

