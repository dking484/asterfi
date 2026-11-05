export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function request(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (r.status === 401 && !url.startsWith('/api/login')) window.dispatchEvent(new Event('asterfi:unauthorized'));
  if (!r.ok) throw new ApiError(r.status, data?.error || r.statusText, data);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, file) => { const f = new FormData(); f.append('file', file); return request('POST', u, f); },
};

export function formatNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return n || '';
}

export function fmtDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Times show in the PBX's time zone (Settings > General), not the viewer's, so "today" matches the
// dashboard's statistics. Set from /api/me once signed in; until then the browser's zone is used.
let pbxZone;
export const setTimeZone = (z) => { pbxZone = z || undefined; };
// "2026-11-05" for the day `d` falls on in the PBX's time zone.
export const dayKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: pbxZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
export const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: pbxZone });
export const fmtDate = (d, opts = { dateStyle: 'medium' }) => new Date(d).toLocaleDateString([], { ...opts, timeZone: pbxZone });

export function fmtWhen(d) {
  if (!d) return '';
  const t = new Date(d);
  const today = dayKey();
  const [y, m, dd] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
  const day = dayKey(t);
  const time = fmtTime(t);
  if (day === today) return `Today ${time}`;
  if (day === yesterday) return `Yesterday ${time}`;
  return `${fmtDate(t, { month: 'short', day: 'numeric', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' })} ${time}`;
}

export const fullName = (u) => `${u?.first_name || ''} ${u?.last_name || ''}`.trim();
