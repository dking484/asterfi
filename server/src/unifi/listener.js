// Phase 0 of UniFi Talk adoption: find UniFi devices on the LAN and record exactly what they send,
// so the Talk-specific adoption and provisioning steps can be built from real traffic.
//  - UDP 10001: UniFi discovery (we broadcast requests and listen for announcements)
//  - TCP 8080 /inform: the device check-in; we decode it and reply "noop" (no adoption yet)
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { q } from '../db.js';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { handleTalkWs, encodeMessage } from './talkws.js';
import { buildProfiles, buildTalkContacts } from './provision.js';
import { directoryFor } from '../directory.js';
import { localAddressFor } from './setinform.js';
import { setForward, getForward } from '../forward.js';
import { phoneLogFor, phoneLogEntry, markPhoneLogRead, callParties } from './calllog.js';
import { bus } from '../events.js';

// The phone shows "Internal Calls Only" unless its profile carries a phone number. Use the user's outbound
// caller ID, else a trunk's caller ID, else the first number on the system; sent in E.164 like UniFi Talk does.
async function userDid(user) {
  const row = (await q(`SELECT COALESCE(NULLIF((SELECT outbound_cid FROM users WHERE id=$1), ''),
    (SELECT caller_id FROM trunks WHERE COALESCE(caller_id, '') <> '' ORDER BY id LIMIT 1),
    (SELECT number FROM numbers WHERE number <> '*' ORDER BY id LIMIT 1)) AS n`, [user.id]))[0];
  const d = String(row?.n || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d ? `+${d}` : '';
}

// Live device WebSockets by MAC, so we can push a fresh config when the assignment changes.
const deviceSockets = new Map();

// Re-send profiles_update to a connected phone so it registers as its (new) assigned user. Returns true if pushed.
export async function reprovisionDevice(mac) {
  const ws = deviceSockets.get(mac);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  const dev = (await q('SELECT ip, assigned_user_id FROM unifi_devices WHERE mac=$1', [mac]))[0];
  if (!dev?.assigned_user_id) return false;
  const user = (await q('SELECT id, extension, first_name, last_name, sip_password FROM users WHERE id=$1', [dev.assigned_user_id]))[0];
  if (!user) return false;
  const host = localAddressFor(dev.ip) || dev.ip;
  ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'profiles_update' }, buildProfiles(user, host, { did: await userDid(user) })));
  await pushDirectory(mac);
  await pushCallLog(mac);
  return true;
}

// Push the assigned user's directory (coworkers, groups, their contacts) to a connected phone, and remove
// entries it was sent before that no longer exist. Returns true if pushed.
export async function pushDirectory(mac) {
  const ws = deviceSockets.get(mac);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  const dev = (await q('SELECT assigned_user_id, synced_contacts FROM unifi_devices WHERE mac=$1', [mac]))[0];
  if (!dev?.assigned_user_id) return false;
  const list = buildTalkContacts(await directoryFor(dev.assigned_user_id));
  const ids = list.map((c) => c.id);
  const gone = (dev.synced_contacts || []).filter((id) => !ids.includes(id));
  if (gone.length) ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'contacts_delete' }, gone));
  ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'contacts_update' }, list));
  await q('UPDATE unifi_devices SET synced_contacts=$2 WHERE mac=$1', [mac, JSON.stringify(ids)]);
  return true;
}

// The phone's Recents: the assigned user's last 200 calls (see calllog.js).
const devExt = async (mac) => (await q('SELECT u.extension FROM unifi_devices d JOIN users u ON u.id = d.assigned_user_id WHERE d.mac=$1', [mac]))[0]?.extension;
const sendEvent = (ws, name, body) => ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name }, body));
export async function pushCallLog(mac) {
  const ws = deviceSockets.get(mac);
  const ext = ws && ws.readyState === ws.OPEN && await devExt(mac);
  if (!ext) return false;
  const list = await phoneLogFor(ext);
  sendEvent(ws, 'call_log', list);
  console.log(`unifi call-log ${mac} ext ${ext}: ${list.length} calls`);
  return true;
}
async function phoneLogRead(mac) {
  const ext = await devExt(mac);
  if (!ext) return;
  await markPhoneLogRead(ext);
  for (const { mac: m } of await q('SELECT d.mac FROM unifi_devices d JOIN users u ON u.id = d.assigned_user_id WHERE u.extension=$1', [ext])) {
    const ws = deviceSockets.get(m);
    if (ws && ws.readyState === ws.OPEN) sendEvent(ws, 'call_log_is_read', null);
  }
}
// A finished call is added to the Recents of every phone whose user was on it.
async function addToCallLogs(callId) {
  const c = (await q('SELECT * FROM calls WHERE id=$1', [callId]))[0];
  if (!c) return;
  const parties = callParties(c);
  const devs = await q('SELECT d.mac, u.extension FROM unifi_devices d JOIN users u ON u.id = d.assigned_user_id WHERE u.extension = ANY($1)', [parties]);
  for (const { mac, extension } of devs) {
    const ws = deviceSockets.get(mac);
    const e = phoneLogEntry(c, extension);
    if (ws && ws.readyState === ws.OPEN && e.number) sendEvent(ws, 'call_log_entries_updated', [e]);
  }
}

// Directory changed (a user, group, or contact was edited): refresh every connected phone, coalescing bursts.
let dirTimer = null;
export function scheduleDirectoryPush() {
  clearTimeout(dirTimer);
  dirTimer = setTimeout(() => {
    for (const mac of deviceSockets.keys()) pushDirectory(mac).catch((e) => console.error('unifi directory push', e.message));
  }, 1500);
}

// Contacts created on the phone are saved as the phone owner's AsterFi contacts.
async function saveContactsFromPhone(mac, contacts) {
  const dev = (await q('SELECT assigned_user_id FROM unifi_devices WHERE mac=$1', [mac]))[0];
  if (!dev?.assigned_user_id) return;
  for (const c of contacts) {
    const number = String(c.number || '').replace(/[^0-9*#+]/g, '');
    if (!number) continue;
    const [first, ...rest] = String(c.name || '').trim().split(/\s+/);
    const dup = await q(`SELECT id FROM contacts WHERE owner_id=$1 AND phones @> $2::jsonb`, [dev.assigned_user_id, JSON.stringify([{ number }])]);
    if (dup.length) continue;
    await q('INSERT INTO contacts (owner_id, first_name, last_name, phones) VALUES ($1,$2,$3,$4)',
      [dev.assigned_user_id, first || number, rest.join(' '), JSON.stringify([{ label: 'Mobile', number }])]);
  }
  scheduleDirectoryPush();
}

// A UniFi phone's status menu: "Available", "Do Not Disturb" or "Redirect" (forward calls). The phone sends the
// redirect number, then the status. Both live in AstDB (CF/DND) so calls pick them up immediately.
const STATUS = { available: 'Available', dnd: 'Do Not Disturb', redirect: 'Redirect' };
async function phoneForward(mac, { number, status }) {
  const dev = (await q('SELECT u.extension FROM unifi_devices d JOIN users u ON u.id = d.assigned_user_id WHERE d.mac=$1', [mac]))[0];
  if (!dev || !ami) return;
  // Every change is confirmed back to all of the user's phones, including the one that made it: the phone waits
  // for that echo before it updates its own screen (the status menu looks stuck without it).
  if (status === undefined) { await setForward(ami, dev.extension, { number }); await pushUserState(dev.extension, { redirectOnly: true }); return; }
  const s = String(status);
  await setForward(ami, dev.extension, { on: s === STATUS.redirect });
  await ami.action(s === STATUS.dnd ? { Action: 'DBPut', Family: 'DND', Key: dev.extension, Val: '1' } : { Action: 'DBDel', Family: 'DND', Key: dev.extension }).catch(() => null);
  await pushUserState(dev.extension);
}

// Tell a user's phones their status and redirect number, as the UniFi console does on connect and after changes;
// without it the phone shows Redirect with a blank number. redirectOnly sends just the number (the phone sends its
// number and status separately, and echoing the old status between the two would flip its screen back).
export async function pushUserState(extension, { redirectOnly = false } = {}) {
  if (!ami) return;
  const devs = await q('SELECT d.mac FROM unifi_devices d JOIN users u ON u.id = d.assigned_user_id WHERE u.extension=$1', [extension]);
  if (!devs.length) return;
  const fwd = await getForward(ami, extension);
  const dnd = (await ami.action({ Action: 'DBGet', Family: 'DND', Key: extension }).catch(() => null))?.events?.[0]?.Val === '1';
  const status = fwd.on ? STATUS.redirect : dnd ? STATUS.dnd : STATUS.available;
  for (const { mac } of devs) {
    const ws = deviceSockets.get(mac);
    if (!ws) continue;
    if (!redirectOnly) ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'user_status' }, { status }));
    ws.send(encodeMessage({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'user_redirect_data' }, { redirect: fwd.number ? { number: fwd.number } : {} }));
    console.log(`unifi user-state ${JSON.stringify({ mac, extension, status: redirectOnly ? undefined : status, redirect: fwd.number || null })}`);
  }
}

// Match the device by its WS auth token (Basic sha512(authkey)) and build the SIP config for its assigned user.
async function resolveDeviceConfig(authHeader, deviceIp) {
  const token = /^Basic\s+(.+)$/i.exec(authHeader || '')?.[1]?.trim();
  if (!token) return {};
  const devices = await q('SELECT mac, authkey, assigned_user_id FROM unifi_devices WHERE authkey IS NOT NULL');
  const dev = devices.find((d) => createHash('sha512').update(d.authkey).digest('hex') === token);
  if (!dev) return {};
  if (!dev.assigned_user_id) return { mac: dev.mac };
  const user = (await q('SELECT id, extension, first_name, last_name, sip_password FROM users WHERE id=$1', [dev.assigned_user_id]))[0];
  if (!user) return { mac: dev.mac };
  const host = localAddressFor(deviceIp) || deviceIp; // Asterisk's address on the phone's subnet
  return { mac: dev.mac, profiles: buildProfiles(user, host, { did: await userDid(user) }) };
}
import { decodeInform, encodeInform, parseHeader, macStr, FLAG, DEFAULT_KEY } from './inform.js';

const CAPTURE_DIR = process.env.ASTERFI_UNIFI_DIR || '/var/lib/asterfi/unifi';
const MCAST = '233.89.188.1';
const PORT = 10001;
const KEEP_CAPTURES = 40;

let sock = null;

let ami = null;
export function initUnifi(amiClient) {
  ami = amiClient;
  // call.ended fires just after the call is saved.
  bus.on('event', (ev) => { if (ev.event === 'call.ended') setTimeout(() => addToCallLogs(ev.data.id).catch((e) => console.error('unifi call log', e.message)), 500); });
  startDiscovery();
  startInform();
}

// ---------------------------------------------------------------- discovery
const TLV = {
  0x01: 'hwaddr', 0x02: 'ipinfo', 0x03: 'firmware', 0x0a: 'uptime', 0x0b: 'hostname', 0x0c: 'platform',
  0x0d: 'essid', 0x0e: 'wmode', 0x10: 'systemId', 0x12: 'seq', 0x13: 'serial', 0x14: 'model', 0x15: 'modelDisplay',
  0x16: 'version', 0x17: 'isDefault', 0x18: 'locating', 0x19: 'dhcp', 0x1a: 'dhcpBound', 0x1b: 'reqFirmware', 0x1c: 'sshPort',
};

export function parseDiscovery(buf) {
  if (buf.length < 8) return null;
  const out = { packetVersion: buf[0], cmd: buf[1], tlv: {} };
  let p = 4;
  const end = Math.min(buf.length, 4 + buf.readUInt16BE(2));
  while (p + 3 <= end) {
    const t = buf[p], l = buf.readUInt16BE(p + 1);
    const v = buf.subarray(p + 3, p + 3 + l);
    p += 3 + l;
    const name = TLV[t] || `0x${t.toString(16)}`;
    let val;
    if (t === 0x01 || t === 0x13) val = macStr(v.subarray(0, 6));
    else if (t === 0x02) val = { mac: macStr(v.subarray(0, 6)), ip: [...v.subarray(6, 10)].join('.') };
    else if (t === 0x0a && l === 4) val = v.readUInt32BE(0);
    else if ([0x17, 0x18, 0x19, 0x1a].includes(t)) val = l ? !!v[0] : true;
    else if (t === 0x1c && l === 2) val = v.readUInt16BE(0);
    else val = /^[\x20-\x7e]*$/.test(v.toString('latin1')) ? v.toString('latin1') : v.toString('hex');
    if (name === 'ipinfo') (out.tlv.ipinfo ||= []).push(val);
    else out.tlv[name] = val;
  }
  return out;
}

function startDiscovery() {
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.error('unifi discovery socket', e.message));
  sock.on('message', (msg, rinfo) => {
    if (msg.length <= 4) return; // our own (or another controller's) request
    const d = parseDiscovery(msg);
    if (!d) return;
    const mac = d.tlv.hwaddr || d.tlv.ipinfo?.[0]?.mac || d.tlv.serial;
    if (!mac) return;
    record({
      mac, source: 'discovery', ip: d.tlv.ipinfo?.[0]?.ip || rinfo.address,
      model: d.tlv.platform || d.tlv.model, modelName: d.tlv.modelDisplay || d.tlv.model,
      firmware: d.tlv.firmware || d.tlv.version, hostname: d.tlv.hostname,
      state: d.tlv.isDefault === true ? 'ready to adopt' : d.tlv.isDefault === false ? 'adopted elsewhere' : null,
      discovery: { ...d, from: rinfo.address, raw: msg.toString('hex') },
    }).catch((e) => console.error('unifi record', e.message));
  });
  sock.bind(PORT, () => {
    sock.setBroadcast(true);
    try { sock.addMembership(MCAST); } catch (e) { console.warn('unifi multicast join failed', e.message); }
    scan();
    setInterval(scan, 60000).unref();
  });
}

// Ask every UniFi device on the LAN to announce itself.
export function scan() {
  if (!sock) return;
  const req = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  sock.send(req, PORT, '255.255.255.255');
  sock.send(req, PORT, MCAST);
}

// A self-signed cert for the HTTPS inform endpoint. Talk phones don't validate it during adoption.
function informTls() {
  const keyFile = path.join(CAPTURE_DIR, 'inform-key.pem');
  const certFile = path.join(CAPTURE_DIR, 'inform-cert.pem');
  try {
    if (!existsSync(keyFile) || !existsSync(certFile)) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-keyout', keyFile, '-out', certFile, '-subj', '/CN=UniFi'], { stdio: 'ignore' });
    }
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  } catch (e) {
    console.error('unifi inform cert', e.message);
    return null;
  }
}

// ---------------------------------------------------------------- inform
function startInform() {
  const onRequest = (req, res) => {
    console.error(`unifi REQ ${req.socket.remoteAddress?.replace(/^::ffff:/, '')} ${req.method} ${req.url} up=${req.headers.upgrade || '-'}`);
    // Modern Talk phones (okhttp) open a WebSocket to /device/inform; classic gear POSTs a binary inform.
    if (!/\/inform\b/.test(req.url)) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handleInform(Buffer.concat(chunks), req, res).catch((e) => {
      console.error('unifi inform', e.message);
      res.writeHead(400).end();
    }));
  };
  // Talk phones inform over HTTPS (they don't validate our cert during adoption). Older gear that speaks
  // plain HTTP is routed to an internal HTTP server by peeking the first byte (0x16 = TLS handshake).
  const httpSrv = http.createServer(onRequest);
  const tls = informTls();
  const httpsSrv = tls && https.createServer(tls, onRequest);
  httpsSrv?.on('tlsClientError', (e) => console.error('unifi inform tls', e.message));

  // Modern Talk phones (okhttp) connect to /device/inform as a WebSocket and expect the Talk provisioning
  // protocol over it. For now we accept the socket and log every frame to learn that protocol.
  // Capture mode: refuse the WebSocket (like a UniFi console does) so the phone falls back to a binary inform.
  const refuseWs = process.env.ASTERFI_WS_REFUSE === '1';
  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (req, socket, head) => {
    if (!/\/inform\b/.test(req.url || '')) { socket.destroy(); return; }
    if (refuseWs) {
      console.error(`unifi REFUSE-WS ${req.socket.remoteAddress?.replace(/^::ffff:/, '')} ${req.url}`);
      const body = 'Cannot GET /device/inform';
      socket.write(`HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      console.error(`unifi ws OPEN ${ip} ${req.url}`);
      const log = (kind, obj) => {
        console.error(`unifi ${kind} ${ip} ${JSON.stringify(obj).slice(0, 300)}`);
        saveCapture(`ws-${ip}`, { at: new Date().toISOString(), kind, ...obj }).catch(() => {});
      };
      log('ws-open', { url: req.url, headers: req.headers });
      // Resolve which device/user this is (auth = "Basic sha512(authkey)"), then push its SIP config.
      resolveDeviceConfig(req.headers.authorization, ip).then((ctx) => {
        log('ws-ctx', { assigned: ctx.profiles?.[0]?.numbers?.[0]?.number || null, mac: ctx.mac || null });
        if (ctx.mac) {
          deviceSockets.set(ctx.mac, ws);
          q("UPDATE unifi_devices SET state='online', last_seen=now() WHERE mac=$1", [ctx.mac]).catch(() => {});
          ws.on('close', () => {
            if (deviceSockets.get(ctx.mac) === ws) {
              deviceSockets.delete(ctx.mac);
              q("UPDATE unifi_devices SET state='offline' WHERE mac=$1 AND state='online'", [ctx.mac]).catch(() => {});
            }
          });
        }
        if (ctx.mac) {
          ctx.onProvisioned = () => {
            pushDirectory(ctx.mac).catch((e) => log('directory-error', { message: e.message }));
            pushCallLog(ctx.mac).catch((e) => log('call-log-error', { message: e.message }));
            const ext = ctx.profiles?.[0]?.sip?.user;
            if (ext) pushUserState(ext).catch((e) => log('user-state-error', { message: e.message }));
          };
          ctx.onGetCallLog = () => pushCallLog(ctx.mac).catch((e) => log('call-log-error', { message: e.message }));
          ctx.onCallLogRead = () => phoneLogRead(ctx.mac).catch((e) => log('call-log-error', { message: e.message }));
          ctx.onCreateContacts = (list) => saveContactsFromPhone(ctx.mac, list).catch((e) => log('create-contacts-error', { message: e.message }));
          ctx.onRedirectNumber = (n) => phoneForward(ctx.mac, { number: n }).catch((e) => log('forward-error', { message: e.message }));
          ctx.onStatus = (s) => phoneForward(ctx.mac, { status: s }).catch((e) => log('forward-error', { message: e.message }));
        }
        handleTalkWs(ws, log, ctx);
      }).catch((e) => { log('ws-ctx-error', { message: e.message }); handleTalkWs(ws, log, {}); });
      ws.on('close', (code) => log('ws-close', { code }));
      ws.on('error', (e) => log('ws-error', { message: e.message }));
    });
  };
  httpSrv.on('upgrade', onUpgrade);
  httpsSrv?.on('upgrade', onUpgrade);

  const gate = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('readable', () => {
      const first = sock.read(1);
      if (!first) { sock.destroy(); return; }
      sock.unshift(first);
      ((first[0] === 0x16 && httpsSrv) ? httpsSrv : httpSrv).emit('connection', sock);
    });
  });
  gate.on('error', (e) => console.error('unifi inform server', e.message));
  gate.listen(8080, '0.0.0.0');
}

async function handleInform(buf, req, res) {
  const header = parseHeader(buf);
  const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  // A device we sent set-adopt to encrypts with the key we gave it; everything else uses the factory key.
  const row = (await q('SELECT authkey FROM unifi_devices WHERE mac=$1', [header.mac.toLowerCase()]))[0];
  let decoded = null, error = null, keyHex = DEFAULT_KEY;
  for (const k of [row?.authkey, DEFAULT_KEY].filter(Boolean)) {
    try { decoded = decodeInform(buf, k); keyHex = k; error = null; break; } catch (e) { error = e.message; }
  }
  const ours = !!decoded && keyHex !== DEFAULT_KEY;
  console.error(`unifi INFORM POST from ${ip} mac=${header.mac} len=${buf.length} decoded=${!!decoded} key=${decoded ? (ours ? 'adoption' : 'factory') : 'NONE(' + (error || '').slice(0, 40) + ')'}`);
  const j = decoded?.json || {};
  const capture = {
    receivedAt: new Date().toISOString(), ip, url: req.url, headers: req.headers,
    header: { ...header, iv: header.iv.toString('hex'), flagNames: Object.entries(FLAG).filter(([, v]) => header.flags & v).map(([k]) => k) },
    decryptError: decoded ? null : error, key: decoded ? (ours ? 'adoption key' : 'factory key') : null,
    payload: decoded?.json ?? decoded?.text ?? null,
    rawBase64: error ? buf.toString('base64') : undefined,
  };
  await record({
    mac: header.mac, source: 'inform', ip: j.ip || ip, model: j.model, modelName: j.model_display,
    firmware: j.version, hostname: j.hostname, inform: capture,
    state: !decoded ? 'adopted elsewhere' : ours ? 'adopting' : j.default === false ? 'adopted elsewhere' : 'ready to adopt',
  });
  await saveCapture(header.mac, capture);

  // We can't decrypt devices that another controller owns; say nothing so they keep their config.
  if (!decoded) { res.writeHead(404).end(); return; }
  const reply = encodeInform({
    mac: header.mac, gcm: !!(header.flags & FLAG.GCM), keyHex,
    json: { _type: 'noop', interval: 10, server_time_in_utc: String(Math.floor(Date.now() / 1000)) },
  });
  res.writeHead(200, { 'content-type': 'application/x-binary', connection: 'close' }).end(reply);
}

async function saveCapture(mac, capture) {
  const dir = path.join(CAPTURE_DIR, mac.replace(/:/g, ''));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${Date.now()}.json`), JSON.stringify(capture, null, 2));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_CAPTURES))) await rm(path.join(dir, f), { force: true });
}

async function record(d) {
  await q(
    `INSERT INTO unifi_devices (mac, model, model_name, ip, firmware, hostname, source, state, last_discovery, last_inform, inform_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'discovered'),$9,$10,$11)
     ON CONFLICT (mac) DO UPDATE SET
       model = coalesce(EXCLUDED.model, unifi_devices.model),
       model_name = coalesce(EXCLUDED.model_name, unifi_devices.model_name),
       ip = coalesce(EXCLUDED.ip, unifi_devices.ip),
       firmware = coalesce(EXCLUDED.firmware, unifi_devices.firmware),
       hostname = coalesce(EXCLUDED.hostname, unifi_devices.hostname),
       source = CASE WHEN EXCLUDED.source = 'inform' THEN 'inform' ELSE unifi_devices.source END,
       state = CASE WHEN unifi_devices.authkey IS NOT NULL THEN unifi_devices.state ELSE coalesce($8, unifi_devices.state) END,
       last_discovery = coalesce(EXCLUDED.last_discovery, unifi_devices.last_discovery),
       last_inform = coalesce(EXCLUDED.last_inform, unifi_devices.last_inform),
       inform_count = unifi_devices.inform_count + EXCLUDED.inform_count,
       last_seen = now()`,
    [d.mac.toLowerCase(), d.model || null, d.modelName || null, d.ip || null, d.firmware || null, d.hostname || null,
      d.source, d.state || null, d.discovery ? JSON.stringify(d.discovery) : null, d.inform ? JSON.stringify(d.inform) : null,
      d.source === 'inform' ? 1 : 0]);
}

export const captureDir = CAPTURE_DIR;
