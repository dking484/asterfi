import { useCallback, useEffect, useRef, useState } from 'react';
import JsSIP from 'jssip';
import { Phone, PhoneOff, PhoneIncoming, Mic, MicOff, Pause, Play, Grid3x3, X, Delete } from 'lucide-react';
import { api, formatNumber, fmtDuration } from '../api.js';
import { Switch } from './ui.jsx';

const STORE = 'asterfi.webphone.enabled';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const SUB = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };
const CALL_OPTS = { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [], rtcpMuxPolicy: 'require' } };

// e.g. "Chrome on Windows", shown on the Phones page so admins can tell browsers apart.
function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

const readPref = () => { try { return localStorage.getItem(STORE) === '1'; } catch { return false; } };
const writePref = (v) => { try { localStorage.setItem(STORE, v ? '1' : '0'); } catch { /* private mode */ } };

// Ring (incoming) and ringback (outgoing) tones: 440+480 Hz, 2 s on / 4 s off.
function useTones() {
  const ctx = useRef(null);
  const stopRef = useRef(null);
  const stop = useCallback(() => { stopRef.current?.(); stopRef.current = null; }, []);
  const play = useCallback((kind) => {
    stop();
    ctx.current ||= new (window.AudioContext || window.webkitAudioContext)();
    const ac = ctx.current;
    ac.resume?.();
    const gain = ac.createGain();
    gain.gain.value = 0;
    gain.connect(ac.destination);
    const oscs = [440, 480].map((f) => { const o = ac.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o; });
    const level = kind === 'ring' ? 0.12 : 0.04;
    let second = 0;
    const step = () => { gain.gain.setTargetAtTime(second % 6 < 2 ? level : 0, ac.currentTime, 0.01); second += 1; };
    step();
    const t = setInterval(step, 1000);
    stopRef.current = () => { clearInterval(t); oscs.forEach((o) => o.stop()); gain.disconnect(); };
  }, [stop]);
  return { play, stop };
}

export default function WebPhone({ me }) {
  const [enabled, setEnabled] = useState(readPref);
  const [open, setOpen] = useState(false);
  const [reg, setReg] = useState({ state: 'off', error: '' });
  const [number, setNumber] = useState('');
  const [call, setCall] = useState(null); // { direction, remote, remoteName, state, startedAt, muted, held }
  const [showKeys, setShowKeys] = useState(false);
  const [notice, setNotice] = useState('');
  const [, tick] = useState(0);
  const ua = useRef(null);
  const session = useRef(null);
  const audio = useRef(null);
  const micStream = useRef(null); // mic stream we opened for an outgoing call; stopped when it ends
  const tones = useTones();
  const secure = window.isSecureContext;

  // Connect / disconnect the SIP user agent.
  useEffect(() => {
    if (!enabled || !secure) { setReg({ state: 'off', error: '' }); return undefined; }
    let stopped = false;
    let agent = null;
    (async () => {
      setReg({ state: 'connecting', error: '' });
      try {
        const c = await api.get('/api/my/webphone');
        if (stopped) return;
        const socket = new JsSIP.WebSocketInterface(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${c.wsPath}`);
        agent = new JsSIP.UA({
          sockets: [socket], uri: `sip:${c.authUser}@${window.location.hostname}`, password: c.password,
          display_name: c.displayName, register: true, session_timers: false, user_agent: `AsterFi Web Phone (${browserName()})`,
        });
        agent.on('registered', () => setReg({ state: 'registered', error: '' }));
        agent.on('unregistered', () => setReg((r) => (r.state === 'failed' ? r : { state: 'connecting', error: '' })));
        agent.on('registrationFailed', (e) => setReg({ state: 'failed', error: e.cause || 'Registration failed' }));
        agent.on('disconnected', () => setReg((r) => (r.state === 'failed' ? r : { state: 'connecting', error: 'Reconnecting…' })));
        agent.on('newRTCSession', ({ session: s }) => attach(s));
        agent.start();
        ua.current = agent;
      } catch (e) {
        setReg({ state: 'failed', error: e.message });
      }
    })();
    return () => { stopped = true; session.current?.terminate?.(); agent?.stop(); ua.current = null; };
  }, [enabled, secure]);

  useEffect(() => {
    if (!call || call.state !== 'active') return undefined;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [call?.state]);

  const attach = (s) => {
    if (session.current && session.current !== s) { s.terminate({ status_code: 486 }); return; } // one call at a time
    session.current = s;
    const remote = s.remote_identity?.uri?.user || '';
    const remoteName = s.remote_identity?.display_name || '';
    setCall({ direction: s.direction, remote, remoteName, state: s.direction === 'incoming' ? 'ringing' : 'calling', muted: false, held: false });
    setShowKeys(false);
    if (s.direction === 'incoming') { setOpen(true); tones.play('ring'); } // outgoing ringback waits for 180 Ringing
    s.on('peerconnection', ({ peerconnection }) => {
      peerconnection.addEventListener('track', (ev) => { if (audio.current) audio.current.srcObject = ev.streams[0]; });
    });
    if (s.connection) s.connection.addEventListener('track', (ev) => { if (audio.current) audio.current.srcObject = ev.streams[0]; });
    s.on('progress', (e) => {
      if (s.direction !== 'outgoing') return;
      if (e.response?.body) tones.stop(); // early media: the far end plays its own ringing
      else tones.play('ringback');
    });
    s.on('accepted', () => { tones.stop(); setCall((c) => c && { ...c, state: 'active', startedAt: Date.now() }); });
    s.on('confirmed', () => { tones.stop(); setCall((c) => c && { ...c, state: 'active', startedAt: c.startedAt || Date.now() }); });
    s.on('hold', () => setCall((c) => c && { ...c, held: true }));
    s.on('unhold', () => setCall((c) => c && { ...c, held: false }));
    const done = (e) => {
      tones.stop();
      if (session.current === s) session.current = null;
      micStream.current?.getTracks().forEach((t) => t.stop());
      micStream.current = null;
      const cause = e?.cause && !['Terminated', 'Canceled', 'Rejected'].includes(e.cause) ? e.cause : null;
      if (cause === JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS) {
        setNotice('Your browser blocked the microphone. Allow microphone access for this site (the icon in the address bar), then try again.');
      } else if (cause) setNotice(`Last call failed: ${cause}.`);
      setCall((c) => c && { ...c, state: 'ended', endCause: cause });
      setTimeout(() => setCall((c) => (c?.state === 'ended' ? null : c)), cause ? 3500 : 1200);
    };
    s.on('ended', done);
    s.on('failed', done);
  };

  // Get the microphone before placing the call, so nothing rings while the browser is still asking.
  const dial = async (n = number) => {
    const target = String(n).replace(/[^0-9*#+]/g, '');
    if (!target || !ua.current || reg.state !== 'registered' || session.current) return;
    setNotice('Waiting for microphone access…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      setNotice(e.name === 'NotAllowedError'
        ? 'Your browser blocked the microphone. Allow microphone access for this site (the icon in the address bar), then try again.'
        : `Couldn't use the microphone: ${e.message}`);
      return;
    }
    setNotice('');
    micStream.current = stream;
    try { ua.current.call(`sip:${target}@${window.location.hostname}`, { ...CALL_OPTS, mediaStream: stream }); } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      micStream.current = null;
      setNotice(`Couldn't place the call: ${e.message}`);
    }
  };
  // Other pages (Contacts) ask for a call with a window event.
  const dialRef = useRef(null);
  dialRef.current = (n) => {
    setOpen(true);
    setNumber(String(n));
    if (!enabled) setNotice('Turn on the web phone (switch above) to call from your browser.');
    else if (reg.state !== 'registered') setNotice('The web phone is still connecting. Press call once it shows Ready.');
    else if (session.current) setNotice('Finish your current call first.');
    else dial(n);
  };
  useEffect(() => {
    const h = (e) => dialRef.current?.(e.detail?.number || '');
    window.addEventListener('asterfi:dial', h);
    return () => window.removeEventListener('asterfi:dial', h);
  }, []);
  const answer = () => { tones.stop(); setNotice(''); try { session.current?.answer(CALL_OPTS); } catch (e) { setNotice(`Couldn't answer: ${e.message}`); } };
  const hangup = () => { tones.stop(); try { session.current?.terminate(); } catch { /* already ended */ } };
  const toggleMute = () => {
    const s = session.current; if (!s) return;
    if (call.muted) s.unmute({ audio: true }); else s.mute({ audio: true });
    setCall({ ...call, muted: !call.muted });
  };
  const toggleHold = () => { const s = session.current; if (!s) return; if (call.held) s.unhold(); else s.hold(); };
  const press = (k) => {
    if (call?.state === 'active') session.current?.sendDTMF(k, { transportType: 'RFC2833' });
    else setNumber((n) => n + k);
  };
  const toggleEnabled = (v) => { setEnabled(v); writePref(v); };

  const dot = { registered: 'green', connecting: 'amber', failed: 'red', off: '' }[reg.state];
  const statusText = !secure ? 'Needs HTTPS' : { registered: 'Ready', connecting: 'Connecting…', failed: reg.error || 'Not connected', off: 'Off' }[reg.state];
  const party = call ? (call.remoteName && call.remoteName !== call.remote ? call.remoteName : formatNumber(call.remote) || 'Unknown') : '';

  return (
    <>
      <audio ref={audio} autoPlay />
      <button className={`wp-launch ${call ? 'busy' : ''}`} onClick={() => setOpen(!open)} title="Web phone">
        {call?.state === 'ringing' ? <PhoneIncoming size={20} /> : <Phone size={20} />}
        {enabled && <span className={`dot ${dot}`} />}
      </button>
      {open && (
        <div className="wp-panel" role="dialog" aria-label="Web phone">
          <div className="wp-head">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Web phone</div>
              <div className="muted small"><span className={`dot ${dot}`} style={{ marginRight: 6 }} />Ext. {me.extension} · {statusText}</div>
            </div>
            <Switch checked={enabled} onChange={toggleEnabled} />
            <button className="btn ghost sm icon" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
          </div>

          {!secure && <div className="alert warn" style={{ margin: 12 }}>Open AsterFi over https:// to use the web phone. Browsers only allow the microphone on secure pages.</div>}
          {secure && !enabled && <div className="wp-body muted small">Turn the web phone on to make and receive calls from this browser. Your desk phones keep ringing too.</div>}

          {secure && enabled && !call && (
            <div className="wp-body">
              {notice && <div className="alert error" style={{ marginBottom: 10 }}><span style={{ flex: 1 }}>{notice}</span><button className="btn ghost sm icon" onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
              <div className="wp-number">
                <input type="tel" value={number} placeholder="Enter a number or extension" onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dial()} />
                {number && <button className="btn ghost sm icon" onClick={() => setNumber((n) => n.slice(0, -1))} aria-label="Delete digit"><Delete size={16} /></button>}
              </div>
              <Keypad onPress={press} />
              <button className="wp-call" disabled={!number || reg.state !== 'registered'} onClick={() => dial()} aria-label="Call"><Phone size={22} /></button>
              <div className="muted small" style={{ textAlign: 'center', marginTop: 10 }}>*97 voicemail · *43 echo test</div>
            </div>
          )}

          {call && (
            <div className="wp-body" style={{ textAlign: 'center' }}>
              <div className="muted small">{{ ringing: 'Incoming call', calling: 'Calling…', active: call.held ? 'On hold' : 'Connected', ended: call.endCause ? `Call failed: ${call.endCause}` : 'Call ended' }[call.state]}</div>
              <div style={{ fontSize: 20, fontWeight: 600, margin: '6px 0 2px' }}>{party}</div>
              {call.remoteName && call.remote && <div className="muted small">{formatNumber(call.remote)}</div>}
              {call.state === 'active' && <div className="num" style={{ fontSize: 15, marginTop: 6 }}>{fmtDuration((Date.now() - call.startedAt) / 1000)}</div>}

              {call.state === 'ringing' && (
                <div className="wp-actions">
                  <button className="wp-round red" onClick={hangup} aria-label="Decline"><PhoneOff size={22} /></button>
                  <button className="wp-round green" onClick={answer} aria-label="Answer"><Phone size={22} /></button>
                </div>
              )}
              {call.state === 'active' && <>
                {showKeys && <div style={{ marginTop: 12 }}><Keypad onPress={press} /></div>}
                <div className="wp-actions small-gap">
                  <button className={`wp-tool ${call.muted ? 'on' : ''}`} onClick={toggleMute}>{call.muted ? <MicOff size={18} /> : <Mic size={18} />}<span>{call.muted ? 'Unmute' : 'Mute'}</span></button>
                  <button className={`wp-tool ${showKeys ? 'on' : ''}`} onClick={() => setShowKeys(!showKeys)}><Grid3x3 size={18} /><span>Keypad</span></button>
                  <button className={`wp-tool ${call.held ? 'on' : ''}`} onClick={toggleHold}>{call.held ? <Play size={18} /> : <Pause size={18} />}<span>{call.held ? 'Resume' : 'Hold'}</span></button>
                </div>
              </>}
              {['calling', 'active'].includes(call.state) && <button className="wp-round red" style={{ margin: '14px auto 0' }} onClick={hangup} aria-label="Hang up"><PhoneOff size={22} /></button>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Keypad({ onPress }) {
  return (
    <div className="wp-keys">
      {KEYS.map((k) => (
        <button key={k} type="button" onClick={() => onPress(k)}>
          <span>{k}</span>{SUB[k] && <small>{SUB[k]}</small>}
        </button>
      ))}
    </div>
  );
}
