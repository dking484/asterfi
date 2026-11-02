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

export function fmtWhen(d) {
  if (!d) return '';
  const t = new Date(d);
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (t.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${t.toLocaleDateString([], { month: 'short', day: 'numeric', year: t.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

export const fullName = (u) => `${u?.first_name || ''} ${u?.last_name || ''}`.trim();
