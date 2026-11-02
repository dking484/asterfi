import { useCallback, useEffect, useState } from 'react';
import { Phone, RefreshCw, Radar, EyeOff, Globe, Link2, Pencil } from 'lucide-react';
import { api, fullName, fmtWhen } from '../api.js';
import { useData, useLiveEvents, useToast, Empty, Drawer, Field, PasswordInput } from '../components/ui.jsx';
import { useDirectory } from '../components/Destination.jsx';

export default function Phones() {
  const { data, reload, loading } = useData('/api/phones');
  const dir = useDirectory();
  useLiveEvents(useCallback(() => reload(), [reload]), ['phone.']);
  const host = window.location.hostname;

  return (
    <>
      <div className="toolbar">
        <div className="muted">Phones signed in to the system right now.</div>
        <div className="spacer" />
        <button className="btn" onClick={reload} disabled={loading}><RefreshCw size={15} />Refresh</button>
      </div>
      <div className="card">
        {data && data.length === 0 ? (
          <Empty icon={Phone} title="No phones online" text={`Point a SIP phone at ${host} using a user's extension and SIP password (Users > Phone Setup).`} />
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Status</th><th>User</th><th>Device</th><th>Address</th><th>Latency</th></tr></thead>
            <tbody>{[...(data || [])].sort((a, b) => (Number(a.extension) || 1e9) - (Number(b.extension) || 1e9)).map((p) => {
              const u = dir.users.find((x) => x.extension === p.extension);
              return (
                <tr key={p.uri}>
                  <td>{p.online ? <span className="badge green"><span className="dot green" />Online</span> : <span className="badge red"><span className="dot red" />{p.status}</span>}</td>
                  <td>{u ? fullName(u) : '—'} <span className="muted">· {p.extension}</span></td>
                  <td>{p.webPhone ? <><Globe size={13} className="muted" style={{ verticalAlign: -2, marginRight: 6 }} />{p.userAgent.replace(/^AsterFi Web Phone \(?/, 'Web phone · ').replace(/\)$/, '') || 'Web phone'}</> : p.model || (p.userAgent && p.userAgent !== 'Unknown' ? p.userAgent : 'SIP device')}</td>
                  <td className={p.webPhone ? 'muted' : 'mono muted'}>{(p.address || p.uri.replace(/^sip:[^@]*@/, '')).split(';')[0]}</td>
                  <td className="num muted">{p.rttMs != null ? `${p.rttMs} ms` : '—'}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>

      <UnifiDevices />
    </>
  );
}

const STATE_BADGE = { online: 'green', offline: 'red', 'ready to adopt': 'green', adopting: 'blue', 'adopted elsewhere': 'amber', discovered: '' };
const isTalk = (d) => /^(UVP|UTP)-/i.test(d?.model || '');

function UnifiDevices() {
  const { data, reload } = useData('/api/unifi/devices');
  const [open, setOpen] = useState(null);
  const toast = useToast();
  const host = window.location.hostname;
  const scan = async () => { await api.post('/api/unifi/scan'); toast('Scanning the network. Ignored devices will show again.'); setTimeout(reload, 3000); };
  const ignore = async (mac) => { await api.post(`/api/unifi/devices/${mac}/ignore`); setOpen(null); toast('Device hidden until the next manual scan'); reload(); };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><Radar size={16} /><h2>UniFi devices</h2><span className="badge amber">Adoption in development</span><div className="spacer" /><button className="btn sm" onClick={scan}><RefreshCw size={13} />Scan network</button></div>
      {data && data.length === 0 ? (
        <div className="card-body muted small">
          <p style={{ marginTop: 0 }}>No UniFi devices seen yet. AsterFi listens for UniFi discovery broadcasts and check-ins ("inform") so it can learn how UniFi Talk phones are adopted.</p>
          <p>To have a Talk phone check in here: factory-reset it, then either add a local DNS record so <span className="mono">unifi</span> resolves to <span className="mono">{host}</span>, set DHCP option 43 to this server, or SSH into the phone (default <span className="mono">ubnt</span>/<span className="mono">ubnt</span>) and run <span className="mono">set-inform http://{host}:8080/inform</span>.</p>
        </div>
      ) : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Device</th><th>MAC</th><th>IP</th><th>Status</th><th>Assigned</th><th>Last seen</th><th></th></tr></thead>
          <tbody>{(data || []).map((d) => (
            <tr key={d.mac} className="clickable" onClick={() => setOpen(d.mac)}>
              <td><div style={{ fontWeight: 500 }}>{d.model_name || d.model || 'UniFi device'}</div>{d.hostname && <div className="muted small">{d.hostname}</div>}</td>
              <td className="mono">{d.mac}</td><td className="mono muted">{d.ip || '—'}</td>
              <td><span className={`badge ${STATE_BADGE[d.state] ?? ''}`}>{d.state}</span></td>
              <td>{d.assigned_ext ? <>{d.assigned_name || 'User'} <span className="muted">· {d.assigned_ext}</span></> : <span className="muted">—</span>}</td>
              <td className="muted small">{fmtWhen(d.last_seen)}</td>
              <td className="actions">{d.adopted
                ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen(d.mac); }}><Pencil size={14} />Edit</button>
                : <>{isTalk(d) && d.state !== 'adopted elsewhere' && <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen(d.mac); }}><Link2 size={14} />Adopt</button>}<button className="btn ghost sm" title="Hide this device until the next manual scan" onClick={(e) => { e.stopPropagation(); ignore(d.mac); }}><EyeOff size={14} />Ignore</button></>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && <DeviceDrawer mac={open} onClose={() => setOpen(null)} onIgnore={() => ignore(open)} />}
    </div>
  );
}

function DeviceDrawer({ mac, onClose, onIgnore }) {
  const { data, reload } = useData(`/api/unifi/devices/${mac}`);
  const [login, setLogin] = useState({ username: 'ubnt', password: 'ubnt' });
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const dir = useDirectory();
  const toast = useToast();
  useEffect(() => { if (data?.assigned_user?.id) setUserId(String(data.assigned_user.id)); }, [data?.assigned_user?.id]);
  const assign = async () => {
    setBusy(true);
    try {
      const r = await api.put(`/api/unifi/devices/${mac}/assign`, { user_id: userId ? Number(userId) : null });
      toast(r.reprovisioned ? 'Assigned — the phone is updating now' : 'Assignment saved');
      reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const adopt = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api.post(`/api/unifi/devices/${mac}/adopt`, { ...login, user_id: userId ? Number(userId) : null });
      setResult(r);
      if (r.ok) toast('Phone pointed at AsterFi');
      reload();
    } catch (e) { setResult({ ok: false, error: e.message }); } finally { setBusy(false); }
  };
  const last = result || data?.adopt_result;
  const download = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `unifi-${mac.replace(/:/g, '')}.json`; a.click();
  };
  return (
    <Drawer title={data?.model_name || data?.model || mac} onClose={onClose} width={620} footer={<><button className="btn" onClick={onIgnore}><EyeOff size={14} />Ignore device</button><div className="spacer" /><button className="btn" onClick={download} disabled={!data}>Download capture</button></>}>
      {data && <>
        <div className="row" style={{ marginBottom: 14 }}>
          <div><div className="muted small">MAC</div><div className="mono">{data.mac}</div></div>
          <div><div className="muted small">IP</div><div className="mono">{data.ip}</div></div>
          <div><div className="muted small">Status</div><div>{data.state}</div></div>
        </div>
        {isTalk(data) && <>
          <div className="section-title">Assigned user</div>
          <p className="muted small" style={{ marginTop: 0 }}>The phone registers as this user's extension. Changing it updates a connected phone right away.</p>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Field label="User"><select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">— unassigned —</option>
              {dir.users.map((u) => <option key={u.id} value={u.id}>{fullName(u)} ({u.extension})</option>)}
            </select></Field>
            <div className="field" style={{ flex: '0 0 auto' }}><button className="btn primary" disabled={busy} onClick={assign}>Save assignment</button></div>
          </div>
        </>}
        {isTalk(data) && !data.adopted && data.state !== 'adopted elsewhere' && <>
          <div className="section-title">Adopt</div>
          <p className="muted small" style={{ marginTop: 0 }}>AsterFi signs in to the phone and tells it to check in here, the same way a UniFi console adopts. A factory-reset phone uses <span className="mono">ubnt</span> / <span className="mono">ubnt</span>. The login is used once and not saved.</p>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Field label="Username"><input type="text" value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} /></Field>
            <Field label="Password"><PasswordInput value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></Field>
            <div className="field" style={{ flex: '0 0 auto' }}><button className="btn primary" disabled={busy} onClick={adopt}><Link2 size={14} />{busy ? 'Adopting…' : 'Adopt'}</button></div>
          </div>
          {last && <div className={`alert ${last.ok ? 'info' : 'error'}`} style={{ display: 'block' }}>
            {last.ok ? (last.unconfirmed
              ? <>Sent <span className="mono">set-inform {last.url}</span>, but the phone didn't confirm it. If check-ins start appearing below, it worked.</>
              : <>Done. The phone now checks in at <span className="mono">{last.url}</span>. Its check-ins appear below within a few seconds.</>) : last.error}
            {last.output && <pre className="mono small" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{last.output}</pre>}
          </div>}
        </>}
        <div className="section-title">Last check-in (decoded)</div>
        <pre className="mono small" style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 360 }}>{data.last_inform ? JSON.stringify(data.last_inform, null, 2) : 'No check-in received yet.'}</pre>
        <div className="section-title">Last discovery announcement</div>
        <pre className="mono small" style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 260 }}>{data.last_discovery ? JSON.stringify(data.last_discovery, null, 2) : 'None yet.'}</pre>
      </>}
    </Drawer>
  );
}
