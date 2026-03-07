import { useState, useRef, useEffect } from 'react';
import { supabase } from './supabaseClient';

const SUGGESTIONS = [
  'How many HIGH ICP leads do I have?',
  'Show me leads that have replied',
  'What are my stats this week?',
  'Find contacts at nike.com',
  'Add example.com as a lead',
  'Submit a dev request',
];

export default function ChatPanel({ orgId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;

    const userMsg = { role: 'user', content: userText };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const isDevRequestIntent = /\b(submit|create|open)\b[\s\S]{0,40}\b(dev request|feature request|bug report)\b/i.test(userText)
        || /\blets submit this request to dev\b/i.test(userText)
        || /\bsubmit this to dev\b/i.test(userText);

      if (isDevRequestIntent) {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        const edgeRes = await fetch('/.netlify/functions/assistant-dev-request', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            message: userText,
            org_id: orgId,
            user_email: session?.user?.email || null,
          }),
        });

        const edgeBody = await edgeRes.json().catch(() => ({}));
        if (!edgeRes.ok) {
          throw new Error(edgeBody.error || `Dev request submit failed: ${edgeRes.status}`);
        }

        const assistantMsg = [
          `✅ Submitted dev request${edgeBody.request_id ? ` **${edgeBody.request_id}**` : ''}.`,
          edgeBody.request?.title ? `**Title:** ${edgeBody.request.title}` : null,
          edgeBody.request?.type ? `**Type:** ${edgeBody.request.type}` : null,
          edgeBody.request?.priority ? `**Priority:** ${edgeBody.request.priority}` : null,
          edgeBody.message || 'The Claude Code agent will pick this up shortly.',
        ].filter(Boolean).join('\n\n');

        setMessages((prev) => [...prev, { role: 'assistant', content: assistantMsg }]);
        return;
      }

      // Build the messages array for the API (only role + content)
      // Messages with string content are display messages; messages with array
      // content are tool exchanges from previous turns.
      let apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      let maxIterations = 8;
      let finalContent = '';

      // Retry helper for transient errors (502/503/504)
      const fetchWithRetry = async (url, options, retries = 1) => {
        for (let attempt = 0; attempt <= retries; attempt++) {
          const res = await fetch(url, options);
          if (res.ok) return res;
          if (attempt < retries && [502, 503, 504].includes(res.status)) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `API error: ${res.status}`);
        }
      };

      while (maxIterations-- > 0) {
        // Step 1: Single Claude API call
        const res = await fetchWithRetry('/.netlify/functions/claude-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: apiMessages, org_id: orgId }),
        });

        const data = await res.json();

        // If no tool calls, we have the final answer
        if (!data.tool_calls || data.tool_calls.length === 0) {
          finalContent = data.content;
          break;
        }

        // Step 2: Execute tool calls server-side
        const toolRes = await fetchWithRetry('/.netlify/functions/claude-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_calls: data.tool_calls, org_id: orgId }),
        });

        const toolData = await toolRes.json();

        // Step 3: Append assistant response + tool results, then loop
        apiMessages = [
          ...apiMessages,
          { role: 'assistant', content: data.raw_content },
          { role: 'user', content: toolData.tool_results },
        ];

        // If Claude also produced text alongside tools, keep it as a fallback
        if (data.content) {
          finalContent = data.content;
        }
      }

      if (!finalContent) {
        finalContent =
          'I ran into my processing limit. Please try a simpler question or break it into steps.';
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: finalContent }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}`, isError: true },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    inputRef.current?.focus();
  };

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-icon">💬</span>
          <span className="chat-title">Chat with your SDR</span>
        </div>
        {messages.length > 0 && (
          <button className="chat-clear-btn" onClick={clearChat}>
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">🤖</div>
            <div className="chat-empty-title">Ask me anything about your pipeline</div>
            <div className="chat-empty-subtitle">
              I can query your data, add leads, find contacts, generate emails, and more.
            </div>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  className="chat-suggestion"
                  onClick={() => sendMessage(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg-${msg.role} ${msg.isError ? 'chat-msg-error' : ''}`}>
            <div className="chat-msg-avatar">
              {msg.role === 'user' ? '👤' : '🤖'}
            </div>
            <div className="chat-msg-bubble">
              <MessageContent content={msg.content} />
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-avatar">🤖</div>
            <div className="chat-msg-bubble chat-typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Ask about your leads, pipeline, contacts..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={loading}
        />
        <button
          className="chat-send-btn"
          onClick={() => sendMessage()}
          disabled={!input.trim() || loading}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

// ── Render markdown-ish content ──────────────────────────────────────────────

function MessageContent({ content }) {
  if (!content) return null;

  // Simple markdown-to-JSX: bold, inline code, headers, lists, line breaks
  const lines = content.split('\n');
  const elements = [];
  let inList = false;
  let listItems = [];

  const flushList = () => {
    if (listItems.length) {
      elements.push(
        <ul key={`list-${elements.length}`} className="chat-list">
          {listItems.map((li, j) => (
            <li key={j}>{formatInline(li)}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
    inList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith('### ')) {
      flushList();
      elements.push(<h4 key={i} className="chat-h4">{formatInline(line.slice(4))}</h4>);
    } else if (line.startsWith('## ')) {
      flushList();
      elements.push(<h3 key={i} className="chat-h3">{formatInline(line.slice(3))}</h3>);
    } else if (line.startsWith('# ')) {
      flushList();
      elements.push(<h3 key={i} className="chat-h3">{formatInline(line.slice(2))}</h3>);
    }
    // List items
    else if (line.match(/^\s*[-*•]\s/)) {
      inList = true;
      listItems.push(line.replace(/^\s*[-*•]\s/, ''));
    }
    // Numbered list
    else if (line.match(/^\s*\d+\.\s/)) {
      inList = true;
      listItems.push(line.replace(/^\s*\d+\.\s/, ''));
    }
    // Empty line
    else if (!line.trim()) {
      flushList();
      // Only add break if not at start/end
      if (i > 0 && i < lines.length - 1) {
        elements.push(<div key={i} className="chat-break" />);
      }
    }
    // Regular text
    else {
      flushList();
      elements.push(<p key={i} className="chat-p">{formatInline(line)}</p>);
    }
  }
  flushList();

  return <div className="chat-content">{elements}</div>;
}

function formatInline(text) {
  // Bold: **text**
  // Inline code: `text`
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Code
    const codeMatch = remaining.match(/`(.+?)`/);

    // Find earliest match
    let earliest = null;
    let type = null;

    if (boldMatch && (!earliest || boldMatch.index < earliest.index)) {
      earliest = boldMatch;
      type = 'bold';
    }
    if (codeMatch && (!earliest || codeMatch.index < earliest.index)) {
      earliest = codeMatch;
      type = 'code';
    }

    if (!earliest) {
      parts.push(remaining);
      break;
    }

    // Text before match
    if (earliest.index > 0) {
      parts.push(remaining.slice(0, earliest.index));
    }

    if (type === 'bold') {
      parts.push(<strong key={key++}>{earliest[1]}</strong>);
    } else if (type === 'code') {
      parts.push(<code key={key++} className="chat-inline-code">{earliest[1]}</code>);
    }

    remaining = remaining.slice(earliest.index + earliest[0].length);
  }

  return parts;
}
