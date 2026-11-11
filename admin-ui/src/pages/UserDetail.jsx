import React, { useCallback, useEffect, useState } from 'react';
import { api, dt, inr, num, LEDGER_LABEL } from '../api';
import { Badge, Icon, Modal, Spinner } from '../components/ui';

const secs = s => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;
const TABS = ['Transactions', 'Calls', 'Orders', 'Spins', 'Devices & sessions', 'Referrals', 'Reports'];

const Table = ({ cols, rows, render, empty = 'Nothing here yet' }) => (
  <div className="table-wrap">
    <table>
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c} className={/Credits|Amount|Balance|Talk|₹/.test(c) ? 'num' : ''}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length ? (
          rows.map(render)
        ) : (
          <tr>
            <td colSpan={cols.length} className="empty">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

const UserDetail = ({ id, back }) => {
  const [d, setD] = useState(null);
  const [tab, setTab] = useState(TABS[0]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'block' | 'credits'
  const [form, setForm] = useState({ amount: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api(`/users/${id}`)
      .then(setD)
      .catch(e => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const act = async (path, body, done) => {
    setBusy(true);
    setError('');
    try {
      await api(`/users/${id}/${path}`, { method: 'POST', body });
      setModal(null);
      setForm({ amount: '', reason: '' });
      setMsg(done);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !d) {
    return <div className="error">{error}</div>;
  }
  if (!d) {
    return <div className="loading">Loading…</div>;
  }
  const u = d.user;
  const blocked = u.status === 'blocked';

  return (
    <>
      <div className="page-head">
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={back}>
            <Icon name="back" size={16} /> Users
          </button>
          <h1 style={{ fontSize: 24 }}>{u.email}</h1>
          <Badge>{u.status}</Badge>
        </div>
        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={() => setModal('credits')}>
            Add / remove credits
          </button>
          <button className={`btn btn-sm ${blocked ? 'btn-dark' : 'btn-danger'}`} onClick={() => setModal('block')}>
            {blocked ? 'Unblock user' : 'Block user'}
          </button>
        </div>
      </div>
      {msg ? <div className="ok" style={{ marginBottom: 14 }}>{msg}</div> : null}
      {error ? <div className="error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="profile">
        <div className="stack">
          <div className="card profile-card">
            <div className="profile-top">
              <span className="avatar">{(u.name || u.email)[0].toUpperCase()}</span>
              <div>
                <h3 style={{ fontSize: 18 }}>{u.name || 'No name'}</h3>
                <div className="muted mono">{u.id}</div>
              </div>
            </div>
            <div className="minis">
              <div className="mini">
                <b>{num(u.credits)}</b>
                <span>credits now</span>
              </div>
              <div className="mini">
                <b>{num(d.totals.calls)}</b>
                <span>calls</span>
              </div>
              <div className="mini">
                <b>{num(d.totals.talkMinutes)}</b>
                <span>talk min</span>
              </div>
              <div className="mini">
                <b>{inr(d.totals.paidInr)}</b>
                <span>paid</span>
              </div>
              <div className="mini">
                <b>{num(d.totals.videos)}</b>
                <span>videos</span>
              </div>
              <div className="mini">
                <b>{num(d.totals.spins)}</b>
                <span>spins</span>
              </div>
            </div>
            <dl className="kv">
              <dt>Lifetime in</dt>
              <dd>{num(u.lifetime_earned)} credits</dd>
              <dt>Lifetime out</dt>
              <dd>{num(u.lifetime_spent)} credits</dd>
              <dt>Last login</dt>
              <dd>{dt(u.last_login_at)}</dd>
              <dt>Referral code</dt>
              <dd className="mono">{u.referral_code || '—'}</dd>
              <dt>Rewards</dt>
              <dd>{u.rewards_disabled ? <Badge tone="blocked">Disabled (rooted / emulator)</Badge> : <Badge tone="active">Allowed</Badge>}</dd>
              {blocked ? (
                <>
                  <dt>Block reason</dt>
                  <dd>{u.blocked_reason || '—'}</dd>
                </>
              ) : null}
            </dl>
          </div>
          <div className="card profile-card">
            <h3>How this account was made</h3>
            <dl className="kv">
              <dt>Created</dt>
              <dd>{dt(d.signup.at)}</dd>
              <dt>Sign-up</dt>
              <dd>{d.signup.method}</dd>
              <dt>First phone</dt>
              <dd className="mono">{d.signup.firstDevice || '—'}</dd>
              <dt>Referred by</dt>
              <dd>{d.signup.referredBy || 'No one'}</dd>
              <dt>Welcome bonus</dt>
              <dd>{d.signup.welcomeBonus ? `${num(d.signup.welcomeBonus)} credits` : 'Not given (phone used before)'}</dd>
              <dt>Terms accepted</dt>
              <dd>{d.signup.termsVersion || '—'}</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="tabs" role="tablist">
            {TABS.map(t => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {tab === 'Transactions' ? (
            <Table
              cols={['When', 'Type', 'Amount', 'Balance after', 'Reference']}
              rows={d.ledger}
              render={l => (
                <tr key={l.id}>
                  <td>{dt(l.created_at)}</td>
                  <td>{LEDGER_LABEL[l.type] || l.type}</td>
                  <td className={`num ${l.amount > 0 ? 'pos' : 'neg'}`}>
                    {l.amount > 0 ? '+' : ''}
                    {num(l.amount)}
                  </td>
                  <td className="num">{num(l.balance_after)}</td>
                  <td className="mono muted">{l.meta?.reason || l.ref_id}</td>
                </tr>
              )}
            />
          ) : null}
          {tab === 'Calls' ? (
            <Table
              cols={['Started', 'To', 'Status', 'Talk', 'Credits', 'Line']}
              rows={d.calls}
              render={c => (
                <tr key={c.id}>
                  <td>{dt(c.started_at)}</td>
                  <td className="mono">{c.to_number}</td>
                  <td>
                    <Badge>{c.status}</Badge>
                  </td>
                  <td className="num">{secs(c.talk_seconds)}</td>
                  <td className="num">{num(c.credits)}</td>
                  <td>{c.provider || 'twilio'}</td>
                </tr>
              )}
            />
          ) : null}
          {tab === 'Orders' ? (
            <Table
              cols={['Created', 'Pack', '₹', 'Credits', 'Status', 'Receipt']}
              rows={d.orders}
              render={o => (
                <tr key={o.id}>
                  <td>{dt(o.created_at)}</td>
                  <td>{o.package_id}</td>
                  <td className="num">{inr(o.amount_paise / 100)}</td>
                  <td className="num">{num(o.credits)}</td>
                  <td>
                    <Badge>{o.status}</Badge>
                  </td>
                  <td className="mono">{o.receipt_no || '—'}</td>
                </tr>
              )}
            />
          ) : null}
          {tab === 'Spins' ? (
            <Table
              cols={['When', 'Prize credits', 'Source', 'Collected']}
              rows={d.spins}
              render={s => (
                <tr key={s.id}>
                  <td>{dt(s.created_at)}</td>
                  <td className="num">{num(s.credits)}</td>
                  <td>{s.source}</td>
                  <td>{s.claimed ? <Badge tone="active">Yes</Badge> : <Badge tone="orange">Waiting for ad</Badge>}</td>
                </tr>
              )}
            />
          ) : null}
          {tab === 'Devices & sessions' ? (
            <>
              <div className="card-pad">
                <b>Phones used:</b>{' '}
                {(u.device_ids || []).length ? (u.device_ids || []).map(x => <span key={x} className="badge mono" style={{ marginRight: 6 }}>{x}</span>) : '—'}
              </div>
              <Table
                cols={['Signed in', 'Phone', 'App', 'Last used', 'State']}
                rows={d.sessions}
                render={s => (
                  <tr key={s.id}>
                    <td>{dt(s.created_at)}</td>
                    <td className="mono">{s.device_id}</td>
                    <td className="muted">{(s.user_agent || '').slice(0, 40)}</td>
                    <td>{dt(s.last_used_at)}</td>
                    <td>{s.revoked_at ? <Badge tone="blocked">Signed out</Badge> : new Date(s.expires_at) < new Date() ? <Badge>Expired</Badge> : <Badge tone="active">Active</Badge>}</td>
                  </tr>
                )}
              />
            </>
          ) : null}
          {tab === 'Referrals' ? (
            <Table
              cols={['Joined', 'Invited user']}
              rows={d.referrals}
              empty="Nobody joined with this user's code yet"
              render={r => (
                <tr key={r.id}>
                  <td>{dt(r.created_at)}</td>
                  <td>{r.email}</td>
                </tr>
              )}
            />
          ) : null}
          {tab === 'Reports' ? (
            <Table
              cols={['When', 'Type', 'Reason', 'Status', 'Details']}
              rows={[...d.reportsAgainst.map(r => ({ ...r, kind: 'Against user' })), ...d.reportsBy.map(r => ({ ...r, kind: 'Filed by user' }))]}
              empty="No reports"
              render={r => (
                <tr key={`${r.kind}${r.id}`}>
                  <td>{dt(r.created_at)}</td>
                  <td>{r.kind}</td>
                  <td>{r.reason}</td>
                  <td>
                    <Badge>{r.status}</Badge>
                  </td>
                  <td className="muted">{r.details || r.target_number || '—'}</td>
                </tr>
              )}
            />
          ) : null}
        </div>
      </div>

      {modal === 'block' ? (
        <Modal title={blocked ? 'Unblock this user?' : 'Block this user?'} onClose={() => setModal(null)}>
          <p className="muted" style={{ margin: 0 }}>
            {blocked ? 'They can sign in and call again.' : 'They are signed out on every phone and cannot call or earn credits.'}
          </p>
          {!blocked ? (
            <input className="input" placeholder="Reason (shown to the user)" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className={`btn ${blocked ? 'btn-dark' : 'btn-danger'}`}
              disabled={busy}
              onClick={() => act('block', { blocked: !blocked, reason: form.reason }, blocked ? 'User unblocked' : 'User blocked')}
            >
              {busy ? <Spinner /> : null} {blocked ? 'Unblock' : 'Block'}
            </button>
          </div>
        </Modal>
      ) : null}
      {modal === 'credits' ? (
        <Modal title="Add or remove credits" onClose={() => setModal(null)}>
          <p className="muted" style={{ margin: 0 }}>
            Use a minus sign to remove (e.g. -500). 1000 credits = 1 minute. The balance never goes below 0.
          </p>
          <input className="input" type="number" placeholder="Amount, e.g. 2000 or -500" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
          <input className="input" placeholder="Reason (saved in the audit log)" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !Number(form.amount) || form.reason.trim().length < 3}
              onClick={() => act('credits', { amount: Math.trunc(Number(form.amount)), reason: form.reason.trim() }, 'Credits updated')}
            >
              {busy ? <Spinner /> : null} Apply
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
};

export default UserDetail;
