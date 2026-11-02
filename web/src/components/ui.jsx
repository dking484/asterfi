import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { X, Copy, Check, Inbox, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';

// ---- data loading ------------------------------------------------------
export function useData(url, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try { setData(await api.get(url)); setError(null); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [url]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

// Live server events (SSE) with a single shared connection.
const listeners = new Set();
let es = null;
export function useLiveEvents(handler, events) {
  useEffect(() => {
    const l = { handler, events };
    listeners.add(l);
    if (!es) {
      es = new EventSource('/api/stream');
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data);
        for (const x of listeners) if (!x.events || x.events.some((p) => ev.event.startsWith(p))) x.handler(ev);
      };
    }
    return () => { listeners.delete(l); if (!listeners.size && es) { es.close(); es = null; } };
  }, [handler, events?.join(',')]);
}

// ---- toasts ------------------------------------------------------------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, message, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}</div>
    </ToastCtx.Provider>
  );
}

// ---- overlays ----------------------------------------------------------
export function Drawer({ title, onClose, children, footer, width }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" style={width ? { width } : undefined}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Confirm({ title, message, confirmLabel = 'Delete', danger = true, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="drawer-backdrop" style={{ zIndex: 89 }} onClick={onCancel} />
      <div className="modal" role="dialog">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="btns">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}

// ---- form bits ---------------------------------------------------------
export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Toggle({ title, description, checked, onChange }) {
  return (
    <div className="check" onClick={() => onChange(!checked)}>
      <div style={{ flex: 1 }}>
        <div className="t">{title}</div>
        {description && <div className="d">{description}</div>}
      </div>
      <div onClick={(e) => e.stopPropagation()}><Switch checked={checked} onChange={onChange} /></div>
    </div>
  );
}

// Read-only value with a copy button. Secrets stay hidden until the eye button is pressed (copy works either way).
export function CopyField({ value, mono = true, secret = false }) {
  const [ok, setOk] = useState(false);
  const [shown, setShown] = useState(!secret);
  return (
    <div className="secret">
      <code className={mono ? 'mono' : ''}>{shown ? value : '•'.repeat(Math.min(String(value || '').length || 8, 24))}</code>
      {secret && <button type="button" className="btn sm icon" title={shown ? 'Hide' : 'Show'} aria-label={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)}>{shown ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
      <button type="button" className="btn sm icon" title="Copy" onClick={() => {
        navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); });
      }}>{ok ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
  );
}

export function Empty({ icon: Icon = Inbox, title, text, action }) {
  return (
    <div className="empty">
      <Icon size={40} strokeWidth={1.5} />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

const COLORS = ['#006fff', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#22c55e', '#eab308', '#6366f1', '#ef4444', '#0ea5e9'];
export function Avatar({ name, size = 32 }) {
  const n = String(name || '?').trim();
  const initials = n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return <div className="avatar" style={{ background: COLORS[h % COLORS.length], width: size, height: size, fontSize: size * 0.4 }}>{initials}</div>;
}

export function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((o) => <button key={o.value} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

// Shared form-state helper for drawers.
export function useForm(initial) {
  const [form, setForm] = useState(initial);
  // Accepts an input change event or a plain value. Check for a real event (nativeEvent), not just a
  // `target` key: destinations like {type: 'user', target: '101'} have one too.
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.nativeEvent ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  return [form, set, setForm];
}

// Password box with an eye button to show what was typed. reveal: show the text (e.g. after generating one).
export function PasswordInput({ reveal, ...props }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { if (reveal) setShown(true); }, [reveal]);
  return (
    <div className="pw-input">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button type="button" className="btn ghost sm icon" tabIndex={-1} title={shown ? 'Hide password' : 'Show password'} aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
