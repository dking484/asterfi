// Research tool: explore a factory-reset UVP-TOUCH-MAX over its SSH, to find the UniFi Talk client app
// (which contains the controller->phone provisioning protocol). The SSH runs one command per exec channel
// with a limited PATH, but full-path binaries execute (proven: /system/bin/info.sh set-adopt worked).
//   node phone-explore.mjs <ip> [port]
import { createRequire } from 'node:module';
const require = createRequire('/opt/asterfi/server/package.json');
const { Client } = require('ssh2');

const IP = process.argv[2];
if (!IP) { console.error('usage: node phone-explore.mjs <phone-ip> [port]'); process.exit(1); }
const PORT = Number(process.argv[3] || 32768);

const COMMANDS = [
  '/system/bin/sh -c "echo SHELL_OK; /system/bin/id; /system/bin/uname -a"',
  '/system/bin/sh -c "/system/bin/getprop ro.build.fingerprint; /system/bin/getprop ro.product.model; /system/bin/getprop ro.build.version.release"',
  '/system/bin/sh -c "/system/bin/ls -la /system/app /system/priv-app /data/app 2>&1 | head -50"',
  '/system/bin/sh -c "/system/bin/ls /system/bin | /system/bin/grep -iE \\"talk|sip|unifi|inform|mca\\""',
  '/system/bin/sh -c "/system/bin/ps -A 2>/dev/null | /system/bin/grep -iE \\"talk|unifi|inform|sip\\" | head -20"',
  '/system/bin/sh -c "/system/bin/find /system /data /vendor -iname \\"*talk*\\" -o -iname \\"*unifi*\\" 2>/dev/null | head -60"',
  '/system/bin/sh -c "/system/bin/cat /proc/version 2>/dev/null; /system/bin/which nc toybox busybox base64 2>/dev/null"',
];

function run(conn, cmd, timeout = 15000) {
  return new Promise((resolve) => {
    let out = '';
    const t = setTimeout(() => resolve(out + '\n(timeout)'), timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); resolve('exec-err: ' + err.message); return; }
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { out += d; });
      stream.on('close', (code) => { clearTimeout(t); resolve(`(exit ${code})\n${out}`); });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  for (const cmd of COMMANDS) {
    const out = await run(conn, cmd);
    console.log(`\n$ ${cmd}\n${out.trim().slice(0, 3000)}`);
  }
  conn.end();
  process.exit(0);
});
conn.on('error', (e) => { console.log('CONNECT ERROR:', e.level === 'client-authentication' ? 'auth rejected (ubnt/ubnt)' : e.message); process.exit(1); });
conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish(['ubnt']));
conn.connect({ host: IP, port: PORT, username: 'ubnt', password: 'ubnt', readyTimeout: 20000, tryKeyboard: true, hostVerifier: () => true });
