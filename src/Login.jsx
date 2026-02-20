import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Login() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    setLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(170deg, #01081e 0%, #070e24 50%, #01081e 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Raleway', -apple-system, sans-serif",
      color: '#f6f6f7',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '420px',
        padding: '0 24px',
      }}>
        {/* Logo / Brand */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            fontSize: '42px',
            fontFamily: "'Barlow', sans-serif",
            fontWeight: 800,
            background: 'linear-gradient(135deg, #9015ed 0%, #4a3fed 50%, #245ef9 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '-1px',
            marginBottom: '8px',
          }}>
            AI SDR Agent
          </div>
          <div style={{
            fontSize: '14px',
            color: 'rgba(255,255,255,0.4)',
            fontWeight: 500,
            letterSpacing: '0.04em',
          }}>
            Onsite Affiliate Outreach Platform
          </div>
        </div>

        {/* Login Card */}
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '18px',
          padding: '36px 32px',
          backdropFilter: 'blur(12px)',
        }}>
          {!sent ? (
            <>
              <h2 style={{
                fontFamily: "'Barlow', sans-serif",
                fontSize: '20px',
                fontWeight: 700,
                marginBottom: '8px',
                letterSpacing: '-0.02em',
              }}>
                Sign in
              </h2>
              <p style={{
                fontSize: '13px',
                color: 'rgba(255,255,255,0.4)',
                marginBottom: '28px',
                lineHeight: 1.5,
              }}>
                Enter your email to receive a magic link — no password needed.
              </p>

              <div onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'rgba(255,255,255,0.35)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    display: 'block',
                    marginBottom: '8px',
                  }}>
                    Email address
                  </label>
                  <input
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin(e)}
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '14px 16px',
                      borderRadius: '10px',
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: 'rgba(0,0,0,0.3)',
                      color: '#f6f6f7',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '14px',
                      outline: 'none',
                      transition: 'border-color 0.2s, box-shadow 0.2s',
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = 'rgba(144,21,237,0.5)';
                      e.target.style.boxShadow = '0 0 0 3px rgba(144,21,237,0.1)';
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                      e.target.style.boxShadow = 'none';
                    }}
                  />
                </div>

                {error && (
                  <div style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: '#f87171',
                    fontSize: '13px',
                  }}>
                    {error}
                  </div>
                )}

                <button
                  onClick={handleLogin}
                  disabled={loading || !email.trim()}
                  style={{
                    width: '100%',
                    padding: '14px',
                    borderRadius: '10px',
                    border: 'none',
                    background: loading ? 'rgba(144,21,237,0.3)' : 'linear-gradient(135deg, #9015ed 0%, #4a3fed 50%, #245ef9 100%)',
                    color: 'white',
                    fontFamily: "'Raleway', sans-serif",
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: loading ? 'wait' : 'pointer',
                    transition: 'all 0.15s',
                    opacity: !email.trim() ? 0.4 : 1,
                    letterSpacing: '0.01em',
                  }}
                >
                  {loading ? '⏳ Sending link...' : '✉️ Send Magic Link'}
                </button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>✉️</div>
              <h2 style={{
                fontFamily: "'Barlow', sans-serif",
                fontSize: '20px',
                fontWeight: 700,
                marginBottom: '8px',
              }}>
                Check your email
              </h2>
              <p style={{
                fontSize: '14px',
                color: 'rgba(255,255,255,0.5)',
                marginBottom: '8px',
                lineHeight: 1.6,
              }}>
                We sent a magic link to
              </p>
              <p style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: '#c6beee',
                marginBottom: '24px',
              }}>
                {email}
              </p>
              <p style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.3)',
                marginBottom: '24px',
                lineHeight: 1.5,
              }}>
                Click the link in the email to sign in. It may take a minute to arrive.
              </p>
              <button
                onClick={() => { setSent(false); setEmail(''); }}
                style={{
                  padding: '10px 20px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.6)',
                  fontFamily: 'inherit',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                ← Try a different email
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          textAlign: 'center',
          marginTop: '32px',
          fontSize: '11px',
          color: 'rgba(255,255,255,0.2)',
        }}>
          Powered by Onsite Affiliate
        </div>
      </div>
    </div>
  );
}
