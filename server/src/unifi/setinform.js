// Points a factory-default UniFi device at AsterFi, the way a UniFi console adopts: SSH in with the
// device's login (ubnt/ubnt after a reset) and run set-adopt. Credentials are used once and never stored.
import os from 'node:os';
import { Client } from 'ssh2';

const toInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

// AsterFi's own address on the device's subnet, so the device can reach the inform port.
export function localAddressFor(deviceIp) {
  const d = toInt(deviceIp);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if ((toInt(a.address) & mask) === (d & mask)) return a.address;
    }
  }
  return null;
}

const NOT_FOUND = /not found|unknown command|invalid command|no such|usage:/i;

// Talk phones allow no terminal and only accept a fixed set of commands, one per exec channel.
// The exact command a UniFi Talk console sends, captured from a real console adopting a Touch Max:
//   /system/bin/info.sh set-adopt <inform url> <key>
// The device then encrypts its check-ins with <key>. The rest are fallbacks for other firmwares.
const COMMANDS = (url, key) => [
  `/system/bin/info.sh set-adopt ${url} ${key}`,
  `info.sh set-adopt ${url} ${key}`,
  `/usr/bin/syswrapper.sh set-adopt ${url} ${key}`,
  `mca-cli-op set-adopt ${url} ${key}`,
  `set-inform ${url}`,
];

function run(conn, cmd, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    const t = setTimeout(() => resolve({ cmd, code: null, out: `${out}\n(no reply)` }), timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); resolve({ cmd, code: null, out: err.message }); return; }
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { out += d; });
      stream.on('close', (code) => { clearTimeout(t); resolve({ cmd, code, out: out.trim() }); });
    });
  });
}

export function setInform(ip, url, { key, port = 22, username = 'ubnt', password = 'ubnt', timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const conn = new Client();
    const log = [];
    let settled = false;
    const hide = (s) => s.split(key).join('<key>'); // the key never appears in the saved transcript
    const transcript = () => log.map((r) => [`$ ${hide(r.cmd)}`, r.out, r.code !== null ? `(exit ${r.code})` : ''].filter(Boolean).join('\n')).join('\n\n').slice(-4000);
    const done = (r) => { if (settled) return; settled = true; conn.end(); resolve({ ...r, output: transcript() }); };
    conn.on('ready', async () => {
      let accepted = null;
      for (const cmd of COMMANDS(url, key)) {
        const r = await run(conn, cmd);
        log.push(r);
        if (r.code === 0 && !NOT_FOUND.test(r.out)) { accepted = r; break; }
      }
      done(accepted
        ? { ok: true, unconfirmed: !/adoption request sent/i.test(accepted.out), command: hide(accepted.cmd) }
        : { ok: false, error: "The phone didn't accept set-adopt or set-inform. What it said is below." });
    });
    conn.on('error', (e) => done({
      ok: false,
      error: e.level === 'client-authentication'
        ? "The device didn't accept that username and password. A factory-reset device uses ubnt / ubnt."
        : `Couldn't connect to the device: ${e.message}`,
    }));
    conn.connect({
      host: ip, port, username, password, readyTimeout: timeout,
      tryKeyboard: true, hostVerifier: () => true, // factory devices have new host keys each reset
    });
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)));
  });
}
