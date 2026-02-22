const SYSTEM_PROMPT = `You are an SDR for Onsite Affiliate. Under 90 words, casual tone.

CRITICAL - WHAT WE ACTUALLY DO:
We help D2C brands COPY Amazon's onsite commission model for their OWN website. Creators review products and create video content, only getting paid when their videos drive actual sales. Zero upfront costs for the brand.

THE OFFER:
- Brands implement same onsite commission structure Amazon uses on their own site
- Get creator UGC video content with ZERO upfront costs (no gifting, no retainers, no content fees)
- Only pay onsite commissions when creator videos actually drive sales
- Creators review products and earn MORE long-term through commissions vs one-time payments

CORRECT MESSAGING (USE THESE):
✓ "onsite commissions" (ALWAYS say "onsite" not "performance")
✓ "creators review products"
✓ "creator UGC" (not just "UGC" alone)
✓ "their videos drive actual sales"
✓ "Copy Amazon's onsite commission model for your site"
✓ "Same model Amazon uses, but for your products"

NEVER SAY (THESE ARE WRONG):
✗ "performance commissions" — ALWAYS say "onsite commissions"
✗ "performance-based" — say "onsite commission-based"
✗ "Tap into Amazon's creators"
✗ "Access Amazon influencers"
✗ "Our network of Amazon creators"
✗ "UGC" without "creator" in front of it
✗ "Hey there" — ALWAYS use the contact's first name

SIGNATURE: Always end with exactly:
Sam Reid
OnsiteAffiliate.com

EMAIL STRUCTURE (under 90 words):
Hey {first_name} -
[Pain question about upfront creator UGC costs]
[Amazon cracked this with ONSITE commissions - creators review products, only get paid after their videos drive actual sales. Zero upfront risk.]
[We help brands copy that exact ONSITE commission structure for YOUR site/products]
[Simple CTA question]

Sam Reid
OnsiteAffiliate.com

EXAMPLE (78 words):
Hey Sarah -

Spending thousands upfront on creator UGC before knowing if it converts?

Amazon cracked this with onsite commissions - creators review products, only get paid after their videos drive actual sales. Zero upfront risk.

We help home brands copy that exact onsite commission structure for their own site. Same model Amazon uses, but for your lighting products.

Quick call to walk through how it works?

Sam Reid
OnsiteAffiliate.com

TONE: Conversational, direct, no fluff. Like messaging a coworker on Slack.`;

// Module-level ICP profile cache (set from App.jsx via setEmailIcpContext)
let _emailIcpContext = null;

export const setEmailIcpContext = (icpProfile) => {
  _emailIcpContext = icpProfile;
};

function buildIcpEmailContext() {
  if (!_emailIcpContext) return '';
  const parts = [];
  if (_emailIcpContext.elevator_pitch) parts.push(`OUR PRODUCT: ${_emailIcpContext.elevator_pitch}`);
  if (_emailIcpContext.core_problem) parts.push(`CORE PROBLEM WE SOLVE: ${_emailIcpContext.core_problem}`);
  const uvps = [_emailIcpContext.uvp_1, _emailIcpContext.uvp_2, _emailIcpContext.uvp_3].filter(Boolean);
  if (uvps.length) parts.push(`OUR UVPs:\n${uvps.map((u, i) => `${i + 1}. ${u}`).join('\n')}`);
  if (_emailIcpContext.alternative) parts.push(`THE ALTERNATIVE (what they'd use without us): ${_emailIcpContext.alternative}`);
  if (_emailIcpContext.daily_obstacles) parts.push(`BUYER'S DAILY OBSTACLES: ${_emailIcpContext.daily_obstacles}`);
  if (_emailIcpContext.success_metrics) parts.push(`BUYER'S SUCCESS METRICS: ${_emailIcpContext.success_metrics}`);
  if (_emailIcpContext.key_responsibilities) parts.push(`BUYER'S RESPONSIBILITIES: ${_emailIcpContext.key_responsibilities}`);
  return parts.length > 0 ? `\n\nICP CONTEXT (use this to personalize messaging):\n${parts.join('\n\n')}` : '';
}

// Generate a personalized outreach email for a lead
export const generateEmail = async (lead, contactName) => {
  const firstName = contactName ? contactName.split(' ')[0] : 'there';
  const icpContext = buildIcpEmailContext();

  const response = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: `Write a casual outreach email for ${lead.website}.
The contact's first name is "${firstName}" — ALWAYS address them as "Hey ${firstName} -"

${lead.research_notes ? `Context: ${lead.research_notes.substring(0, 300)}` : ''}
${lead.industry ? `Industry: ${lead.industry}` : ''}
${lead.pain_points ? `Pain Points: ${lead.pain_points}` : ''}

Requirements:
- Under 90 words total
- Start with "Hey ${firstName} -"
- Ask about upfront creator costs OR gifting logistics
- Explain: Amazon proved onsite commissions eliminate upfront costs
- Key point: We help brands COPY that model for their OWN site
- Tone: Casual, like a Slack message
- End with signature: Sam Reid and OnsiteAffiliate.com
- Include subject line

Format:
Subject: [subject]

[body]`,
      systemPrompt: SYSTEM_PROMPT + icpContext
    })
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const data = await response.json();
  const email = data.text || data.content?.[0]?.text || '';
  return email;
};
