import { supabase } from '../supabaseClient';
import { resolveOrgId } from './orgService';

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
  if (ctx.daily_obstacles) contextParts.push(`BUYER CONTEXT (daily obstacles): ${ctx.daily_obstacles}`);
  if (ctx.success_stories) contextParts.push(`SUCCESS STORIES: ${ctx.success_stories}`);
  if (ctx.industry_trends) contextParts.push(`INDUSTRY TRENDS: ${ctx.industry_trends}`);
  if (ctx.competitor_analysis) contextParts.push(`COMPETITOR ANALYSIS: ${ctx.competitor_analysis}`);
  if (ctx.call_to_action) contextParts.push(`CALL TO ACTION: ${ctx.call_to_action}`);

  if (contextParts.length > 0) {
    sections.push(`BUYER CONTEXT:\n${contextParts.join('\n')}`);
  }

  return sections.join('\n');
}

// ── Generate a system prompt based on the current ICP profile ──

export const getSystemPrompt = () => {
  return buildSystemPrompt();
};

// ── Generate a personalized email based on the system prompt and user input ──

export const generateEmail = (userInput) => {
  const systemPrompt = getSystemPrompt();
  const emailTemplate = `
  You are an SDR writing outreach emails. Under 90 words, casual tone.

  Write a concise, personalized cold email. Ask about a relevant pain point, introduce the product, and end with a simple CTA.

  SIGNATURE: Always end with exactly:
  Team
  [Company]

  TONE: Conversational, direct, no fluff. Like messaging a coworker on Slack.

  ${systemPrompt}

  USER INPUT:
  ${userInput}

  EMAIL:
  `;

  return emailTemplate;
};