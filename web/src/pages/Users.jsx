import { useCallback, useMemo, useState } from 'react';
import { Plus, Search, Users as UsersIcon, RefreshCw, Trash2, KeyRound, Mail } from 'lucide-react';
import { api, fullName, formatNumber } from '../api.js';
import { useData, useToast, useLiveEvents, Drawer, Confirm, Field, Toggle, Avatar, Empty, CopyField, useForm, PasswordInput } from '../components/ui.jsx';
import { useDirectory, DestinationPicker, describeDest } from '../components/Destination.jsx';
import { useFieldDefs, CustomFieldInputs } from '../components/CustomFields.jsx';
import { usePresence, PresenceBadge } from '../components/Presence.jsx';

// Easy-to-read random password (no 0/O, 1/l/I).
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => PW_CHARS[b % PW_CHARS.length]).join('');

const NEW_USER = {
  role: 'user', password: '', first_name: '', last_name: '', email: '', extension: '', outbound_cid: '', ring_seconds: 25,
  vm_enabled: true, vm_pin: String(Math.floor(1000 + Math.random() * 9000)), notify_voicemail: true, notify_missed: true,
  vm_attach_audio: true, noanswer_dest: { type: 'voicemail' }, max_devices: 5,
};

export default function Users({ me }) {
  const { data: users, reload } = useData('/api/users');
  const { data: phones, reload: reloadPhones } = useData('/api/phones');
  const presence = usePresence();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const dir = useDirectory();
  useLiveEvents(useCallback(() => { reloadPhones(); }, [reloadPhones]), ['phone.']);

  const online = useMemo(() => new Set((phones || []).filter((p) => p.online).map((p) => p.extension)), [phones]);
  const rows = (users || []).filter((u) => `${fullName(u)} ${u.extension} ${u.email || ''}`.toLowerCase().includes(search.toLowerCase()));
  const done = () => { setEditing(null); reload(); dir.refresh(); };

  return (
    <>
      <div className="toolbar">
        <div className="search"><Search size={15} /><input type="search" placeholder="Search users" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ ...NEW_USER })}><Plus size={16} />Add User</button>
      </div>
      <div className="card">
        {users && users.length === 0 ? (
          <Empty icon={UsersIcon} title="No users yet" text="Each user gets an extension, voicemail and email notifications." action={<button className="btn primary" onClick={() => setEditing({ ...NEW_USER })}><Plus size={16} />Add User</button>} />
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Status</th><th>Extension</th><th>Email</th><th>Role</th><th>Phones</th><th>When unanswered</th><th>Notifications</th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="clickable" onClick={() => setEditing(u)}>
                  <td><div className="person"><Avatar name={fullName(u)} /><div className="n">{fullName(u)}</div></div></td>
                  <td><PresenceBadge p={presence[u.extension]} /></td>
                  <td className="num">{u.extension}</td>
                  <td className="muted">{u.email || '—'}</td>
                  <td>{u.role === 'admin' ? <span className="badge blue">Administrator</span> : u.has_login ? <span className="badge">User</span> : <span className="muted small">No sign-in</span>}</td>
                  <td>{online.has(u.extension) ? <span className="badge green"><span className="dot green" />{(phones || []).filter((p) => p.extension === u.extension && p.online).length} online</span> : <span className="badge"><span className="dot" />Offline</span>}</td>
                  <td className="muted">{u.noanswer_dest?.type === 'voicemail' && !u.noanswer_dest?.target ? (u.vm_enabled ? 'Voicemail' : 'Hang up') : describeDest(u.noanswer_dest, dir)}</td>
                  <td className="muted small">{[u.notify_voicemail && u.email && 'Voicemail', u.notify_missed && u.email && 'Missed calls'].filter(Boolean).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
      {editing && <UserDrawer me={me} user={editing} dnd={presence[editing.extension]?.status === 'dnd'} phones={(phones || []).filter((p) => p.extension === editing.extension)} onClose={() => setEditing(null)} onSaved={done} />}
    </>
  );
}

function UserDrawer({ me, user, dnd, phones, onClose, onSaved }) {
  const isNew = !user.id;
  const [f, set, setF] = useForm({ ...user, email: user.email || '', outbound_cid: user.outbound_cid || '', custom: user.custom || {}, password: '', clear_login: false, send_login: false });
  const [generated, setGenerated] = useState(0);
  const { defs } = useFieldDefs();
  const [tab, setTab] = useState('general');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [dndOn, setDnd] = useState(dnd);
  const toast = useToast();

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...f };
      for (const k of ['id', 'created_at', 'has_login', 'last_login']) delete body[k];
      if (body.send_login && !body.password && !body.clear_login) body.password = randomPassword();
      if (!body.password) delete body.password;
      if (body.clear_login || !body.email) delete body.send_login;
      if (isNew && !body.extension) delete body.extension;
      if (body.noanswer_dest?.type === 'voicemail-self') body.noanswer_dest = { type: 'voicemail' };
      const r = isNew ? await api.post('/api/users', body) : await api.put(`/api/users/${user.id}`, body);
      if (r.login_email === 'sent') toast(`${isNew ? 'User added' : 'User saved'}. Sign-in details emailed to ${r.email}.`);
      else if (r.login_email === 'failed') toast(`${isNew ? 'User added' : 'User saved'}, but the email didn't send: ${r.login_email_error}. Their password is ${body.password}.`, 'error');
      else toast(isNew ? 'User added' : 'User saved');
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async () => { await api.del(`/api/users/${user.id}`); toast('User deleted'); onSaved(); };
  const toggleDnd = async (v) => { setDnd(v); await api.post(`/api/users/${user.id}/dnd`, { dnd: v }); toast(v ? 'Do not disturb on' : 'Do not disturb off'); };
  const host = window.location.hostname;
  const nd = f.noanswer_dest?.type === 'voicemail' && !f.noanswer_dest?.target ? { type: 'voicemail-self' } : f.noanswer_dest;

  return (
    <Drawer title={isNew ? 'Add User' : fullName(user)} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={busy}>{isNew ? 'Add User' : 'Save'}</button>
    </>}>
      {err && <div className="alert error">{err}</div>}
      {!isNew && (
        <div className="tabs">
          {[['general', 'General'], ['voicemail', 'Voicemail & Alerts'], ['phone', 'Phone Setup']].map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      )}

      {(isNew || tab === 'general') && <>
        <div className="row">
          <Field label="First name"><input type="text" value={f.first_name} onChange={set('first_name')} autoFocus /></Field>
          <Field label="Last name"><input type="text" value={f.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="Email" hint="Used to sign in and for voicemail and missed-call emails."><input type="email" value={f.email} onChange={set('email')} /></Field>
        <div className="row">
          <Field label="Extension" hint={isNew ? 'Leave blank to pick the next free one.' : null}><input type="text" inputMode="numeric" value={f.extension} onChange={set('extension')} /></Field>
          <Field label="Ring for (seconds)"><input type="number" min="5" max="120" value={f.ring_seconds} onChange={set('ring_seconds')} /></Field>
        </div>
        <Field label="Outbound caller ID" hint="Number shown when this user calls out. Blank uses the trunk default."><input type="text" value={f.outbound_cid} onChange={set('outbound_cid')} placeholder="(860) 555-0100" /></Field>
        <Field label="If not answered">
          <DestinationPicker value={nd} selfVoicemail onChange={(d) => setF({ ...f, noanswer_dest: d.type === 'voicemail-self' ? { type: 'voicemail' } : d })} />
        </Field>
        <CustomFieldInputs title="Profile" defs={defs.filter((d) => d.users)} values={f.custom} onChange={(c) => setF((cur) => ({ ...cur, custom: c }))} />
        <div className="section-title">Sign-in & role</div>
        <Field label="Role" hint={f.role === 'admin' ? 'Can manage everything in this console.' : 'Can see only their own voicemail, call history and settings.'}>
          <select value={f.role} onChange={set('role')} disabled={me && user.id === me.id}>
            <option value="user">User</option><option value="admin">Administrator</option>
          </select>
        </Field>
        {!f.clear_login && <Field label={user.has_login ? 'New password' : 'Password'} hint={user.has_login ? 'Leave blank to keep their current password.' : "Leave blank if they don't need to sign in. They sign in with their email or extension."}>
          <div style={{ display: 'flex', gap: 8 }}>
            <PasswordInput autoComplete="new-password" value={f.password} onChange={set('password')} reveal={generated} />
            <button type="button" className="btn" style={{ flexShrink: 0 }} onClick={() => { setF((cur) => ({ ...cur, password: randomPassword() })); setGenerated((n) => n + 1); }}><KeyRound size={14} />Generate</button>
          </div>
        </Field>}
        {!f.clear_login && <Toggle title={<><Mail size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Email sign-in details</>}
          description={!f.email ? 'Add an email address above to send them.'
            : f.password ? `When you save, ${f.email} gets the sign-in page, their username, this password, extension, voicemail PIN and SIP details.`
            : user.has_login ? `Generates a new password when you save (replacing their current one) and emails it to ${f.email} with the rest of their login details.`
            : `Generates a password when you save and emails it to ${f.email} with the rest of their login details.`}
          checked={!!f.email && f.send_login} onChange={set('send_login')} />}
        {user.has_login && !(me && user.id === me.id) && <Toggle title="Remove sign-in" description="They keep their phone and voicemail but can't open this console." checked={f.clear_login} onChange={set('clear_login')} />}
        {!isNew && <Toggle title="Do not disturb" description="Calls skip this user's phones. Users can also dial *76." checked={dndOn} onChange={toggleDnd} />}
        {isNew && <>
          <div className="section-title">Notifications</div>
          <Toggle title="Email new voicemails" checked={f.notify_voicemail} onChange={set('notify_voicemail')} />
          <Toggle title="Email missed calls" checked={f.notify_missed} onChange={set('notify_missed')} />
        </>}
      </>}

      {!isNew && tab === 'voicemail' && <>
        <Toggle title="Voicemail" description="Callers can leave a message when this user doesn't answer." checked={f.vm_enabled} onChange={set('vm_enabled')} />
        {f.vm_enabled && <Field label="Voicemail PIN" hint="Dial *97 from your phone to check messages."><input type="text" inputMode="numeric" value={f.vm_pin} onChange={set('vm_pin')} /></Field>}
        <div className="section-title">Email notifications</div>
        {!f.email && <div className="alert warn">Add an email address on the General tab to receive notifications.</div>}
        <Toggle title="New voicemail" description="Includes caller, time and length." checked={f.notify_voicemail} onChange={set('notify_voicemail')} />
        {f.notify_voicemail && <Toggle title="Attach the recording" description="Adds the message as an MP3." checked={f.vm_attach_audio} onChange={set('vm_attach_audio')} />}
        <Toggle title="Missed calls" description="Sent when a call rings this user and nobody answers (and no voicemail is left)." checked={f.notify_missed} onChange={set('notify_missed')} />
      </>}

      {!isNew && tab === 'phone' && <>
        <div className="section-title">Registered phones</div>
        {phones.length === 0 ? <p className="muted">No phones are signed in as this user.</p> : phones.map((p) => (
          <div key={p.uri} className="order-item" style={{ marginBottom: 6 }}>
            <span className={`dot ${p.online ? 'green' : 'red'}`} />
            <div className="n"><div>{p.userAgent || 'SIP device'}</div><div className="muted small mono">{p.uri.replace(/^sip:/, '').split(';')[0]}</div></div>
            {p.rttMs != null && <span className="muted small">{p.rttMs} ms</span>}
          </div>
        ))}
        <div className="section-title">SIP credentials</div>
        <p className="muted small" style={{ marginTop: 0 }}>Use these to sign in a desk phone or softphone.</p>
        <Field label="Server"><CopyField value={host} /></Field>
        <Field label="Username / extension"><CopyField value={user.extension} /></Field>
        <Field label="Password"><CopyField value={f.sip_password} secret /></Field>
        <details className="card" style={{ padding: '10px 14px', marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Third-generation UniFi Talk phone (G3 Touch Pro / Enterprise / Wall)</summary>
          <p className="muted small" style={{ margin: '8px 0 0' }}>Only third-generation (G3) Talk phones can register directly to a SIP PBX. If the phone's screen offers a <b>Third-Party PBX</b> option, use it:</p>
          <ol className="small" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
            <li>Factory-reset the phone and power it on.</li>
            <li>On its screen choose <b>Third-Party PBX</b> and let it update, then tap <b>Manual Configuration</b>.</li>
            <li>Enter <b>Host</b> and <b>Proxy</b>: <span className="mono">{host}</span>, <b>Register name</b>: <span className="mono">{user.extension}</span>, <b>Password</b>: the SIP password above. Port 5060, UDP.</li>
            <li>The status bar turns green once it registers, and the phone appears above.</li>
          </ol>
        </details>
        <details className="card" style={{ padding: '10px 14px', marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Older UniFi Talk phone (UVP-Touch, Touch Max, …)</summary>
          <p className="small" style={{ margin: '8px 0 0' }}>These phones have no manual SIP setup — they only work when adopted. Factory-reset the phone, then adopt it in <b>Phones → UniFi Devices</b> and assign it to this user; AsterFi provisions its SIP account and it registers automatically.</p>
        </details>
        <button className="btn sm" onClick={() => setF({ ...f, sip_password: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('') })}><RefreshCw size={13} />Generate new password</button>
        <p className="muted small">Saving a new password signs out phones using the old one.</p>
        <Field label="Max phones at once"><input type="number" min="1" max="10" value={f.max_devices} onChange={set('max_devices')} /></Field>
        <PhonebookUrls userId={user.id} host={host} />
      </>}

      {confirm && <Confirm title={`Delete ${fullName(user)}?`} message={`Extension ${user.extension} will stop working and its voicemail box is removed. This can't be undone.`} onConfirm={del} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}

// Remote phonebook URLs for standard SIP desk phones: the user's coworkers, groups and their own contacts.
function PhonebookUrls({ userId, host }) {
  const { data, reload } = useData(`/api/users/${userId}/phonebook`);
  const toast = useToast();
  const rotate = async () => { await api.post(`/api/users/${userId}/phonebook/rotate`); reload(); toast('New phonebook link created. Update the phones that use it.'); };
  if (!data?.token) return null;
  const base = `http://${host}/phonebook/${data.token}`;
  return <>
    <div className="section-title">Phone directory</div>
    <p className="muted small" style={{ marginTop: 0 }}>Adopted UniFi Talk phones get the directory automatically. For other desk phones, enter the link for the phone's brand as its remote phonebook. It lists coworkers, ring groups and this user's contacts.</p>
    <Field label="Yealink" hint="Directory → Remote Phone Book → Remote URL."><CopyField value={`${base}/yealink.xml`} /></Field>
    <Field label="Grandstream" hint="Phonebook → Download via HTTP; server path is this link (the phone adds phonebook.xml)."><CopyField value={`${host}/phonebook/${data.token}/gs`} /></Field>
    <Field label="Cisco, Fanvil, Snom, Htek and others" hint="Any phone that reads a CiscoIPPhoneDirectory XML phonebook."><CopyField value={`${base}/cisco.xml`} /></Field>
    <button className="btn sm" onClick={rotate}><RefreshCw size={13} />New link</button>
    <p className="muted small">Anyone with the link can read this directory. A new link stops the old one working.</p>
  </>;
}

export { formatNumber };
