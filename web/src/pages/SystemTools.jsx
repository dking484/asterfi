// Settings > System: Services (status, start and restart), Logs (recent lines or followed live) and the
// Asterisk console (run CLI commands and watch Asterisk's live output).
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw, Play, Download, Pause, Radio, Trash2, FileText, CornerDownLeft } from 'lucide-react';
import { api, fmtWhen } from '../api.js';
import { useData, useToast, Confirm } from '../components/ui.jsx';

const fmtBytes = (n) => (n == null ? '—' : n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`);
const MAX_LINES = 5000;

// Follows a server-sent-events URL while `on` is true, calling onLine for each { line } message.
function useStream(url, on, onLine, onError) {
  const cb = useRef({ onLine, onError });
  cb.current = { onLine, onError };
  useEffect(() => {
    if (!on || !url) return undefined;
    const es = new EventSource(url);
    es.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.error) { es.close(); cb.current.onError?.(d.error); } else cb.current.onLine(d.line);
    };
    return () => es.close();
  }, [url, on]);
}

// Keeps a scroll box pinned to the bottom unless the reader has scrolled up.
function useStickyScroll(deps) {
  const ref = useRef(null);
  const stick = useRef(true);
  const onScroll = () => { const el = ref.current; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, onScroll, toBottom: () => { stick.current = true; } };
}

const lineClass = (l) => (/\b(ERROR|CRITICAL|FATAL|PANIC)\b|\berror:/i.test(l) ? 'err' : /\bWARNING\b|\bwarn(ing)?:/i.test(l) ? 'warn' : /\b(NOTICE|DEBUG)\b/.test(l) ? 'dim' : '');
const LogLines = ({ lines, boxRef, onScroll, empty }) => (
  <div className="logview" ref={boxRef} onScroll={onScroll}>
    {lines.length ? lines.map((l, i) => <div key={i} className={typeof l === 'string' ? lineClass(l) : l.cls}>{typeof l === 'string' ? l : l.text}</div>)
      : <div className="dim">{empty}</div>}
  </div>
);

function download(name, lines) {
  const blob = new Blob([lines.map((l) => (typeof l === 'string' ? l : l.text)).join('\n') + '\n'], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- services
const STATE = {
  active: ['green', 'Running'], activating: ['amber', 'Starting'], deactivating: ['amber', 'Stopping'], reloading: ['amber', 'Reloading'],
  inactive: ['red', 'Stopped'], failed: ['red', 'Failed'],
};
const RESTART_NOTE = {
  asterisk: (calls) => `${calls ? `${calls} call${calls === 1 ? '' : 's'} in progress will drop. ` : ''}Phones and trunks re-register within a few seconds.`,
  asterfi: () => 'This web console disconnects for a few seconds and reconnects on its own. Calls aren’t affected.',
  postgresql: () => 'AsterFi loses its database for a few seconds. Calls in progress continue, but call history for them may be incomplete.',
  nginx: () => 'The web console and the phones’ phonebook are unavailable for a moment. Calls aren’t affected.',
};

export function Services({ onViewLog }) {
  const { data, reload } = useData('/api/system/services');
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(null);
  const toast = useToast();
  useEffect(() => { const t = setInterval(reload, busy ? 2000 : 10000); return () => clearInterval(t); }, [reload, busy]);

  const act = async (s, action) => {
    setAsk(null);
    setBusy(s.unit);
    try {
      const r = await api.post(`/api/system/services/${s.unit}/${action}`);
      if (s.unit === 'asterfi') {
        // Wait for the service to go down and come back.
        await new Promise((res) => setTimeout(res, 2500));
        for (let i = 0; i < 30; i += 1) {
          try { await api.get('/api/system/services'); break; } catch { await new Promise((res) => setTimeout(res, 1000)); }
        }
      }
      toast(`${s.name} ${action === 'start' ? 'started' : 'restarted'}${r.via === 'ami' ? ' (through Asterisk)' : ''}`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); reload(); }
  };
  if (!data) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Services</h2><div className="spacer" />
        <button className="btn sm" onClick={reload}><RefreshCw size={13} />Refresh</button>
      </div>
      {data.services.length === 0 ? <div className="card-body muted">Service details are only available on Linux.</div> : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Service</th><th>Status</th><th>Since</th><th>Memory</th><th /></tr></thead>
          <tbody>{data.services.map((s) => {
            const [color, label] = !s.installed ? ['', 'Not installed'] : STATE[s.state] || ['', s.state];
            const timer = s.unit.endsWith('.timer');
            const up = s.state === 'active';
            return (
              <tr key={s.unit}>
                <td><div>{s.name}</div><div className="muted small">{s.about}</div></td>
                <td>
                  <span className={`badge ${color}`}><span className={`dot ${color}`} />{timer && up ? 'Scheduled' : label}</span>
                  {s.state === 'failed' && s.result && s.result !== 'success' && <div className="muted small" style={{ marginTop: 4 }}>Reason: {s.result}</div>}
                  {s.restarts > 0 && <div className="muted small" style={{ marginTop: 4 }} title="Times systemd restarted it after it stopped unexpectedly">Restarted automatically {s.restarts}×</div>}
                </td>
                <td className="small">{s.since ? fmtWhen(s.since) : '—'}</td>
                <td className="small">{timer ? '—' : fmtBytes(s.memory)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => onViewLog(s.unit === 'asterisk' ? 'asterisk' : s.unit === 'asterfi-backup.timer' ? 'backup' : s.unit)}><FileText size={13} />Log</button>{' '}
                  {s.restart && s.installed && (up
                    ? <button className="btn sm" disabled={!!busy} onClick={() => setAsk({ s, action: 'restart' })}><RotateCw size={13} className={busy === s.unit ? 'spin' : ''} />{busy === s.unit ? 'Restarting…' : 'Restart'}</button>
                    : <button className="btn sm primary" disabled={!!busy} onClick={() => act(s, 'start')}><Play size={13} />{busy === s.unit ? 'Starting…' : 'Start'}</button>)}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {ask && <Confirm title={`Restart ${ask.s.name}?`} message={RESTART_NOTE[ask.s.unit]?.(data.activeCalls)} confirmLabel="Restart"
        danger={ask.s.unit === 'asterisk' && data.activeCalls > 0} onConfirm={() => act(ask.s, 'restart')} onCancel={() => setAsk(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- logs
export function Logs({ source, setSource }) {
  const { data: sources } = useData('/api/system/logs');
  const [count, setCount] = useState(500);
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [lines, setLines] = useState([]);
  const [from, setFrom] = useState('');
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const { ref, onScroll, toBottom } = useStickyScroll([lines]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get(`/api/system/logs/${source}?lines=${count}&filter=${encodeURIComponent(applied)}`);
      setLines(r.lines); setFrom(r.from); toBottom();
    } catch (e) { setLines([]); setError(e.message); setLive(false); } finally { setLoading(false); }
  }, [source, count, applied]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const f = applied.toLowerCase();
  useStream(`/api/system/logs/${source}/stream`, live && !error, (l) => {
    if (f && !l.toLowerCase().includes(f)) return;
    setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(-MAX_LINES + 1), l] : [...prev, l]));
  }, (e) => { setError(e); setLive(false); });

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={source} onChange={(e) => { setSource(e.target.value); setLive(false); }} style={{ width: 'auto' }}>
          {(sources || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 'auto' }} title="How many recent lines to load">
          {[200, 500, 2000, 5000].map((n) => <option key={n} value={n}>Last {n} lines</option>)}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); setApplied(filter.trim()); }} style={{ display: 'flex', gap: 6 }}>
          <input type="search" placeholder="Filter, e.g. trunk-2 or ERROR" value={filter} onChange={(e) => { setFilter(e.target.value); if (!e.target.value) setApplied(''); }} style={{ width: 220 }} />
        </form>
        <div className="spacer" />
        <button className={`btn sm ${live ? 'primary' : ''}`} onClick={() => { setLive((v) => !v); toBottom(); }} disabled={!!error} title="Show new lines as they're written">
          {live ? <><Pause size={13} />Pause</> : <><Radio size={13} />Live</>}
        </button>
        <button className="btn sm" onClick={load} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''} />Reload</button>
        <button className="btn sm" onClick={() => download(`${source}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.log`, lines)} disabled={!lines.length}><Download size={13} />Download</button>
      </div>
      {error ? <div className="card-body"><div className="alert warn" style={{ margin: 0 }}>{error}</div></div> : (
        <>
          <LogLines lines={lines} boxRef={ref} onScroll={onScroll} empty={loading ? 'Loading…' : applied ? `No lines match “${applied}”.` : 'This log is empty.'} />
          <div className="card-body muted small" style={{ paddingTop: 8, paddingBottom: 10 }}>
            {from}{applied && ` · showing lines containing “${applied}”`}{live && ' · following live'} · {lines.length} line{lines.length === 1 ? '' : 's'}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Asterisk console
const QUICK = [
  ['core show channels', 'Calls in progress'],
  ['pjsip show registrations', 'Trunk registrations'],
  ['pjsip show contacts', 'Registered phones'],
  ['pjsip show identifies', 'Inbound trunk matching'],
  ['pjsip show endpoints', 'Endpoints'],
  ['core show uptime', 'Uptime'],
  ['pjsip set logger on', 'Show SIP messages'],
  ['pjsip set logger off', 'Hide SIP messages'],
];
const HISTORY_KEY = 'asterfi.cli.history';
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };

export function Console() {
  const [out, setOut] = useState([]);
  const [cmd, setCmd] = useState('');
  const [live, setLive] = useState(true);
  const [error, setError] = useState(null);
  const [ask, setAsk] = useState(null);
  const [running, setRunning] = useState(false);
  const hist = useRef(loadHistory());
  const pos = useRef(-1);
  const input = useRef(null);
  const { ref, onScroll, toBottom } = useStickyScroll([out]);
  const toast = useToast();

  const add = (items) => setOut((prev) => { const next = [...prev, ...items]; return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next; });
  useStream('/api/system/console/stream', live, (l) => add([{ text: l, cls: lineClass(l) }]), (e) => { setError(e); setLive(false); });

  const run = async (command, confirmed = false) => {
    command = command.trim();
    if (!command) return;
    setAsk(null);
    if (!confirmed) {
      hist.current = [command, ...hist.current.filter((h) => h !== command)].slice(0, 50);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.current)); } catch { /* private mode */ }
      pos.current = -1;
      setCmd('');
    }
    setRunning(true);
    try {
      const r = await api.post('/api/system/cli', { command, confirmed });
      if (r.confirm) { setAsk(command); return; }
      toBottom();
      add([{ text: `asterfi*CLI> ${command}`, cls: 'cmd' }, ...String(r.output || '').replace(/\n$/, '').split('\n').map((t) => ({ text: t, cls: 'out' }))]);
    } catch (e) {
      add([{ text: `asterfi*CLI> ${command}`, cls: 'cmd' }, { text: e.message, cls: 'err' }]);
    } finally { setRunning(false); input.current?.focus(); }
  };
  const onKey = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      pos.current = Math.max(-1, Math.min(hist.current.length - 1, pos.current + (e.key === 'ArrowUp' ? 1 : -1)));
      setCmd(pos.current < 0 ? '' : hist.current[pos.current]);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Asterisk console</h2><div className="spacer" />
        <button className={`btn sm ${live ? 'primary' : ''}`} onClick={() => { setError(null); setLive((v) => !v); }} title="Show Asterisk's live output (calls, registrations, warnings)">
          {live ? <><Pause size={13} />Pause live output</> : <><Radio size={13} />Show live output</>}
        </button>
        <button className="btn sm" onClick={() => download(`asterisk-console-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.log`, out)} disabled={!out.length}><Download size={13} />Download</button>
        <button className="btn sm" onClick={() => setOut([])}><Trash2 size={13} />Clear</button>
      </div>
      <div className="card-body" style={{ paddingBottom: 10 }}>
        <div className="chips">{QUICK.map(([c, label]) => <button key={c} className="btn sm" title={c} onClick={() => run(c)} disabled={running}>{label}</button>)}</div>
      </div>
      {error && <div className="card-body" style={{ paddingTop: 0 }}><div className="alert warn" style={{ margin: 0 }}>Live output stopped: {error}</div></div>}
      <LogLines lines={out} boxRef={ref} onScroll={onScroll} empty={live ? 'Waiting for Asterisk output… Run a command below, or make a call to see it here.' : 'Run a command below.'} />
      <form className="cli-input" onSubmit={(e) => { e.preventDefault(); run(cmd); }}>
        <span className="mono muted">CLI&gt;</span>
        <input ref={input} type="text" className="mono" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey}
          placeholder="Asterisk command, e.g. pjsip show endpoint 1001" autoComplete="off" spellCheck={false} disabled={running} />
        <button className="btn sm primary" type="submit" disabled={running || !cmd.trim()}><CornerDownLeft size={13} />Run</button>
      </form>
      <div className="card-body muted small" style={{ paddingTop: 0 }}>Commands run in Asterisk as typed (↑ and ↓ recall earlier ones). Changes made here last until Asterisk restarts or AsterFi rewrites its configuration.</div>
      {ask && <Confirm title="Run this command?" message={`“${ask}” can stop Asterisk or drop calls in progress.`} confirmLabel="Run it"
        onConfirm={() => run(ask, true)} onCancel={() => { setAsk(null); toast('Command not run'); }} />}
    </div>
  );
}
