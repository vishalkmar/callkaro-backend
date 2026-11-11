import React from 'react';
import { addDays, dayIST } from '../api';

const P = {
  dashboard: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
  users: 'M16 11a4 4 0 1 0-8 0M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-8 18a8 8 0 0 1 16 0',
  money: 'M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v.01M18 15v.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4',
  logout: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  phone: 'M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z',
  rupee: 'M6 3h12M6 8h12M6 13l8.5 8M6 13h3c6.7 0 6.7-10 0-10',
  play: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2-14 6 4-6 4V8Z',
  wheel: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-10V2m0 10 8.7 5M12 12l-8.7 5',
  key: 'M15 7a4 4 0 1 1-4 4l-8 8v3h3l1-1v-2h2v-2h2l1.5-1.5A4 4 0 0 1 15 7Z',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  app: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm4 17h2',
  back: 'M15 18l-6-6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  alert: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
  coins: 'M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Zm8-3v6c0 1.7-3.6 3-8 3s-8-1.3-8-3V4m16 6v6c0 1.7-3.6 3-8 3s-8-1.3-8-3v-6',
};

export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={P[name]} />
  </svg>
);

export const Badge = ({ children, tone }) => <span className={`badge ${tone || String(children).toLowerCase()}`}>{children}</span>;

export const Kpi = ({ label, value, sub, icon, color = 'var(--orange)', hero }) => (
  <div className={`card kpi${hero ? ' hero' : ''}`}>
    {icon ? (
      <span className="dot" style={{ background: color }}>
        <Icon name={icon} size={17} />
      </span>
    ) : null}
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {sub ? <div className="sub">{sub}</div> : null}
  </div>
);

const PRESETS = [
  ['Today', 0],
  ['7D', 6],
  ['30D', 29],
  ['90D', 89],
  ['1Y', 364],
];

/** Indian-day date range with quick presets + custom from/to. */
export const DateRange = ({ value, onChange }) => {
  const today = dayIST();
  const active = PRESETS.find(([, n]) => value.to === today && value.from === addDays(today, -n));
  return (
    <div className="range">
      <div className="seg" role="group" aria-label="Quick range">
        {PRESETS.map(([label, n]) => (
          <button
            key={label}
            type="button"
            className={active?.[0] === label ? 'on' : ''}
            onClick={() => onChange({ from: addDays(today, -n), to: today })}
          >
            {label}
          </button>
        ))}
      </div>
      <input className="input" type="date" value={value.from} max={value.to} onChange={e => onChange({ ...value, from: e.target.value })} aria-label="From" />
      <span className="muted">to</span>
      <input className="input" type="date" value={value.to} min={value.from} max={today} onChange={e => onChange({ ...value, to: e.target.value })} aria-label="To" />
    </div>
  );
};

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export const Modal = ({ title, children, onClose }) => (
  <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className="card modal" role="dialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </div>
  </div>
);
