// API used by the AsterFi web UI. Everything requires a signed-in user except setup/login.
// Users with role "user" only reach the self-service routes in USER_ROUTES; the rest need "admin".
import { randomBytes } from 'node:crypto';
import { q, one, getSetting, setSetting } from '../db.js';
import { hashPassword, verifyPassword, createSession, sessionUser, findLogin, SESSION_COOKIE, newApiKey, randomSecret, sha256 } from '../auth.js';
import { scheduleApply, applyNow } from '../asterisk/generate.js';
import { normalizeNumber, extSafe } from '../asterisk/dest.js';
import { validateFlow, RECORDINGS } from '../asterisk/ivr.js';
import { fieldDefs, saveFieldDefs, mergeCustom, visibleCustom } from '../customfields.js';
import { activeCalls, activeCallsFor, invalidateUserCache } from '../calltracker.js';
import { listMessages, findMessage, transcode, deleteMessage, markHeard, transcribeVoicemail } from '../voicemail.js';
import { sttSettings, STT_MODELS } from '../stt.js';
import { host as sysHost, performance as sysPerformance, storage as sysStorage, versions as sysVersions } from '../system.js';
import { updateStatus } from '../updates.js';
import { annotate as annotateCompat } from '../compat.js';
import { sendTestEmail, sendLoginDetailsEmail } from '../notify/email.js';
import { sendTest, redeliver } from '../notify/webhooks.js';
import { bus, EVENT_TYPES } from '../events.js';
import { saveUpload, saveTts, removePrompt, promptFile, renderTts, KOKORO_VOICES, kokoroAvailable } from '../prompts.js';
import { tmpdir } from 'node:os';
import { scan as unifiScan, reprovisionDevice, scheduleDirectoryPush, pushUserState } from '../unifi/listener.js';
import { phonebookToken } from './phonebook.js';
import { setInform, localAddressFor } from '../unifi/setinform.js';
import { registrationState, REASON_HELP } from '../trunkstatus.js';
import { readdir, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { CONTACT_QUERY } from '../directory.js';
import { getForward, setForward } from '../forward.js';
import { clickToCall } from '../clicktocall.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const notFound = () => new HttpError(404, 'Not found');

const RESERVED = /^(\*|#)/;
async function assertExtensionFree(ext, { table, id } = {}) {
  if (!/^[0-9]{2,6}$/.test(ext || '')) throw bad('Extension must be 2 to 6 digits.');
  if (RESERVED.test(ext)) throw bad('That extension is reserved.');
  const hits = await q(
    `SELECT 'users' t, id FROM users WHERE extension=$1
     UNION ALL SELECT 'ring_groups', id FROM ring_groups WHERE extension=$1
     UNION ALL SELECT 'call_flows', id FROM call_flows WHERE extension=$1`, [ext]);
  if (hits.some((h) => !(h.t === table && h.id === Number(id)))) throw bad(`Extension ${ext} is already in use.`);
}

const DEST_TYPES = ['user', 'group', 'flow', 'voicemail', 'external', 'hangup'];
function cleanDest(d, fallback = { type: 'hangup' }) {
  if (!d || !DEST_TYPES.includes(d.type)) return fallback;
  return d.type === 'hangup' ? { type: 'hangup' } : { type: d.type, target: String(d.target ?? '') };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

async function update(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return one(`SELECT * FROM ${table} WHERE id=$1`, [id]);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const row = await one(`UPDATE ${table} SET ${sets} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => fields[k])]);
  if (!row) throw notFound();
  return row;
}
async function insert(table, fields) {
  const keys = Object.keys(fields);
  return one(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map((k) => fields[k]));
}
async function remove(table, id) {
  const r = await q(`DELETE FROM ${table} WHERE id=$1 RETURNING id`, [id]);
  if (!r.length) throw notFound();
}

export default async function adminRoutes(app, { ami }) {
  app.setErrorHandler((err, req, reply) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 && !err.status ? 'Internal error' : err.message });
  });

  // --- auth -------------------------------------------------------------
  const OPEN = ['/api/setup', '/api/login', '/api/setup/status', '/api/forgot', '/api/reset'];
  // What a non-admin user may call: their own account, voicemail and calls, plus a name directory.
  const USER_ROUTES = [/^GET \/api\/me$/, /^POST \/api\/logout$/, /^(GET|PUT) \/api\/my$/, /^POST \/api\/my\/(dnd|password|call)$/, /^GET \/api\/my\/dashboard$/, /^GET \/api\/my\/webphone$/,
    /^GET \/api\/stream$/, /^GET \/api\/calls$/, /^GET \/api\/calls\/[\d.]+\/recording$/, /^(GET|POST) \/api\/contacts$/, /^GET \/api\/contact-fields$/, /^(PUT|DELETE) \/api\/contacts\/\d+$/, /^GET \/api\/users$/, /^GET \/api\/groups$/, /^GET \/api\/presence$/,
    /^(GET|POST|DELETE) \/api\/voicemail(\/|$)/];
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/v1/') || OPEN.includes(path)) return;
    const user = await sessionUser(req.cookies[SESSION_COOKIE]);
    if (!user) throw new HttpError(401, 'Not signed in');
    req.user = user;
    req.isAdmin = user.role === 'admin';
    if (!req.isAdmin && !USER_ROUTES.some((r) => r.test(`${req.method} ${path}`))) throw new HttpError(403, 'Administrators only');
  });

  // Phones show coworkers, groups and contacts, so any change to those refreshes the UniFi phones' directories.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400 && /^\/api\/(contacts|users|groups)(\/|$|\?)/.test(req.url)) scheduleDirectoryPush();
  });

  // Remote phonebook URL token for a user's standard SIP phones (see routes/phonebook.js).
  app.get('/api/users/:id/phonebook', async (req) => ({ token: await phonebookToken(Number(req.params.id)) }));
  app.post('/api/users/:id/phonebook/rotate', async (req) => ({ token: await phonebookToken(Number(req.params.id), { rotate: true }) }));

  const setCookie = (reply, s) => reply.setCookie(SESSION_COOKIE, s.token, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge: s.maxAge, secure: 'auto',
  });
  const adminCount = async () => (await one(`SELECT count(*)::int n FROM users WHERE role='admin' AND password_hash IS NOT NULL`)).n;

  app.get('/api/setup/status', async () => {
    const g = await getSetting('general');
    return { needsSetup: (await adminCount()) === 0, siteName: g.siteName };
  });

  // First run: the first person becomes an admin user with an extension of their own.
  app.post('/api/setup', async (req, reply) => {
    if ((await adminCount()) > 0) throw bad('Setup is already complete.');
    const { first_name, last_name, email, extension, password, siteName, timezone } = req.body || {};
    if (!String(first_name || '').trim()) throw bad('First name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw bad('A valid email address is required.');
    if (!password || password.length < 8) throw bad('Password must be at least 8 characters.');
    await assertExtensionFree(String(extension || ''));
    const u = await insert('users', {
      extension: String(extension), first_name: first_name.trim(), last_name: String(last_name || '').trim(), email: email.trim(),
      sip_password: randomSecret(16), role: 'admin', password_hash: await hashPassword(password),
    });
    const g = await getSetting('general');
    await setSetting('general', { ...g, siteName: siteName || g.siteName, timezone: timezone || g.timezone });
    invalidateUserCache();
    await scheduleApply();
    setCookie(reply, await createSession(u.id));
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const u = await findLogin(username);
    if (!u || !(await verifyPassword(String(password || ''), u.password_hash))) {
      await new Promise((r) => setTimeout(r, 600));
      throw new HttpError(401, 'Incorrect email/extension or password.');
    }
    await q('UPDATE users SET last_login=now() WHERE id=$1', [u.id]);
    setCookie(reply, await createSession(u.id));
    return { ok: true };
  });

  // Forgot password: email a 6-digit code. Always responds ok so it can't be used to probe for accounts.
  app.post('/api/forgot', async (req) => {
    const email = String(req.body?.email || '').trim();
    const u = email && await one('SELECT id, email, first_name, password_hash FROM users WHERE lower(email)=lower($1)', [email]);
    if (u && u.email && u.password_hash) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await q('DELETE FROM password_resets WHERE user_id=$1', [u.id]);
      await q("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1,$2, now() + interval '15 minutes')", [u.id, sha256(code)]);
      const { sendPasswordResetEmail } = await import('../notify/email.js');
      sendPasswordResetEmail(u, code).catch((e) => console.error('reset email', e.message));
    } else {
      await new Promise((r) => setTimeout(r, 400)); // even timing whether or not the account exists
    }
    return { ok: true };
  });
  // Reset with the emailed code.
  app.post('/api/reset', async (req) => {
    const { email, code, password } = req.body || {};
    if (!password || String(password).length < 8) throw bad('New password must be at least 8 characters.');
    const u = email && await one('SELECT id FROM users WHERE lower(email)=lower($1)', [String(email).trim()]);
    const pr = u && await one('SELECT * FROM password_resets WHERE user_id=$1', [u.id]);
    if (!pr || new Date(pr.expires_at) < new Date()) throw bad('That code has expired. Request a new one.');
    if (pr.tries >= 5) { await q('DELETE FROM password_resets WHERE user_id=$1', [u.id]); throw bad('Too many attempts. Request a new code.'); }
    if (sha256(String(code || '')) !== pr.code_hash) {
      await q('UPDATE password_resets SET tries=tries+1 WHERE user_id=$1', [u.id]);
      throw bad('That code is incorrect.');
    }
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await hashPassword(password)]);
    await q('DELETE FROM password_resets WHERE user_id=$1', [u.id]);
    await q('DELETE FROM user_sessions WHERE user_id=$1', [u.id]); // sign out everywhere
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    await q('DELETE FROM user_sessions WHERE token=$1', [req.cookies[SESSION_COOKIE]]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ ...req.user, name: `${req.user.first_name} ${req.user.last_name}`.trim() }));

  // --- my account (any signed-in user) ---------------------------------
  const MY_FIELDS = ['email', 'vm_pin', 'notify_voicemail', 'notify_missed', 'vm_attach_audio', 'ring_seconds'];
  app.get('/api/my', async (req) => {
    const u = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const { password_hash, ...rest } = u;
    const d = await ami.action({ Action: 'DBGet', Family: 'DND', Key: u.extension }).catch(() => null);
    return { ...rest, dnd: d?.events?.[0]?.Val === '1', forward: await getForward(ami, u.extension) };
  });
  app.put('/api/my/theme', async (req) => {
    const theme = String(req.body?.theme || '');
    if (!['dark', 'light'].includes(theme)) throw bad('Unknown theme.');
    await q('UPDATE users SET theme=$2 WHERE id=$1', [req.user.id, theme]);
    return { theme };
  });
  app.put('/api/my', async (req) => {
    const f = cleanUser(pick(req.body || {}, MY_FIELDS));
    if (req.body?.custom) {
      const cur = await one('SELECT custom FROM users WHERE id=$1', [req.user.id]);
      f.custom = JSON.stringify(mergeCustom(cur.custom, req.body.custom, await fieldDefs(), (d) => d.users && d.user_editable));
    }
    if (f.email !== undefined && !f.email) throw bad("Your email address is your sign-in, so it can't be blank.");
    if (f.email) await assertEmailFree(f.email, req.user.id);
    const u = await update('users', req.user.id, f);
    await changed();
    const { password_hash, ...rest } = u;
    return rest;
  });
  app.post('/api/my/password', async (req) => {
    const { current, password } = req.body || {};
    const u = await one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await verifyPassword(String(current || ''), u.password_hash))) throw bad('Current password is incorrect.');
    if (!password || password.length < 8) throw bad('New password must be at least 8 characters.');
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await hashPassword(password)]);
    await q('DELETE FROM user_sessions WHERE user_id=$1 AND token<>$2', [req.user.id, req.cookies[SESSION_COOKIE]]);
    return { ok: true };
  });
  app.post('/api/my/dnd', async (req) => setDnd(req.user.extension, !!req.body?.dnd));
  app.post('/api/my/forward', async (req) => {
    const number = String(req.body?.number ?? '').replace(/[^0-9*#+]/g, '');
    if (req.body?.on && !number) throw bad('Enter the number to forward your calls to.');
    if (number === req.user.extension) throw bad("You can't forward calls to your own extension.");
    const r = await setForward(ami, req.user.extension, { number, on: !!req.body?.on });
    pushUserState(req.user.extension).catch(() => {});
    return r;
  });
  // Click-to-call from the console: ring my phones, then dial the number once I pick up.
  app.post('/api/my/call', async (req) => clickToCall(ami, { extension: req.user.extension, number: req.body?.number }));
  app.get('/api/my/webphone', async (req) => {
    const u = await one('SELECT extension, first_name, last_name, sip_password FROM users WHERE id=$1', [req.user.id]);
    return {
      extension: u.extension, authUser: `webrtc-${u.extension}`, password: u.sip_password,
      displayName: `${u.first_name} ${u.last_name}`.trim(), wsPath: '/ws',
    };
  });

  async function setDnd(ext, on) {
    await ami.action({ Action: on ? 'DBPut' : 'DBDel', Family: 'DND', Key: ext, Val: on ? '1' : undefined });
    pushUserState(ext).catch(() => {});
    return { ok: true, dnd: on };
  }
  async function assertEmailFree(email, id) {
    if (await one('SELECT 1 FROM users WHERE lower(email)=lower($1) AND id<>$2', [email, Number(id) || 0])) throw bad('Another user already has that email address.');
  }

  // --- dashboard & live ---------------------------------------------------
  app.get('/api/dashboard', async () => {
    const [counts, today, recent, contacts, trunks] = await Promise.all([
      one(`SELECT (SELECT count(*) FROM users)::int users, (SELECT count(*) FROM ring_groups)::int groups,
                  (SELECT count(*) FROM call_flows)::int flows, (SELECT count(*) FROM numbers)::int numbers`),
      one(`SELECT count(*)::int total, count(*) FILTER (WHERE status='answered')::int answered,
                  count(*) FILTER (WHERE status IN ('missed','abandoned','busy'))::int missed,
                  count(*) FILTER (WHERE status='voicemail')::int voicemail,
                  coalesce(sum(talk_seconds),0)::int talk_seconds
           FROM calls WHERE started_at >= date_trunc('day', now())`),
      q('SELECT * FROM calls ORDER BY started_at DESC LIMIT 8'),
      phoneContacts().catch(() => []),
      trunkStatus().catch(() => []),
    ]);
    // Asterisk reports registrations as "trunk-<id>"; show the name the admin gave the trunk instead.
    const names = new Map((await q('SELECT id, name FROM trunks')).map((t) => [`trunk-${t.id}`, t.name]));
    const named = trunks.map((t) => ({ ...t, name: names.get(t.trunk) || t.trunk }));
    return { counts, today, recent, active: activeCalls(), phonesOnline: new Set(contacts.filter((c) => c.online).map((c) => c.extension)).size, trunks: named };
  });

  // The same dashboard for one person: only calls they placed, were rung for or answered, their mailboxes
  // (their own and their groups'), and their own phones.
  app.get('/api/my/dashboard', async (req) => {
    const x = req.user.extension;
    const mine = '(answered_by=$1 OR from_num=$1 OR to_num=$1 OR $1 = ANY(missed_exts))';
    const [today, recent, contacts, boxes] = await Promise.all([
      one(`SELECT count(*)::int total, count(*) FILTER (WHERE status='answered' AND (answered_by=$1 OR from_num=$1))::int answered,
                  count(*) FILTER (WHERE $1 = ANY(missed_exts))::int missed,
                  coalesce(sum(talk_seconds) FILTER (WHERE answered_by=$1 OR from_num=$1),0)::int talk_seconds
           FROM calls WHERE started_at >= date_trunc('day', now()) AND ${mine}`, [x]),
      q(`SELECT * FROM calls WHERE ${mine} ORDER BY started_at DESC LIMIT 8`, [x]),
      phoneContacts().catch(() => []),
      myBoxes(req),
    ]);
    const voicemail = [];
    for (const b of boxes) {
      for (const { file, ...m } of await listMessages(b.mailbox).catch(() => [])) {
        if (m.folder === 'INBOX') voicemail.push({ ...m, boxName: b.name, groupBox: b.group });
      }
    }
    voicemail.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    return { today, recent, active: activeCallsFor(x), phones: contacts.filter((c) => c.extension === x), voicemail: voicemail.slice(0, 5), newVoicemail: voicemail.length };
  });

  app.get('/api/live', async () => ({ active: activeCalls() }));

  // Server-sent events so the UI can refresh live.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // Non-admins only get event names (to refresh their own views), never other people's call details.
    const send = (ev) => reply.raw.write(`data: ${JSON.stringify({ event: ev.event, data: req.isAdmin ? ev.data : null })}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    bus.on('event', send);
    req.raw.on('close', () => { clearInterval(ping); bus.off('event', send); });
  });

  // --- users ------------------------------------------------------------
  const USER_FIELDS = ['extension', 'first_name', 'last_name', 'email', 'sip_password', 'outbound_cid', 'ring_seconds', 'vm_enabled',
    'vm_pin', 'notify_voicemail', 'notify_missed', 'vm_attach_audio', 'noanswer_dest', 'max_devices'];
  function cleanUser(b) {
    const f = pick(b, USER_FIELDS);
    if ('first_name' in f && !String(f.first_name).trim()) throw bad('First name is required.');
    if ('email' in f) f.email = String(f.email || '').trim() || null;
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw bad('Email address looks invalid.');
    if ('vm_pin' in f && !/^[0-9]{4,10}$/.test(String(f.vm_pin))) throw bad('Voicemail PIN must be 4 to 10 digits.');
    if ('sip_password' in f && String(f.sip_password).length < 8) throw bad('SIP password must be at least 8 characters.');
    if ('outbound_cid' in f) f.outbound_cid = normalizeNumber(f.outbound_cid || '') || null;
    if ('noanswer_dest' in f) f.noanswer_dest = cleanDest(f.noanswer_dest, { type: 'voicemail' });
    if ('ring_seconds' in f) f.ring_seconds = Math.max(5, Math.min(120, Number(f.ring_seconds) || 25));
    if ('max_devices' in f) f.max_devices = Math.max(1, Math.min(10, Number(f.max_devices) || 5));
    return f;
  }
  const changed = async () => { invalidateUserCache(); await scheduleApply(); };

  const publicUser = ({ password_hash, ...u }) => ({ ...u, has_login: !!password_hash });
  // Role and sign-in password are set by admins; at least one admin who can sign in must remain.
  async function applyLogin(f, body, id) {
    if (body.role !== undefined) {
      if (!['admin', 'user'].includes(body.role)) throw bad('Unknown role.');
      f.role = body.role;
    }
    if (body.password) {
      if (String(body.password).length < 8) throw bad('Sign-in password must be at least 8 characters.');
      f.password_hash = await hashPassword(String(body.password));
    }
    if (body.clear_login) f.password_hash = null;
    if (body.send_login && (!body.password || body.clear_login)) throw bad('Set or generate a password to email their sign-in details.');
    if (f.email) await assertEmailFree(f.email, id);
    if (id && (f.role === 'user' || f.password_hash === null)) {
      const others = await one(`SELECT count(*)::int n FROM users WHERE role='admin' AND password_hash IS NOT NULL AND id<>$1`, [id]);
      const self = await one('SELECT role, password_hash FROM users WHERE id=$1', [id]);
      if (self?.role === 'admin' && self.password_hash && others.n === 0) throw bad('There must be at least one administrator who can sign in.');
    }
    return f;
  }

  // After a save with "Email sign-in details" on: the user is saved either way, the result says whether the email went.
  async function emailLogin(req, u) {
    if (!req.body?.send_login) return {};
    try {
      await sendLoginDetailsEmail(u, String(req.body.password), req.headers.origin || `${req.protocol}://${req.headers.host}`);
      return { login_email: 'sent' };
    } catch (e) { return { login_email: 'failed', login_email_error: e.message }; }
  }

  app.get('/api/users', async (req) => {
    const rows = await q('SELECT * FROM users ORDER BY extension');
    if (req.isAdmin) return rows.map(publicUser);
    const defs = await fieldDefs();
    return rows.map((u) => ({ id: u.id, extension: u.extension, first_name: u.first_name, last_name: u.last_name, email: u.email, vm_enabled: u.vm_enabled,
      custom: visibleCustom(u.custom, defs, (d) => d.users && d.public) }));
  });
  app.get('/api/users/:id', async (req) => {
    const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u) throw notFound();
    return publicUser(u);
  });
  app.post('/api/users', async (req) => {
    const f = await applyLogin(cleanUser(req.body || {}), req.body || {}, null);
    if (req.body?.custom) f.custom = JSON.stringify(mergeCustom({}, req.body.custom, await fieldDefs(), (d) => d.users));
    if (!f.extension) {
      const r = await one(`SELECT coalesce(max(extension::int), 100) + 1 AS next FROM users WHERE extension ~ '^[0-9]{3}$'`);
      f.extension = String(r.next);
    }
    await assertExtensionFree(f.extension);
    f.sip_password = f.sip_password || randomSecret(16);
    if (!f.first_name) throw bad('First name is required.');
    if (req.body?.send_login && !f.email) throw bad('Add an email address to send their sign-in details.');
    const u = await insert('users', f);
    await changed();
    return { ...publicUser(u), ...(await emailLogin(req, u)) };
  });
  app.put('/api/users/:id', async (req) => {
    const before = await one('SELECT role FROM users WHERE id=$1', [req.params.id]);
    const f = await applyLogin(cleanUser(req.body || {}), req.body || {}, req.params.id);
    if (req.body?.custom) {
      const cur = await one('SELECT custom FROM users WHERE id=$1', [req.params.id]);
      f.custom = JSON.stringify(mergeCustom(cur?.custom, req.body.custom, await fieldDefs(), (d) => d.users));
    }
    if (f.extension) await assertExtensionFree(f.extension, { table: 'users', id: req.params.id });
    if (req.body?.send_login && !('email' in f ? f.email : (await one('SELECT email FROM users WHERE id=$1', [req.params.id]))?.email)) throw bad('Add an email address to send their sign-in details.');
    const u = await update('users', req.params.id, f);
    // Only a new password, removed sign-in or changed role ends their other sessions.
    if (f.password_hash !== undefined || (f.role && f.role !== before?.role)) {
      await q('DELETE FROM user_sessions WHERE user_id=$1 AND token<>$2', [u.id, req.cookies[SESSION_COOKIE]]);
    }
    await changed();
    return { ...publicUser(u), ...(await emailLogin(req, u)) };
  });
  app.delete('/api/users/:id', async (req) => {
    if (Number(req.params.id) === req.user.id) throw bad("You can't delete your own account.");
    await applyLogin({ password_hash: null }, {}, req.params.id);
    const u = await one('SELECT extension FROM users WHERE id=$1', [req.params.id]);
    await remove('users', req.params.id);
    if (u) await q('UPDATE ring_groups SET members = array_remove(members, $1)', [u.extension]);
    await changed();
    return { ok: true };
  });
  app.post('/api/users/:id/dnd', async (req) => {
    const u = await one('SELECT extension FROM users WHERE id=$1', [req.params.id]);
    if (!u) throw notFound();
    return setDnd(u.extension, !!req.body?.dnd);
  });
  // Everyone's presence: status (available / dnd / forward + number) from AstDB, and whether their phones are online,
  // ringing or on a call from the extension hints (desk + web phone together).
  app.get('/api/presence', async () => {
    const tree = async (family) => ((await ami.action({ Action: 'DBGetTree', Family: family }).catch(() => null))?.events || [])
      .filter((e) => e.Key).map((e) => [String(e.Key).replace(`/${family}/`, ''), e.Val]);
    const [dnd, cf, hints, users] = await Promise.all([tree('DND'), tree('CF'),
      ami.action({ Action: 'ExtensionStateList' }).catch(() => null), q('SELECT extension FROM users')]);
    const dndSet = new Set(dnd.filter(([, v]) => v === '1').map(([k]) => k));
    const fwd = new Map(cf.filter(([, v]) => v));
    const state = new Map((hints?.events || []).filter((e) => e.Event === 'ExtensionStatus' && e.Context === 'asterfi-ext')
      .map((e) => [String(e.Exten), Number(e.Status)]));
    const out = {};
    for (const { extension: x } of users) {
      const st = state.get(x) ?? 4; // 0 idle, 1 in use, 2 busy, 4 unavailable, 8 ringing, 16 on hold
      out[x] = {
        status: fwd.has(x) ? 'forward' : dndSet.has(x) ? 'dnd' : 'available', forwardTo: fwd.get(x) || null,
        online: st >= 0 && !(st & 4), onCall: st > 0 && !!(st & (1 | 2 | 16)), ringing: st > 0 && !!(st & 8),
      };
    }
    return out;
  });
  app.get('/api/users-dnd', async () => {
    const r = await ami.action({ Action: 'DBGetTree', Family: 'DND' }).catch(() => ({ events: [] }));
    return (r.events || []).filter((e) => e.Val === '1').map((e) => String(e.Key).replace(/^\/DND\//, ''));
  });

  // --- ring groups ------------------------------------------------------
  function cleanGroup(b) {
    const f = pick(b, ['extension', 'name', 'strategy', 'ring_seconds', 'members', 'fail_dest', 'queue', 'voicemail']);
    if ('voicemail' in f) {
      const v = f.voicemail || {};
      const emails = (Array.isArray(v.emails) ? v.emails : String(v.emails || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
      const badEmail = emails.find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
      if (badEmail) throw bad(`"${badEmail}" is not a valid email address.`);
      f.voicemail = {
        enabled: !!v.enabled,
        pin: String(v.pin || '').replace(/\D/g, '').slice(0, 10),
        greeting_prompt_id: Number(v.greeting_prompt_id) || null,
        email_members: v.email_members !== false,
        emails: [...new Set(emails)].slice(0, 20),
        attach_audio: v.attach_audio !== false,
      };
    }
    if ('queue' in f) {
      const x = f.queue || {};
      const n = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
      f.queue = {
        enabled: !!x.enabled,
        max_wait: n(x.max_wait, 30, 3600, 300),
        max_callers: n(x.max_callers, 0, 100, 0),
        announce_position: x.announce_position !== false,
        hold_prompt_id: Number(x.hold_prompt_id) || null,
        hold_every: n(x.hold_every, 15, 600, 60),
        // Offer waiting callers a callback after a few minutes.
        callback_enabled: !!x.callback_enabled,
        callback_after: n(x.callback_after, 1, 30, 2), // minutes before the offer first plays
        callback_prompt_id: Number(x.callback_prompt_id) || null,
      };
      if (f.queue.callback_enabled && !f.queue.callback_prompt_id) throw bad('Pick the message that offers callers the callback option.');
    }
    if ('name' in f && !String(f.name).trim()) throw bad('Name is required.');
    if ('strategy' in f && !['ringall', 'hunt'].includes(f.strategy)) throw bad('Unknown ring strategy.');
    if ('members' in f) f.members = [...new Set((f.members || []).map(extSafe).filter(Boolean))];
    if ('ring_seconds' in f) f.ring_seconds = Math.max(5, Math.min(300, Number(f.ring_seconds) || 20));
    if ('fail_dest' in f) f.fail_dest = cleanDest(f.fail_dest);
    return f;
  }
  app.get('/api/groups', async (req) => {
    const rows = await q('SELECT * FROM ring_groups ORDER BY extension');
    // The mailbox PIN and notification addresses are for administrators only.
    return req.isAdmin ? rows : rows.map(({ voicemail, ...g }) => ({ ...g, voicemail: { enabled: !!voicemail?.enabled } }));
  });
  // Live queue counts per queuing group, keyed by extension.
  app.get('/api/groups/queues', async () => {
    const r = await ami.action({ Action: 'QueueSummary' }).catch(() => ({ events: [] }));
    const out = {};
    for (const e of r.events || []) {
      const m = /^asterfi-q-(\d+)(?:-[0-9a-f]+)?$/.exec(e.Queue || '');
      if (e.Event === 'QueueSummary' && m) out[m[1]] = { waiting: Number(e.Callers) || 0, available: Number(e.Available) || 0, longest: Number(e.LongestHoldTime) || 0 };
    }
    return out;
  });
  app.post('/api/groups', async (req) => {
    const f = cleanGroup(req.body || {});
    await assertExtensionFree(f.extension);
    if (!f.name) throw bad('Name is required.');
    const g = await insert('ring_groups', f);
    await scheduleApply();
    return g;
  });
  app.put('/api/groups/:id', async (req) => {
    const f = cleanGroup(req.body || {});
    if (f.extension) await assertExtensionFree(f.extension, { table: 'ring_groups', id: req.params.id });
    const g = await update('ring_groups', req.params.id, f);
    await scheduleApply();
    return g;
  });
  app.delete('/api/groups/:id', async (req) => { await remove('ring_groups', req.params.id); await scheduleApply(); return { ok: true }; });

  // --- call flows (IVR) -------------------------------------------------
  app.get('/api/flows', async () => q('SELECT id, name, extension, updated_at, jsonb_array_length(graph->\'nodes\') AS blocks FROM call_flows ORDER BY name'));
  app.get('/api/flows/:id', async (req) => (await one('SELECT * FROM call_flows WHERE id=$1', [req.params.id])) || Promise.reject(notFound()));
  app.post('/api/flows', async (req) => {
    const { name, extension } = req.body || {};
    if (!String(name || '').trim()) throw bad('Name is required.');
    if (extension) await assertExtensionFree(extension);
    const graph = { nodes: [{ id: 'start', type: 'start', position: { x: 80, y: 200 }, data: { label: 'Incoming call', answer: true } }], edges: [] };
    const f = await insert('call_flows', { name: name.trim(), extension: extension || null, graph });
    await scheduleApply();
    return f;
  });
  app.put('/api/flows/:id', async (req) => {
    const f = pick(req.body || {}, ['name', 'extension', 'graph']);
    if ('extension' in f) {
      f.extension = f.extension ? String(f.extension) : null;
      if (f.extension) await assertExtensionFree(f.extension, { table: 'call_flows', id: req.params.id });
    }
    if (f.graph) {
      const errors = validateFlow(f.graph);
      if (errors.length && !req.body.force) return { ok: false, errors };
      f.graph = { nodes: f.graph.nodes || [], edges: f.graph.edges || [], viewport: f.graph.viewport };
    }
    const row = await update('call_flows', req.params.id, { ...f, updated_at: new Date() });
    await scheduleApply();
    return { ok: true, flow: row };
  });
  app.delete('/api/flows/:id', async (req) => { await remove('call_flows', req.params.id); await scheduleApply(); return { ok: true }; });

  // --- prompts ----------------------------------------------------------
  app.get('/api/prompts', async () => q('SELECT * FROM prompts ORDER BY name'));
  // Where each prompt is played: call-flow blocks, ring-group hold messages and group voicemail greetings.
  app.get('/api/prompts/usage', async () => {
    const BLOCK = { start: 'Incoming call greeting', greeting: 'Play message', menu: 'Menu', hangup: 'Hang up message', whisper: 'Announce to answerer' };
    const out = {};
    const add = (id, use) => { if (Number(id)) (out[Number(id)] ||= []).push(use); };
    for (const f of await q('SELECT id, name, graph FROM call_flows ORDER BY name')) {
      for (const n of f.graph?.nodes || []) {
        add(n.data?.promptId, { kind: 'flow', id: f.id, name: f.name, where: n.data?.label || BLOCK[n.type] || n.type, link: `/flows/${f.id}` });
      }
    }
    for (const g of await q('SELECT id, name, extension, queue, voicemail FROM ring_groups ORDER BY name')) {
      if (g.queue?.enabled) add(g.queue.hold_prompt_id, { kind: 'group', id: g.id, name: g.name, where: 'Queue hold message', link: '/groups' });
      if (g.queue?.enabled && g.queue.callback_enabled) add(g.queue.callback_prompt_id, { kind: 'group', id: g.id, name: g.name, where: 'Queue callback offer', link: '/groups' });
      if (g.voicemail?.enabled) add(g.voicemail.greeting_prompt_id, { kind: 'group', id: g.id, name: g.name, where: 'Voicemail greeting', link: '/groups' });
    }
    return out;
  });
  const voiceOf = (v) => (KOKORO_VOICES.some((x) => x.id === v) ? v : null);
  app.post('/api/prompts', async (req) => {
    const { name, kind, tts_text, tts_voice } = req.body || {};
    if (!String(name || '').trim()) throw bad('Name is required.');
    if (kind === 'tts' && !String(tts_text || '').trim()) throw bad('Enter the text to speak.');
    const p = await insert('prompts', { name: name.trim(), kind: ['tts', 'phone', 'upload'].includes(kind) ? kind : 'upload', tts_text: tts_text || null, tts_voice: voiceOf(tts_voice) });
    if (p.kind === 'tts') {
      await saveTts(p.id, tts_text.slice(0, 2000), p.tts_voice);
      return update('prompts', p.id, { has_audio: true });
    }
    return p;
  });
  // New text or a new voice regenerates the audio, which also switches an uploaded or recorded prompt to text-to-speech.
  app.put('/api/prompts/:id', async (req) => {
    const f = pick(req.body || {}, ['name', 'tts_text', 'tts_voice']);
    if ('name' in f && !String(f.name).trim()) throw bad('Name is required.');
    if (!String(f.tts_text || '').trim()) delete f.tts_text;
    if ('tts_voice' in f) f.tts_voice = voiceOf(f.tts_voice);
    const before = await one('SELECT tts_voice FROM prompts WHERE id=$1', [req.params.id]);
    const p = await update('prompts', req.params.id, f);
    const voiceChanged = 'tts_voice' in f && f.tts_voice !== before?.tts_voice && p.kind === 'tts' && p.tts_text;
    if (f.tts_text || voiceChanged) {
      await saveTts(p.id, p.tts_text.slice(0, 2000), p.tts_voice);
      return update('prompts', p.id, { has_audio: true, kind: 'tts', updated_at: new Date() });
    }
    return p;
  });

  // --- text-to-speech settings ---------------------------------------------
  app.get('/api/tts', async () => ({ ...(await getSetting('tts')), kokoroAvailable: kokoroAvailable(), voices: KOKORO_VOICES }));
  app.put('/api/settings/tts', async (req) => {
    const b = pick(req.body || {}, ['engine', 'voice', 'speed']);
    if (b.engine && !['kokoro', 'flite'].includes(b.engine)) throw bad('Unknown engine.');
    if (b.voice !== undefined) b.voice = voiceOf(b.voice) || 'af_heart';
    if (b.speed !== undefined) b.speed = Math.max(0.5, Math.min(2, Number(b.speed) || 1));
    await setSetting('tts', { ...(await getSetting('tts')), ...b });
    return { ok: true };
  });
  // --- voicemail transcription settings ------------------------------------
  app.get('/api/settings/stt', async () => ({ ...(await sttSettings()), models: STT_MODELS }));
  app.put('/api/settings/stt', async (req) => {
    const b = pick(req.body || {}, ['enabled', 'model']);
    if ('enabled' in b) b.enabled = !!b.enabled;
    if (b.model !== undefined && !STT_MODELS.some((m) => m.id === b.model)) throw bad('Unknown model.');
    await setSetting('stt', { ...(await getSetting('stt')), ...b });
    return { ok: true };
  });
  app.post('/api/tts/preview', async (req, reply) => {
    const text = String(req.body?.text || '').trim().slice(0, 500);
    if (!text) throw bad('Enter some text to preview.');
    const out = `${tmpdir()}/asterfi-preview-${Date.now()}.wav`;
    try {
      await renderTts(text, out, { voice: voiceOf(req.body?.voice), speed: req.body?.speed });
      reply.type('audio/mpeg').send(await transcode(out, 'mp3'));
    } finally { await rm(out, { force: true }); }
  });
  // Re-render every text prompt that follows the default voice (after the default changes).
  app.post('/api/tts/regenerate', async () => {
    const rows = await q(`SELECT id, tts_text, tts_voice FROM prompts WHERE kind='tts' AND tts_text IS NOT NULL AND tts_voice IS NULL ORDER BY id`);
    (async () => {
      for (const r of rows) {
        try { await saveTts(r.id, r.tts_text, null); await q('UPDATE prompts SET updated_at=now() WHERE id=$1', [r.id]); }
        catch (e) { console.error('regenerate prompt', r.id, e.message); }
      }
    })();
    return { ok: true, count: rows.length };
  });
  app.post('/api/prompts/:id/upload', async (req) => {
    const file = await req.file();
    if (!file) throw bad('No file uploaded.');
    const buf = await file.toBuffer();
    await saveUpload(Number(req.params.id), buf).catch(() => { throw bad('Could not read that audio file. Try WAV or MP3.'); });
    return update('prompts', req.params.id, { has_audio: true, kind: 'upload', tts_text: null, updated_at: new Date() });
  });
  app.get('/api/prompts/:id/audio', async (req, reply) => {
    const buf = await transcode(promptFile(req.params.id), 'mp3').catch(() => null);
    if (!buf) throw notFound();
    reply.type('audio/mpeg').send(buf);
  });
  app.delete('/api/prompts/:id', async (req) => { await remove('prompts', req.params.id); await removePrompt(req.params.id); return { ok: true }; });

  // --- numbers (DIDs) ---------------------------------------------------
  function cleanNumber(b) {
    const f = pick(b, ['number', 'name', 'destination', 'trunk_id']);
    if ('trunk_id' in f) f.trunk_id = Number(f.trunk_id) || null;
    if ('number' in f) {
      f.number = normalizeNumber(f.number);
      if (!f.number) throw bad('Enter a phone number, or * for unmatched calls.');
    }
    if ('destination' in f) f.destination = cleanDest(f.destination);
    return f;
  }
  app.get('/api/numbers', async () => q('SELECT * FROM numbers ORDER BY number'));
  async function assertTrunk(f) {
    if (f.trunk_id && !(await one('SELECT 1 FROM trunks WHERE id=$1', [f.trunk_id]))) throw bad('That trunk no longer exists.');
    return f;
  }
  app.post('/api/numbers', async (req) => {
    const f = await assertTrunk(cleanNumber(req.body || {}));
    if (await one('SELECT 1 FROM numbers WHERE number=$1', [f.number])) throw bad('That number already exists.');
    const n = await insert('numbers', f);
    await scheduleApply();
    return n;
  });
  app.put('/api/numbers/:id', async (req) => { const n = await update('numbers', req.params.id, await assertTrunk(cleanNumber(req.body || {}))); await scheduleApply(); return n; });
  app.delete('/api/numbers/:id', async (req) => { await remove('numbers', req.params.id); await scheduleApply(); return { ok: true }; });

  // --- trunks & outbound routes ----------------------------------------
  const TRUNK_FIELDS = ['name', 'host', 'port', 'transport', 'username', 'password', 'auth_username', 'from_domain', 'from_user', 'register', 'caller_id', 'match_ips', 'enabled', 'custom'];
  const TRUNK_SECTIONS = ['endpoint', 'registration', 'aor', 'auth', 'identify'];
  function cleanTrunk(b) {
    const f = pick(b, TRUNK_FIELDS);
    if ('name' in f && !String(f.name).trim()) throw bad('Name is required.');
    if ('host' in f && !/^[a-zA-Z0-9.-]+$/.test(String(f.host).trim())) throw bad('Host must be a hostname or IP address.');
    if ('host' in f) f.host = f.host.trim();
    if ('port' in f) f.port = Number(f.port) || 5060;
    if ('transport' in f && !['udp', 'tcp'].includes(f.transport)) f.transport = 'udp';
    if ('caller_id' in f) f.caller_id = normalizeNumber(f.caller_id || '') || null;
    // Extra PJSIP options, e.g. {section:"endpoint", key:"t38_udptl", value:"yes"}.
    if ('custom' in f) {
      f.custom = (f.custom || []).filter((c) => c && String(c.key || '').trim()).map((c) => {
        const key = String(c.key).trim(), value = String(c.value ?? '').trim();
        if (!TRUNK_SECTIONS.includes(c.section)) throw bad(`Unknown section "${c.section}".`);
        if (!/^[a-z0-9_]+$/.test(key)) throw bad(`"${key}" isn't a valid option name (lowercase letters, digits, underscores).`);
        if (/[\r\n]/.test(value)) throw bad(`The value for "${key}" can't contain line breaks.`);
        if (key === 'type') throw bad('The "type" option is set by AsterFi.');
        return { section: c.section, key, value };
      });
      f.custom = JSON.stringify(f.custom);
    }
    return f;
  }
  const maskTrunk = (t) => ({ ...t, password: t.password ? '********' : '' });
  app.get('/api/trunks', async () => {
    const [rows, st] = await Promise.all([q('SELECT * FROM trunks ORDER BY id'), trunkStatus().catch(() => [])]);
    return Promise.all(rows.map(async (t) => {
      const live = st.find((s) => s.trunk === `trunk-${t.id}`);
      const reg = t.register && t.username ? await registrationState(t, live?.status) : null;
      const code = /^(\d{3})/.exec(reg?.reason || '')?.[1];
      return {
        ...maskTrunk(t),
        status: !t.enabled ? 'Disabled' : !t.register ? 'IP auth' : live?.status || 'Unknown',
        reason: live?.status === 'Registered' ? null : reg?.reason || null,
        reasonHelp: live?.status === 'Registered' ? null : REASON_HELP[code] || (reg?.reason === 'No response' ? REASON_HELP[408] : null),
        retryIn: reg?.retryIn ?? null,
        checkedAt: reg?.at || null,
      };
    }));
  });
  app.post('/api/trunks', async (req) => {
    const f = cleanTrunk(req.body || {});
    if (!f.name || !f.host) throw bad('Name and host are required.');
    const t = await insert('trunks', f);
    // First trunk gets a sensible default outbound route, and any route left without a trunk
    // (e.g. after its trunk was deleted) picks up the new one rather than failing every call.
    if (!(await one('SELECT 1 FROM outbound_routes LIMIT 1'))) {
      await insert('outbound_routes', { name: 'Default', priority: 10, patterns: ['911', '933', '_N11', '_NXXNXXXXXX', '_1NXXNXXXXXX', '_011.'], trunk_ids: [t.id] });
    } else {
      await q(`UPDATE outbound_routes SET trunk_ids = ARRAY[$1::int] WHERE cardinality(trunk_ids) = 0`, [t.id]);
    }
    await scheduleApply();
    await reRegister(t);
    return maskTrunk(t);
  });
  app.put('/api/trunks/:id', async (req) => {
    const f = cleanTrunk(req.body || {});
    if (f.password === '********') delete f.password;
    const t = await update('trunks', req.params.id, f);
    await scheduleApply();
    await reRegister(t);
    return maskTrunk(t);
  });
  app.post('/api/trunks/:id/register', async (req) => {
    const t = await one('SELECT * FROM trunks WHERE id=$1', [req.params.id]);
    if (!t) throw notFound();
    if (!(await reRegister(t))) throw bad('This trunk does not register (IP authentication) or is disabled.');
    return { ok: true };
  });
  // Edits must take effect now: Asterisk otherwise keeps waiting out the retry timer
  // from the last failure (10 minutes after a 403).
  async function reRegister(t) {
    if (!t.enabled || !t.register || !t.username || !t.password) return false;
    const r = await ami.action({ Action: 'PJSIPRegister', Registration: `trunk-${t.id}` }).catch(() => null);
    return r?.Response === 'Success';
  }
  app.delete('/api/trunks/:id', async (req) => {
    await remove('trunks', req.params.id);
    await q('UPDATE outbound_routes SET trunk_ids = array_remove(trunk_ids, $1::int)', [req.params.id]);
    await scheduleApply();
    return { ok: true };
  });

  function cleanRoute(b) {
    const f = pick(b, ['name', 'priority', 'patterns', 'trunk_ids', 'strip', 'prepend']);
    if ('patterns' in f) {
      f.patterns = (f.patterns || []).map((p) => String(p).trim()).filter(Boolean);
      for (const p of f.patterns) if (!/^(_[0-9XZN\[\]\-.!*#+]+|[0-9*#+]+)$/.test(p)) throw bad(`"${p}" is not a valid dial pattern.`);
    }
    if ('trunk_ids' in f) f.trunk_ids = (f.trunk_ids || []).map(Number).filter(Boolean);
    if ('strip' in f) f.strip = Math.max(0, Number(f.strip) || 0);
    if ('prepend' in f) f.prepend = String(f.prepend || '').replace(/[^0-9]/g, '');
    if ('priority' in f) f.priority = Number(f.priority) || 10;
    return f;
  }
  app.get('/api/routes', async () => q('SELECT * FROM outbound_routes ORDER BY priority, id'));
  app.post('/api/routes', async (req) => { const r = await insert('outbound_routes', cleanRoute(req.body || {})); await scheduleApply(); return r; });
  app.put('/api/routes/:id', async (req) => { const r = await update('outbound_routes', req.params.id, cleanRoute(req.body || {})); await scheduleApply(); return r; });
  app.delete('/api/routes/:id', async (req) => { await remove('outbound_routes', req.params.id); await scheduleApply(); return { ok: true }; });

  // --- phones (live registrations) -------------------------------------
  async function phoneContacts() {
    const r = await ami.action({ Action: 'PJSIPShowContacts' });
    // Match a contact to a known UniFi phone by IP, so we can show its model (it registers User-Agent "Unknown").
    const devs = await q("SELECT ip, model, model_name FROM unifi_devices WHERE ip IS NOT NULL AND authkey IS NOT NULL");
    const modelByIp = new Map(devs.map((d) => [d.ip, d.model_name || d.model]));
    // ContactList has no AOR field; ObjectName is "<aor>;@<hash>" and Endpoint names the endpoint.
    return (r.events || []).filter((e) => e.Event === 'ContactList').map((e) => {
      const aor = String(e.ObjectName || '').split(';@')[0] || String(e.Endpoint || '');
      return { aor, e };
    }).filter(({ aor }) => aor && !aor.startsWith('trunk-')).map(({ aor, e }) => {
      const webPhone = aor.startsWith('webrtc-');
      const model = webPhone ? null : modelByIp.get((/@([0-9.]+)/.exec(e.Uri || '') || [])[1]) || null;
      return {
        extension: aor.replace(/^webrtc-/, ''), webPhone, model,
        uri: e.Uri, userAgent: e.UserAgent || '', status: e.Status,
        online: ['Reachable', 'NonQualified', 'Created', 'Unknown'].includes(e.Status),
        // Web phones arrive through nginx on this server, so their network address isn't meaningful.
        address: webPhone ? 'Web browser' : e.ViaAddr ? `${e.ViaAddr}${e.ViaPort ? `:${e.ViaPort}` : ''}` : '',
        rttMs: e.RoundtripUsec && e.RoundtripUsec !== 'N/A' ? Math.round(Number(e.RoundtripUsec) / 1000) : null,
        expires: e.ExpirationTime ? new Date(Number(e.ExpirationTime) * 1000) : null,
      };
    });
  }
  async function trunkStatus() {
    const r = await ami.action({ Action: 'PJSIPShowRegistrationsOutbound' });
    return (r.events || []).filter((e) => e.Event === 'OutboundRegistrationDetail').map((e) => ({ trunk: e.ObjectName, status: e.Status }));
  }
  app.get('/api/phones', async () => phoneContacts());

  // --- UniFi devices (Talk adoption, phase 0) ---------------------------
  app.get('/api/unifi/devices', async () =>
    q(`SELECT d.mac, d.model, d.model_name, d.ip, d.firmware, d.hostname, d.source, d.state, d.first_seen, d.last_seen,
              d.inform_count, d.last_inform IS NOT NULL AS has_inform, d.authkey IS NOT NULL AS adopted,
              u.extension AS assigned_ext, trim(u.first_name || ' ' || u.last_name) AS assigned_name
       FROM unifi_devices d LEFT JOIN users u ON u.id = d.assigned_user_id
       WHERE NOT d.ignored
       ORDER BY (d.authkey IS NOT NULL) DESC,
                (CASE WHEN u.extension ~ '^[0-9]+$' THEN u.extension::int END) NULLS LAST, d.last_seen DESC`));
  // Change which user a Talk phone is assigned to, and push the new SIP account to it if it's connected.
  app.put('/api/unifi/devices/:mac/assign', async (req) => {
    const mac = req.params.mac.toLowerCase();
    if (!(await one('SELECT mac FROM unifi_devices WHERE mac=$1', [mac]))) throw notFound();
    const { user_id } = req.body || {};
    if (user_id && !(await one('SELECT id FROM users WHERE id=$1', [user_id]))) throw bad('Unknown user.');
    await q('UPDATE unifi_devices SET assigned_user_id=$2 WHERE mac=$1', [mac, user_id || null]);
    const reprovisioned = await reprovisionDevice(mac);
    return { ok: true, reprovisioned };
  });
  app.get('/api/unifi/devices/:mac', async (req) => {
    const d = await one('SELECT * FROM unifi_devices WHERE mac=$1', [req.params.mac.toLowerCase()]);
    if (!d) throw notFound();
    const { authkey, ...rest } = d; // the adoption key stays on the server
    const assigned = d.assigned_user_id && await one('SELECT id, extension, first_name, last_name FROM users WHERE id=$1', [d.assigned_user_id]);
    return { ...rest, has_authkey: !!authkey, assigned_user: assigned || null };
  });
  // A manual scan brings ignored devices back so they can be reviewed again.
  app.post('/api/unifi/scan', async () => { await q('UPDATE unifi_devices SET ignored=false WHERE ignored'); unifiScan(); return { ok: true }; });
  // Adopt: sign in to a Talk phone and point it at this server. Only Talk phones; never Protect or other gear.
  app.post('/api/unifi/devices/:mac/adopt', async (req) => {
    const d = await one('SELECT * FROM unifi_devices WHERE mac=$1', [req.params.mac.toLowerCase()]);
    if (!d) throw notFound();
    if (!/^(UVP|UTP)-/i.test(d.model || '')) throw bad('Only UniFi Talk phones can be adopted here.');
    if (!d.ip) throw bad("AsterFi hasn't seen this phone's IP address yet. Try Scan network.");
    const local = localAddressFor(d.ip);
    if (!local) throw bad(`The phone at ${d.ip} isn't on the same network as AsterFi.`);
    const url = `http://${local}:8080/device/inform`; // the path a Talk console uses
    const { username, password, user_id } = req.body || {};
    // Which AsterFi user/extension this phone is assigned to; its SIP account is pushed when the phone connects.
    if (user_id !== undefined) {
      if (user_id && !(await one('SELECT id FROM users WHERE id=$1', [user_id]))) throw bad('Unknown user.');
      await q('UPDATE unifi_devices SET assigned_user_id=$2 WHERE mac=$1', [d.mac, user_id || null]);
    }
    // The key the phone will encrypt its check-ins with; kept so the listener can read them.
    const key = d.authkey || randomBytes(16).toString('hex');
    if (!d.authkey) await q('UPDATE unifi_devices SET authkey=$2 WHERE mac=$1', [d.mac, key]);
    // Talk phones run SSH on a high port and announce it in discovery (e.g. 0x8000 = 32768).
    const port = parseInt(d.last_discovery?.tlv?.sshPort || '', 16) || 22;
    const r = await setInform(d.ip, url, { key, port, username: username || 'ubnt', password: password || 'ubnt' });
    const result = { at: new Date().toISOString(), url, port, ok: r.ok, unconfirmed: !!r.unconfirmed, command: r.command || null, error: r.error || null, output: r.output };
    await q(`UPDATE unifi_devices SET adopt_result=$2, state=CASE WHEN $3 THEN 'adopting' ELSE state END WHERE mac=$1`,
      [d.mac, JSON.stringify(result), r.ok]);
    return result;
  });
  app.post('/api/unifi/devices/:mac/ignore', async (req) => {
    await q('UPDATE unifi_devices SET ignored=true WHERE mac=$1', [req.params.mac.toLowerCase()]);
    return { ok: true };
  });
  app.delete('/api/unifi/devices/:mac', async (req) => { await q('DELETE FROM unifi_devices WHERE mac=$1', [req.params.mac.toLowerCase()]); return { ok: true }; });

  // --- call history -----------------------------------------------------
  app.get('/api/calls', async (req) => {
    const { limit = 50, offset = 0, status, direction, search } = req.query;
    // Admins see everyone's calls unless they ask for their own ("My history").
    const extension = req.isAdmin && req.query.mine !== '1' ? req.query.extension : req.user.extension;
    const where = [];
    const p = [];
    if (status) { p.push(status === 'missed' ? ['missed', 'abandoned', 'busy'] : [status]); where.push(`status = ANY($${p.length})`); }
    if (direction) { p.push(direction); where.push(`direction = $${p.length}`); }
    if (extension) { p.push(extension); where.push(`(answered_by=$${p.length} OR from_num=$${p.length} OR to_num=$${p.length} OR $${p.length} = ANY(missed_exts))`); }
    if (search) { p.push(`%${search}%`); where.push(`(from_num ILIKE $${p.length} OR from_name ILIKE $${p.length} OR to_num ILIKE $${p.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, total] = await Promise.all([
      q(`SELECT * FROM calls ${w} ORDER BY started_at DESC LIMIT ${Math.min(500, Number(limit) || 50)} OFFSET ${Number(offset) || 0}`, p),
      one(`SELECT count(*)::int n FROM calls ${w}`, p),
    ]);
    return { rows, total: total.n };
  });

  // A call flow's recording of the conversation, as MP3. Users only hear calls they were part of.
  app.get('/api/calls/:id/recording', async (req, reply) => {
    const c = await one('SELECT * FROM calls WHERE id=$1', [String(req.params.id)]);
    const x = req.user.extension;
    if (!c || (!req.isAdmin && ![c.answered_by, c.from_num, c.to_num].includes(x) && !(c.missed_exts || []).includes(x))) throw notFound();
    const file = (c.path || []).find((s) => s.step === 'recording')?.file;
    if (!/^[\d.]+$/.test(file || '')) throw notFound();
    const wav = `${RECORDINGS}/${file}.wav`;
    if (!(await stat(wav).catch(() => null))?.size) throw notFound();
    reply.type('audio/mpeg').header('cache-control', 'private, max-age=3600').send(await transcode(wav));
  });

  // --- contacts: a private list per user ------------------------------------
  const PHONE_LABELS = ['Mobile', 'Work', 'Home', 'Other'];
  const CONTACT_SELECT = CONTACT_QUERY;
  function cleanContact(b, { coworker = false } = {}) {
    const t = (v, n = 200) => String(v ?? '').trim().slice(0, n);
    const f = { first_name: t(b.first_name), last_name: t(b.last_name), company: t(b.company), notes: t(b.notes, 2000) };
    f.email = t(b.email) || null;
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw bad("That email address doesn't look right.");
    f.phones = (Array.isArray(b.phones) ? b.phones : [])
      .map((x) => ({ label: PHONE_LABELS.includes(x?.label) ? x.label : 'Other', number: t(x?.number, 40) }))
      .filter((x) => /\d/.test(x.number)).slice(0, 10);
    // Details attached to a coworker take the coworker's name from their user account.
    if (coworker) { f.first_name = ''; f.last_name = ''; }
    else if (!f.first_name && !f.last_name && !f.company) throw bad('Enter a name or company.');
    f.phones = JSON.stringify(f.phones);
    return f;
  }
  app.get('/api/contacts', async (req) => q(`${CONTACT_SELECT} WHERE c.owner_id=$1 ORDER BY lower(COALESCE(u.first_name || u.last_name, c.first_name || c.last_name || c.company))`, [req.user.id]));
  app.get('/api/contact-fields', async () => fieldDefs());
  app.put('/api/settings/contact-fields', async (req) => saveFieldDefs(req.body?.fields));
  app.post('/api/contacts', async (req) => {
    const coworkerId = req.body?.coworker_id ? Number(req.body.coworker_id) : null;
    if (coworkerId) {
      if (coworkerId === req.user.id || !(await one('SELECT 1 FROM users WHERE id=$1', [coworkerId]))) throw bad('That coworker no longer exists.');
      if (await one('SELECT 1 FROM contacts WHERE owner_id=$1 AND coworker_id=$2', [req.user.id, coworkerId])) throw bad('You already have details for this coworker.');
    }
    const row = await insert('contacts', {
      ...cleanContact(req.body || {}, { coworker: !!coworkerId }), owner_id: req.user.id, coworker_id: coworkerId,
      custom: JSON.stringify(mergeCustom({}, req.body?.custom, await fieldDefs(), (d) => d.contacts)),
    });
    return one(`${CONTACT_SELECT} WHERE c.id=$1`, [row.id]);
  });
  app.put('/api/contacts/:id', async (req) => {
    const own = await one('SELECT coworker_id FROM contacts WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
    if (!own) throw notFound();
    const f = cleanContact(req.body || {}, { coworker: !!own.coworker_id });
    if (req.body?.custom) {
      const cur = await one('SELECT custom FROM contacts WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
      if (!cur) throw notFound();
      f.custom = JSON.stringify(mergeCustom(cur.custom, req.body.custom, await fieldDefs(), (d) => d.contacts));
    }
    const keys = Object.keys(f);
    const row = await one(`UPDATE contacts SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(', ')}, updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [req.params.id, req.user.id, ...keys.map((k) => f[k])]);
    if (!row) throw notFound();
    return one(`${CONTACT_SELECT} WHERE c.id=$1`, [row.id]);
  });
  app.delete('/api/contacts/:id', async (req) => {
    const r = await one('DELETE FROM contacts WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r) throw notFound();
    return { ok: true };
  });

  // --- voicemail: each signed-in user sees their own mailbox plus the group boxes they belong to ---
  const myBoxes = async (req) => {
    const groups = await q(`SELECT extension, name FROM ring_groups
      WHERE (voicemail->>'enabled')::boolean AND $1 = ANY(members) ORDER BY extension`, [req.user.extension]);
    return [{ mailbox: req.user.extension, name: 'My voicemail', group: false }, ...groups.map((g) => ({ mailbox: g.extension, name: g.name, group: true }))];
  };
  const ownBox = async (req, mailbox) => {
    const box = extSafe(mailbox);
    if (!(await myBoxes(req)).some((b) => b.mailbox === box)) throw notFound();
    return box;
  };
  app.get('/api/voicemail', async (req) => {
    const out = [];
    for (const b of await myBoxes(req)) {
      for (const { file, ...m } of await listMessages(b.mailbox)) out.push({ ...m, boxName: b.name, groupBox: b.group });
    }
    return out.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  });
  app.get('/api/voicemail/boxes', async (req) => myBoxes(req));
  app.get('/api/voicemail/:mailbox/:id/audio', async (req, reply) => {
    const m = await findMessage(await ownBox(req, req.params.mailbox), req.params.id);
    if (!m) throw notFound();
    reply.type('audio/mpeg').header('cache-control', 'private, max-age=3600').send(await transcode(`${m.file}.wav`));
  });
  // Whether this server transcribes voicemail, so the Voicemail page knows to offer "Transcribe".
  app.get('/api/voicemail/transcription', async () => { const { enabled, available } = await sttSettings(); return { enabled, available }; });
  // Transcribe one message now (e.g. one left before transcription was turned on). Runs in the background;
  // the page refreshes on the voicemail.transcribed event.
  app.post('/api/voicemail/:mailbox/:id/transcribe', async (req) => {
    const mailbox = await ownBox(req, req.params.mailbox);
    if (!(await sttSettings()).available) throw new HttpError(409, 'Voicemail transcription is not installed on this server.');
    const row = await one('SELECT * FROM voicemails WHERE mailbox=$1 AND msg_id=$2', [mailbox, req.params.id]);
    if (!row) throw notFound();
    if (row.transcript_status === 'pending') return { ok: true };
    await q(`UPDATE voicemails SET transcript_status='pending' WHERE msg_id=$1`, [row.msg_id]);
    transcribeVoicemail(row).catch(() => {});
    return { ok: true };
  });
  app.post('/api/voicemail/:mailbox/:id/heard', async (req) => { await markHeard(await ownBox(req, req.params.mailbox), req.params.id); return { ok: true }; });
  app.delete('/api/voicemail/:mailbox/:id', async (req) => {
    if (!(await deleteMessage(await ownBox(req, req.params.mailbox), req.params.id))) throw notFound();
    return { ok: true };
  });

  // --- settings ---------------------------------------------------------
  app.get('/api/settings/general', async () => getSetting('general'));
  app.put('/api/settings/general', async (req) => {
    const cur = await getSetting('general');
    const b = pick(req.body || {}, ['siteName', 'timezone', 'externalAddress', 'localNets', 'publicUrl']);
    if (b.localNets && !Array.isArray(b.localNets)) b.localNets = String(b.localNets).split(/[\s,]+/).filter(Boolean);
    const next = { ...cur, ...b };
    await setSetting('general', next);
    const transportChanged = cur.externalAddress !== next.externalAddress || JSON.stringify(cur.localNets) !== JSON.stringify(next.localNets);
    await applyNow({ transports: transportChanged });
    return { ...next, restartRequired: transportChanged };
  });
  app.get('/api/settings/smtp', async () => { const s = await getSetting('smtp'); return { ...s, password: s.password ? '********' : '' }; });
  app.put('/api/settings/smtp', async (req) => {
    const cur = await getSetting('smtp');
    const b = pick(req.body || {}, ['host', 'port', 'secure', 'username', 'password', 'fromAddress', 'fromName', 'allowSelfSigned']);
    if (b.password === '********') delete b.password;
    if (b.port) b.port = Number(b.port);
    await setSetting('smtp', { ...cur, ...b });
    return { ok: true };
  });
  app.post('/api/settings/smtp/test', async (req) => {
    const to = String(req.body?.to || '').trim();
    if (!to) throw bad('Enter an address to send the test to.');
    try { await sendTestEmail(to); } catch (e) { throw bad(`Sending failed: ${e.message}`); }
    return { ok: true };
  });
  // The AMI connection drops as Asterisk restarts, so don't wait for a reply.
  app.post('/api/system/restart-asterisk', async () => {
    if (!ami.connected) throw bad('Asterisk is not connected.');
    ami.command('core restart gracefully').catch(() => {});
    return { ok: true };
  });
  app.get('/api/system/info', async () => ({
    asterisk: (await ami.command('core show version').catch(() => '')).trim(),
    uptime: (await ami.command('core show uptime seconds').catch(() => '')).trim(),
    amiConnected: ami.connected,
  }));
  // Settings > System: health and performance, storage, component versions and the update check.
  app.get('/api/system/overview', async () => {
    const [h, perf, store, uptime, contacts, trunks, calls] = await Promise.all([
      sysHost(), sysPerformance(), sysStorage(q, RECORDINGS),
      ami.command('core show uptime seconds').catch(() => ''),
      phoneContacts().catch(() => []), trunkStatus().catch(() => []),
      one(`SELECT count(*)::int today, (SELECT count(*) FROM calls)::bigint total FROM calls WHERE started_at >= date_trunc('day', now())`),
    ]);
    return {
      host: { ...h, asteriskUptime: Number((/System uptime: (\d+)/.exec(uptime) || [])[1]) || null, amiConnected: ami.connected },
      ...perf, storage: store,
      telephony: {
        activeCalls: activeCalls().length, callsToday: calls.today, callsTotal: Number(calls.total),
        phonesOnline: contacts.filter((c) => c.online).length, phonesTotal: contacts.length,
        trunksRegistered: trunks.filter((t) => t.status === 'Registered').length, trunksTotal: trunks.length,
      },
    };
  });
  app.get('/api/system/versions', async (req) => {
    const v = await sysVersions(ami, q, { refresh: req.query.refresh === '1' });
    return { ...v, issues: annotateCompat(v) };
  });
  // Components outside the versions this release supports, for the dashboard warning and the System tab badge.
  app.get('/api/system/compat', async () => ({ issues: annotateCompat(await sysVersions(ami, q)) }));
  app.get('/api/system/update', async (req) => updateStatus({ force: req.query.check === '1' }));
  app.put('/api/settings/updates', async (req) => {
    await setSetting('updates', { ...(await getSetting('updates')), auto: req.body?.auto !== false });
    return updateStatus();
  });
  // Nightly backups written by asterfi-backup.timer.
  const BACKUP_DIR = '/var/backups/asterfi';
  app.get('/api/backups', async () => {
    const files = (await readdir(BACKUP_DIR).catch(() => [])).filter((f) => /^asterfi-\d{8}-\d{4}\.tar\.gz$/.test(f));
    const rows = await Promise.all(files.map(async (f) => { const st = await stat(`${BACKUP_DIR}/${f}`); return { name: f, size: st.size, createdAt: st.mtime }; }));
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  });
  app.get('/api/backups/:name', async (req, reply) => {
    if (!/^asterfi-\d{8}-\d{4}\.tar\.gz$/.test(req.params.name)) throw notFound();
    const file = `${BACKUP_DIR}/${req.params.name}`;
    await stat(file).catch(() => { throw notFound(); });
    reply.header('content-disposition', `attachment; filename="${req.params.name}"`).type('application/gzip');
    return reply.send(createReadStream(file));
  });
  app.get('/api/email-log', async () => q('SELECT * FROM email_log ORDER BY id DESC LIMIT 100'));

  // --- webhooks ---------------------------------------------------------
  app.get('/api/webhooks/events', async () => EVENT_TYPES);
  app.get('/api/webhooks', async () => q(`SELECT w.*,
      (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='failed')::int failed,
      (SELECT max(created_at) FROM webhook_deliveries d WHERE d.webhook_id=w.id) last_delivery
    FROM webhooks w ORDER BY id`));
  function cleanHook(b) {
    const f = pick(b, ['name', 'url', 'events', 'enabled']);
    if ('url' in f && !/^https?:\/\/\S+$/.test(f.url || '')) throw bad('URL must start with http:// or https://');
    if ('events' in f) f.events = (f.events || []).filter((e) => e === '*' || /^[a-z]+\.(\*|[a-z]+)$/.test(e));
    return f;
  }
  app.post('/api/webhooks', async (req) => {
    const f = cleanHook(req.body || {});
    if (!f.name || !f.url) throw bad('Name and URL are required.');
    return insert('webhooks', { events: ['*'], ...f, secret: `whsec_${randomSecret(32)}` });
  });
  app.put('/api/webhooks/:id', async (req) => update('webhooks', req.params.id, cleanHook(req.body || {})));
  app.post('/api/webhooks/:id/rotate-secret', async (req) => update('webhooks', req.params.id, { secret: `whsec_${randomSecret(32)}` }));
  app.delete('/api/webhooks/:id', async (req) => { await remove('webhooks', req.params.id); return { ok: true }; });
  app.post('/api/webhooks/:id/test', async (req) => sendTest(req.params.id));
  app.get('/api/webhooks/:id/deliveries', async (req) =>
    q('SELECT * FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT 100', [req.params.id]));
  app.post('/api/deliveries/:id/redeliver', async (req) => { await redeliver(req.params.id); return { ok: true }; });

  // --- API keys -------------------------------------------------------
  app.get('/api/apikeys', async () => q('SELECT id, name, prefix, created_at, last_used FROM api_keys ORDER BY id'));
  app.post('/api/apikeys', async (req) => {
    if (!String(req.body?.name || '').trim()) throw bad('Name is required.');
    const k = newApiKey();
    const row = await insert('api_keys', { name: req.body.name.trim(), key_hash: k.hash, prefix: k.prefix });
    return { id: row.id, name: row.name, prefix: row.prefix, key: k.key };
  });
  app.delete('/api/apikeys/:id', async (req) => { await remove('api_keys', req.params.id); return { ok: true }; });

}

export { HttpError };
