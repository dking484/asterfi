// Settings > System: updates, health, performance (live + 24-hour charts), storage and software versions.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ExternalLink, CheckCircle2, ArrowUpCircle, AlertTriangle, Cpu, MemoryStick, HardDrive } from 'lucide-react';
import { api, fmtWhen } from '../api.js';
import { useData, useToast, Seg } from '../components/ui.jsx';
import { Services, Logs, Console } from './SystemTools.jsx';

/* global __WEB_VERSIONS__ */
const WEB_VERSIONS = typeof __WEB_VERSIONS__ === 'object' ? __WEB_VERSIONS__ : {};

const fmtBytes = (n) => {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const fmtUptime = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};
const pct = (used, total) => (total ? Math.round((100 * used) / total) : 0);
// Meter colour only signals trouble; the number beside it always says how full.
const level = (p) => (p >= 90 ? 'red' : p >= 75 ? 'amber' : 'ok');

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'services', label: 'Services' }, { value: 'logs', label: 'Logs' }, { value: 'console', label: 'Asterisk console' }];
const VIEW_KEY = 'asterfi.system.view';

export default function SystemSettings() {
  const [view, setViewState] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || 'overview'; } catch { return 'overview'; } });
  const [logSource, setLogSource] = useState('asterisk');
  const setView = (v) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };
  return (
    <div style={{ maxWidth: view === 'overview' ? 980 : 1200 }}>
      <Seg value={view} onChange={setView} options={VIEWS} />
      {view === 'overview' && <Overview />}
      {view === 'services' && <Services onViewLog={(id) => { setLogSource(id); setView('logs'); }} />}
      {view === 'logs' && <Logs source={logSource} setSource={setLogSource} />}
      {view === 'console' && <Console />}
    </div>
  );
}

function Overview() {
  const { data, reload } = useData('/api/system/overview');
  useEffect(() => { const t = setInterval(reload, 10000); return () => clearInterval(t); }, [reload]);
  return (
    <div style={{ marginTop: 16 }}>
      <UpdateCard />
      {data && <>
        <Health d={data} />
        <Performance d={data} />
        <div className="grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
          <Programs d={data} />
          <Storage d={data} />
        </div>
      </>}
      <Versions />
    </div>
  );
}

// ---------------------------------------------------------------- updates
function UpdateCard() {
  const { data: u, setData } = useData('/api/system/update');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!u) return null;
  const check = async () => {
    setBusy(true);
    try { setData(await api.get('/api/system/update?check=1')); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Updates</h2><div className="spacer" />
        <button className="btn sm" onClick={check} disabled={busy}><RefreshCw size={13} />{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      <div className="card-body">
        {u.available ? (
          <div className="alert info" style={{ display: 'block' }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><ArrowUpCircle size={16} />AsterFi {u.latest.replace(/^v/, '')} is available</div>
            <div style={{ marginTop: 4 }}>You have {u.current}.{u.publishedAt && ` Released ${new Date(u.publishedAt).toLocaleDateString()}.`} {u.url && <a href={u.url} target="_blank" rel="noopener">What's new <ExternalLink size={12} style={{ verticalAlign: -1 }} /></a>}</div>
          </div>
        ) : u.latest ? (
          <div className="update-ok"><CheckCircle2 size={18} /><div><b>AsterFi {u.current} is up to date.</b><div className="muted small">The latest release is {u.latest}.</div></div></div>
        ) : !u.error && <p className="muted" style={{ marginTop: 0 }}>{u.checkedAt ? 'No releases have been published yet.' : `This server runs AsterFi ${u.current}. Press Check now to look for a newer release.`}</p>}
        {u.error && <div className="alert warn"><AlertTriangle size={15} /><span>{u.error}</span></div>}
        {u.available && <>
          <div className="section-title">How to update</div>
          <p className="small" style={{ marginTop: 0 }}>On the server, in the folder you installed AsterFi from, run these. The installer keeps your database, settings, prompts, voicemail and certificate. Calls in progress drop when the services restart.</p>
          <pre className="code-box">{'git pull\nsudo ./install.sh'}</pre>
        </>}
        <div className="muted small">{u.checkedAt ? `Last checked ${fmtWhen(u.checkedAt)}` : 'Not checked yet'}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- health
const SERVICE_NAMES = { asterfi: 'AsterFi service', asterisk: 'Asterisk', postgresql: 'PostgreSQL', nginx: 'nginx (web)', 'asterfi-backup.timer': 'Nightly backup' };
function Health({ d }) {
  const t = d.telephony;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>System health</h2></div>
      <div className="card-body">
        <div className="kv-grid">
          <KV k="Server" v={d.host.hostname} />
          <KV k="Operating system" v={d.host.os} />
          <KV k="Server up for" v={fmtUptime(d.host.uptime)} />
          <KV k="Asterisk up for" v={fmtUptime(d.host.asteriskUptime)} />
          <KV k="AsterFi service up for" v={fmtUptime(d.host.serviceUptime)} />
          <KV k="Connection to Asterisk" v={d.host.amiConnected ? <span className="badge green"><span className="dot green" />Connected</span> : <span className="badge red"><span className="dot red" />Disconnected</span>} />
        </div>
        {d.services.length > 0 && <>
          <div className="section-title">Services</div>
          <div className="chips">{d.services.map((s) => (
            <span key={s.name} className={`badge ${s.state === 'active' ? 'green' : 'red'}`} title={`systemctl: ${s.state}`}>
              <span className={`dot ${s.state === 'active' ? 'green' : 'red'}`} />{SERVICE_NAMES[s.name] || s.name}: {s.state === 'active' ? 'running' : s.state}
            </span>
          ))}</div>
        </>}
        <div className="section-title">Phone system</div>
        <div className="kv-grid">
          <KV k="Calls in progress" v={t.activeCalls} />
          <KV k="Calls today" v={t.callsToday} />
          <KV k="Phones online" v={`${t.phonesOnline} of ${t.phonesTotal} signed in`} />
          <KV k="SIP trunks registered" v={t.trunksTotal ? `${t.trunksRegistered} of ${t.trunksTotal}` : 'None set up'} />
        </div>
      </div>
    </div>
  );
}
const KV = ({ k, v }) => <div className="kv"><div className="muted small">{k}</div><div>{v ?? '—'}</div></div>;

// ---------------------------------------------------------------- performance
function Performance({ d }) {
  const memP = pct(d.memory.used, d.memory.total);
  const diskP = d.disk ? pct(d.disk.used, d.disk.total) : null;
  const cpu = d.cpu;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Performance</h2><div className="spacer" /><span className="muted small">Live, refreshed every 10 seconds</span></div>
      <div className="card-body">
        <div className="meters">
          <Meter icon={Cpu} label="CPU" value={`${Math.round(cpu.busy)}%`} p={cpu.busy}
            sub={`${cpu.cores} ${cpu.cores === 1 ? 'core' : 'cores'} · load ${cpu.load.map((x) => x.toFixed(2)).join(' / ')}`} title={cpu.model} />
          <Meter icon={MemoryStick} label="Memory" value={`${fmtBytes(d.memory.used)} of ${fmtBytes(d.memory.total)}`} p={memP}
            sub={`${memP}% used${d.memory.swapTotal ? ` · swap ${fmtBytes(d.memory.swapUsed)} of ${fmtBytes(d.memory.swapTotal)}` : ''}`} />
          {d.disk && <Meter icon={HardDrive} label="Disk" value={`${fmtBytes(d.disk.used)} of ${fmtBytes(d.disk.total)}`} p={diskP} sub={`${fmtBytes(d.disk.free)} free`} />}
        </div>
        <div className="grid-2" style={{ marginTop: 18 }}>
          <HistoryChart title="CPU use" points={d.history.map((h) => ({ at: h.at, v: h.cpu }))} max={100} fmt={(v) => `${Math.round(v)}%`} />
          <HistoryChart title="Memory used" points={d.history.map((h) => ({ at: h.at, v: h.memory }))} max={d.memory.total} fmt={fmtBytes} />
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>One point a minute for the last 24 hours, kept since the AsterFi service last started.</p>
      </div>
    </div>
  );
}

function Meter({ icon: Icon, label, value, sub, p, title }) {
  return (
    <div className="meter" title={title}>
      <div className="meter-l"><Icon size={14} />{label}</div>
      <div className="meter-v">{value}</div>
      <div className="meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={label}>
        <div className={`meter-fill ${level(p)}`} style={{ width: `${Math.min(100, Math.max(1, p))}%` }} />
      </div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

// A single measure over time: a 2px line over a faint area, a recessive grid, and a crosshair readout on hover.
function HistoryChart({ title, points, max, fmt }) {
  const box = useRef(null);
  const [w, setW] = useState(420);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    if (!box.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = 130, L = 46, R = 8, T = 8, B = 20;
  const pw = w - L - R, ph = H - T - B;
  const t0 = points[0]?.at, t1 = points[points.length - 1]?.at;
  const x = (at) => L + (t1 > t0 ? ((at - t0) / (t1 - t0)) * pw : pw);
  const y = (v) => T + ph - (Math.min(v, max) / max) * ph;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = points.length > 1 ? `${line}L${x(t1).toFixed(1)},${T + ph}L${x(t0).toFixed(1)},${T + ph}Z` : '';
  const onMove = useCallback((e) => {
    if (points.length < 2) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const at = t0 + ((px - L) / pw) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
    setHover(best);
  }, [points, t0, t1, pw]);
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const last = points[points.length - 1];
  return (
    <div className="hchart" ref={box}>
      <div className="hchart-head"><span>{title}</span>{last && <span className="muted">now {fmt(last.v)}</span>}</div>
      {points.length < 2 ? <div className="hchart-empty muted small">Collecting data. A point is added every minute.</div> : (
        <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
          aria-label={`${title} over the last ${Math.round((t1 - t0) / 60000)} minutes, now ${fmt(last.v)}`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={L} x2={w - R} y1={T + ph - f * ph} y2={T + ph - f * ph} className="hchart-grid" />
              <text x={L - 6} y={T + ph - f * ph + 4} textAnchor="end" className="hchart-axis">{fmt(f * max)}</text>
            </g>
          ))}
          <text x={L} y={H - 4} className="hchart-axis">{time(t0)}</text>
          <text x={w - R} y={H - 4} textAnchor="end" className="hchart-axis">{time(t1)}</text>
          <path d={area} className="hchart-area" />
          <path d={line} className="hchart-line" />
          {hover && <>
            <line x1={x(hover.at)} x2={x(hover.at)} y1={T} y2={T + ph} className="hchart-cross" />
            <circle cx={x(hover.at)} cy={y(hover.v)} r={4.5} className="hchart-dot" />
          </>}
        </svg>
      )}
      {hover && <div className="hchart-tip" style={{ left: Math.min(Math.max(x(hover.at), 70), w - 70) }}><b>{fmt(hover.v)}</b><span className="muted">{time(hover.at)}</span></div>}
    </div>
  );
}

// ---------------------------------------------------------------- memory by program, storage
function Programs({ d }) {
  if (!d.programs.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>Memory by program</h2></div>
      <table className="t"><tbody>{d.programs.map((p) => (
        <tr key={p.name}><td>{p.name}</td><td className="num muted actions">{fmtBytes(p.bytes)}</td></tr>
      ))}</tbody></table>
    </div>
  );
}

function Storage({ d }) {
  const s = d.storage;
  const rows = [['Voicemail', s.voicemail], ['Call recordings', s.recordings], ['Audio prompts', s.prompts], ['Database', s.database], ['Backups (last 14)', s.backups]];
  return (
    <div className="card">
      <div className="card-head"><h2>Storage</h2><div className="spacer" /><span className="muted small">Updated every 10 minutes</span></div>
      <table className="t"><tbody>{rows.map(([k, v]) => (
        <tr key={k}><td>{k}</td><td className="num muted actions">{fmtBytes(v)}</td></tr>
      ))}</tbody></table>
    </div>
  );
}

// ---------------------------------------------------------------- versions
// Status always carries a word as well as a colour, so it never relies on colour alone.
function Supported({ c }) {
  if (!c) return <span className="muted small">—</span>;
  if (c.status === 'ok') return <span className="badge green" title="A version this AsterFi release supports"><CheckCircle2 size={12} />{c.supported}</span>;
  if (c.status === 'untested') return <span className="badge amber" title="Outside the versions this AsterFi release is tested with"><AlertTriangle size={12} />Untested · needs {c.supported}</span>;
  return <span className="muted small">{c.supported}</span>;
}
const WEB_ROWS = [
  ['React', 'react', 'User interface library'],
  ['React Router', 'react-router-dom', 'Page navigation'],
  ['React Flow (@xyflow/react)', '@xyflow/react', 'Call-flow canvas'],
  ['JsSIP', 'jssip', 'Web phone (SIP over WebSocket)'],
  ['Lucide', 'lucide-react', 'Icons'],
  ['Vite', 'vite', 'Builds the console'],
];
function Versions() {
  const { data, setData } = useData('/api/system/versions');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); try { setData(await api.get('/api/system/versions?refresh=1')); } finally { setBusy(false); } };
  if (!data) return null;
  const groups = [...data.groups, { name: 'Web console libraries', items: WEB_ROWS.map(([name, pkg, purpose]) => ({ name, version: WEB_VERSIONS[pkg] || null, purpose, compat: { status: 'ok', supported: 'pinned' } })) }];
  const issues = data.issues || [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Software versions</h2><div className="spacer" />
        <span className="muted small" style={{ marginRight: 10 }}>Read {fmtWhen(data.checkedAt)}</span>
        <button className="btn sm" onClick={refresh} disabled={busy}><RefreshCw size={13} />{busy ? 'Reading…' : 'Refresh'}</button>
      </div>
      {issues.length > 0 ? (
        <div className="card-body" style={{ paddingBottom: 0 }}><div className="alert warn" style={{ marginBottom: 0 }}><AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <span>{issues.length === 1 ? 'One component is' : `${issues.length} components are`} outside the versions this AsterFi release is tested with. AsterFi keeps running, but something may not work. Usually this means the operating system upgraded it; the next AsterFi release that supports it will clear this.</span>
        </div></div>
      ) : <div className="card-body muted small" style={{ paddingBottom: 0 }}>Everything below is a version this AsterFi release supports.</div>}
      <div className="table-wrap"><table className="t versions">
        <thead><tr><th>Component</th><th>Version</th><th>Supported</th><th>Used for</th></tr></thead>
        {groups.map((g) => (
          <tbody key={g.name}>
            <tr className="group-row"><td colSpan={4}>{g.name}</td></tr>
            {g.items.map((it) => (
              <tr key={it.name}>
                <td>{it.name}</td>
                <td className="mono">{it.version || <span className="muted">{it.version === null && g.name !== 'Phone system' ? 'not installed' : '—'}</span>}</td>
                <td><Supported c={it.compat} /></td>
                <td className="muted small">{it.purpose}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table></div>
      <div className="card-body muted small" style={{ borderTop: '1px solid var(--border)' }}>Each AsterFi release pins the speech packages and models it's tested with and lists the supported range for system software; the installer installs exactly those. Operating-system packages (PostgreSQL, nginx and the audio tools) still get security updates from the system's package manager. Asterisk is held on its supported major version, so updates within it install but a newer major version doesn't.</div>
    </div>
  );
}

