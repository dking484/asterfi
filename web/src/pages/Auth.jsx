import { useState } from 'react';
import { BrandLogo } from '../theme.jsx';
import { api } from '../api.js';
import { Field, PasswordInput } from '../components/ui.jsx';

const ZONES = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['America/New_York'];

export function Login({ siteName, onDone }) {
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.post('/api/login', f); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  if (forgot) return <ForgotPassword siteName={siteName} onBack={() => setForgot(false)} />;
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <BrandLogo />
        <h1>Sign in to {siteName || 'AsterFi'}</h1>
        <p>Check voicemail, call history and your phone settings.</p>
        {err && <div className="alert error">{err}</div>}
        <Field label="Email or extension"><input type="text" autoFocus autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Password"><PasswordInput autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 38 }} disabled={busy}>Sign in</button>
        <button type="button" className="btn ghost sm" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={() => setForgot(true)}>Forgot password?</button>
      </form>
    </div>
  );
}

function ForgotPassword({ siteName, onBack }) {
  const [step, setStep] = useState(1); // 1 = enter email, 2 = enter code + new password
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState({ password: '', confirm: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.post('/api/forgot', { email }); setStep(2); setMsg(`If an account uses ${email}, a reset code is on its way. Enter it below.`); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const reset = async (e) => {
    e.preventDefault();
    if (pw.password !== pw.confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr('');
    try { await api.post('/api/reset', { email, code, password: pw.password }); setStep(3); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={step === 1 ? request : reset}>
        <BrandLogo />
        <h1>Reset your password</h1>
        {err && <div className="alert error">{err}</div>}
        {step === 1 && <>
          <p>Enter your account email and we'll send a reset code.</p>
          <Field label="Email"><input type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 38 }} disabled={busy || !email}>Send reset code</button>
        </>}
        {step === 2 && <>
          {msg && <div className="alert info">{msg}</div>}
          <Field label="Reset code"><input type="text" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" /></Field>
          <Field label="New password"><PasswordInput autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
          <Field label="Confirm new password"><PasswordInput autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 38 }} disabled={busy || !code || !pw.password}>Set new password</button>
        </>}
        {step === 3 && <div className="alert info">Your password has been reset. You can sign in now.</div>}
        <button type="button" className="btn ghost sm" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={onBack}>Back to sign in</button>
      </form>
    </div>
  );
}

export function Setup({ onDone }) {
  const [f, setF] = useState({
    siteName: 'AsterFi', first_name: '', last_name: '', email: '', extension: '101', password: '', confirm: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setErr("Passwords don't match.");
    setBusy(true); setErr('');
    try { await api.post('/api/setup', f); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit} style={{ width: 460 }}>
        <BrandLogo />
        <h1>Welcome to AsterFi</h1>
        <p>Name your phone system and set up the first user. They become the administrator.</p>
        {err && <div className="alert error">{err}</div>}
        <div className="row">
          <Field label="System name"><input type="text" value={f.siteName} onChange={set('siteName')} /></Field>
          <Field label="Time zone"><select value={f.timezone} onChange={set('timezone')}>{ZONES.map((z) => <option key={z}>{z}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="First name"><input type="text" value={f.first_name} onChange={set('first_name')} /></Field>
          <Field label="Last name"><input type="text" value={f.last_name} onChange={set('last_name')} /></Field>
        </div>
        <div className="row">
          <Field label="Email" hint="You'll sign in with this."><input type="email" value={f.email} onChange={set('email')} autoComplete="username" /></Field>
          <Field label="Your extension"><input type="text" inputMode="numeric" value={f.extension} onChange={set('extension')} style={{ maxWidth: 110 }} /></Field>
        </div>
        <div className="row">
          <Field label="Password"><PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
          <Field label="Confirm"><PasswordInput value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
        </div>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 38 }} disabled={busy}>Get started</button>
      </form>
    </div>
  );
}
