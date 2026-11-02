import { useCallback, useEffect, useRef, useState } from 'react';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, ArrowLeftRight, Voicemail, Search, History, ChevronLeft, ChevronRight, Disc } from 'lucide-react';
import { api, formatNumber, fmtDuration, fmtWhen, fullName } from '../api.js';
import { useLiveEvents, Empty, Seg, Drawer } from '../components/ui.jsx';
import { useDirectory } from '../components/Destination.jsx';
import { useContactLookup, contactName } from './Contacts.jsx';

export function partyLabel(num, dir, findContact) {
  if (!num) return 'Unknown';
  const u = dir?.users.find((x) => x.extension === num);
  if (u) return `${fullName(u)} (${num})`;
  const g = dir?.groups.find((x) => x.extension === num);
  if (g) return g.name;
  const c = findContact?.(num);
  if (c) return `${contactName(c)} · ${formatNumber(num)}`;
  return formatNumber(num);
}

// Who the call was meant for: the group or person it was first sent to ("Service", "David King"),
// or null when that's just the number shown above it (internal calls) or nobody (outbound).
export function recipientLabel(c, dir) {
  const t = (c.path || []).find((s) => s.step === 'group' || s.step === 'user');
  const x = t && String(t.target || '').split('&')[0];
  if (!x || x === c.to_num) return null;
  const g = dir?.groups.find((y) => y.extension === x);
  if (g) return g.name;
  const u = dir?.users.find((y) => y.extension === x);
  return u ? fullName(u) : x;
}

// Who answered, as { name, sub }: sub is their extension, or "Forwarded → number" when they took it on the
// number their call forwarding sends to. A forwarded call answered before the tracker credited the user
// (answered_by empty) still shows the forwarding user.
export function answeredParty(c, dir) {
  if (c.status !== 'answered') return null;
  const steps = c.path || [];
  const ans = steps.find((s) => s.step === 'answered');
  const fwd = steps.filter((s) => s.step === 'forward');
  const ext = c.answered_by || (fwd.length === 1 ? fwd[0].from : null);
  if (!ext) return { name: 'Outside party', sub: null };
  const to = ans?.forwarded || fwd.find((f) => f.from === ext)?.to;
  const u = dir?.users.find((x) => x.extension === ext);
  return { name: u ? fullName(u) : ext, sub: to ? `Forwarded → ${formatNumber(to)}` : `Ext. ${ext}` };
}

// Who the call was for on top (group or person), the number it came in on below; just the number otherwise.
function ToCell({ c, dir, findContact }) {
  const r = recipientLabel(c, dir);
  const num = partyLabel(c.to_num, dir, findContact);
  if (!r) return <div>{num}</div>;
  return <><div>{r}</div><div className="muted small">{num}</div></>;
}

function AnsweredCell({ c, dir }) {
  const a = answeredParty(c, dir);
  if (!a) return <span className="muted">—</span>;
  return <><div>{a.name}</div>{a.sub && <div className="muted small">{a.sub}</div>}</>;
}

export function CallIcon({ c }) {
  const st = c.status || (c.answeredAt ? 'answered' : 'ringing');
  if (st === 'voicemail') return <Voicemail size={16} color="var(--purple)" />;
  if (['missed', 'abandoned', 'busy'].includes(st)) return <PhoneMissed size={16} color="var(--red)" />;
  if (c.direction === 'outbound') return <PhoneOutgoing size={16} color="var(--accent)" />;
  if (c.direction === 'internal') return <ArrowLeftRight size={16} color="var(--muted)" />;
  return <PhoneIncoming size={16} color="var(--green)" />;
}

const STATUS = { answered: ['green', 'Answered'], missed: ['red', 'Missed'], abandoned: ['red', 'Caller hung up'], busy: ['amber', 'Busy'], voicemail: ['blue', 'Voicemail'], failed: ['red', 'Failed'] };
export function StatusBadge({ status }) {
  const [c, l] = STATUS[status] || ['', status];
  return <span className={`badge ${c}`}>{l}</span>;
}

// Recorded by its call flow, and someone answered (so there's a conversation to play).
const isRecorded = (c) => c.status === 'answered' && (c.path || []).some((s) => s.step === 'recording');

const PAGE = 50;
const SCOPE_KEY = 'asterfi.calls.scope';
const readScope = () => { try { return localStorage.getItem(SCOPE_KEY) || 'all'; } catch { return 'all'; } };

export default function Calls({ isAdmin = false }) {
  const [filter, setFilter] = useState('');
  const [scope, setScopeState] = useState(isAdmin ? readScope : 'mine');
  const setScope = (v) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ } };
  const latest = useRef(0);
  const [direction, setDirection] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: PAGE, offset: page * PAGE });
    if (filter) p.set('status', filter);
    if (direction) p.set('direction', direction);
    if (search) p.set('search', search);
    if (isAdmin && scope === 'mine') p.set('mine', '1');
    const n = ++latest.current; // ignore replies that arrive after a newer request
    api.get(`/api/calls?${p}`).then((r) => { if (n === latest.current) setData(r); }).catch(() => {});
  }, [filter, direction, search, page, scope, isAdmin]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load]);
  useLiveEvents(load, ['call.ended']);
  useEffect(() => setPage(0), [filter, direction, search, scope]);

  const pages = data ? Math.ceil(data.total / PAGE) : 0;
  return (
    <>
      <div className="toolbar">
        <Seg value={filter} onChange={setFilter} options={[{ value: '', label: 'All' }, { value: 'answered', label: 'Answered' }, { value: 'missed', label: 'Missed' }, { value: 'voicemail', label: 'Voicemail' }]} />
        <select value={direction} onChange={(e) => setDirection(e.target.value)} style={{ width: 150 }}>
          <option value="">All directions</option><option value="inbound">Incoming</option><option value="outbound">Outgoing</option><option value="internal">Internal</option>
        </select>
        {isAdmin && <Seg value={scope} onChange={setScope} options={[{ value: 'mine', label: 'My history' }, { value: 'all', label: 'All history' }]} />}
        <div className="spacer" />
        <div className="search"><Search size={15} /><input type="search" placeholder="Search number or name" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      <div className="card">
        {data && data.rows.length === 0 ? <Empty icon={History} title="No calls found" /> : (
          <CallTable rows={data?.rows || []} />
        )}
      </div>
      {pages > 1 && <div className="toolbar" style={{ marginTop: 12 }}>
        <div className="spacer" /><span className="muted small">Page {page + 1} of {pages} · {data.total} calls</span>
        <button className="btn sm icon" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={15} /></button>
        <button className="btn sm icon" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><ChevronRight size={15} /></button>
      </div>}
    </>
  );
}

// The call list used by Call History and the Dashboard; click a row for its details.
export function CallTable({ rows }) {
  const dir = useDirectory();
  const findContact = useContactLookup();
  const [detail, setDetail] = useState(null);
  return (
    <>
      <div className="table-wrap"><table className="t">
        <thead><tr><th></th><th>From</th><th>To</th><th>Answered by</th><th>Result</th><th>When</th><th className="actions">Duration</th></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id} className="clickable" onClick={() => setDetail(c)}>
            <td style={{ width: 36 }}><CallIcon c={c} /></td>
            <td><div>{findContact(c.from_num) ? contactName(findContact(c.from_num)) : c.from_name && c.from_name !== c.from_num ? c.from_name : partyLabel(c.from_num, dir)}</div>{(findContact(c.from_num) || (c.from_name && c.from_name !== c.from_num)) && <div className="muted small">{formatNumber(c.from_num)}</div>}</td>
            <td><ToCell c={c} dir={dir} findContact={findContact} /></td>
            <td><AnsweredCell c={c} dir={dir} /></td>
            <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={c.status} />{isRecorded(c) && <Disc size={13} color="var(--red)" style={{ verticalAlign: -2, marginLeft: 6 }} aria-label="Recorded" />}</td>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(c.started_at)}</td>
            <td className="num muted actions">{c.status === 'answered' ? fmtDuration(c.talk_seconds) : fmtDuration(c.duration)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {detail && <CallDetail c={detail} dir={dir} onClose={() => setDetail(null)} />}
    </>
  );
}

const QUEUE_EXIT = { TIMEOUT: 'waited the maximum time', FULL: 'queue was full', JOINEMPTY: 'nobody was signed in', LEAVEEMPTY: 'everyone signed out', JOINUNAVAIL: 'nobody was available', LEAVEUNAVAIL: 'nobody was available' };
const STEP = {
  number: (s) => `Arrived on ${formatNumber(s.did) || 'a number'}${s.name ? ` (${s.name})` : ''}`,
  flow: (s) => `Entered call flow "${s.name}"`,
  ivr: (s) => (s.key ? `Pressed ${s.key} at "${s.node}"` : `Passed "${s.node}"`),
  group: (s, dir) => `Rang group ${partyLabel(s.target, dir)}`,
  user: (s, dir) => `Rang ${partyLabel(s.target, dir)}`,
  queue: (s, dir) => `Waiting in queue for ${partyLabel(s.group, dir)}${s.position ? ` (position ${s.position})` : ''}`,
  'queue-exit': (s) => `Left the queue: ${QUEUE_EXIT[s.status] || s.status || 'no answer'}`,
  forward: (s, dir) => `Forwarded by ${partyLabel(s.from, dir)} to ${formatNumber(s.to)}`,
  answered: (s, dir) => `Answered${s.by ? ` by ${partyLabel(s.by, dir)}` : ''}`,
  callback: (s, dir) => `Asked ${partyLabel(s.group, dir)} for a callback`,
  voicemail: (s, dir) => `Sent to voicemail for ${partyLabel(s.mailbox, dir)}`,
  recording: () => 'Recording started (once answered)',
};

function CallDetail({ c, dir, onClose }) {
  const t0 = new Date(c.started_at).getTime();
  return (
    <Drawer title="Call details" onClose={onClose}>
      <div className="row" style={{ marginBottom: 18 }}>
        <div><div className="muted small">From</div><div>{c.from_name || partyLabel(c.from_num, dir)}</div><div className="muted small">{formatNumber(c.from_num)}</div></div>
        <div><div className="muted small">To</div><div>{partyLabel(c.to_num, dir)}</div></div>
      </div>
      <div className="row" style={{ marginBottom: 18 }}>
        <div><div className="muted small">Result</div><StatusBadge status={c.status} /></div>
        <div><div className="muted small">Talk time</div>{fmtDuration(c.talk_seconds)}</div>
        <div><div className="muted small">Total</div>{fmtDuration(c.duration)}</div>
      </div>
      {isRecorded(c) && <><div className="section-title">Recording</div>
        <audio controls preload="none" src={`/api/calls/${encodeURIComponent(c.id)}/recording`} style={{ width: '100%', marginBottom: 6 }} /></>}
      <div className="section-title">Timeline</div>
      <div className="order-list">
        <div className="order-item"><span className="muted small num" style={{ width: 44 }}>0:00</span><span className="n">Call started · {fmtWhen(c.started_at)}</span></div>
        {(c.path || []).map((s, i) => (
          <div key={i} className="order-item"><span className="muted small num" style={{ width: 44 }}>{fmtDuration((new Date(s.at) - t0) / 1000)}</span><span className="n">{STEP[s.step]?.(s, dir) || s.step}</span></div>
        ))}
        <div className="order-item"><span className="muted small num" style={{ width: 44 }}>{fmtDuration(c.duration)}</span><span className="n">Call ended</span></div>
      </div>
      {c.missed_exts?.length > 0 && <><div className="section-title">Missed by</div><div className="chips">{c.missed_exts.map((e) => <span key={e} className="chip" style={{ paddingRight: 10 }}>{partyLabel(e, dir)}</span>)}</div></>}
      <div className="section-title">Call ID</div><div className="mono muted">{c.id}</div>
    </Drawer>
  );
}
