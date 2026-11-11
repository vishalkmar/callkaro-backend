import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, dt } from '../api';
import { Badge, Icon, Spinner } from '../components/ui';

const ACTION = {
  login_success: 'Signed in',
  login_failed: 'Wrong password',
  login_locked: 'Sign-in while locked',
  login_password_ok: 'Password OK, code sent',
  login_code_failed: 'Wrong 2FA code',
  logout: 'Signed out',
  password_changed: 'Password changed',
  password_change_failed: 'Password change refused',
  totp_enabled: 'Authenticator turned on',
  totp_disabled: 'Authenticator turned off',
  sessions_revoked: 'Other sessions signed out',
  user_blocked: 'Blocked a user',
  user_unblocked: 'Unblocked a user',
  credits_adjusted: 'Changed credits',
};

const Security = ({ admin, refreshAdmin }) => {
  const [setup, setSetup] = useState(null); // { secret, otpauthUri, qr }
  const [code, setCode] = useState('');
  const [off, setOff] = useState({ password: '', code: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [sessions, setSessions] = useState([]);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState({});

  const load = useCallback(() => {
    api('/security/sessions').then(setSessions).catch(() => {});
    api('/security/audit', { query: { limit: 60 } }).then(setLog).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const run = async (key, fn, success) => {
    setBusy(key);
    setNote({});
    try {
      await fn();
      setNote({ [key]: { ok: success } });
      load();
    } catch (e) {
      setNote({ [key]: { error: e.message } });
    } finally {
      setBusy('');
    }
  };
  const Note = ({ k }) => (note[k]?.error ? <div className="error">{note[k].error}</div> : note[k]?.ok ? <div className="ok">{note[k].ok}</div> : null);

  const startSetup = () =>
    run('totp', async () => {
      const s = await api('/security/totp/setup', { method: 'POST' });
      setSetup({ ...s, qr: await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 360, color: { dark: '#111318' } }) });
    }, 'Scan the QR code, then enter the 6-digit code to confirm.');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Security</h1>
          <p>Two-step sign-in, password and sessions for {admin.username}</p>
        </div>
      </div>
      <div className="sec-grid">
        <div className="card card-pad stack">
          <h3>Two-step sign-in (2FA)</h3>
          <div className="method">
            <span className="ic" style={{ background: 'var(--orange)' }}>
              <Icon name="mail" />
            </span>
            <div>
              <b>Email code</b> {admin.totpEnabled ? <Badge>Backup</Badge> : <Badge tone="active">In use</Badge>}
              <div className="muted">A 6-digit code is sent to {admin.email} on every sign-in.</div>
            </div>
          </div>
          <div className="method">
            <span className="ic" style={{ background: 'var(--ink)' }}>
              <Icon name="app" />
            </span>
            <div style={{ flex: 1 }}>
              <b>Authenticator app</b> {admin.totpEnabled ? <Badge tone="active">On</Badge> : <Badge>Off</Badge>}
              <div className="muted">Google Authenticator, Microsoft Authenticator, Authy… Works without email or internet on the phone.</div>
            </div>
          </div>
          <Note k="totp" />
          {!admin.totpEnabled && !setup ? (
            <button className="btn btn-primary" onClick={startSetup} disabled={busy === 'totp'}>
              {busy === 'totp' ? <Spinner /> : null} Set up authenticator app
            </button>
          ) : null}
          {!admin.totpEnabled && setup ? (
            <div className="stack">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <img className="qr" src={setup.qr} alt="QR code for the authenticator app" />
                <div className="stack" style={{ flex: 1, minWidth: 200 }}>
                  <div className="muted">1. Open your authenticator app and scan this code.</div>
                  <div className="muted">Can&apos;t scan? Enter this key:</div>
                  <div className="secret mono">{setup.secret}</div>
                  <div className="muted">2. Type the 6-digit code it shows:</div>
                  <input className="input code-input" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
                </div>
              </div>
              <button
                className="btn btn-primary"
                disabled={code.length !== 6 || busy === 'totp'}
                onClick={() =>
                  run('totp', async () => {
                    await api('/security/totp/enable', { method: 'POST', body: { code } });
                    setSetup(null);
                    setCode('');
                    await refreshAdmin();
                  }, 'Authenticator app is on. Next sign-in will ask for its code.')
                }
              >
                Confirm & turn on
              </button>
            </div>
          ) : null}
          {admin.totpEnabled ? (
            <div className="stack">
              <div className="muted">Turn off (needs your password and a current app code):</div>
              <input className="input" type="password" placeholder="Password" value={off.password} onChange={e => setOff({ ...off, password: e.target.value })} />
              <input className="input" inputMode="numeric" maxLength={6} placeholder="Authenticator code" value={off.code} onChange={e => setOff({ ...off, code: e.target.value.replace(/\D/g, '') })} />
              <button
                className="btn btn-ghost"
                disabled={!off.password || off.code.length !== 6 || busy === 'totp'}
                onClick={() =>
                  run('totp', async () => {
                    await api('/security/totp/disable', { method: 'POST', body: off });
                    setOff({ password: '', code: '' });
                    await refreshAdmin();
                  }, 'Authenticator app turned off. Sign-in uses the email code again.')
                }
              >
                Turn off authenticator
              </button>
            </div>
          ) : null}
        </div>

        <div className="card card-pad stack">
          <h3>Change password</h3>
          <div className="muted">At least 10 characters with letters and numbers. Other browsers are signed out.</div>
          <Note k="pw" />
          <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={pw.currentPassword} onChange={e => setPw({ ...pw, currentPassword: e.target.value })} />
          <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={pw.newPassword} onChange={e => setPw({ ...pw, newPassword: e.target.value })} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Repeat new password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} />
          {pw.confirm && pw.confirm !== pw.newPassword ? <div className="error">The new passwords do not match</div> : null}
          <button
            className="btn btn-dark"
            disabled={!pw.currentPassword || !pw.newPassword || pw.newPassword !== pw.confirm || busy === 'pw'}
            onClick={() =>
              run('pw', async () => {
                await api('/security/password', { method: 'POST', body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } });
                setPw({ currentPassword: '', newPassword: '', confirm: '' });
              }, 'Password changed.')
            }
          >
            {busy === 'pw' ? <Spinner /> : null} Update password
          </button>

          <h3 style={{ marginTop: 10 }}>Signed-in browsers</h3>
          <Note k="sess" />
          {sessions.map(s => (
            <div key={s.id} className="method">
              <span className="ic" style={{ background: s.current ? 'var(--green)' : '#9CA3AF' }}>
                <Icon name="key" />
              </span>
              <div>
                <b>{s.current ? 'This browser' : (s.user_agent || 'Unknown browser').slice(0, 50)}</b>
                <div className="muted">
                  {s.ip} · last active {dt(s.last_seen_at)}
                </div>
              </div>
            </div>
          ))}
          <button
            className="btn btn-ghost"
            disabled={sessions.length < 2 || busy === 'sess'}
            onClick={() => run('sess', () => api('/security/sessions/revoke-others', { method: 'POST' }), 'Other browsers were signed out.')}
          >
            Sign out all other browsers
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-pad">
          <h3>Activity log</h3>
          <div className="muted">Sign-ins, failed attempts and every admin action.</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Admin</th>
                <th>Action</th>
                <th>IP</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {log.map(l => (
                <tr key={l.id}>
                  <td>{dt(l.created_at)}</td>
                  <td>{l.username || '—'}</td>
                  <td>
                    {/fail|locked/.test(l.action) ? <Badge tone="blocked">{ACTION[l.action] || l.action}</Badge> : ACTION[l.action] || l.action}
                  </td>
                  <td className="mono">{l.ip || '—'}</td>
                  <td className="muted">{Object.keys(l.detail || {}).length ? JSON.stringify(l.detail).slice(0, 80) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default Security;
