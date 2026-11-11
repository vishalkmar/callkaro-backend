import React, { useState } from 'react';
import { api } from '../api';
import { Icon, Spinner } from '../components/ui';

/** Step 1 username + password, step 2 the second factor (emailed code or authenticator app). */
const Login = ({ onSignedIn }) => {
  const [step, setStep] = useState('password');
  const [form, setForm] = useState({ username: '', password: '' });
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submitPassword = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const c = await api('/auth/login', { method: 'POST', body: form });
      setChallenge(c);
      setStep('code');
      setForm(f => ({ ...f, password: '' })); // never keep it around
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/auth/verify', { method: 'POST', body: { challengeId: challenge.challengeId, code: code.trim() } });
      onSignedIn(r.admin);
    } catch (err) {
      setError(err.code === 'ADMIN_BAD_CODE' && err.data?.attemptsLeft != null ? `Wrong code - ${err.data.attemptsLeft} tries left` : err.message);
      if (err.code === 'ADMIN_CODE_EXPIRED') {
        setStep('password');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">
            <Icon name="phone" size={18} />
          </span>
          <span>
            Calling<span className="k">Karo</span>
            <small>Admin console</small>
          </span>
        </div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1>
            Everything in your app, <span>one secure place.</span>
          </h1>
          <p>Users, calls, credits, revenue and security - protected by a password and a second factor on every sign-in.</p>
        </div>
        <p style={{ fontSize: 12, position: 'relative', zIndex: 1 }}>Every sign-in and admin action is recorded.</p>
      </div>
      <div className="login-form">
        {step === 'password' ? (
          <form className="login-card" onSubmit={submitPassword}>
            <div>
              <h2>Sign in</h2>
              <p className="muted">Admin access only.</p>
            </div>
            {error ? <div className="error">{error}</div> : null}
            <label className="field">
              Username
              <input className="input" autoComplete="username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required autoFocus />
            </label>
            <label className="field">
              Password
              <input className="input" type="password" autoComplete="current-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
            </label>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : null} Continue
            </button>
          </form>
        ) : (
          <form className="login-card" onSubmit={submitCode}>
            <div>
              <h2>Two-step check</h2>
              <p className="muted">
                {challenge?.method === 'totp'
                  ? 'Enter the 6-digit code from your authenticator app.'
                  : `We emailed a 6-digit code to ${challenge?.sentTo}. It is valid for 5 minutes.`}
              </p>
            </div>
            {error ? <div className="error">{error}</div> : null}
            <input
              className="input code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              autoFocus
              required
            />
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>
              {busy ? <Spinner /> : null} Verify & sign in
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setStep('password');
                setCode('');
                setError('');
              }}
            >
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default Login;
