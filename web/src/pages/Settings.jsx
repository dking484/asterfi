import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, ArrowUp, ArrowDown, ListPlus, Send, Server, Webhook, KeyRound, RotateCw, CheckCircle2, XCircle, Clock, Mail, Route } from 'lucide-react';
import { api, fmtWhen } from '../api.js';
import { VoiceSelect, PreviewButton, loadTts, useTts } from '../components/Voices.jsx';
import { FIELD_TYPES, useFieldDefs } from '../components/CustomFields.jsx';
import { useData, useToast, useLiveEvents, Drawer, Confirm, Field, Toggle, Empty, CopyField, useForm, Switch, PasswordInput } from '../components/ui.jsx';

// General first, the rest alphabetical.
const TABS = [['general', 'General'], ['fields', 'Contact Fields'], ['email', 'Email'], ['webhooks', 'Webhooks & API']];
const MOVED = ['routing', 'trunks', 'routes']; // now Call Routing > Trunks & Routes
const PROMPTS = ['recordings']; // now only Call Flows > Audio Prompts
const ZONES = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['America/New_York'];

export default function Settings() {
  const { tab = 'general' } = useParams();
  const nav = useNavigate();
  if (MOVED.includes(tab)) return <Navigate to="/trunks" replace />;
  if (PROMPTS.includes(tab)) return <Navigate to="/flows" replace />;
  return (
    <>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => nav(k === 'general' ? '/settings' : `/settings/${k}`)}>{l}</button>)}</div>
      {tab === 'general' && <General />}
      {tab === 'email' && <Email />}
      {tab === 'fields' && <ContactFields />}
      {tab === 'webhooks' && <Integrations />}
    </>
  );
}

// Call Routing > Trunks & Routes: carrier connections, then which one each outside call uses.
export function TrunksAndRoutes() {
  return (
    <>
      <h2 className="section-head">SIP Trunks</h2>
      <Trunks />
      <h2 className="section-head" style={{ marginTop: 32 }}>Outbound Routes</h2>
      <Routes />
    </>
  );
}

// ---------------------------------------------------------------- contact fields
function ContactFields() {
  const { defs, reload, loaded } = useFieldDefs();
  const [editing, setEditing] = useState(null);
  const [del, setDel] = useState(null);
  const toast = useToast();
  const saveAll = async (fields, msg) => { await api.put('/api/settings/contact-fields', { fields }); toast(msg); reload(); };
  const move = (i, d) => { const l = [...defs]; [l[i], l[i + d]] = [l[i + d], l[i]]; saveAll(l, 'Order saved').catch((e) => toast(e.message, 'error')); };
  const where = (f) => [f.contacts && 'Contacts', f.users && 'User profiles'].filter(Boolean).join(' & ');
  return (
    <>
      <div className="toolbar">
        <div className="muted">Extra details to keep on contacts and on user profiles, like Department, Account number or Birthday.</div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ label: '', type: 'text', options: [], contacts: true, users: true, user_editable: true, public: true })}><Plus size={16} />Add Field</button>
      </div>
      <div className="card">
        {loaded && defs.length === 0 ? <Empty icon={ListPlus} title="No custom fields yet" text="Fields you add here appear on every contact and, if you choose, on each user's profile." /> : (
          <table className="t">
            <thead><tr><th>Field</th><th>Type</th><th>Shows on</th><th>On user profiles</th><th></th></tr></thead>
            <tbody>{defs.map((f, i) => (
              <tr key={f.id} className="clickable" onClick={() => setEditing(f)}>
                <td style={{ fontWeight: 500 }}>{f.label}{f.type === 'select' && <div className="muted small" style={{ fontWeight: 400 }}>{f.options.join(', ')}</div>}</td>
                <td className="muted">{Object.fromEntries(FIELD_TYPES)[f.type]}</td>
                <td>{where(f)}</td>
                <td className="muted small">{f.users ? [f.user_editable ? 'Users can edit their own' : 'Admins only', f.public ? 'coworkers can see it' : 'hidden from coworkers'].join(' · ') : '—'}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn ghost sm icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp size={14} /></button>
                  <button className="btn ghost sm icon" disabled={i === defs.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown size={14} /></button>
                  <button className="btn ghost sm icon" onClick={() => setDel(f)} title="Delete"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing && <FieldDrawer field={editing} onClose={() => setEditing(null)} onSave={async (f) => {
        const list = f.id ? defs.map((x) => (x.id === f.id ? f : x)) : [...defs, f];
        await saveAll(list, 'Field saved'); setEditing(null);
      }} />}
      {del && <Confirm title={`Delete "${del.label}"?`} message="The field and every value filled in for it, on all contacts and users, are removed." onConfirm={async () => { await saveAll(defs.filter((x) => x.id !== del.id), 'Field deleted'); setDel(null); }} onCancel={() => setDel(null)} />}
    </>
  );
}

function FieldDrawer({ field, onClose, onSave }) {
  const [f, set, setF] = useForm({ ...field, options: (field.options || []).join('\n') });
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    try { await onSave({ ...f, options: f.options.split('\n') }); } catch (e) { setErr(e.message); }
  };
  return (
    <Drawer title={field.id ? field.label : 'Add Field'} onClose={onClose} footer={<><div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      {err && <div className="alert error">{err}</div>}
      <Field label="Name"><input type="text" value={f.label} onChange={set('label')} autoFocus placeholder="Department" /></Field>
      <Field label="Type" hint={field.id ? 'Changing the type keeps existing values, but they may no longer pass the new checks when edited.' : null}>
        <select value={f.type} onChange={set('type')}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      {f.type === 'select' && <Field label="Choices" hint="One per line."><textarea rows={5} value={f.options} onChange={set('options')} placeholder={'Sales\nService\nOffice'} /></Field>}
      <div className="section-title">Shows on</div>
      <Toggle title="Contacts" description="Everyone's personal contacts get this field." checked={f.contacts} onChange={set('contacts')} />
      <Toggle title="User profiles" description="Each user's profile gets this field; it's shown on the Users page and on My Account." checked={f.users} onChange={set('users')} />
      {f.users && <>
        <Toggle title="Users can edit their own" description="Otherwise only administrators can fill it in." checked={f.user_editable} onChange={set('user_editable')} />
        <Toggle title="Coworkers can see it" description="Shown when someone opens this user on the Contacts page." checked={f.public} onChange={set('public')} />
      </>}
    </Drawer>
  );
}

// ---------------------------------------------------------------- general
function General() {
  const { data } = useData('/api/settings/general');
  const { data: info } = useData('/api/system/info');
  const { data: backups } = useData('/api/backups');
  const [f, set, setF] = useForm(null);
  const [restart, setRestart] = useState(false);
  const toast = useToast();
  useEffect(() => { if (data) setF({ ...data, localNets: (data.localNets || []).join(', ') }); }, [data]);
  if (!f) return null;
  const save = async () => {
    try {
      const r = await api.put('/api/settings/general', f);
      toast('Settings saved');
      if (r.restartRequired) setRestart(true);
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div style={{ maxWidth: 640 }}>
      {restart && <div className="alert warn" style={{ alignItems: 'center' }}><span style={{ flex: 1 }}>Network changes take effect after Asterisk restarts. Active calls will drop.</span><button className="btn sm" onClick={async () => { await api.post('/api/system/restart-asterisk'); setRestart(false); toast('Asterisk is restarting'); }}>Restart now</button></div>}
      <div className="card"><div className="card-body">
        <Field label="System name"><input type="text" value={f.siteName} onChange={set('siteName')} /></Field>
        <Field label="Time zone" hint="Used for business hours in call flows and for email timestamps."><select value={f.timezone} onChange={set('timezone')}>{ZONES.map((z) => <option key={z}>{z}</option>)}</select></Field>
        <Field label="Web address" hint="Used for links in notification emails, e.g. https://phones.example.com"><input type="url" value={f.publicUrl || ''} onChange={set('publicUrl')} placeholder={window.location.origin} /></Field>
        <div className="section-title">Network</div>
        <Field label="Public IP address" hint="Only needed if your SIP trunk reaches this server through NAT."><input type="text" value={f.externalAddress || ''} onChange={set('externalAddress')} placeholder="203.0.113.10" /></Field>
        <Field label="Local networks" hint="Comma-separated. Phones on these networks are treated as local."><input type="text" value={f.localNets} onChange={set('localNets')} /></Field>
        <button className="btn primary" onClick={save}>Save</button>
      </div></div>
      <VoiceSettings />
      <TranscriptionSettings />
      {info &&<div className="card" style={{ marginTop: 16 }}><div className="card-head"><h2>System</h2></div><div className="card-body small">
        <div className="row"><div className="muted">Asterisk</div><div>{info.asterisk}</div></div>
        <div className="row" style={{ marginTop: 6 }}><div className="muted">Manager connection</div><div>{info.amiConnected ? <span className="badge green">Connected</span> : <span className="badge red">Disconnected</span>}</div></div>
      </div></div>}
      <div className="card" style={{ marginTop: 16 }}><div className="card-head"><h2>Backups</h2><div className="spacer" /><span className="muted small">Nightly at 02:30 server time · last 14 kept</span></div>
        {backups && backups.length === 0 ? <div className="card-body muted small">No backups yet. The first runs tonight.</div> : (
          <table className="t"><tbody>{(backups || []).map((b) => (
            <tr key={b.name}><td className="mono small">{b.name}</td><td className="muted small">{fmtWhen(b.createdAt)}</td><td className="muted small num">{(b.size / 1048576).toFixed(1)} MB</td>
              <td className="actions"><a className="btn sm" href={`/api/backups/${b.name}`}>Download</a></td></tr>
          ))}</tbody></table>
        )}
        <div className="card-body muted small" style={{ borderTop: '1px solid var(--border)' }}>Each backup holds the database, phone system configuration, audio prompts and voicemail. Backups include SIP and email passwords, so store downloads securely.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- text-to-speech
function VoiceSettings() {
  const tts = useTts();
  const [f, setF] = useState(null);
  const [sample, setSample] = useState('Thank you for calling. For sales, press 1. For service, press 2.');
  const [regen, setRegen] = useState(null);
  const toast = useToast();
  useEffect(() => { if (tts && !f) setF({ engine: tts.engine, voice: tts.voice, speed: tts.speed }); }, [tts]);
  if (!f) return null;
  const changed = f.engine !== tts.engine || f.voice !== tts.voice || Number(f.speed) !== Number(tts.speed);
  const save = async () => {
    try { await api.put('/api/settings/tts', f); await loadTts(true); toast('Voice saved'); setRegen('ask'); } catch (e) { toast(e.message, 'error'); }
  };
  const regenerate = async () => {
    const r = await api.post('/api/tts/regenerate');
    setRegen(null);
    toast(r.count ? `Re-recording ${r.count} text prompt${r.count === 1 ? '' : 's'} in the background (a few seconds each)` : 'No text prompts use the default voice');
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Text-to-speech voice</h2></div>
      <div className="card-body">
        <p className="muted small" style={{ marginTop: 0 }}>Used for prompts you type in call flows. Each prompt can also pick its own voice.</p>
        <Field label="Engine">
          <select value={f.engine} onChange={(e) => setF({ ...f, engine: e.target.value })}>
            <option value="kokoro" disabled={!tts.kokoroAvailable}>Kokoro: natural voices{tts.kokoroAvailable ? '' : ' (not installed)'}</option>
            <option value="flite">Flite: basic, robotic</option>
          </select>
        </Field>
        {f.engine === 'kokoro' && <>
          <Field label="Default voice"><VoiceSelect value={f.voice} onChange={(v) => setF({ ...f, voice: v })} /></Field>
          <Field label={`Speaking speed: ${Number(f.speed).toFixed(2)}×`}>
            <input type="range" min="0.7" max="1.3" step="0.05" value={f.speed} onChange={(e) => setF({ ...f, speed: Number(e.target.value) })} />
          </Field>
        </>}
        <Field label="Try it">
          <div className="row" style={{ alignItems: 'center' }}>
            <input type="text" value={sample} onChange={(e) => setSample(e.target.value)} />
            <PreviewButton text={sample} voice={f.engine === 'kokoro' ? f.voice : null} speed={f.speed} label="Listen" />
          </div>
          {changed && f.engine !== tts.engine && <div className="hint">Preview uses the engine that is saved; save first to hear a different engine.</div>}
        </Field>
        <button className="btn primary" onClick={save} disabled={!changed}>Save</button>
        {regen === 'ask' && <div className="alert info" style={{ marginTop: 14, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>Re-record existing text prompts with the new default voice?</span>
          <button className="btn sm primary" onClick={regenerate}>Re-record</button><button className="btn sm ghost" onClick={() => setRegen(null)}>Not now</button>
        </div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- voicemail transcription
function TranscriptionSettings() {
  const { data, reload } = useData('/api/settings/stt');
  const toast = useToast();
  if (!data) return null;
  const save = async (patch) => {
    try { await api.put('/api/settings/stt', patch); await reload(); toast('Transcription settings saved'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>Voicemail transcription</h2></div>
      <div className="card-body">
        <p className="muted small" style={{ marginTop: 0 }}>New voicemails are turned into text on this server (no cloud service) and shown on the Voicemail page and in voicemail emails.</p>
        {!data.available && <div className="alert warn">Transcription isn't installed on this server. Run the installer again (without SKIP_STT=1) to add it.</div>}
        <Toggle title="Transcribe new voicemails" description="Emails wait up to 90 seconds for the text, so they arrive a few seconds later than before." checked={data.enabled} onChange={(v) => save({ enabled: v })} />
        <Field label="Model" hint="Small makes fewer mistakes with names and numbers but takes about three times as long.">
          <select value={data.model} disabled={!data.available} onChange={(e) => save({ model: e.target.value })}>
            {data.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- email
function Email() {
  const { data } = useData('/api/settings/smtp');
  const { data: log, reload: reloadLog } = useData('/api/email-log');
  const [f, set, setF] = useForm(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return null;
  const save = async () => { try { await api.put('/api/settings/smtp', f); toast('Email settings saved'); } catch (e) { toast(e.message, 'error'); } };
  const test = async () => {
    setBusy(true);
    try { await api.put('/api/settings/smtp', f); await api.post('/api/settings/smtp/test', { to }); toast(`Test email sent to ${to}`); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); reloadLog(); }
  };
  const presets = { smtp2go: ['mail.smtp2go.com', 587, false], gmail: ['smtp.gmail.com', 587, false], office365: ['smtp.office365.com', 587, false], sendgrid: ['smtp.sendgrid.net', 587, false], dreamhost: ['smtp.dreamhost.com', 465, true] };
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card"><div className="card-head"><Mail size={16} /><h2>Outgoing mail server</h2></div><div className="card-body">
        <p className="muted small" style={{ marginTop: 0 }}>Voicemail and missed-call emails are sent through this server.</p>
        <Field label="Quick setup">
          <select value="" onChange={(e) => { const p = presets[e.target.value]; if (p) setF({ ...f, host: p[0], port: p[1], secure: p[2] }); }}>
            <option value="">Choose a provider…</option><option value="smtp2go">SMTP2GO</option><option value="gmail">Gmail / Google Workspace</option><option value="office365">Microsoft 365</option><option value="sendgrid">SendGrid</option><option value="dreamhost">DreamHost</option>
          </select>
        </Field>
        <div className="row">
          <Field label="SMTP server"><input type="text" value={f.host} onChange={set('host')} placeholder="smtp.example.com" /></Field>
          <Field label="Port"><input type="number" value={f.port} onChange={set('port')} style={{ maxWidth: 110 }} /></Field>
        </div>
        <Toggle title="Use SSL/TLS from the start" description="Usually on for port 465. Port 587 upgrades with STARTTLS automatically." checked={f.secure} onChange={set('secure')} />
        <div className="row">
          <Field label="Username"><input type="text" value={f.username} onChange={set('username')} autoComplete="off" /></Field>
          <Field label="Password"><PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        </div>
        <div className="row">
          <Field label="From address"><input type="email" value={f.fromAddress} onChange={set('fromAddress')} placeholder="phones@example.com" /></Field>
          <Field label="From name"><input type="text" value={f.fromName} onChange={set('fromName')} /></Field>
        </div>
        <Toggle title="Allow self-signed certificates" checked={f.allowSelfSigned} onChange={set('allowSelfSigned')} />
        <button className="btn primary" onClick={save}>Save</button>
        <div className="section-title">Send a test</div>
        <div className="row"><input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" /><button className="btn" style={{ flex: '0 0 auto' }} onClick={test} disabled={!to || busy}><Send size={14} />Send test</button></div>
      </div></div>
      <div className="card"><div className="card-head"><h2>Recent emails</h2></div>
        {log && log.length === 0 ? <Empty icon={Mail} title="Nothing sent yet" /> : (
          <div className="table-wrap"><table className="t"><tbody>{(log || []).slice(0, 25).map((l) => (
            <tr key={l.id}><td>{l.status === 'sent' ? <CheckCircle2 size={15} color="var(--green)" /> : <XCircle size={15} color="var(--red)" />}</td>
              <td><div className="small">{l.subject}</div><div className="muted small">{l.recipient}{l.error ? ` · ${l.error}` : ''}</div></td>
              <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(l.created_at)}</td></tr>
          ))}</tbody></table></div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- trunks
const CUSTOM_SECTIONS = ['endpoint', 'registration', 'aor', 'auth', 'identify'];
const NEW_TRUNK = { custom: [], name: '', host: '', port: 5060, transport: 'udp', username: '', password: '', auth_username: '', from_domain: '', from_user: '', register: true, caller_id: '', match_ips: '', enabled: true };
const statusBadge = (st) => (st === 'Registered' ? 'green' : ['IP auth', 'Disabled'].includes(st) ? '' : st === 'Registering' ? 'amber' : 'red');

function TrunkStatus({ t, onRetry }) {
  const [busy, setBusy] = useState(false);
  const retry = async (e) => { e.stopPropagation(); setBusy(true); try { await onRetry(t); } finally { setTimeout(() => setBusy(false), 1500); } };
  return (
    <div>
      <span className={`badge ${statusBadge(t.status)}`}>{busy ? 'Registering…' : t.status}</span>
      {t.reason && !busy && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>Provider said: {t.reason}{t.retryIn ? ` · next automatic try in ${Math.round(t.retryIn / 60)} min` : ''}</div>}
      {t.reasonHelp && !busy && <div className="muted small">{t.reasonHelp}</div>}
      {t.register && t.enabled && t.status !== 'Registered' && <button className="btn sm" style={{ marginTop: 6 }} disabled={busy} onClick={retry}><RotateCw size={13} />Retry now</button>}
    </div>
  );
}

function Trunks() {
  const { data, reload } = useData('/api/trunks');
  const [editing, setEditing] = useState(null);
  const toast = useToast();
  useLiveEvents(useCallback(() => reload(), [reload]), ['trunk.']);
  const retry = async (t) => { try { await api.post(`/api/trunks/${t.id}/register`); setTimeout(reload, 2500); } catch (e) { toast(e.message, 'error'); } };
  return (
    <>
      <div className="toolbar"><div className="muted">Connections to your phone carrier for outside calls.</div><div className="spacer" /><button className="btn primary" onClick={() => setEditing({ ...NEW_TRUNK })}><Plus size={16} />Add Trunk</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={Server} title="No SIP trunks" text="Add your SIP provider's details to make and receive outside calls." /> : (
          <table className="t"><thead><tr><th>Name</th><th>Server</th><th>Authentication</th><th>Status</th></tr></thead>
            <tbody>{(data || []).map((t) => (
              <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                <td style={{ fontWeight: 500 }}>{t.name}{!t.enabled && <span className="badge" style={{ marginLeft: 8 }}>Disabled</span>}</td>
                <td className="mono">{t.host}:{t.port}</td>
                <td className="muted">{t.register ? 'Registration' : 'IP address'}</td>
                <td style={{ maxWidth: 360 }}><TrunkStatus t={t} onRetry={retry} /></td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <TrunkDrawer trunk={editing} onRetry={retry} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); setTimeout(reload, 3000); }} />}
    </>
  );
}
function TrunkDrawer({ trunk, onClose, onSaved, onRetry }) {
  const isNew = !trunk.id;
  const [f, set, setF] = useForm({ ...NEW_TRUNK, ...Object.fromEntries(Object.entries(trunk).map(([k, v]) => [k, v ?? ''])), custom: trunk.custom || [] });
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const save = async () => {
    setErr('');
    try {
      const { id, created_at, status, ...body } = f;
      if (isNew) await api.post('/api/trunks', body); else await api.put(`/api/trunks/${trunk.id}`, body);
      toast(f.register && f.enabled ? 'Trunk saved. Registering now…' : 'Trunk saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Drawer title={isNew ? 'Add SIP Trunk' : trunk.name} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      {err && <div className="alert error">{err}</div>}
      {!isNew && trunk.status && <div className="card" style={{ padding: 12, marginBottom: 16 }}><TrunkStatus t={trunk} onRetry={onRetry} /></div>}
      <Field label="Name"><input type="text" value={f.name} onChange={set('name')} autoFocus placeholder="My carrier" /></Field>
      <div className="row">
        <Field label="Server"><input type="text" value={f.host} onChange={set('host')} placeholder="sip.provider.com" /></Field>
        <Field label="Port"><input type="number" value={f.port} onChange={set('port')} style={{ maxWidth: 100 }} /></Field>
        <Field label="Transport"><select value={f.transport} onChange={set('transport')} style={{ maxWidth: 100 }}><option value="udp">UDP</option><option value="tcp">TCP</option></select></Field>
      </div>
      <Toggle title="Register with the provider" description="Turn off if your provider authenticates by IP address instead." checked={f.register} onChange={set('register')} />
      <div className="row">
        <Field label="Username"><input type="text" value={f.username} onChange={set('username')} autoComplete="off" /></Field>
        <Field label="Password"><PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
      </div>
      <Field label="Default outbound caller ID" hint="Used when a user has no caller ID of their own."><input type="text" value={f.caller_id} onChange={set('caller_id')} placeholder="(860) 555-0100" /></Field>
      <div className="section-title">Advanced</div>
      <div className="row">
        <Field label="Auth username" hint="If different from username."><input type="text" value={f.auth_username} onChange={set('auth_username')} /></Field>
        <Field label="From domain" hint="Defaults to the server address."><input type="text" value={f.from_domain} onChange={set('from_domain')} placeholder={f.host} /></Field>
      </div>
      <Field label="From user"><input type="text" value={f.from_user} onChange={set('from_user')} /></Field>
      <Field label="Extra inbound IPs" hint="Comma-separated addresses or CIDRs your provider sends calls from."><input type="text" value={f.match_ips} onChange={set('match_ips')} /></Field>
      <Toggle title="Enabled" checked={f.enabled} onChange={set('enabled')} />
      <div className="section-title">Custom fields</div>
      <p className="muted small" style={{ marginTop: 0 }}>Extra PJSIP options your provider asks for, added to the chosen section of this trunk's configuration. They override AsterFi's own value for the same option.</p>
      {f.custom.map((c, i) => {
        const upd = (patch) => setF({ ...f, custom: f.custom.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
            <select value={c.section} onChange={(e) => upd({ section: e.target.value })} style={{ flex: '0 0 120px' }}>
              {CUSTOM_SECTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input type="text" className="mono" placeholder="option" value={c.key} onChange={(e) => upd({ key: e.target.value })} />
            <input type="text" className="mono" placeholder="value" value={c.value} onChange={(e) => upd({ value: e.target.value })} />
            <button className="btn ghost sm icon" style={{ flex: '0 0 auto' }} onClick={() => setF({ ...f, custom: f.custom.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
          </div>
        );
      })}
      <button className="btn sm" onClick={() => setF({ ...f, custom: [...f.custom, { section: 'endpoint', key: '', value: '' }] })}><Plus size={13} />Add field</button>
      <p className="muted small">Examples: endpoint <span className="mono">t38_udptl</span> = <span className="mono">yes</span>, endpoint <span className="mono">outbound_proxy</span> = <span className="mono">sip:proxy.example.com;lr</span>, registration <span className="mono">expiration</span> = <span className="mono">600</span>.</p>
      {confirm && <Confirm title={`Delete ${trunk.name}?`} message="Outside calls through this trunk will stop working." onConfirm={async () => { await api.del(`/api/trunks/${trunk.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}

// ---------------------------------------------------------------- outbound routes
function Routes() {
  const { data, reload } = useData('/api/routes');
  const { data: trunks } = useData('/api/trunks');
  const [editing, setEditing] = useState(null);
  const tname = (id) => trunks?.find((t) => t.id === id)?.name || `#${id}`;
  return (
    <>
      <div className="toolbar"><div className="muted">Which trunk handles each kind of outside call. Routes are tried in priority order.</div><div className="spacer" /><button className="btn primary" onClick={() => setEditing({ name: '', priority: 10, patterns: [], trunk_ids: [], strip: 0, prepend: '' })}><Plus size={16} />Add Route</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={Route} title="No outbound routes" text="A default route is created when you add your first trunk." /> : (
          <table className="t"><thead><tr><th>Priority</th><th>Name</th><th>Dial patterns</th><th>Trunks</th></tr></thead>
            <tbody>{(data || []).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                <td className="num">{r.priority}</td><td style={{ fontWeight: 500 }}>{r.name}</td>
                <td><div className="chips">{r.patterns.map((p) => <span key={p} className="chip mono" style={{ paddingRight: 10 }}>{p}</span>)}</div></td>
                <td>{r.trunk_ids.length ? <span className="muted">{r.trunk_ids.map(tname).join(' → ')}</span> : <span className="badge red">No trunk: calls on this route will fail</span>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <RouteDrawer route={editing} trunks={trunks || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}
function RouteDrawer({ route, trunks, onClose, onSaved }) {
  const isNew = !route.id;
  const [f, set, setF] = useForm({ ...route, patternsText: route.patterns.join('\n') });
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    setErr('');
    try {
      const body = { name: f.name, priority: f.priority, patterns: f.patternsText.split(/[\s,]+/).filter(Boolean), trunk_ids: f.trunk_ids, strip: f.strip, prepend: f.prepend };
      if (isNew) await api.post('/api/routes', body); else await api.put(`/api/routes/${route.id}`, body);
      onSaved();
    } catch (e) { setErr(e.message); }
  };
  const toggleTrunk = (id) => setF({ ...f, trunk_ids: f.trunk_ids.includes(id) ? f.trunk_ids.filter((x) => x !== id) : [...f.trunk_ids, id] });
  return (
    <Drawer title={isNew ? 'Add Outbound Route' : route.name} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      {err && <div className="alert error">{err}</div>}
      <div className="row">
        <Field label="Name"><input type="text" value={f.name} onChange={set('name')} /></Field>
        <Field label="Priority" hint="Lower runs first."><input type="number" value={f.priority} onChange={set('priority')} style={{ maxWidth: 100 }} /></Field>
      </div>
      <Field label="Dial patterns" hint="One per line. X = any digit, N = 2-9, Z = 1-9, . = one or more. Example: _NXXNXXXXXX for 10-digit numbers.">
        <textarea className="mono" rows={6} value={f.patternsText} onChange={set('patternsText')} />
      </Field>
      <Field label="Trunks" hint="Tried in the order you select them.">
        <div className="list-pick">{trunks.map((t) => (
          <label key={t.id}><input type="checkbox" checked={f.trunk_ids.includes(t.id)} onChange={() => toggleTrunk(t.id)} />{t.name}{f.trunk_ids.includes(t.id) && <span className="badge blue" style={{ marginLeft: 'auto' }}>{f.trunk_ids.indexOf(t.id) + 1}</span>}</label>
        ))}</div>
      </Field>
      <div className="row">
        <Field label="Remove leading digits"><input type="number" min="0" value={f.strip} onChange={set('strip')} /></Field>
        <Field label="Add prefix"><input type="text" value={f.prepend} onChange={set('prepend')} /></Field>
      </div>
      {confirm && <Confirm title="Delete route?" message="Calls matching these patterns won't go out." onConfirm={async () => { await api.del(`/api/routes/${route.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}

// ---------------------------------------------------------------- integrations
function Integrations() {
  const { data: hooks, reload } = useData('/api/webhooks');
  const { data: events } = useData('/api/webhooks/events');
  const { data: keys, reload: reloadKeys } = useData('/api/apikeys');
  const [editing, setEditing] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [keyName, setKeyName] = useState('');
  const [delKey, setDelKey] = useState(null);
  const toast = useToast();
  const createKey = async () => {
    try { const k = await api.post('/api/apikeys', { name: keyName }); setNewKey(k); setKeyName(''); reloadKeys(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <>
      <div className="card">
        <div className="card-head"><Webhook size={16} /><h2>Webhooks</h2><div className="spacer" /><button className="btn primary sm" onClick={() => setEditing({ name: '', url: '', events: ['*'], enabled: true })}><Plus size={14} />Add Webhook</button></div>
        {hooks && hooks.length === 0 ? <Empty icon={Webhook} title="No webhooks" text="Send call, voicemail and phone events to another app as they happen." /> : (
          <table className="t"><thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Last delivery</th><th>Status</th></tr></thead>
            <tbody>{(hooks || []).map((h) => (
              <tr key={h.id} className="clickable" onClick={() => setEditing(h)}>
                <td style={{ fontWeight: 500 }}>{h.name}</td><td className="mono muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.url}</td>
                <td className="muted small">{h.events.includes('*') ? 'All events' : `${h.events.length} selected`}</td>
                <td className="muted small">{h.last_delivery ? fmtWhen(h.last_delivery) : '—'}</td>
                <td>{!h.enabled ? <span className="badge">Paused</span> : h.failed ? <span className="badge red">{h.failed} failed</span> : <span className="badge green">Active</span>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><KeyRound size={16} /><h2>API keys</h2></div>
        <div className="card-body">
          <p className="muted small" style={{ marginTop: 0 }}>Other apps use an API key to read users and call history and to start click-to-call. Send it as <span className="mono">Authorization: Bearer &lt;key&gt;</span> to <span className="mono">{window.location.origin}/api/v1</span>.</p>
          {newKey && <div className="alert info" style={{ display: 'block' }}><div style={{ marginBottom: 8 }}>Copy this key now. You won't be able to see it again.</div><CopyField value={newKey.key} /></div>}
          <div className="row" style={{ maxWidth: 480, marginBottom: 14 }}><input type="text" placeholder="Key name, e.g. CRM integration" value={keyName} onChange={(e) => setKeyName(e.target.value)} /><button className="btn" style={{ flex: '0 0 auto' }} disabled={!keyName} onClick={createKey}><Plus size={14} />Create key</button></div>
          {keys?.length > 0 && <table className="t"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
            {keys.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono muted">{k.prefix}…</td><td className="muted small">{fmtWhen(k.created_at)}</td><td className="muted small">{k.last_used ? fmtWhen(k.last_used) : 'Never'}</td><td className="actions"><button className="btn ghost sm icon" onClick={() => setDelKey(k)}><Trash2 size={14} /></button></td></tr>)}
          </tbody></table>}
          <details style={{ marginTop: 16 }}><summary className="small" style={{ cursor: 'pointer' }}>API endpoints</summary>
            <pre className="mono small" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 6, overflowX: 'auto' }}>{`GET  /api/v1/users                     List users and extensions
GET  /api/v1/users/:extension          One user
GET  /api/v1/calls?since=&until=&number=&extension=&status=&limit=
GET  /api/v1/calls/active              Calls in progress
GET  /api/v1/calls/:id                 One call, with its timeline
POST /api/v1/calls                     Click-to-call: {"extension":"101","number":"8605550100"}
GET  /api/v1/voicemail?mailbox=101     Voicemail messages`}</pre>
          </details>
        </div>
      </div>
      {editing && <WebhookDrawer key={editing.id || 'new'} hook={editing} events={events || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} onReopen={(h) => { reload(); setEditing(h); }} />}
      {delKey && <Confirm title={`Revoke "${delKey.name}"?`} message="Apps using this key will stop working immediately." confirmLabel="Revoke" onConfirm={async () => { await api.del(`/api/apikeys/${delKey.id}`); setDelKey(null); reloadKeys(); }} onCancel={() => setDelKey(null)} />}
    </>
  );
}

function WebhookDrawer({ hook, events, onClose, onSaved, onReopen }) {
  const isNew = !hook.id;
  const [f, set, setF] = useForm(hook);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('settings');
  const [confirm, setConfirm] = useState(false);
  const [testing, setTesting] = useState(false);
  const { data: deliveries, reload } = useData(isNew ? null : `/api/webhooks/${hook.id}/deliveries`);
  const [open, setOpen] = useState(null);
  const toast = useToast();
  const all = f.events.includes('*');
  const toggleEvent = (n) => setF({ ...f, events: f.events.includes(n) ? f.events.filter((e) => e !== n) : [...f.events.filter((e) => e !== '*'), n] });
  const save = async () => {
    setErr('');
    try {
      const body = { name: f.name, url: f.url, events: f.events.length ? f.events : ['*'], enabled: f.enabled };
      // A new webhook stays open so its signing secret can be copied right away.
      if (isNew) { onReopen(await api.post('/api/webhooks', body)); toast('Webhook created. Copy the signing secret below.'); return; }
      await api.put(`/api/webhooks/${hook.id}`, body);
      toast('Webhook saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };
  const test = async () => {
    setTesting(true);
    try { const r = await api.post(`/api/webhooks/${hook.id}/test`); toast(r.ok ? `Delivered (HTTP ${r.code})` : `Failed: ${r.code ? `HTTP ${r.code}` : r.body}`, r.ok ? 'ok' : 'error'); reload(); } finally { setTesting(false); }
  };
  return (
    <Drawer title={isNew ? 'Add Webhook' : hook.name} onClose={onClose} width={560} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      {!isNew && <button className="btn" onClick={test} disabled={testing}><Send size={14} />Send test</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      {err && <div className="alert error">{err}</div>}
      {!isNew && <div className="tabs">{[['settings', 'Settings'], ['deliveries', 'Deliveries'], ['verify', 'Verifying requests']].map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>}
      {tab === 'settings' && <>
        <Field label="Name"><input type="text" value={f.name} onChange={set('name')} autoFocus placeholder="My app" /></Field>
        <Field label="Endpoint URL" hint="AsterFi POSTs JSON here for each event."><input type="url" value={f.url} onChange={set('url')} placeholder="https://app.example.com/hooks/asterfi" /></Field>
        <Toggle title="Active" checked={f.enabled} onChange={set('enabled')} />
        {isNew && <div className="alert info">Save to create the webhook. Its signing secret appears here once it's created.</div>}
        {!isNew && <Field label="Signing secret" hint="Your endpoint uses this to verify the X-AsterFi-Signature header."><CopyField value={hook.secret} secret /></Field>}
        {!isNew && <button className="btn sm" style={{ marginBottom: 14 }} onClick={async () => { onReopen(await api.post(`/api/webhooks/${hook.id}/rotate-secret`)); toast('Secret rotated. Update your endpoint with the new one.'); }}><RotateCw size={13} />Rotate secret</button>}
        <div className="section-title">Events</div>
        <Toggle title="Send all events" description="Including event types added in future versions." checked={all} onChange={(v) => setF({ ...f, events: v ? ['*'] : [] })} />
        {!all && <div className="list-pick">{events.map((e) => (
          <label key={e.name}><input type="checkbox" checked={f.events.includes(e.name)} onChange={() => toggleEvent(e.name)} /><div><div className="mono">{e.name}</div><div className="muted small">{e.description}</div></div></label>
        ))}</div>}
      </>}
      {tab === 'deliveries' && (deliveries?.length ? (
        <div className="order-list">{deliveries.map((d) => (
          <div key={d.id}>
            <div className="order-item" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === d.id ? null : d.id)}>
              {d.status === 'success' ? <CheckCircle2 size={15} color="var(--green)" /> : d.status === 'failed' ? <XCircle size={15} color="var(--red)" /> : <Clock size={15} color="var(--amber)" />}
              <span className="n mono">{d.event}</span>
              <span className="muted small">{d.response_code ? `HTTP ${d.response_code}` : d.status}{d.attempts > 1 ? ` · ${d.attempts} tries` : ''}</span>
              <span className="muted small">{fmtWhen(d.created_at)}</span>
            </div>
            {open === d.id && <div style={{ padding: '8px 4px' }}>
              <pre className="mono small" style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 6, overflowX: 'auto', maxHeight: 260 }}>{JSON.stringify(d.payload, null, 2)}</pre>
              {d.response_body && <pre className="mono small muted" style={{ whiteSpace: 'pre-wrap' }}>{d.response_body}</pre>}
              <button className="btn sm" onClick={async () => { await api.post(`/api/deliveries/${d.id}/redeliver`); toast('Queued for redelivery'); setTimeout(reload, 2500); }}><RotateCw size={13} />Redeliver</button>
            </div>}
          </div>
        ))}</div>
      ) : <Empty title="No deliveries yet" text="Use Send test to check the endpoint." />)}
      {tab === 'verify' && <div className="small">
        <Field label="Signing secret"><CopyField value={hook.secret} secret /></Field>
        <p>Every request carries these headers:</p>
        <pre className="mono" style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 6, overflowX: 'auto' }}>{`X-AsterFi-Event: call.ended
X-AsterFi-Delivery: 1234
X-AsterFi-Signature: t=1793108199,v1=<hex>`}</pre>
        <p>To verify, compute HMAC-SHA256 with your signing secret over <span className="mono">{'`${t}.${rawBody}`'}</span> and compare it to <span className="mono">v1</span>. Reject requests where <span className="mono">t</span> is more than 5 minutes old.</p>
        <pre className="mono" style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 6, overflowX: 'auto' }}>{`const [t, v1] = sig.split(',').map(p => p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET)
  .update(\`\${t}.\${rawBody}\`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));`}</pre>
        <p>Return any 2xx status within 10 seconds. Failed deliveries are retried after 30 s, 2 min, 10 min, 30 min and 2 h.</p>
      </div>}
      {confirm && <Confirm title={`Delete ${hook.name}?`} message="Events will stop being sent to this URL." onConfirm={async () => { await api.del(`/api/webhooks/${hook.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}

export { Switch };
