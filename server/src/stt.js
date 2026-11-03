// Voicemail transcription with faster-whisper, run locally on the CPU (deploy/stt/whisper_stt.py).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { getSetting } from './db.js';

const STT = process.env.ASTERFI_STT || '/opt/asterfi/stt/whisper_stt.py';
const STT_PY = process.env.ASTERFI_STT_PYTHON || '/opt/asterfi/stt/venv/bin/python';
const TIMEOUT_MS = 5 * 60 * 1000;

export const sttAvailable = () => existsSync(STT) && existsSync(STT_PY);
export const STT_MODELS = [
  { id: 'base.en', name: 'Base: fast, good for clear speech' },
  { id: 'small.en', name: 'Small: more accurate, about 3× slower, needs ~1 GB free memory' },
];

export async function sttSettings() {
  const s = await getSetting('stt');
  return { enabled: !!s.enabled, model: STT_MODELS.some((m) => m.id === s.model) ? s.model : 'base.en', available: sttAvailable() };
}

// One transcription at a time: each takes the whole CPU for a few seconds.
let queue = Promise.resolve();
const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

// The text spoken in a WAV file ('' when there's no speech). Throws if transcription isn't installed or fails.
export function transcribe(wavFile, model) {
  if (!sttAvailable()) return Promise.reject(new Error('Voicemail transcription is not installed on this server.'));
  return serial(() => new Promise((resolve, reject) => {
    const p = spawn(STT_PY, [STT, '--model', model || 'base.en', wavFile], { env: { ...process.env, HF_HUB_OFFLINE: '1' } });
    // Lowest CPU priority, so Asterisk (call audio) always runs first on a small server.
    try { os.setPriority(p.pid, 19); } catch { /* not permitted here; runs at normal priority */ }
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`transcription failed (${code ?? 'timed out'}): ${err.trim().split('\n').pop() || 'no output'}`));
    });
  }));
}
