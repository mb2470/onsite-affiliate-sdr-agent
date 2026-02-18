const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { prompt, systemPrompt, useWebSearch } = JSON.parse(event.body);

    if (!prompt) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Prompt is required' }),
      };
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Build request params
    const params = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful AI assistant.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    // Add web search tool if requested
    if (useWebSearch) {
      params.tools = [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ];
    }

    const message = await anthropic.messages.create(params);

    // Extract all text blocks from response (skips tool_use and search_result blocks)
    const textContent = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        content: message.content,
        text: textContent,
      }),
    };
  } catch (error) {
    console.error('Claude API Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'Failed to call Claude API',
      }),
    };
  }
};
