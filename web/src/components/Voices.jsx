import { useEffect, useRef, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { api } from '../api.js';

// Text-to-speech settings and voice list, fetched once and shared.
let cache = null;
const listeners = new Set();
export async function loadTts(force = false) {
  if (!cache || force) {
    cache = await api.get('/api/tts');
    listeners.forEach((l) => l(cache));
  }
  return cache;
}
export function useTts() {
  const [tts, setTts] = useState(cache);
  useEffect(() => {
    listeners.add(setTts);
    loadTts().then(setTts).catch(() => {});
    return () => listeners.delete(setTts);
  }, []);
  return tts;
}

export const voiceLabel = (v) => (v ? `${v.name} · ${v.gender}, ${v.language}` : '');

// Voice dropdown grouped by language. `allowDefault` adds "Default voice" (value '').
export function VoiceSelect({ value, onChange, allowDefault, disabled }) {
  const tts = useTts();
  if (!tts) return <select disabled><option>Loading voices…</option></select>;
  const groups = [...new Set(tts.voices.map((v) => v.language))];
  const def = tts.voices.find((v) => v.id === tts.voice);
  return (
    <select value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      {allowDefault && <option value="">Default voice{def ? ` (${def.name})` : ''}</option>}
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {tts.voices.filter((v) => v.language === g).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.gender}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// Plays a sample of `text` in `voice` without saving anything.
export function PreviewButton({ text, voice, speed, label = 'Preview' }) {
  const [state, setState] = useState('idle'); // idle | loading | playing
  const audio = useRef(null);
  useEffect(() => () => audio.current?.pause(), []);
  const go = async () => {
    if (state === 'playing') { audio.current?.pause(); setState('idle'); return; }
    setState('loading');
    try {
      const r = await fetch('/api/tts/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice, speed }) });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      audio.current = new Audio(url);
      audio.current.onended = () => { setState('idle'); URL.revokeObjectURL(url); };
      await audio.current.play();
      setState('playing');
    } catch {
      setState('idle');
    }
  };
  return (
    <button type="button" className="btn sm" style={{ flex: '0 0 auto' }} disabled={!String(text || '').trim()} onClick={go}>
      {state === 'loading' ? <Loader2 size={13} className="spin" /> : state === 'playing' ? <Square size={13} /> : <Play size={13} />}
      {state === 'loading' ? 'Generating…' : state === 'playing' ? 'Stop' : label}
    </button>
  );
}
