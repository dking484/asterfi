import { useEffect, useState } from 'react';
import { Plus, UsersRound, ArrowUp, ArrowDown, X, Trash2, Hourglass } from 'lucide-react';
import { api, fullName } from '../api.js';
import { useData, useToast, Drawer, Confirm, Field, Empty, Seg, Avatar, Toggle, useForm } from '../components/ui.jsx';
import { PromptSelect } from './Flows.jsx';
import { useDirectory, DestinationPicker, describeDest } from '../components/Destination.jsx';

const QUEUE = { enabled: false, max_wait: 300, max_callers: 0, announce_position: true, hold_prompt_id: null, hold_every: 60, callback_enabled: false, callback_after: 2, callback_prompt_id: null };
const VM = { enabled: false, pin: '', greeting_prompt_id: null, email_members: true, emails: [], attach_audio: true };
const NEW = { voicemail: VM, name: '', extension: '', strategy: 'ringall', ring_seconds: 20, members: [], fail_dest: { type: 'hangup' }, queue: QUEUE };

export default function Groups() {
  const { data, reload } = useData('/api/groups');
  const [editing, setEditing] = useState(null);
  const dir = useDirectory();
  const done = () => { setEditing(null); reload(); dir.refresh(); };
  const nextExt = () => {
    const used = new Set([...(data || []).map((g) => g.extension), ...dir.users.map((u) => u.extension)]);
    let n = 600; while (used.has(String(n))) n++;
    return String(n);
  };
  const add = () => setEditing({ ...NEW, extension: nextExt() });
  const live = useQueueCounts(data);

  return (
    <>
      <div className="toolbar"><div className="muted">Ring groups ring several users at once, or one after another.</div><div className="spacer" /><button className="btn primary" onClick={add}><Plus size={16} />Add Ring Group</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={UsersRound} title="No ring groups" text="Create a group like Sales or Support, then point a number or call flow at it." action={<button className="btn primary" onClick={add}><Plus size={16} />Add Ring Group</button>} /> : (
          <table className="t">
            <thead><tr><th>Name</th><th>Extension</th><th>Ring style</th><th>Members</th><th>Queue</th><th>If nobody answers</th></tr></thead>
            <tbody>{(data || []).map((g) => (
              <tr key={g.id} className="clickable" onClick={() => setEditing(g)}>
                <td className="n" style={{ fontWeight: 500 }}>{g.name}</td>
                <td className="num">{g.extension}</td>
                <td>{g.strategy === 'hunt' ? 'One at a time' : 'All at once'}</td>
                <td><div style={{ display: 'flex', gap: 2 }}>{g.members.slice(0, 6).map((m) => { const u = dir.users.find((x) => x.extension === m); return <span key={m} title={u ? fullName(u) : m}><Avatar name={u ? fullName(u) : m} size={26} /></span>; })}{g.members.length > 6 && <span className="muted small">+{g.members.length - 6}</span>}</div></td>
                <td>{g.queue?.enabled ? <QueueBadge q={live[g.extension]} /> : <span className="muted">Off</span>}</td>
                <td className="muted">{describeDest(g.fail_dest, dir)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing && <GroupDrawer group={editing} onClose={() => setEditing(null)} onSaved={done} />}
    </>
  );
}

// Polls live waiting counts while any group has queuing on.
function useQueueCounts(groups) {
  const [live, setLive] = useState({});
  const on = (groups || []).some((g) => g.queue?.enabled);
  useEffect(() => {
    if (!on) return undefined;
    let stop = false;
    const tick = () => api.get('/api/groups/queues').then((r) => { if (!stop) setLive(r || {}); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [on]);
  return live;
}

function QueueBadge({ q }) {
  if (!q?.waiting) return <span className="badge green">On · none waiting</span>;
  const m = Math.floor(q.longest / 60), sec = q.longest % 60;
  return <span className="badge amber"><Hourglass size={12} />{q.waiting} waiting · longest {m ? `${m}m ` : ''}{sec}s</span>;
}

function GroupDrawer({ group, onClose, onSaved }) {
  const isNew = !group.id;
  const [f, set, setF] = useForm({ ...group, queue: { ...QUEUE, ...(group.queue || {}) }, voicemail: { ...VM, ...(group.voicemail || {}) } });
  const [emails, setEmails] = useState((f.voicemail.emails || []).join(', '));
  const setV = (k) => (v) => setF((cur) => ({ ...cur, voicemail: { ...cur.voicemail, [k]: v?.nativeEvent ? v.target.value : v } }));
  const useGroupVm = () => setF((cur) => ({ ...cur, fail_dest: { type: 'voicemail', target: cur.extension } }));
  const setQ = (k) => (v) => setF((cur) => ({ ...cur, queue: { ...cur.queue, [k]: v?.nativeEvent ? v.target.value : v } }));
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const dir = useDirectory();
  const toast = useToast();

  const toggle = (ext) => setF({ ...f, members: f.members.includes(ext) ? f.members.filter((m) => m !== ext) : [...f.members, ext] });
  const move = (i, d) => { const m = [...f.members]; [m[i], m[i + d]] = [m[i + d], m[i]]; setF({ ...f, members: m }); };
  const save = async () => {
    setErr('');
    try {
      const { id, created_at, ...body } = { ...f, voicemail: { ...f.voicemail, emails } };
      if (isNew) await api.post('/api/groups', body); else await api.put(`/api/groups/${group.id}`, body);
      toast('Ring group saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Drawer title={isNew ? 'Add Ring Group' : group.name} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button>
    </>}>
      {err && <div className="alert error">{err}</div>}
      <div className="row">
        <Field label="Name"><input type="text" value={f.name} onChange={set('name')} autoFocus placeholder="Sales" /></Field>
        <Field label="Extension"><input type="text" value={f.extension} onChange={set('extension')} /></Field>
      </div>
      <Field label="Ring style">
        <Seg value={f.strategy} onChange={set('strategy')} options={[{ value: 'ringall', label: 'All at once' }, { value: 'hunt', label: 'One at a time' }]} />
      </Field>
      <Field label={f.strategy === 'hunt' ? 'Ring each member for (seconds)' : 'Ring for (seconds)'}><input type="number" min="5" max="300" value={f.ring_seconds} onChange={set('ring_seconds')} /></Field>

      <div className="section-title">Members {f.strategy === 'hunt' && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· in ring order</span>}</div>
      {f.members.length > 0 && <div className="order-list" style={{ marginBottom: 10 }}>
        {f.members.map((m, i) => { const u = dir.users.find((x) => x.extension === m); return (
          <div key={m} className="order-item">
            <Avatar name={u ? fullName(u) : m} size={24} />
            <span className="n">{u ? fullName(u) : m} <span className="muted">· {m}</span></span>
            {f.strategy === 'hunt' && <><button className="btn ghost sm icon" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button><button className="btn ghost sm icon" disabled={i === f.members.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button></>}
            <button className="btn ghost sm icon" onClick={() => toggle(m)}><X size={14} /></button>
          </div>
        ); })}
      </div>}
      <div className="list-pick">
        {dir.users.filter((u) => !f.members.includes(u.extension)).map((u) => (
          <label key={u.id}><input type="checkbox" checked={false} onChange={() => toggle(u.extension)} /><Avatar name={fullName(u)} size={24} />{fullName(u)} <span className="muted">· {u.extension}</span></label>
        ))}
        {dir.users.length === 0 && <div className="muted" style={{ padding: 12 }}>Add users first.</div>}
      </div>

      <div className="section-title">Call queue</div>
      <Toggle title="Queue callers when everyone is busy" description="Callers hear hold music and wait for the next free member, instead of going straight to the fallback below." checked={f.queue.enabled} onChange={setQ('enabled')} />
      {f.queue.enabled && <>
        <div className="row">
          <Field label="Longest wait (seconds)" hint="Then the caller goes to the fallback."><input type="number" min="30" max="3600" value={f.queue.max_wait} onChange={setQ('max_wait')} /></Field>
          <Field label="Most callers waiting" hint="0 means no limit."><input type="number" min="0" max="100" value={f.queue.max_callers} onChange={setQ('max_callers')} /></Field>
        </div>
        <Toggle title="Tell callers their place in line" description={'"You are now first in line", repeated about every minute.'} checked={f.queue.announce_position} onChange={setQ('announce_position')} />
        <Field label="Hold message" hint="Optional. Played between the hold music, e.g. &quot;Thanks for holding, someone will be right with you.&quot;"><PromptSelect value={f.queue.hold_prompt_id} onChange={setQ('hold_prompt_id')} /></Field>
        {f.queue.hold_prompt_id && !f.queue.callback_enabled && <Field label="Play the hold message every (seconds)"><input type="number" min="15" max="600" value={f.queue.hold_every} onChange={setQ('hold_every')} /></Field>}
        <div className="hint" style={{ marginBottom: 12 }}>Members already on a call are skipped. If no member's phone is online, callers go straight to the fallback.</div>

        <Toggle title="Offer a callback after waiting" description="After a few minutes on hold, callers can press 1 to leave a message or 2 to be called back at their number, instead of waiting." checked={f.queue.callback_enabled} onChange={setQ('callback_enabled')} />
        {f.queue.callback_enabled && <>
          <Field label="Offer the callback after (minutes)" hint="The offer message plays at this point and repeats."><input type="number" min="1" max="30" value={f.queue.callback_after} onChange={setQ('callback_after')} /></Field>
          <Field label="Offer message" hint="What callers hear, e.g. &quot;To leave a message press 1; to be called back at your number press 2.&quot;"><PromptSelect value={f.queue.callback_prompt_id} onChange={setQ('callback_prompt_id')} /></Field>
          {!f.voicemail.enabled && <div className="hint" style={{ color: 'var(--amber)', marginBottom: 12 }}>Turn on group voicemail below for the "leave a message" (press 1) option. Without it, only the callback request (press 2) works.</div>}
          {f.queue.callback_prompt_id && f.queue.hold_prompt_id && <div className="hint" style={{ marginBottom: 12 }}>While a callback is offered, the offer message replaces the hold message above.</div>}
        </>}
      </>}

      <div className="section-title">Group voicemail</div>
      <Toggle title="Shared voicemail box" description={`Callers can leave one message for the whole group. Members see it on their Voicemail page and can dial *98, mailbox ${f.extension || 'number'}.`} checked={f.voicemail.enabled} onChange={setV('enabled')} />
      {f.voicemail.enabled && <>
        <Field label="Greeting" hint="Optional. Without one, callers hear: &quot;Nobody is available to take your call.&quot;"><PromptSelect value={f.voicemail.greeting_prompt_id} onChange={setV('greeting_prompt_id')} /></Field>
        <Toggle title="Email every member" description="Members with an email address get a &quot;missed call, voicemail left&quot; email, instead of a separate missed-call email." checked={f.voicemail.email_members} onChange={setV('email_members')} />
        <Field label="Also email" hint="Other addresses to notify, separated by commas."><input type="text" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="office@example.com" /></Field>
        <Toggle title="Attach the recording" description="Adds the message as an MP3 to each email." checked={f.voicemail.attach_audio} onChange={setV('attach_audio')} />
        <Field label="Mailbox PIN" hint="For checking messages from a phone with *98. Default 1234."><input type="text" inputMode="numeric" value={f.voicemail.pin} onChange={setV('pin')} placeholder="1234" style={{ maxWidth: 140 }} /></Field>
      </>}

      <div className="section-title">{f.queue.enabled ? 'If nobody answers in time' : 'If nobody answers'}</div>
      {f.voicemail.enabled && !(f.fail_dest?.type === 'voicemail' && f.fail_dest.target === f.extension) && (
        <div className="hint" style={{ marginBottom: 8 }}>Callers don't reach the group voicemail yet. <button type="button" className="btn sm" onClick={useGroupVm}>Send them there</button></div>
      )}
      <DestinationPicker value={f.fail_dest} onChange={set('fail_dest')} />
      {confirm && <Confirm title={`Delete ${group.name}?`} message="Numbers and call flows pointing at this group will stop reaching it." onConfirm={async () => { await api.del(`/api/groups/${group.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}
