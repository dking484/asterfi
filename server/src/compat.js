// Compares what's actually running with the versions this AsterFi release supports (compatibility.json for
// system software, the installed requirements.txt pins for the Python speech packages). Anything outside them
// is flagged in Settings > System and on the admin dashboard; AsterFi keeps running either way.
import { readFileSync } from 'node:fs';

export const COMPAT = JSON.parse(readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'));

const nums = (v) => String(v).split(/[^0-9]+/).filter(Boolean).map(Number);
// Compares only as many parts as the bound has: "18" covers 18.x, "3.14" covers 3.14.x.
function cmp(version, bound) {
  const a = nums(version), b = nums(bound);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i] ? -1 : 1;
  return 0;
}
export const inRange = (version, { min, max }) => (!min || cmp(version, min) >= 0) && (!max || cmp(version, max) <= 0);

export function rangeText({ min, max }) {
  if (min && max) return min === max ? `${min}.x` : `${min} – ${max}`;
  return min ? `${min} or newer` : max ? `up to ${max}` : 'any';
}

// The pinned speech packages, as installed beside each venv by setup.sh ({ 'faster-whisper': '1.2.1', ... }).
function pins() {
  const out = {};
  for (const venv of ['tts', 'stt']) {
    let text = '';
    try { text = readFileSync(`/opt/asterfi/${venv}/requirements.txt`, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/^([A-Za-z0-9._-]+)==([^\s#;]+)/gm)) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// { status: 'ok' | 'untested' | 'unknown', supported: '22.x' } for one row of versions(). `key` names either
// a compatibility.json component or `pip:<package>`.
export function check(key, version, pinned = pins()) {
  if (!key) return null;
  if (key.startsWith('pip:')) {
    const want = pinned[key.slice(4)];
    if (!want) return null; // installed before pinning, or not installed
    if (!version) return { status: 'unknown', supported: want };
    return { status: version === want ? 'ok' : 'untested', supported: want };
  }
  const c = COMPAT.components[key];
  if (!c) return null;
  if (!version) return { status: 'unknown', supported: rangeText(c) };
  return { status: inRange(version, c) ? 'ok' : 'untested', supported: rangeText(c) };
}

// Adds `compat` to each row of a versions() result; returns the rows that are outside what's supported.
export function annotate(versions) {
  const pinned = pins();
  const issues = [];
  for (const g of versions.groups) {
    for (const row of g.items) {
      row.compat = check(row.key, row.version, pinned);
      if (row.compat?.status === 'untested') issues.push({ name: row.name, version: row.version, supported: row.compat.supported });
    }
  }
  return issues;
}
