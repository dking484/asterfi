import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users as UsersIcon, UsersRound, Phone, Hash, Workflow, History, Voicemail as VmIcon, Settings as SettingsIcon, LogOut, Menu, UserCircle, BookUser, Server } from 'lucide-react';
import { api, setTimeZone } from './api.js';
import { DirectoryProvider } from './components/Destination.jsx';
import { useLiveEvents } from './components/ui.jsx';
import { Login, Setup } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Users from './pages/Users.jsx';
import Groups from './pages/Groups.jsx';
import Phones from './pages/Phones.jsx';
import Numbers from './pages/Numbers.jsx';
import Flows from './pages/Flows.jsx';
import Calls from './pages/Calls.jsx';
import Contacts from './pages/Contacts.jsx';
import Voicemail from './pages/Voicemail.jsx';
import Settings, { TrunksAndRoutes } from './pages/Settings.jsx';
import Account from './pages/Account.jsx';
import WebPhone from './components/WebPhone.jsx';
import { applyTheme, BrandLogo } from './theme.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { section: 'Directory' },
  { to: '/contacts', label: 'Contacts', icon: BookUser },
  { to: '/users', label: 'Users', icon: UsersIcon, admin: true },
  { to: '/groups', label: 'Ring Groups', icon: UsersRound, admin: true },
  { to: '/phones', label: 'Phones', icon: Phone, admin: true },
  { section: 'Call Routing', admin: true },
  { to: '/numbers', label: 'Numbers', icon: Hash, admin: true },
  { to: '/flows', label: 'Call Flows', icon: Workflow, admin: true },
  { to: '/trunks', label: 'Trunks & Routes', icon: Server, admin: true },
  { section: 'Activity' },
  { to: '/calls', label: 'Call History', icon: History },
  { to: '/voicemail', label: 'Voicemail', icon: VmIcon, badge: 'vm' },
  { section: 'Account' },
  { to: '/account', label: 'My Account', icon: UserCircle },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, admin: true },
];

const TITLES = { '/': 'Dashboard', '/users': 'Users', '/groups': 'Ring Groups', '/phones': 'Phones', '/numbers': 'Numbers', '/flows': 'Call Flows', '/trunks': 'Trunks & Routes', '/calls': 'Call History', '/contacts': 'Contacts', '/voicemail': 'Voicemail', '/settings': 'Settings', '/account': 'My Account' };

export default function App() {
  const [state, setState] = useState({ loading: true });

  const check = async () => {
    try {
      const s = await api.get('/api/setup/status');
      if (s.needsSetup) return setState({ setup: true, siteName: s.siteName });
      const me = await api.get('/api/me').catch(() => null);
      if (me?.theme) applyTheme(me.theme);
      setTimeZone(me?.timeZone);
      setState({ me, siteName: s.siteName });
    } catch {
      setState({ error: true });
    }
  };
  useEffect(() => {
    check();
    const h = () => setState((s) => ({ ...s, me: null }));
    window.addEventListener('asterfi:unauthorized', h);
    return () => window.removeEventListener('asterfi:unauthorized', h);
  }, []);

  if (state.loading) return null;
  if (state.error) return <div className="auth"><div className="auth-card"><h1>Can't reach AsterFi</h1><p>The management service isn't responding. Try again in a moment.</p><button className="btn primary" onClick={check}>Retry</button></div></div>;
  if (state.setup) return <Setup onDone={check} />;
  if (!state.me) return <Login siteName={state.siteName} onDone={check} />;
  return <DirectoryProvider isAdmin={state.me.role === 'admin'}><Shell me={state.me} siteName={state.siteName} onLogout={async () => { await api.post('/api/logout'); check(); }} /></DirectoryProvider>;
}

function Shell({ me, siteName, onLogout }) {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [navHidden, setNavHidden] = useState(() => { try { return localStorage.getItem('asterfi-nav') === 'hidden'; } catch { return false; } });
  const toggleNav = () => {
    if (window.matchMedia('(max-width: 860px)').matches) return setOpen(true);
    setNavHidden((h) => { try { localStorage.setItem('asterfi-nav', h ? '' : 'hidden'); } catch { /* not remembered */ } return !h; });
  };
  const [vmCount, setVmCount] = useState(0);
  const loadVm = async () => {
    const v = await api.get('/api/voicemail').catch(() => []);
    setVmCount(v.filter((m) => m.folder === 'INBOX').length);
  };
  useEffect(() => { loadVm(); }, [loc.pathname]);
  useLiveEvents(loadVm, ['voicemail.']);
  useEffect(() => setOpen(false), [loc.pathname]);

  const base = '/' + (loc.pathname.split('/')[1] || '');
  const isAdmin = me.role === 'admin';
  const title = TITLES[base] || '';

  return (
    <div className={`shell ${navHidden ? 'nav-hidden' : ''}`}>
      <nav className={`nav ${open ? 'open' : ''}`}>
        <div className="nav-brand">
          <a className="brand-link" href="https://asterfi.org" target="_blank" rel="noopener" title="asterfi.org"><BrandLogo /></a>
          {siteName && siteName !== 'AsterFi' && <small>{siteName}</small>}
        </div>
        <div className="nav-list">
          {NAV.filter((n) => isAdmin || !n.admin).map((n, i) => n.section ? <div key={i} className="nav-section">{n.section}</div> : (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <n.icon size={17} strokeWidth={1.8} />{n.label}
              {n.badge === 'vm' && vmCount > 0 && <span className="count">{vmCount}</span>}
            </NavLink>
          ))}
        </div>
        <div className="nav-foot">
          <div className="me"><Phone size={16} /></div>
          <div className="who">{me.name}<div className="muted small">Ext. {me.extension} · {isAdmin ? 'Administrator' : 'User'}</div></div>
          <button className="btn ghost sm icon" title="Sign out" onClick={onLogout}><LogOut size={15} /></button>
        </div>
      </nav>
      {open && <div className="drawer-backdrop" style={{ zIndex: 49 }} onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon" onClick={toggleNav} aria-label="Menu" title="Show or hide the menu"><Menu size={18} /></button>
          <h1>{title}</h1>
          <div className="spacer" />
          <div id="topbar-actions" style={{ display: 'flex', gap: 8 }} />
        </header>
        <main className="content">
          {isAdmin ? (
            <Routes>
              <Route path="/" element={<Dashboard me={me} isAdmin />} />
              <Route path="/users" element={<Users me={me} />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/phones" element={<Phones />} />
              <Route path="/numbers" element={<Numbers />} />
              <Route path="/flows" element={<Flows />} />
              <Route path="/flows/:id" element={<Flows />} />
              <Route path="/trunks" element={<TrunksAndRoutes />} />
              <Route path="/calls" element={<Calls me={me} isAdmin />} />
              <Route path="/contacts" element={<Contacts me={me} />} />
              <Route path="/voicemail" element={<Voicemail me={me} />} />
              <Route path="/account" element={<Account />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/:tab" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard me={me} />} />
              <Route path="/calls" element={<Calls me={me} />} />
              <Route path="/contacts" element={<Contacts me={me} />} />
              <Route path="/voicemail" element={<Voicemail me={me} />} />
              <Route path="/account" element={<Account />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          )}
        </main>
      </div>
      <WebPhone me={me} />
    </div>
  );
}
