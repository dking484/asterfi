import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Voicemail, Users, Phone, Server, ArrowRightLeft, CircleUser, Clock, Monitor } from 'lucide-react';
import { api, formatNumber, fmtDuration, fmtWhen } from '../api.js';
import { useLiveEvents, Empty, Seg } from '../components/ui.jsx';
import { useDirectory } from '../components/Destination.jsx';
import { CallIcon, partyLabel, CallTable } from './Calls.jsx';
import { usePresence, presenceInfo } from '../components/Presence.jsx';

const SCOPE_KEY = 'asterfi.dash.scope';
const readScope = () => { try { return localStorage.getItem(SCOPE_KEY) || 'all'; } catch { return 'all'; } };

// Admins pick the company view or their own; everyone else gets their own.
export default function Dashboard({ me, isAdmin = false }) {
  const [scope, setScopeState] = useState(readScope);
  const setScope = (v) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ } };
  const toggle = isAdmin && (
    <div className="toolbar"><div className="spacer" />
      <Seg value={scope} onChange={setScope} options={[{ value: 'mine', label: 'My dashboard' }, { value: 'all', label: 'Company' }]} />
    </div>
  );
  return <>{toggle}{isAdmin && scope === 'all' ? <CompanyDashboard me={me} /> : <MyDashboard me={me} />}</>;
}

function CompanyDashboard({ me }) {
  const [d, setD] = useState(null);
  const [, tick] = useState(0);
  const load = useCallback(() => api.get('/api/dashboard').then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [load]);
  useLiveEvents(load, ['call.', 'phone.', 'voicemail.']);
  const dir = useDirectory();
  const presence = usePresence();
  if (!d) return null;
  const mine = presenceInfo(presence[me?.extension]);

  return (
    <>
      <div className="stats">
        <Stat icon={PhoneIncoming} label="Calls today" value={d.today.total} />
        <Stat icon={Phone} label="Answered" value={d.today.answered} />
        <Stat icon={PhoneMissed} label="Missed" value={d.today.missed} />
        <Stat icon={Voicemail} label="Voicemails" value={d.today.voicemail} />
        <Stat icon={Users} label="Phones online" value={`${d.phonesOnline} / ${d.counts.users}`} />
        <Stat icon={CircleUser} label="My status" value={<span className="my-status"><span className={`dot ${mine.color}`} />{mine.label}</span>}
          sub={mine.detail || (me ? `Ext. ${me.extension}` : '')} to="/account" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h2>Active calls</h2><span className="badge blue">{d.active.length}</span></div>
          {d.active.length === 0 ? <Empty icon={ArrowRightLeft} title="No active calls" /> : (
            <table className="t"><tbody>
              {d.active.map((c) => (
                <tr key={c.id}>
                  <td><CallIcon c={c} /></td>
                  <td><div>{c.fromName || formatNumber(c.from)}</div><div className="muted small">to {partyLabel(c.answeredBy || c.to, dir)}</div></td>
                  <td><span className={`badge ${c.state === 'talking' ? 'green' : 'amber'}`}>{c.state === 'talking' ? 'Talking' : 'Ringing'}</span></td>
                  <td className="num muted">{fmtDuration((Date.now() - new Date(c.answeredAt || c.startedAt)) / 1000)}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Carrier connections</h2><div className="spacer" /><Link to="/trunks" className="small">Manage</Link></div>
          {d.trunks.length === 0 ? <Empty icon={Server} title="No SIP trunk yet" text="Add your carrier to make and receive outside calls." action={<Link className="btn primary" to="/trunks">Add trunk</Link>} /> : (
            <table className="t"><tbody>
              {d.trunks.map((t) => (
                <tr key={t.trunk}><td>{t.name}</td><td className="actions"><span className={`badge ${t.status === 'Registered' ? 'green' : 'red'}`}>{t.status}</span></td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Recent calls</h2><div className="spacer" /><Link to="/calls" className="small">View all</Link></div>
        {d.recent.length === 0 ? <Empty icon={PhoneOutgoing} title="No calls yet" /> : (
          <CallTable rows={d.recent} me={me} />
        )}
      </div>
    </>
  );
}

// One person's dashboard: only their calls, their mailboxes (own and groups'), their phones and status.
function MyDashboard({ me }) {
  const [d, setD] = useState(null);
  const [, tick] = useState(0);
  const load = useCallback(() => api.get('/api/my/dashboard').then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [load]);
  useLiveEvents(load, ['call.', 'phone.', 'voicemail.']);
  const dir = useDirectory();
  const presence = usePresence();
  if (!d) return null;
  const mine = presenceInfo(presence[me?.extension]);

  return (
    <>
      <div className="stats">
        <Stat icon={PhoneIncoming} label="My calls today" value={d.today.total} />
        <Stat icon={Phone} label="Answered" value={d.today.answered} />
        <Stat icon={PhoneMissed} label="Missed" value={d.today.missed} to="/calls" title="Open Call History" />
        <Stat icon={Voicemail} label="New voicemail" value={d.newVoicemail} to="/voicemail" title="Open Voicemail" />
        <Stat icon={Clock} label="Talk time today" value={fmtDuration(d.today.talk_seconds)} />
        <Stat icon={CircleUser} label="My status" value={<span className="my-status"><span className={`dot ${mine.color}`} />{mine.label}</span>}
          sub={mine.detail || (me ? `Ext. ${me.extension}` : '')} to="/account" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h2>My active calls</h2><span className="badge blue">{d.active.length}</span></div>
          {d.active.length === 0 ? <Empty icon={ArrowRightLeft} title="No active calls" /> : (
            <table className="t"><tbody>
              {d.active.map((c) => (
                <tr key={c.id}>
                  <td><CallIcon c={c} /></td>
                  <td><div>{c.fromName || partyLabel(c.from, dir)}</div><div className="muted small">to {partyLabel(c.answeredBy || c.to, dir)}</div></td>
                  <td><span className={`badge ${c.state === 'talking' ? 'green' : 'amber'}`}>{c.state === 'talking' ? 'Talking' : 'Ringing'}</span></td>
                  <td className="num muted">{fmtDuration((Date.now() - new Date(c.answeredAt || c.startedAt)) / 1000)}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>My phones</h2></div>
          {d.phones.length === 0 ? <Empty icon={Phone} title="No phones signed in" text={`Nothing is registered to extension ${me?.extension}.`} /> : (
            <table className="t"><tbody>
              {d.phones.map((p) => (
                <tr key={p.uri}>
                  <td style={{ width: 36 }}>{p.webPhone ? <Monitor size={16} color="var(--muted)" /> : <Phone size={16} color="var(--muted)" />}</td>
                  <td><div>{p.webPhone ? 'Web phone' : p.model || 'Desk phone'}</div><div className="muted small">{p.address}</div></td>
                  <td className="actions"><span className={`badge ${p.online ? 'green' : 'red'}`}>{p.online ? 'Online' : 'Offline'}</span></td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      {d.voicemail.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h2>New voicemail</h2><span className="badge blue">{d.newVoicemail}</span><div className="spacer" /><Link to="/voicemail" className="small">Listen</Link></div>
          <table className="t"><tbody>
            {d.voicemail.map((m) => (
              <tr key={`${m.mailbox}-${m.msgId}`}>
                <td style={{ width: 36 }}><Voicemail size={16} color="var(--purple)" /></td>
                <td><div>{m.callerName || formatNumber(m.callerNum) || 'Unknown caller'}</div>{m.callerName && <div className="muted small">{formatNumber(m.callerNum)}</div>}</td>
                <td className="muted">{m.boxName}</td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(m.receivedAt)}</td>
                <td className="num muted actions">{fmtDuration(m.duration)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>My recent calls</h2><div className="spacer" /><Link to="/calls" className="small">View all</Link></div>
        {d.recent.length === 0 ? <Empty icon={PhoneOutgoing} title="No calls yet" /> : <CallTable rows={d.recent} me={me} />}
      </div>
    </>
  );
}

function Stat({ icon: Icon, label, value, sub, to, title = 'Change on My Account' }) {
  const body = <><div className="l"><Icon size={14} />{label}</div><div className="v">{value}</div>{sub && <div className="muted small">{sub}</div>}</>;
  return to ? <Link to={to} className="stat stat-link" title={title}>{body}</Link> : <div className="stat">{body}</div>;
}
