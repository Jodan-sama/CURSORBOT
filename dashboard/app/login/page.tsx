'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Invalid password');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto 0' }}>
      <h1 style={{ fontFamily: 'var(--font-din-condensed), sans-serif', marginBottom: 8 }}>
        Cursorbot Control
      </h1>
      <p style={{ color: '#555', marginBottom: 24 }}>Enter password to continue.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          style={{
            width: '100%',
            padding: '10px 12px',
            marginBottom: 12,
            border: '1px solid #ccc',
            borderRadius: 6,
            fontSize: 16,
            boxSizing: 'border-box',
          }}
        />
        {error && (
          <p style={{ color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px 16px',
            backgroundColor: '#0D9488',
            color: '#000',
            border: 'none',
            borderRadius: 6,
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
