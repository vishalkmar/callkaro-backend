import React, { useEffect, useState } from 'react';
import { api, dt, num } from '../api';
import { Badge, Icon } from '../components/ui';

const Users = ({ openUser }) => {
  const [q, setQ] = useState({ search: '', status: '', page: 1 });
  const [typed, setTyped] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  // search after the admin stops typing
  useEffect(() => {
    const t = setTimeout(() => setQ(s => ({ ...s, search: typed, page: 1 })), 350);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    api('/users', { query: { ...q, limit: 25 } })
      .then(d => live && setData(d))
      .catch(e => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [q]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>{data ? `${num(data.total)} users` : ' '}</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="card">
        <div className="toolbar">
          <div className="row" style={{ flex: 1, minWidth: 260 }}>
            <Icon name="search" />
            <input className="input" placeholder="Search email, name, referral code or user id" value={typed} onChange={e => setTyped(e.target.value)} style={{ flex: 1 }} />
          </div>
          <select className="select" value={q.status} onChange={e => setQ({ ...q, status: e.target.value, page: 1 })} aria-label="Status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
            <option value="deleted">Deleted</option>
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th className="num">Credits</th>
                <th className="num">Calls</th>
                <th className="num">Phones</th>
                <th>Joined</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {!data ? (
                <tr>
                  <td colSpan={7} className="loading">
                    Loading…
                  </td>
                </tr>
              ) : data.users.length ? (
                data.users.map(u => (
                  <tr key={u.id} className="click" onClick={() => openUser(u.id)}>
                    <td>
                      <b>{u.email}</b>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.name || '—'} · {u.referral_code}
                      </div>
                    </td>
                    <td>
                      <Badge>{u.status}</Badge>
                    </td>
                    <td className="num">{num(u.credits)}</td>
                    <td className="num">{num(u.calls)}</td>
                    <td className="num">{num(u.devices)}</td>
                    <td>{dt(u.created_at)}</td>
                    <td>{dt(u.last_login_at)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    No users match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted">
            Page {q.page} of {pages}
          </span>
          <div className="row">
            <button className="btn btn-ghost btn-sm" disabled={q.page <= 1} onClick={() => setQ({ ...q, page: q.page - 1 })}>
              Previous
            </button>
            <button className="btn btn-ghost btn-sm" disabled={q.page >= pages} onClick={() => setQ({ ...q, page: q.page + 1 })}>
              Next
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Users;
