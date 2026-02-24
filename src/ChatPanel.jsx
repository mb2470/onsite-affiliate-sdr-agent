import { useState, useRef, useEffect } from 'react';

const SUGGESTIONS = [
  'How many HIGH ICP leads do I have?',
  'Show me leads that have replied',
  'What are my stats this week?',
  'Find contacts at nike.com',
  'Add example.com as a lead',
  'Is the agent running?',
];

export default function ChatPanel() {
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
      // Build the messages array for the API (only role + content)
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch('/.netlify/functions/claude-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `API error: ${res.status}`);
      }

      const data = await res.json();
      setMessages((prev) => [...prev, { role: 'assistant', content: data.content }]);
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
