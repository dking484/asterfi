// Compiles a call-flow graph (from the visual designer) into Asterisk dialplan.
// Each node becomes its own context: asterfi-flow-<flowId>-<nodeId>, entered at s,1.
import { gotoDest, idSafe, dpEsc, extSafe, digits } from './dest.js';

const DAY = { mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun' };
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TERMINAL = new Set(['user', 'group', 'voicemail', 'external', 'flow', 'hangup']);
export const MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

export const RECORDINGS = '/var/spool/asterisk/monitor/asterfi';
const prompt = (id) => (id ? `asterfi/prompt-${Number(id)}` : '');
const hhmm = (s) => (/^\d{1,2}:\d{2}$/.test(s || '') ? s.padStart(5, '0') : null);

export function compileFlow(flow, tz) {
  const fid = Number(flow.id);
  const nodes = flow.graph?.nodes || [];
  const edges = flow.graph?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = (nodeId, handle) => {
    const e = edges.find((x) => x.source === nodeId && (x.sourceHandle || 'next') === handle);
    return e && byId.has(e.target) ? e.target : null;
  };
  const ctx = (nodeId) => `asterfi-flow-${fid}-${idSafe(nodeId)}`;
  // Where to go from a node's output handle: terminals compile inline, others jump to their context.
  const jump = (nodeId, handle) => {
    const t = out(nodeId, handle);
    if (!t) return 'Hangup()';
    const n = byId.get(t);
    if (TERMINAL.has(n.type)) return terminal(n);
    return `Goto(${ctx(t)},s,1)`;
  };
  const terminal = (n) => {
    const d = n.data || {};
    if (n.type === 'hangup') {
      if (prompt(d.promptId)) return `Goto(${ctx(n.id)},s,1)`; // custom message gets its own context below
      return d.playGoodbye ? 'Goto(asterfi-goodbye,s,1)' : 'Hangup()';
    }
    return gotoDest({ type: n.type, target: d.target });
  };

  const L = [];
  const start = nodes.find((n) => n.type === 'start');
  L.push(`[asterfi-flow-${fid}]`);
  L.push(`exten => s,1,NoOp(Call flow ${fid}: ${dpEsc(flow.name)})`);
  L.push(` same => n,Set(__ASTERFI_FLOW=${fid})`);
  L.push(` same => n,UserEvent(AsterFiFlow,Flow: ${fid},Name: ${dpEsc(flow.name)})`);
  // Record the conversation (only once it's bridged to whoever answers, so ringing and hold aren't kept).
  // A flow that hands off to another recorded flow doesn't start a second recording.
  if (start?.data?.record) {
    L.push(' same => n,GotoIf($["${ASTERFI_REC}"!=""]?recd)',
      ' same => n,Set(__ASTERFI_REC=${CHANNEL(linkedid)})',
      ` same => n,MixMonitor(${RECORDINGS}/\${ASTERFI_REC}.wav,b)`,
      ' same => n,UserEvent(AsterFiRecording,File: ${ASTERFI_REC})',
      ' same => n(recd),NoOp()');
  }
  if (!start || start.data?.answer !== false) {
    L.push(' same => n,Answer()', ' same => n,Wait(1)');
    // Optional greeting on the Incoming call block itself.
    if (prompt(start?.data?.promptId)) L.push(` same => n,Playback(${prompt(start.data.promptId)})`);
  }
  L.push(` same => n,${start ? jump(start.id, 'next') : 'Hangup()'}`);
  L.push('');

  for (const n of nodes) {
    const hangupMsg = n.type === 'hangup' && prompt(n.data?.promptId);
    if (n.type === 'start' || (TERMINAL.has(n.type) && !hangupMsg)) continue;
    const d = n.data || {};
    const c = ctx(n.id);
    L.push(`[${c}]`);
    switch (n.type) {
      case 'greeting':
        L.push(`exten => s,1,NoOp(Greeting ${dpEsc(d.label)})`);
        if (prompt(d.promptId)) L.push(` same => n,Playback(${prompt(d.promptId)})`);
        L.push(` same => n,${jump(n.id, 'next')}`);
        break;

      case 'menu': {
        const retries = Math.max(0, Math.min(5, Number(d.retries ?? 2)));
        const timeout = Math.max(1, Math.min(30, Number(d.timeout ?? 5)));
        const v = `ASTERFI_TRIES_${idSafe(n.id).replace(/-/g, '_')}`;
        L.push(`exten => s,1,Set(${v}=0)`);
        L.push(` same => n(play),Background(${prompt(d.promptId) || 'silence/1'})`);
        L.push(` same => n,WaitExten(${timeout})`);
        for (const k of (d.keys || []).filter((k) => MENU_KEYS.includes(k))) {
          L.push(`exten => ${k},1,UserEvent(AsterFiIvr,Flow: ${fid},Node: ${dpEsc(d.label || n.id)},Key: ${k})`);
          L.push(` same => n,${jump(n.id, `key-${k}`)}`);
        }
        for (const [ext, handle, snd] of [['i', 'invalid', 'option-is-invalid'], ['t', 'timeout', '']]) {
          L.push(`exten => ${ext},1,Set(${v}=$[\${${v}}+1])`);
          L.push(` same => n,GotoIf($[\${${v}}>${retries}]?done)`);
          if (snd) L.push(` same => n,Playback(${snd})`);
          L.push(' same => n,Goto(s,play)');
          L.push(` same => n(done),${jump(n.id, handle)}`);
        }
        if (d.allowExtensions) L.push('include => asterfi-directdial');
        break;
      }

      case 'hours': {
        L.push(`exten => s,1,NoOp(Business hours ${dpEsc(d.label)})`);
        const zone = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(d.timezone || '') ? d.timezone : tz;
        for (const h of d.holidays || []) {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h.date || '');
          if (m) L.push(` same => n,GotoIfTime(*,*,${Number(m[3])},${MON[Number(m[2]) - 1]},${zone}?closed)`);
        }
        for (const r of d.schedule || []) {
          const days = (r.days || []).filter((x) => DAY[x]);
          const s = hhmm(r.start), e = hhmm(r.end);
          if (!days.length || !s || !e) continue;
          L.push(` same => n,GotoIfTime(${s}-${e},${days.join('&')},*,*,${zone}?open)`);
        }
        L.push(' same => n,Goto(closed)');
        L.push(` same => n(open),${jump(n.id, 'open')}`);
        L.push(` same => n(closed),${jump(n.id, 'closed')}`);
        break;
      }

      case 'whisper':
        // Played to whoever answers later in the call, before they're connected (see asterfi-whisper).
        L.push(`exten => s,1,Set(__ASTERFI_WHISPER=${prompt(d.promptId)})`);
        L.push(` same => n,${jump(n.id, 'next')}`);
        break;

      case 'notify':
        L.push(`exten => s,1,UserEvent(AsterFiIvr,Flow: ${fid},Node: ${dpEsc(d.label || n.id)},Key: )`);
        L.push(` same => n,${jump(n.id, 'next')}`);
        break;

      case 'setname':
        L.push(`exten => s,1,Set(CALLERID(name)=${dpEsc(d.prefix).slice(0, 12)}\${CALLERID(name)})`);
        L.push(` same => n,${jump(n.id, 'next')}`);
        break;

      case 'directory': {
        // Dial by name: Asterisk's Directory searches the people in the voicemail list and connects the caller
        // to the one they pick. Pressing 0 takes the Operator output; no match or giving up takes No match.
        const opts = ({ first: 'f', last: 'l', both: 'b' }[d.searchBy] || 'l') + (d.sayExtension ? 'e' : '') + (d.menu !== false ? 'm' : '');
        L.push(`exten => s,1,UserEvent(AsterFiIvr,Flow: ${fid},Node: ${dpEsc(d.label || n.id)},Key: directory)`);
        L.push(` same => n,Directory(asterfi,asterfi-directdial,${opts})`);
        L.push(` same => n,${jump(n.id, 'none')}`);
        L.push(`exten => o,1,${jump(n.id, 'operator')}`);
        L.push(`exten => a,1,${jump(n.id, 'none')}`);
        break;
      }

      case 'hangup':
        L.push(`exten => s,1,Playback(${prompt(d.promptId)})`);
        if (d.playGoodbye) L.push(' same => n,Playback(vm-goodbye)');
        L.push(' same => n,Hangup()');
        break;

      default:
        L.push('exten => s,1,Hangup()');
    }
    L.push('');
  }
  return L.join('\n');
}

// Basic structural checks shown in the designer before saving.
export function validateFlow(graph) {
  const errors = [];
  const nodes = graph?.nodes || [];
  if (nodes.filter((n) => n.type === 'start').length !== 1) errors.push('A call flow needs exactly one Start block.');
  for (const n of nodes) {
    const d = n.data || {};
    if (['user', 'group', 'voicemail'].includes(n.type) && !extSafe(d.target)) errors.push(`"${d.label || n.type}" has no target selected.`);
    if (n.type === 'external' && !digits(d.target)) errors.push('An External Number block has no number.');
    if (n.type === 'flow' && !d.target) errors.push('A Go to Call Flow block has no flow selected.');
    if (n.type === 'menu' && !(d.keys || []).length) errors.push(`Menu "${d.label || n.id}" has no keys enabled.`);
  }
  return errors;
}
