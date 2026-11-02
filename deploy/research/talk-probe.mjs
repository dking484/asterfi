// Research tool (NOT part of AsterFi): learn the UniFi Talk adoption + provisioning protocol using only
// this server and the user's OWN UniFi Talk console. The user adopts this decoy from their console; the
// decoy records what the console does, so we can implement the same flow in AsterFi.
//
// Flow:
//   1. Every 15s, broadcast a copy of a real phone's discovery announcement with THIS server's IP and a
//      made-up MAC, so the console's Talk app lists the decoy as adoptable.
//   2. Run an SSH endpoint on 32768 that logs the command the console runs. The console sends
//      "/system/bin/info.sh set-adopt <inform-url> <key>" — we capture <inform-url> and <key>.
//   3. Acting as the adopted device, open the WebSocket the console pointed us at (auth = Basic sha512(key),
//      the scheme a real phone uses) and record every message the console sends: assignment, SIP config, etc.
//
//   node talk-probe.mjs --raw <hex> --ip 192.0.2.10 --log /var/lib/asterfi/unifi/probe.log
import dgram from 'node:dgram';
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { encodeInform, decodeInform } from '/opt/asterfi/server/src/unifi/inform.js';

const require = createRequire('/opt/asterfi/server/package.json');
const { Server } = require('ssh2');
const WebSocket = require('ws');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MY_IP = arg('ip', '192.0.2.10');
const MY_MAC = arg('mac', '74:83:c2:de:c0:01');
const SSH_PORT = Number(arg('port', '32768'));
const LOG = arg('log', '/var/lib/asterfi/unifi/probe.log');
const MINUTES = Number(arg('minutes', '30'));

const record = (type, data) => {
  const entry = { at: new Date().toISOString(), type, ...data };
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  console.log(JSON.stringify(entry).slice(0, 500));
};

// ---- announce ourselves so the console offers to adopt the decoy ----
const mine = Buffer.from(arg('raw'), 'hex');
const swap = (fromHex, toBuf) => {
  const from = Buffer.from(fromHex, 'hex');
  let i = 0;
  while ((i = mine.indexOf(from, i)) !== -1) { toBuf.copy(mine, i); i += toBuf.length; }
};
swap('7483c2bf635b', Buffer.from(MY_MAC.split(':').map((h) => parseInt(h, 16))));
swap('0a00008a', Buffer.from(MY_IP.split('.').map(Number)));
const uuidAt = mine.indexOf(Buffer.from('e167bc74', 'ascii'));
if (uuidAt !== -1) Buffer.from(randomUUID(), 'ascii').copy(mine, uuidAt);
// Announce factory/adoptable state: TLV 0x17 is 01 on a fresh phone, 00 once a controller owns it.
for (let i = 4, end = 4 + mine.readUInt16BE(2); i + 3 <= end;) {
  const t = mine[i]; const l = mine.readUInt16BE(i + 1);
  if (t === 0x17 && l >= 1) mine[i + 3] = 0x01;
  i += 3 + l;
}

const announcer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
announcer.bind(() => {
  announcer.setBroadcast(true);
  const beat = () => announcer.send(mine, 10001, '255.255.255.255');
  beat();
  setInterval(beat, 15000);
  record('started', { ip: MY_IP, mac: MY_MAC, sshPort: SSH_PORT });
});

// ---- after set-adopt, POST a TNBU inform to the console and log its (decrypted) provisioning reply ----
let informSent = false;
function postInform(url, key) {
  if (informSent) return;
  informSent = true;
  const u = new URL(url);
  const payload = {
    mac: MY_MAC, ip: MY_IP, model: 'UVP-TOUCH-MAX', model_display: 'UVP-TOUCH-MAX',
    version: '2.26.3', serial: MY_MAC.replace(/:/g, ''), isdefault: false, inform_url: url,
    uptime: 120, time: Math.floor(Date.now() / 1000), state: 2, adopted: true,
  };
  // Try newer GCM first, then CBC; both with and without zlib if needed.
  const attempts = [{ gcm: true }, { gcm: false }];
  const send = (i) => {
    if (i >= attempts.length) { record('inform-giving-up', {}); return; }
    const body = encodeInform({ mac: MY_MAC, json: payload, keyHex: key, gcm: attempts[i].gcm });
    record('inform-post', { attempt: attempts[i], bytes: body.length, to: url });
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-binary', 'Content-Length': body.length, 'User-Agent': 'okhttp/5.1.0' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) { record('inform-reply-err', { status: res.statusCode, body: buf.toString('utf8').slice(0, 300) }); return send(i + 1); }
        let decoded = null; let err = null;
        try { decoded = decodeInform(buf, key); } catch (e) { err = e.message; }
        record('inform-reply', { status: 200, len: buf.length, decodeError: err, payload: decoded?.json ?? decoded?.text ?? buf.toString('base64').slice(0, 200) });
        return undefined;
      });
    });
    req.on('error', (e) => { record('inform-post-error', { message: e.message }); send(i + 1); });
    req.end(body);
  };
  send(0);
}

let wsStarted = false;
function openConsoleWs(url, key) {
  if (wsStarted) return;
  wsStarted = true;
  const base = url.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
  // Match the URL's scheme first (http -> ws), then try the other transport if that fails.
  const candidates = /^https:/.test(url) ? [`wss://${base}`, `ws://${base}`] : [`ws://${base}`, `wss://${base}`];
  const token = createHash('sha512').update(key).digest('hex'); // Basic sha512(key), as the phone does
  const connect = (i) => {
    if (i >= candidates.length) { record('ws-giving-up', {}); return; }
    const target = candidates[i];
    record('ws-connecting', { target });
    const ws = new WebSocket(target, {
      // Present ourselves exactly like the real phone's okhttp client.
      headers: { Authorization: `Basic ${token}`, 'User-Agent': 'okhttp/5.1.0', 'Accept-Encoding': 'gzip' },
      perMessageDeflate: true,
      rejectUnauthorized: false,
      followRedirects: true,
    });
    let opened = false;
    ws.on('open', () => { opened = true; record('ws-open', { target }); });
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const after = buf.subarray(8).toString('utf8'); // 8-byte prefix then JSON
      record('ws-from-console', { binary: isBinary, prefix: buf.subarray(0, 8).toString('hex'), len: buf.length, body: after.slice(0, 3000) });
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => record('ws-rejected', { target, status: res.statusCode, headers: res.headers, body: body.slice(0, 500) }));
    });
    ws.on('close', (code, reason) => record('ws-close', { target, code, reason: reason.toString().slice(0, 200) }));
    ws.on('error', (e) => { record('ws-error', { target, message: e.message.split('\n')[0] }); if (!opened) connect(i + 1); });
  };
  connect(0);
}

// ---- SSH endpoint: log the console's command, then kick off the WebSocket capture ----
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
  record('ssh-connect', {});
  client.on('authentication', (ctx) => { record('ssh-auth', { method: ctx.method, username: ctx.username }); ctx.accept(); });
  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('pty', (a) => a && a());
      session.on('exec', (accept, _reject, info) => {
        record('ssh-exec', { command: info.command });
        const m = /set-adopt\s+(\S+)\s+(\S+)/.exec(info.command);
        if (m) { record('adopt-parsed', { informUrl: m[1] }); openConsoleWs(m[1], m[2]); }
        const stream = accept();
        stream.write('Broadcast completed: result=0\n');
        stream.exit(0);
        stream.end();
      });
      session.on('shell', (accept) => { const s = accept(); s.write('# '); });
    });
  });
  client.on('error', (e) => record('ssh-error', { message: e.message }));
});
ssh.listen(SSH_PORT, '0.0.0.0', () => record('ssh-listening', { port: SSH_PORT }));

setTimeout(() => { record('stopped', {}); process.exit(0); }, MINUTES * 60000);
