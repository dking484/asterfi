import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useData, useToast, Field, Toggle, CopyField, useForm, PasswordInput } from '../components/ui.jsx';
import { useFieldDefs, CustomFieldInputs } from '../components/CustomFields.jsx';
import { THEMES, currentTheme, saveTheme } from '../theme.jsx';

// Self-service settings for whoever is signed in.
export default function Account() {
  const { data, reload } = useData('/api/my');
  const [f, set, setF] = useForm(null);
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const toast = useToast();
  const { defs } = useFieldDefs();
  useEffect(() => { if (data) setF({ ...data, email: data.email || '', custom: data.custom || {} }); }, [data]);
  if (!f) return null;

  const save = async () => {
    try {
      await api.put('/api/my', { email: f.email, vm_pin: f.vm_pin, notify_voicemail: f.notify_voicemail, notify_missed: f.notify_missed, vm_attach_audio: f.vm_attach_audio, ring_seconds: f.ring_seconds, custom: f.custom });
      toast('Saved'); reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const changePw = async () => {
    if (pw.password !== pw.confirm) return toast("New passwords don't match.", 'error');
    try { await api.post('/api/my/password', pw); setPw({ current: '', password: '', confirm: '' }); toast('Password changed'); } catch (e) { toast(e.message, 'error'); }
  };
  const dnd = async (v) => { setF({ ...f, dnd: v }); await api.post('/api/my/dnd', { dnd: v }); toast(v ? 'Do not disturb on' : 'Do not disturb off'); };

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="card"><div className="card-head"><h2>{f.first_name} {f.last_name}</h2><span className="badge">Ext. {f.extension}</span></div><div className="card-body">
          <Toggle title="Do not disturb" description="Your phones won't ring. You can also dial *76." checked={f.dnd} onChange={dnd} />
          <Forwarding initial={f.forward} />
          <Field label="Email" hint="Used to sign in and for notifications."><input type="email" value={f.email} onChange={set('email')} /></Field>
          <div className="row">
            <Field label="Voicemail PIN" hint="Dial *97 to check messages."><input type="text" inputMode="numeric" value={f.vm_pin} onChange={set('vm_pin')} /></Field>
            <Field label="Ring for (seconds)"><input type="number" min="5" max="120" value={f.ring_seconds} onChange={set('ring_seconds')} /></Field>
          </div>
          <CustomFieldInputs title="Profile" defs={defs.filter((d) => d.users)} values={f.custom} readOnly={(d) => !d.user_editable} onChange={(c) => setF({ ...f, custom: c })} />
          <div className="section-title">Email me</div>
          <Toggle title="New voicemails" checked={f.notify_voicemail} onChange={set('notify_voicemail')} />
          {f.notify_voicemail && <Toggle title="Attach the recording" checked={f.vm_attach_audio} onChange={set('vm_attach_audio')} />}
          <Toggle title="Missed calls" checked={f.notify_missed} onChange={set('notify_missed')} />
          <button className="btn primary" onClick={save}>Save</button>
        </div></div>
        <Appearance />
        <div className="card" style={{ marginTop: 16 }}><div className="card-head"><h2>Change password</h2></div><div className="card-body">
          <Field label="Current password"><PasswordInput autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <div className="row">
            <Field label="New password"><PasswordInput autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
            <Field label="Confirm"><PasswordInput autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          </div>
          <button className="btn" disabled={!pw.current || !pw.password} onClick={changePw}>Change password</button>
        </div></div>
      </div>
      <div className="card"><div className="card-head"><h2>Phone setup</h2></div><div className="card-body">
        <p className="muted small" style={{ marginTop: 0 }}>Use these to sign in a desk phone or softphone app.</p>
        <Field label="Server"><CopyField value={window.location.hostname} /></Field>
        <Field label="Username / extension"><CopyField value={f.extension} /></Field>
        <Field label="SIP password"><CopyField value={f.sip_password} secret /></Field>
        <p className="muted small">On a UniFi Talk Gen 3 phone, choose Third-Party PBX, then Manual Configuration, and enter the server as Host and Proxy, your extension as Register name, and the SIP password.</p>
      </div></div>
    </div>
  );
}

// Theme picker; the change shows right away and is saved to this user.
function Appearance() {
  const [theme, setTheme] = useState(currentTheme);
  const toast = useToast();
  const pick = async (id) => {
    setTheme(id);
    try { await saveTheme(id); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}><div className="card-head"><h2>Appearance</h2></div><div className="card-body">
      <div className="theme-picks">
        {THEMES.map((t) => (
          <button key={t.id} type="button" className={`theme-pick ${theme === t.id ? 'on' : ''}`} onClick={() => pick(t.id)} aria-pressed={theme === t.id}>
            <div className="sw">
              <i style={{ background: t.swatch.nav }} />
              <b style={{ background: t.swatch.bg }}>
                <span style={{ background: t.swatch.bar, width: '60%' }} />
                <span style={{ background: t.swatch.line }} />
                <span style={{ background: t.swatch.line, width: '75%' }} />
              </b>
            </div>
            {t.label}
          </button>
        ))}
      </div>
    </div></div>
  );
}

// Call forwarding; the same setting as Redirect on a UniFi phone's status menu.
function Forwarding({ initial }) {
  const [fw, setFw] = useState({ number: initial?.number || '', on: !!initial?.on });
  const toast = useToast();
  const save = async (next) => {
    try {
      const r = await api.post('/api/my/forward', next);
      setFw({ number: r.number || next.number, on: r.on });
      toast(r.on ? `Calls forward to ${r.number}` : 'Call forwarding off');
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <>
      <Toggle title="Forward my calls" description="Calls to your extension ring this number instead. Ring group calls still ring your phones." checked={fw.on}
        onChange={(on) => save({ ...fw, on })} />
      <Field label="Forward to" hint="An outside number or another extension.">
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="tel" value={fw.number} placeholder="(860) 555-0100" onChange={(e) => setFw({ ...fw, number: e.target.value })} />
          <button className="btn" onClick={() => save(fw)}>Save</button>
        </div>
      </Field>
    </>
  );
}
