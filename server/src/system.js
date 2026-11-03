// Settings > System: host health, performance (with a 24-hour history), storage, and the version of every
// component AsterFi runs on. Linux details come from /proc, ps and systemctl; elsewhere they're left out.
import os from 'node:os';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { activeCalls } from './calltracker.js';

const SERVER_DIR = new URL('..', import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));
export const asterfiVersion = async () => (await readJson(new URL('package.json', SERVER_DIR)).catch(() => ({}))).version || 'unknown';

// stdout + stderr of a command ('' if it's missing or fails). Many tools print their version on stderr.
const run = (cmd, args = [], timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`.trim()));
});
const match = (text, re) => (re.exec(text || '') || [])[1] || null;

// ---- performance -----------------------------------------------------------------------------------
const cpuTimes = () => os.cpus().reduce((t, c) => {
  const total = Object.values(c.times).reduce((a, b) => a + b, 0);
  return { idle: t.idle + c.times.idle, total: t.total + total };
}, { idle: 0, total: 0 });
// Share of CPU time busy since `prev`, 0–100.
const busySince = (prev, cur) => (cur.total > prev.total ? Math.round(1000 * (1 - (cur.idle - prev.idle) / (cur.total - prev.total))) / 10 : 0);

async function memory() {
  const info = await readFile('/proc/meminfo', 'utf8').catch(() => '');
  const kb = (k) => Number(match(info, new RegExp(`^${k}:\\s+(\\d+)`, 'm'))) * 1024;
  const total = kb('MemTotal') || os.totalmem();
  const available = info ? kb('MemAvailable') : os.freemem();
  return { total, used: total - available, swapTotal: kb('SwapTotal') || 0, swapUsed: (kb('SwapTotal') - kb('SwapFree')) || 0 };
}

async function disk(dir = '/') {
  try {
    const s = await statfs(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch { return null; }
}

// Live: CPU over the last few seconds. History: one point a minute for 24 hours (kept in memory, so it
// starts over when the service restarts).
const HISTORY_MINUTES = 24 * 60;
const history = [];
let fast = { base: cpuTimes(), busy: 0 };
let slowBase = cpuTimes();
setInterval(() => { const cur = cpuTimes(); fast = { base: cur, busy: busySince(fast.base, cur) }; }, 5000).unref();
setInterval(async () => {
  const cur = cpuTimes();
  const m = await memory();
  history.push({ at: Date.now(), cpu: busySince(slowBase, cur), memory: m.used, load: os.loadavg()[0], calls: activeCalls().length });
  slowBase = cur;
  if (history.length > HISTORY_MINUTES) history.splice(0, history.length - HISTORY_MINUTES);
}, 60000).unref();

// Memory of the programs that make up the phone system, summed across their processes.
const PROGRAMS = { asterisk: 'Asterisk', node: 'AsterFi service', postgres: 'PostgreSQL', nginx: 'nginx', python3: 'Speech models (while running)' };
async function programMemory() {
  if (process.platform !== 'linux') return [];
  const sums = {};
  for (const line of (await run('ps', ['-eo', 'rss=,comm='])).split('\n')) {
    const [rss, comm] = line.trim().split(/\s+/, 2);
    const name = comm?.startsWith('python') ? 'python3' : comm;
    if (PROGRAMS[name]) sums[name] = (sums[name] || 0) + Number(rss) * 1024;
  }
  return Object.entries(sums).map(([k, bytes]) => ({ name: PROGRAMS[k], bytes })).sort((a, b) => b.bytes - a.bytes);
}

const SERVICES = ['asterfi', 'asterisk', 'postgresql', 'nginx', 'asterfi-backup.timer'];
async function services() {
  if (process.platform !== 'linux') return [];
  const states = (await run('systemctl', ['is-active', ...SERVICES])).split('\n');
  return SERVICES.map((name, i) => ({ name, state: states[i] || 'unknown' }));
}

export async function performance() {
  const [mem, root, programs, svc] = await Promise.all([memory(), disk('/'), programMemory(), services()]);
  const cpus = os.cpus();
  return {
    cpu: { cores: cpus.length, model: cpus[0]?.model?.trim() || null, busy: fast.busy, load: os.loadavg() },
    memory: mem, disk: root, programs, services: svc, history,
  };
}

// ---- host ------------------------------------------------------------------------------------------
export async function host() {
  const rel = await readFile('/etc/os-release', 'utf8').catch(() => '');
  return {
    hostname: os.hostname(),
    os: match(rel, /^PRETTY_NAME="?([^"\n]+)/m) || `${os.type()} ${os.release()}`,
    kernel: os.release(), arch: os.arch(),
    uptime: Math.round(os.uptime()), serviceUptime: Math.round(process.uptime()),
  };
}

// ---- storage (walking the spool takes a moment, so it's cached) --------------------------------------
async function dirSize(dir, budget = { files: 100000 }) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (budget.files-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p, budget);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
let storageCache = { at: 0, value: null };
export async function storage(q, recordingsDir) {
  if (storageCache.value && Date.now() - storageCache.at < 10 * 60 * 1000) return storageCache.value;
  const [voicemail, recordings, backups, prompts, db] = await Promise.all([
    dirSize(config.voicemailSpool), dirSize(recordingsDir), dirSize('/var/backups/asterfi'), dirSize(config.soundsDir),
    q('SELECT pg_database_size(current_database())::bigint AS n').then((r) => Number(r[0].n)).catch(() => null),
  ]);
  storageCache = { at: Date.now(), value: { voicemail, recordings, backups, prompts, database: db } };
  return storageCache.value;
}

// ---- versions --------------------------------------------------------------------------------------
const nodeModuleVersion = (name) => readJson(new URL(`node_modules/${name}/package.json`, SERVER_DIR)).then((j) => j.version).catch(() => null);
const pythonPackages = async (venv, names) => {
  const py = `/opt/asterfi/${venv}/venv/bin/python`;
  const script = `import importlib.metadata as m, json\nout = {}\nfor n in ${JSON.stringify(names)}:\n    try: out[n] = m.version(n)\n    except Exception: pass\nprint(json.dumps(out))`;
  try { return JSON.parse((await run(py, ['-c', script], 20000)).split('\n').pop() || '{}'); } catch { return {}; }
};

let versionCache = null;
// Every component AsterFi uses, grouped for display. `refresh` re-reads them (e.g. after apt upgrades).
export async function versions(ami, q, { refresh = false } = {}) {
  if (versionCache && !refresh) return versionCache;
  const [asterisk, pg, nginx, ffmpeg, sox, lame, flite, python, tts, stt, whisperModels, kokoroModels, ...libs] = await Promise.all([
    ami.command('core show version').catch(() => ''),
    q("SELECT current_setting('server_version') AS v").then((r) => r[0].v).catch(() => null),
    run('nginx', ['-v']), run('ffmpeg', ['-version']), run('sox', ['--version']), run('lame', ['--version']), run('flite', ['--version']),
    run('python3', ['--version']),
    pythonPackages('tts', ['kokoro-onnx', 'onnxruntime']),
    pythonPackages('stt', ['faster-whisper', 'ctranslate2', 'av', 'numpy']),
    readdir('/opt/asterfi/stt/models').then((d) => d.map((x) => match(x, /^models--Systran--faster-whisper-(.+)$/)).filter(Boolean)).catch(() => []),
    readdir('/opt/asterfi/tts/models').then((d) => d.filter((x) => x.endsWith('.onnx'))).catch(() => []),
    ...['fastify', '@fastify/cookie', '@fastify/multipart', '@fastify/static', 'pg', 'nodemailer', 'ws', 'ssh2'].map(nodeModuleVersion),
  ]);
  const [fastify, cookie, multipart, staticV, pgLib, nodemailer, ws, ssh2] = libs;
  const h = await host();
  // `key` ties a row to its supported range in compat.js (a compatibility.json component, or pip:<package>).
  const row = (name, version, purpose, key = null) => ({ name, version: version || null, purpose, key });
  versionCache = {
    checkedAt: new Date(),
    groups: [
      { name: 'Phone system', items: [
        row('AsterFi', await asterfiVersion(), 'This web console and management service'),
        row('Asterisk', match(asterisk, /^Asterisk (\d[\w.]*)/), 'Calls, voicemail, queues and call flows', 'asterisk'),
        row('PostgreSQL', pg && pg.split(' ')[0], 'Database for users, calls and settings', 'postgresql'),
        row('Node.js', process.versions.node, 'Runs the AsterFi service', 'node'),
        row('nginx', match(nginx, /nginx\/([\d.]+)/), 'Web server and HTTPS', 'nginx'),
        row('Operating system', h.os, 'Runs everything above'),
        row('Linux kernel', h.kernel, `${h.arch} processor architecture`),
      ] },
      { name: 'Audio and speech', items: [
        row('FFmpeg', match(ffmpeg, /ffmpeg version (\S+?)(?:-\d+ubuntu\S*)?\s/) || match(ffmpeg, /ffmpeg version (\S+)/), 'Converts uploads and voicemail audio', 'ffmpeg'),
        row('SoX', match(sox, /v([\d.]+)/), 'Audio processing'),
        row('LAME', match(lame, /version ([\d.]+)/), 'MP3 encoding for voicemail emails'),
        row('Flite', match(flite, /flite-([\d.]+)/), 'Basic text-to-speech voice'),
        row('Python', match(python, /Python ([\d.]+)/), 'Runs the speech models', 'python'),
        row('Kokoro (kokoro-onnx)', tts['kokoro-onnx'], `Natural text-to-speech voices${kokoroModels.length ? ` · model ${kokoroModels.join(', ')}` : ''}`, 'pip:kokoro-onnx'),
        row('ONNX Runtime', tts.onnxruntime || stt.onnxruntime, 'Runs the Kokoro model', 'pip:onnxruntime'),
        row('faster-whisper', stt['faster-whisper'], `Voicemail transcription${whisperModels.length ? ` · models ${whisperModels.join(', ')}` : ''}`, 'pip:faster-whisper'),
        row('CTranslate2', stt.ctranslate2, 'Runs the Whisper model', 'pip:ctranslate2'),
        row('PyAV', stt.av, 'Audio decoding library used by faster-whisper', 'pip:av'),
        row('NumPy', stt.numpy || tts.numpy, 'Audio samples for the speech models', 'pip:numpy'),
      ] },
      { name: 'Server libraries', items: [
        row('Fastify', fastify, 'Web server framework for the API'),
        row('@fastify/cookie, multipart, static', [cookie, multipart, staticV].filter(Boolean).join(' · '), 'Sign-in cookies, uploads and serving the console'),
        row('node-postgres (pg)', pgLib, 'Database driver'),
        row('Nodemailer', nodemailer, 'Sends notification emails'),
        row('ws', ws, 'WebSockets for UniFi Talk phones'),
        row('ssh2', ssh2, 'Adopting UniFi Talk phones over SSH'),
      ] },
    ],
  };
  return versionCache;
}
