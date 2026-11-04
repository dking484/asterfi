// Settings > System: service status and restarts, log viewing (recent lines, or followed live) and the
// Asterisk console. Restarts go through a sudo rule the installer writes (/etc/sudoers.d/asterfi) that lets
// the service account run only "systemctl start|restart" on these units; Asterisk can also be restarted over AMI.
import { spawn, execFile } from 'node:child_process';
import { access, rm, open, constants } from 'node:fs/promises';

export const SERVICES = [
  { unit: 'asterisk', name: 'Asterisk', about: 'Phone calls, voicemail and SIP', restart: true },
  { unit: 'asterfi', name: 'AsterFi service', about: 'This web console, the API and phone provisioning', restart: true },
  { unit: 'postgresql', name: 'PostgreSQL', about: 'The database', restart: true },
  { unit: 'nginx', name: 'nginx', about: 'HTTPS for the web console and the phonebook', restart: true },
  { unit: 'asterfi-backup.timer', name: 'Nightly backup', about: 'Backs up the database, configuration and voicemail', restart: false },
];
const unitOf = (u) => SERVICES.find((s) => s.unit === u);

const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}`, err: `${stderr || ''}`.trim() || err?.message || '' }));
});

const PROPS = ['ActiveState', 'SubState', 'ActiveEnterTimestamp', 'StateChangeTimestamp', 'NRestarts', 'MemoryCurrent', 'Result', 'UnitFileState', 'LoadState'];
export async function serviceStatus() {
  if (process.platform !== 'linux') return [];
  return Promise.all(SERVICES.map(async (s) => {
    const { out } = await run('systemctl', ['show', s.unit, '--no-pager', ...PROPS.map((p) => `-p${p}`)]);
    const p = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const mem = Number(p.MemoryCurrent);
    return {
      ...s, state: p.ActiveState || 'unknown', sub: p.SubState || null, result: p.Result || null,
      installed: p.LoadState !== 'not-found', enabled: p.UnitFileState || null,
      since: p.StateChangeTimestamp ? new Date(p.StateChangeTimestamp).toISOString() : null,
      restarts: Number(p.NRestarts) || 0, memory: Number.isFinite(mem) && mem < 2 ** 60 ? mem : null,
    };
  }));
}

// Restarting the AsterFi service ends this process, so it's done after the reply has gone out.
export async function controlService(unit, action, ami) {
  const s = unitOf(unit);
  if (!s || !s.restart) throw Object.assign(new Error('That service can’t be restarted from here.'), { status: 400 });
  if (!['restart', 'start'].includes(action)) throw Object.assign(new Error('Unknown action.'), { status: 400 });
  const go = () => run('sudo', ['-n', 'systemctl', action, unit], 60000);
  if (unit === 'asterfi') { setTimeout(go, 500); return { ok: true, pending: true }; }
  const r = await go();
  if (r.ok) return { ok: true };
  // Without the sudo rule (an older install), Asterisk can still restart itself over AMI.
  if (unit === 'asterisk' && action === 'restart' && ami?.connected) {
    ami.command('core restart now').catch(() => {});
    return { ok: true, via: 'ami' };
  }
  const noSudo = /password is required|not allowed|a terminal is required|sudo: /i.test(r.err);
  throw Object.assign(new Error(noSudo
    ? 'AsterFi isn’t allowed to restart services on this server yet. Run the installer again (sudo ./install.sh) to add the permission.'
    : `systemctl ${action} ${unit} failed: ${r.err.split('\n').slice(-3).join(' ')}`), { status: 400 });
}

// ---- logs ------------------------------------------------------------------------------------------
const ASTERISK_LOG = '/var/log/asterisk/messages.log';
export const LOG_SOURCES = [
  { id: 'asterisk', name: 'Asterisk', file: ASTERISK_LOG },
  { id: 'asterfi', name: 'AsterFi service', unit: 'asterfi' },
  { id: 'asterisk-service', name: 'Asterisk service (start/stop)', unit: 'asterisk' },
  { id: 'nginx', name: 'nginx errors', file: '/var/log/nginx/error.log', unit: 'nginx' },
  { id: 'postgresql', name: 'PostgreSQL', unit: 'postgresql*' },
  { id: 'backup', name: 'Nightly backup', unit: 'asterfi-backup' },
  { id: 'install', name: 'Last install or update', file: '/var/log/asterfi-install.log' },
];
const sourceOf = (id) => {
  const s = LOG_SOURCES.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error('Unknown log.'), { status: 400 });
  return s;
};
const MAX_LINES = 5000;
// The install log is full of terminal colour codes; key generation fills the AsterFi log with dots.
const clean = (l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
const noise = (l) => /^[.+*\-]{40,}$/.test(l.trim().replace(/^.*?node\[\d+\]: /, ''));

async function tailFile(file, lines) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const want = Math.min(size, lines * 400);
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, size - want);
    const all = buf.toString('utf8').split('\n');
    if (want < size) all.shift(); // partial first line
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines);
  } finally { await fh.close(); }
}

function journalArgs(unit, { lines, follow }) {
  return ['--no-pager', '-o', 'short-iso', '-u', unit, ...(follow ? ['-f', '-n', '0'] : ['-n', String(lines)])];
}
// The service account reads the journal through the systemd-journal group the installer adds it to.
const journalHelp = 'AsterFi isn’t allowed to read the system journal yet. Run the installer again (sudo ./install.sh) to add the permission.';

// Which file or journal to use: a source with a file uses it when it's readable, else the journal.
async function pick(s) {
  if (s.file) {
    try { await access(s.file, constants.R_OK); return { file: s.file }; }
    catch (e) { if (!s.unit) throw Object.assign(new Error(e.code === 'EACCES' ? `AsterFi can’t read ${s.file}. Run the installer again (sudo ./install.sh) to add the permission.` : `${s.file} doesn’t exist yet.`), { status: 400 }); }
  }
  return { unit: s.unit };
}

export async function readLog(id, { lines = 500, filter = '' } = {}) {
  const s = sourceOf(id);
  lines = Math.max(10, Math.min(MAX_LINES, Number(lines) || 500));
  const src = await pick(s);
  let out;
  if (src.file) out = await tailFile(src.file, filter ? MAX_LINES : lines);
  else {
    const r = await run('journalctl', journalArgs(src.unit, { lines: filter ? MAX_LINES : lines }));
    if (!r.ok && !r.out) throw Object.assign(new Error(r.err || 'journalctl failed'), { status: 400 });
    if (/not seeing messages from other users|insufficient permissions/i.test(r.err)) throw Object.assign(new Error(journalHelp), { status: 400 });
    out = r.out.split('\n').filter((l) => l && !/^-- No entries --$/.test(l));
  }
  out = out.map(clean).filter((l) => !noise(l));
  if (filter) { const f = filter.toLowerCase(); out = out.filter((l) => l.toLowerCase().includes(f)).slice(-lines); }
  return { source: s.id, from: src.file || `journal: ${src.unit}`, lines: out };
}

// Follows a log, calling onLine for each new line until the returned stop() is called.
export async function followLog(id, onLine) {
  const s = sourceOf(id);
  const src = await pick(s);
  const p = src.file ? spawn('tail', ['-n', '0', '-F', src.file]) : spawn('journalctl', journalArgs(src.unit, { follow: true }));
  return lineStream(p, (l) => { l = clean(l); if (!noise(l)) onLine(l); });
}

function lineStream(p, onLine) {
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    parts.forEach((l) => l && onLine(l));
  });
  p.on('error', () => {});
  return () => { try { p.kill(); } catch { /* already gone */ } };
}

// ---- Asterisk console ------------------------------------------------------------------------------
// Commands that would stop Asterisk or drop calls, which the console asks to confirm first.
export const DISRUPTIVE = /^\s*(core\s+(stop|restart)|module\s+unload|channel\s+request\s+hangup|hangup\s+request|pjsip\s+send\s+unregister)\b/i;

export async function cli(ami, command) {
  command = String(command || '').trim();
  if (!command) throw Object.assign(new Error('Enter a command.'), { status: 400 });
  if (command.length > 500 || /[\r\n]/.test(command)) throw Object.assign(new Error('Enter one command at a time.'), { status: 400 });
  if (!ami?.connected) throw Object.assign(new Error('Asterisk is not connected.'), { status: 400 });
  // "core restart"/"core stop" drop the AMI connection, so there's no output to wait for.
  if (/^\s*core\s+(stop|restart)\b/i.test(command)) { ami.command(command).catch(() => {}); return { output: 'Sent. Asterisk is going down; the console reconnects when it’s back.' }; }
  return { output: await ami.command(command) };
}

// Live console output: while someone has the console open, Asterisk also writes its verbose output to a
// temporary log channel (not kept across Asterisk restarts, so it's added again when AMI reconnects).
const CONSOLE_LOG = '/var/log/asterisk/asterfi-console.log';
const viewers = new Set();
let tailStop = null;
let amiRef = null;

async function addChannel() {
  if (!amiRef?.connected) return;
  const have = await amiRef.command('logger show channels').catch(() => '');
  // The listing truncates long paths. verbose(3) gives this channel its own level: under systemd
  // Asterisk's own verbosity is 0, which would leave out call progress.
  if (!have.includes('asterfi-console')) await amiRef.command(`logger add channel ${CONSOLE_LOG} notice,warning,error,verbose(3),dtmf`).catch(() => {});
}
async function startTail() {
  await addChannel();
  if (tailStop) return;
  // -F keeps following once Asterisk creates the file.
  // Each "asterisk -rx" on the server logs a connect and disconnect; leave those out.
  tailStop = lineStream(spawn('tail', ['-n', '0', '-F', CONSOLE_LOG]), (l) => {
    if (!/asterisk\.c: Remote UNIX connection( disconnected)?$/.test(l)) viewers.forEach((v) => v(l));
  });
}
async function stopTail() {
  tailStop?.();
  tailStop = null;
  if (amiRef?.connected) await amiRef.command(`logger remove channel ${CONSOLE_LOG}`).catch(() => {});
  await rm(CONSOLE_LOG, { force: true }).catch(() => {});
}

export function initConsole(ami) {
  amiRef = ami;
  // Asterisk drops the channel when it restarts, so add it back. With no one watching, clear out one left
  // behind if AsterFi stopped while the console was open.
  ami.on('connected', () => (viewers.size ? addChannel() : stopTail()));
}

export async function watchConsole(onLine) {
  viewers.add(onLine);
  if (viewers.size === 1) await startTail();
  return async () => {
    viewers.delete(onLine);
    if (!viewers.size) await stopTail();
  };
}
