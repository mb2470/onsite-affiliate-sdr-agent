import { supabase } from '../supabaseClient';

// Module-level ICP profile cache (set from App.jsx via setEmailIcpContext)
let _emailIcpContext = null;

export const setEmailIcpContext = (icpProfile) => {
  _emailIcpContext = icpProfile;
};

// ═══ BUILD SYSTEM PROMPT DYNAMICALLY FROM ICP PROFILE ═══

function buildSystemPrompt() {
  const ctx = _emailIcpContext;

  // ── If no ICP profile loaded, return a minimal generic prompt ──
  if (!ctx || !ctx.elevator_pitch) {
    return `You are an SDR writing outreach emails. Under 90 words, casual tone.

Write a concise, personalized cold email. Ask about a relevant pain point, introduce the product, and end with a simple CTA.

SIGNATURE: Always end with exactly:
Team
[Company]

TONE: Conversational, direct, no fluff. Like messaging a coworker on Slack.`;
  }

  // ── Build each section from profile fields ──
  const sections = [];

  // Role & tone
  const tone = ctx.email_tone || 'Conversational, direct, no fluff. Like messaging a coworker on Slack.';
  sections.push(`You are an SDR. Under 90 words, casual tone.`);

  // What we do
  sections.push(`CRITICAL - WHAT WE ACTUALLY DO:\n${ctx.elevator_pitch}`);

  // The offer (UVPs)
  const uvps = [ctx.uvp_1, ctx.uvp_2, ctx.uvp_3].filter(Boolean);
  if (uvps.length) {
    sections.push(`THE OFFER:\n${uvps.map(u => `- ${u}`).join('\n')}`);
  }

  // Core problem
  if (ctx.core_problem) {
    sections.push(`CORE PROBLEM WE SOLVE:\n${ctx.core_problem}`);
  }

  // Social proof / comparison
  if (ctx.social_proof) {
    sections.push(`SOCIAL PROOF / COMPARISON:\nReference "${ctx.social_proof}" as a known model the prospect will recognize. Position us as bringing that model to their business.`);
  }

  // Correct messaging
  if (ctx.messaging_do?.length) {
    sections.push(`CORRECT MESSAGING (USE THESE):\n${ctx.messaging_do.map(p => `✓ ${p}`).join('\n')}`);
  }

  // Incorrect messaging
  if (ctx.messaging_dont?.length) {
    sections.push(`NEVER SAY (THESE ARE WRONG):\n${ctx.messaging_dont.map(p => `✗ ${p}`).join('\n')}\n✗ "Hey there" — ALWAYS use the contact's first name`);
  }

  // Signature
  const senderName = ctx.sender_name || 'Team';
  const senderUrl = ctx.sender_url || '';
  const sigLines = [senderName, senderUrl].filter(Boolean).join('\n');
  sections.push(`SIGNATURE: Always end with exactly:\n${sigLines}`);

  // Email structure
  sections.push(`EMAIL STRUCTURE (under 90 words):
Hey {first_name} -
[Pain question about ${ctx.core_problem || 'their current challenge'}]
[${ctx.social_proof ? `How ${ctx.social_proof} proves the model works` : 'How our approach eliminates the risk'}]
[We help brands ${ctx.uvp_1 || 'solve this problem'}]
[Simple CTA question]

${sigLines}`);

  // Example email
  if (ctx.email_example) {
    sections.push(`EXAMPLE:\n${ctx.email_example}`);
  }

  // Tone
  sections.push(`TONE: ${tone}`);

  // Buyer context for personalization
  const contextParts = [];
  if (ctx.alternative) contextParts.push(`THE ALTERNATIVE (what they'd use without us): ${ctx.alternative}`);
  if (ctx.daily_obstacles) contextParts.push(`BUYER'S DAILY OBSTACLES: ${ctx.daily_obstacles}`);
  if (ctx.success_metrics) contextParts.push(`BUYER'S SUCCESS METRICS: ${ctx.success_metrics}`);
  if (ctx.key_responsibilities) contextParts.push(`BUYER'S RESPONSIBILITIES: ${ctx.key_responsibilities}`);
  if (contextParts.length) {
    sections.push(`ICP CONTEXT (use this to personalize messaging):\n${contextParts.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

function buildEmailPrompt(lead, firstName) {
  const ctx = _emailIcpContext;
  const senderName = ctx?.sender_name || 'Team';
  const senderUrl = ctx?.sender_url || '';
  const sigLine = [senderName, senderUrl].filter(Boolean).join(' and ');

  const parts = [
    `Write a casual outreach email for ${lead.website}.`,
    `The contact's first name is "${firstName}" — ALWAYS address them as "Hey ${firstName} -"`,
    '',
    lead.research_notes ? `Context: ${lead.research_notes.substring(0, 300)}` : '',
    lead.industry ? `Industry: ${lead.industry}` : '',
    lead.pain_points ? `Pain Points: ${lead.pain_points}` : '',
    '',
    'Requirements:',
    '- Under 90 words total',
    `- Start with "Hey ${firstName} -"`,
    ctx?.core_problem ? `- Reference their pain: ${ctx.core_problem}` : '- Ask about a relevant pain point',
    ctx?.social_proof ? `- Use social proof: ${ctx.social_proof}` : '- Explain why our approach works',
    ctx?.uvp_1 ? `- Key point: ${ctx.uvp_1}` : '- Highlight our main value prop',
    '- Tone: Casual, like a Slack message',
    `- End with signature: ${sigLine}`,
    '- Include subject line',
    '',
    'Format:',
    'Subject: [subject]',
    '',
    '[body]',
  ];

  return parts.filter(line => line !== null).join('\n');
}

// Check outreach_log for a previously sent email for this lead that can be reused.
// Returns { subject, body, contactName, sentAt } or null if none found.
export const getCachedEmail = async (website) => {
  const cleanDomain = website.toLowerCase().replace(/^www\./, '');

  const { data, error } = await supabase
    .from('outreach_log')
    .select('email_subject, email_body, contact_name, sent_at')
    .ilike('website', `%${cleanDomain}%`)
    .order('sent_at', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;

  const row = data[0];
  if (!row.email_subject || !row.email_body) return null;

  return {
    subject: row.email_subject,
    body: row.email_body,
    contactName: row.contact_name,
    sentAt: row.sent_at,
    // Reconstruct the full email text in the same format generateEmail returns
    text: `Subject: ${row.email_subject}\n\n${row.email_body}`,
  };
};

// Personalize a cached email for a new contact by swapping the first name greeting
export const personalizeEmail = (emailText, newFirstName) => {
  if (!newFirstName || newFirstName === 'there') return emailText;
  // Replace "Hey <AnyName> -" with "Hey <newFirstName> -"
  let result = emailText.replace(/Hey \w+ -/i, `Hey ${newFirstName} -`);
  result = result.replace(/Hey there -/i, `Hey ${newFirstName} -`);
  return result;
};

// Generate a personalized outreach email for a lead
export const generateEmail = async (lead, contactName) => {
  const firstName = contactName ? contactName.split(' ')[0] : 'there';

  const response = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: buildEmailPrompt(lead, firstName),
      systemPrompt: buildSystemPrompt()
    })
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const data = await response.json();
  const email = data.text || data.content?.[0]?.text || '';
  return email;
};
