// Audio prompts for call flows: uploaded files, text-to-speech, or recorded from a phone (*77<id>).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getSetting } from './db.js';

const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.slice(-300)}`))));
  if (input !== undefined) p.stdin.end(input);
});

export const promptFile = (id, ext = 'wav') => path.join(config.soundsDir, `prompt-${Number(id)}.${ext}`);

// Write the 8 kHz .wav Asterisk plays to narrowband phones and a 16 kHz .wav16 for G.722.
async function convertInto(id, src, file = (ext) => promptFile(id, ext)) {
  await mkdir(config.soundsDir, { recursive: true });
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '8000', '-acodec', 'pcm_s16le', '-f', 'wav', file('wav')]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', file('wav16')]);
}

export async function saveUpload(id, buffer) {
  const tmp = path.join(os.tmpdir(), `asterfi-upload-${id}-${Date.now()}`);
  await writeFile(tmp, buffer);
  try { await convertInto(id, tmp); } finally { await rm(tmp, { force: true }); }
}

// ---- text-to-speech ------------------------------------------------------
const KOKORO = process.env.ASTERFI_KOKORO || '/opt/asterfi/tts/kokoro_tts.py';
const KOKORO_PY = '/opt/asterfi/tts/venv/bin/python';
export const kokoroAvailable = () => existsSync(KOKORO) && existsSync(KOKORO_PY);

const LANGS = { a: 'American English', b: 'British English', e: 'Spanish' };
const NAMES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_nova', 'af_jessica', 'af_river', 'af_aoede', 'af_kore', 'af_alloy',
  'am_michael', 'am_adam', 'am_eric', 'am_liam', 'am_echo', 'am_onyx', 'am_puck', 'am_fenrir',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'bm_george', 'bm_daniel', 'bm_lewis', 'bm_fable', 'ef_dora', 'em_alex'];
export const KOKORO_VOICES = NAMES.map((id) => ({
  id, name: id.slice(3).replace(/^./, (c) => c.toUpperCase()),
  language: LANGS[id[0]], gender: id[1] === 'f' ? 'Female' : 'Male',
}));

// One Kokoro run at a time: each needs ~400 MB and the whole CPU on this server.
let queue = Promise.resolve();
const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

// Renders text to a WAV file using the configured engine; falls back to Flite if Kokoro fails.
export async function renderTts(text, out, { voice, speed } = {}) {
  const s = await getSetting('tts');
  const engine = s.engine === 'flite' || !kokoroAvailable() ? 'flite' : 'kokoro';
  if (engine === 'kokoro') {
    try {
      await serial(() => run(KOKORO_PY, [KOKORO, '--out', out, '--voice', voice || s.voice || 'af_heart', '--speed', String(speed || s.speed || 1)], text));
      return 'kokoro';
    } catch (e) {
      console.error('kokoro failed, using flite:', e.message);
    }
  }
  await run('flite', ['-voice', 'slt', '-t', text, '-o', out]);
  return 'flite';
}

export async function saveTts(id, text, voice) {
  const tmp = path.join(os.tmpdir(), `asterfi-tts-${id}-${Date.now()}.wav`);
  try {
    await renderTts(text, tmp, { voice });
    await convertInto(id, tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

// A built-in prompt (asterfi/<name>), spoken once with the current TTS settings and kept.
export async function ensureSystemPrompt(name, text) {
  const file = (ext) => path.join(config.soundsDir, `${name}.${ext}`);
  if (existsSync(file('wav'))) return;
  const tmp = path.join(os.tmpdir(), `asterfi-sys-${name}-${Date.now()}.wav`);
  try {
    await renderTts(text, tmp);
    await convertInto(null, tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function removePrompt(id) {
  for (const ext of ['wav', 'wav16']) await rm(promptFile(id, ext), { force: true });
}
