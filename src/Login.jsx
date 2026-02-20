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

  const handleGoogleLogin = async () => {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) setError(error.message);
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
                Sign in to access the Onsite Affiliate SDR platform.
              </p>

              {/* Google Sign In */}
              <button onClick={handleGoogleLogin}
                style={{
                  width: '100%', padding: '13px', borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.05)',
                  color: '#f6f6f7', fontFamily: "'Raleway', sans-serif",
                  fontSize: '14px', fontWeight: 500, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; }}>
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', margin: '24px 0' }}>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>or</span>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
              </div>

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
