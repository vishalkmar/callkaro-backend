import React, { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, addDays, dayIST, dt, inr, num, LEDGER_LABEL } from '../api';
import { Badge, DateRange, Kpi } from '../components/ui';

const ORANGE = '#FF7A2E';
const PIE = ['#FF7A2E', '#111318', '#1F9D55', '#6D5EF0', '#F5A623', '#14B8A6', '#EC4899', '#5B8DEF', '#D93B30', '#9CA3AF'];
const short = d => d.slice(5).split('-').reverse().join('/');

const Dashboard = ({ openUser }) => {
  const [range, setRange] = useState({ from: addDays(dayIST(), -29), to: dayIST() });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    api('/dashboard', { query: range })
      .then(d => live && setData(d))
      .catch(e => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [range]);

  const k = data?.kpis;
  const earned = (data?.creditsByType || []).filter(c => c.credits > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            {range.from === range.to ? range.from : `${range.from} → ${range.to}`} · India time
          </p>
        </div>
        <DateRange value={range} onChange={setRange} />
      </div>
      {error ? <div className="error">{error}</div> : null}
      {!data ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <div className="kpis">
            <Kpi hero label="Revenue" value={inr(k.revenueInr)} sub={`${num(k.orders)} paid orders · margin ${inr(k.estMarginInr)}`} />
            <Kpi label="New users" value={num(k.usersNew)} sub={`${num(k.usersTotal)} total · ${num(k.usersActive)} active`} icon="users" />
            <Kpi label="Calls" value={num(k.calls)} sub={`${num(k.callsAnswered)} answered · ${num(k.talkMinutes)} min talk`} icon="phone" color="#111318" />
            <Kpi label="Provider cost (est.)" value={inr(k.estProviderCostInr)} sub={`${num(k.creditsCharged)} credits charged`} icon="rupee" color="#D93B30" />
            <Kpi label="Rewarded videos" value={num(k.videos)} sub="watched in range" icon="play" color="#6D5EF0" />
            <Kpi label="Spins" value={num(k.spins)} sub="in range" icon="wheel" color="#1F9D55" />
            <Kpi label="Credits in wallets" value={num(k.creditsOutstanding)} sub={`≈ ${num(Math.floor(k.creditsOutstanding / 1000))} min of talk owed`} icon="coins" color="#F5A623" />
            <Kpi label="Blocked / open reports" value={`${num(k.usersBlocked)} / ${num(k.reportsOpen)}`} sub="users blocked · reports to review" icon="alert" color="#D93B30" />
          </div>

          <div className="grid-2">
            <div className="card card-pad">
              <div className="chart-title">
                <h3>Calls & talk minutes</h3>
                <span className="muted">per day</span>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data.series} margin={{ left: -10, right: 8 }}>
                  <defs>
                    <linearGradient id="gCalls" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ORANGE} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ORANGE} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#f0f0f3" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={short} fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip labelFormatter={short} />
                  <Legend />
                  <Area type="monotone" dataKey="calls" name="Calls" stroke={ORANGE} fill="url(#gCalls)" strokeWidth={2.5} />
                  <Area type="monotone" dataKey="talkMinutes" name="Talk minutes" stroke="#111318" fill="transparent" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="card card-pad">
              <div className="chart-title">
                <h3>New users</h3>
                <span className="muted">per day</span>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.series} margin={{ left: -10, right: 8 }}>
                  <CartesianGrid stroke="#f0f0f3" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={short} fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip labelFormatter={short} cursor={{ fill: '#fff1e8' }} />
                  <Bar dataKey="newUsers" name="New users" fill={ORANGE} radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid-2">
            <div className="card card-pad">
              <div className="chart-title">
                <h3>Revenue · videos · spins</h3>
                <span className="muted">per day</span>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={data.series} margin={{ left: -10, right: 8 }}>
                  <CartesianGrid stroke="#f0f0f3" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={short} fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={short} />
                  <Legend />
                  <Area type="monotone" dataKey="revenueInr" name="Revenue ₹" stroke="#1F9D55" fill="#1F9D5522" strokeWidth={2} />
                  <Area type="monotone" dataKey="videos" name="Videos" stroke="#6D5EF0" fill="transparent" strokeWidth={2} />
                  <Area type="monotone" dataKey="spins" name="Spins" stroke={ORANGE} fill="transparent" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="card card-pad">
              <div className="chart-title">
                <h3>Credits given out</h3>
                <span className="muted">by source</span>
              </div>
              {earned.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={earned} dataKey="credits" nameKey="type" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {earned.map((e, i) => (
                        <Cell key={e.type} fill={PIE[i % PIE.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v, n) => [num(v), LEDGER_LABEL[n] || n]} />
                    <Legend formatter={n => LEDGER_LABEL[n] || n} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="empty">No credits given in this range</div>
              )}
            </div>
          </div>

          <div className="grid-2e">
            <div className="card">
              <div className="card-pad">
                <h3>Top callers</h3>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th className="num">Calls</th>
                      <th className="num">Minutes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCallers.length ? (
                      data.topCallers.map(t => (
                        <tr key={t.id} className="click" onClick={() => openUser(t.id)}>
                          <td>{t.email}</td>
                          <td className="num">{num(t.calls)}</td>
                          <td className="num">{num(t.talkMinutes)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="empty">
                          No calls in this range
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-pad">
                <h3>Latest sign-ups</h3>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Joined</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentUsers.map(u => (
                      <tr key={u.id} className="click" onClick={() => openUser(u.id)}>
                        <td>{u.email}</td>
                        <td>{dt(u.created_at)}</td>
                        <td>
                          <Badge>{u.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default Dashboard;
