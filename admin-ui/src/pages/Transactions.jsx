import React, { useEffect, useState } from 'react';
import { api, addDays, dayIST, dt, num, LEDGER_LABEL } from '../api';
import { DateRange, Icon, Kpi } from '../components/ui';

const Transactions = ({ openUser }) => {
  const [range, setRange] = useState({ from: addDays(dayIST(), -29), to: dayIST() });
  const [q, setQ] = useState({ type: '', search: '', page: 1 });
  const [typed, setTyped] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQ(s => ({ ...s, search: typed, page: 1 })), 350);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    setError('');
    api('/transactions', { query: { ...range, ...q, limit: 30 } })
      .then(d => live && setData(d))
      .catch(e => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [range, q]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p>Every credit movement in every wallet</p>
        </div>
        <DateRange
          value={range}
          onChange={r => {
            setRange(r);
            setQ(s => ({ ...s, page: 1 }));
          }}
        />
      </div>
      {error ? <div className="error">{error}</div> : null}
      {data ? (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
          <Kpi label="Entries" value={num(data.total)} icon="money" />
          <Kpi label="Credits added" value={`+${num(data.credited)}`} icon="coins" color="#1F9D55" />
          <Kpi label="Credits used / removed" value={num(data.debited)} icon="phone" color="#D93B30" />
        </div>
      ) : null}
      <div className="card">
        <div className="toolbar">
          <div className="row" style={{ flex: 1, minWidth: 240 }}>
            <Icon name="search" />
            <input className="input" placeholder="User email or reference id" value={typed} onChange={e => setTyped(e.target.value)} style={{ flex: 1 }} />
          </div>
          <select className="select" value={q.type} onChange={e => setQ({ ...q, type: e.target.value, page: 1 })} aria-label="Type">
            <option value="">All types</option>
            {(data?.types || Object.keys(LEDGER_LABEL)).map(t => (
              <option key={t} value={t}>
                {LEDGER_LABEL[t] || t}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th className="num">Balance after</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {!data ? (
                <tr>
                  <td colSpan={6} className="loading">
                    Loading…
                  </td>
                </tr>
              ) : data.rows.length ? (
                data.rows.map(r => (
                  <tr key={r.id} className="click" onClick={() => openUser(r.user_id)}>
                    <td>{dt(r.created_at)}</td>
                    <td>{r.email}</td>
                    <td>{LEDGER_LABEL[r.type] || r.type}</td>
                    <td className={`num ${r.amount > 0 ? 'pos' : 'neg'}`}>
                      {r.amount > 0 ? '+' : ''}
                      {num(r.amount)}
                    </td>
                    <td className="num">{num(r.balance_after)}</td>
                    <td className="mono muted">{r.meta?.reason || r.ref_id}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="empty">
                    No transactions match
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

export default Transactions;
