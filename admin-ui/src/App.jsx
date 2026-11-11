import React, { useCallback, useEffect, useState } from 'react';
import { api, setSignedOutHandler } from './api';
import { Icon } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';
import Transactions from './pages/Transactions';
import Security from './pages/Security';

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['users', 'Users', 'users'],
  ['transactions', 'Transactions', 'money'],
  ['security', 'Security', 'shield'],
];

// #/users/<id> style routes (no server routing needed)
const readRoute = () => {
  const [, page = 'dashboard', id] = window.location.hash.split('/');
  return { page, id };
};

const App = () => {
  const [admin, setAdmin] = useState(undefined); // undefined = checking, null = signed out
  const [route, setRoute] = useState(readRoute());

  const refreshAdmin = useCallback(
    () =>
      api('/me')
        .then(r => setAdmin(r.admin))
        .catch(() => setAdmin(null)),
    [],
  );

  useEffect(() => {
    setSignedOutHandler(() => setAdmin(null));
    refreshAdmin();
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [refreshAdmin]);

  const go = (page, id) => {
    window.location.hash = id ? `/${page}/${id}` : `/${page}`;
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setAdmin(null);
    go('dashboard');
  };

  if (admin === undefined) {
    return <div className="loading">Loading…</div>;
  }
  if (!admin) {
    return <Login onSignedIn={a => setAdmin(a)} />;
  }

  const openUser = id => go('users', id);
  let page;
  if (route.page === 'users' && route.id) {
    page = <UserDetail id={route.id} back={() => go('users')} />;
  } else if (route.page === 'users') {
    page = <Users openUser={openUser} />;
  } else if (route.page === 'transactions') {
    page = <Transactions openUser={openUser} />;
  } else if (route.page === 'security') {
    page = <Security admin={admin} refreshAdmin={refreshAdmin} />;
  } else {
    page = <Dashboard openUser={openUser} />;
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="phone" size={18} />
          </span>
          <span>
            Calling<span className="k">Karo</span>
            <small>Admin</small>
          </span>
        </div>
        {NAV.map(([key, label, icon]) => (
          <button key={key} className={`nav-item${route.page === key ? ' active' : ''}`} onClick={() => go(key)}>
            <Icon name={icon} />
            {label}
          </button>
        ))}
        <div className="side-foot">
          <div className="who">
            <span className="avatar">{admin.username[0].toUpperCase()}</span>
            <div>
              <b style={{ color: '#fff' }}>{admin.username}</b>
              <div style={{ fontSize: 12, color: '#8b8f9b' }}>{admin.totpEnabled ? 'Authenticator 2FA' : 'Email 2FA'}</div>
            </div>
          </div>
          <button className="nav-item" onClick={logout}>
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
};

export default App;
