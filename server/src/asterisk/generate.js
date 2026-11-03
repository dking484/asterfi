// Renders AsterFi's database into Asterisk config files and reloads Asterisk.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { q, getSetting } from '../db.js';
import { config } from '../config.js';
import { gotoDest, extSafe, dpEsc, digits, idSafe } from './dest.js';
import { compileFlow, RECORDINGS } from './ivr.js';
import { ensureSystemPrompt } from '../prompts.js';

const CODECS = 'g722,ulaw,alaw';

// A 50 ms silent clip, used to mute queue announcements that would only delay ringing.
const BLANK = 'blank';
async function ensureBlank() {
  const file = path.join(config.soundsDir, `${BLANK}.wav`);
  const samples = 400; // 8 kHz, 16-bit mono
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await mkdir(config.soundsDir, { recursive: true });
  await writeFile(file, wav);
}

async function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

const cidName = (u) => `${u.first_name} ${u.last_name}`.trim().replace(/["<>\r\n]/g, '');
const confVal = (s) => String(s ?? '').replace(/[\r\n;]/g, '');

// Asterisk keeps a queue's member order (and its linear/ringall container) across reloads, so a reordered
// or re-strategized group would keep ringing in the old order. Naming the queue after its order makes any
// change create a fresh queue; the old one is dropped on reload once its callers are gone.
export function queueName(g) {
  const sig = `${g.strategy}|${(g.members || []).map(extSafe).filter(Boolean).join(',')}`;
  return `asterfi-q-${extSafe(g.extension)}-${createHash('sha1').update(sig).digest('hex').slice(0, 6)}`;
}

export function renderTransports(general) {
  const nat = [];
  if (general.externalAddress) {
    nat.push(`external_media_address=${confVal(general.externalAddress)}`);
    nat.push(`external_signaling_address=${confVal(general.externalAddress)}`);
  }
  for (const n of general.localNets || []) nat.push(`local_net=${confVal(n)}`);
  // WebSocket transport for the browser web phone (nginx proxies wss://host/ws to Asterisk's HTTP server).
  // Browsers reach it through nginx on this host, so loopback counts as local too.
  const ws = ['[asterfi-ws]', 'type=transport', 'protocol=ws', 'bind=0.0.0.0', ...nat, 'local_net=127.0.0.0/8', ''].join('\n');
  return ws + '\n' + ['udp', 'tcp'].map((p) => [
    `[asterfi-${p}]`, 'type=transport', `protocol=${p}`, 'bind=0.0.0.0:5060', ...nat, '',
  ].join('\n')).join('\n');
}

export function renderUsers(users) {
  const L = [
    '[asterfi-phone](!)', 'type=endpoint', 'context=asterfi-internal', 'disallow=all', `allow=${CODECS}`,
    'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'dtmf_mode=rfc4733',
    'send_pai=yes', 'language=en', 'device_state_busy_at=1', 'allow_subscribe=yes', '',
  ];
  for (const u of users) {
    const e = extSafe(u.extension);
    L.push(`[${e}](asterfi-phone)`, `auth=${e}`, `aors=${e}`, `callerid="${cidName(u)}" <${e}>`);
    if (u.vm_enabled) L.push(`mailboxes=${e}@${config.vmContext}`);
    L.push(`set_var=ASTERFI_EXT=${e}`);
    if (digits(u.outbound_cid)) L.push(`set_var=ASTERFI_OUTCID=${digits(u.outbound_cid)}`);
    L.push('');
    L.push(`[${e}]`, 'type=auth', 'auth_type=userpass', `username=${e}`, `password=${confVal(u.sip_password)}`, '');
    L.push(`[${e}]`, 'type=aor', `max_contacts=${Math.max(1, Math.min(10, u.max_devices || 5))}`,
      'remove_existing=yes', 'qualify_frequency=30', '');
    // Browser web phone line for the same user: WebRTC needs its own endpoint (DTLS-SRTP, ICE).
    const w = `webrtc-${e}`;
    L.push(`[${w}]`, 'type=endpoint', 'context=asterfi-internal', 'transport=asterfi-ws', 'webrtc=yes',
      'dtls_auto_generate_cert=yes', 'disallow=all', 'allow=ulaw,alaw,g722', 'dtmf_mode=rfc4733', 'send_pai=yes',
      'device_state_busy_at=1', `auth=${w}`, `aors=${w}`, `callerid="${cidName(u)}" <${e}>`, `set_var=ASTERFI_EXT=${e}`);
    if (u.vm_enabled) L.push(`mailboxes=${e}@${config.vmContext}`);
    if (digits(u.outbound_cid)) L.push(`set_var=ASTERFI_OUTCID=${digits(u.outbound_cid)}`);
    L.push('');
    L.push(`[${w}]`, 'type=auth', 'auth_type=userpass', `username=${w}`, `password=${confVal(u.sip_password)}`, '');
    L.push(`[${w}]`, 'type=aor', 'max_contacts=3', 'remove_existing=yes', '');
  }
  return L.join('\n');
}

export function renderTrunks(trunks) {
  const L = [];
  for (const t of trunks.filter((x) => x.enabled)) {
    const n = `trunk-${t.id}`;
    // Admin-supplied options land at the end of their section, so they override generated values.
    const extra = (section) => (t.custom || []).filter((c) => c.section === section && /^[a-z0-9_]+$/.test(c.key))
      // Semicolons start comments in Asterisk config, so escape them (e.g. sip:proxy;lr).
      .map((c) => `${c.key}=${String(c.value ?? '').replace(/[\r\n]/g, '').replace(/(^|[^\\]);/g, '$1\\;')}`);
    const hp = `${confVal(t.host)}:${Number(t.port) || 5060}`;
    const transport = t.transport === 'tcp' ? 'asterfi-tcp' : 'asterfi-udp';
    const hasAuth = !!(t.username && t.password);
    if (hasAuth) {
      L.push(`[${n}]`, 'type=auth', 'auth_type=userpass',
        `username=${confVal(t.auth_username || t.username)}`, `password=${confVal(t.password)}`, ...extra('auth'), '');
    }
    if (t.register && hasAuth) {
      L.push(`[${n}]`, 'type=registration', `transport=${transport}`, `outbound_auth=${n}`,
        `server_uri=sip:${hp}`, `client_uri=sip:${confVal(t.username)}@${hp}`, `contact_user=${confVal(t.username)}`,
        // No line=yes: its random per-start tag changes our Contact on every Asterisk restart, so the
        // carrier keeps the old bindings and delivers each call several times. Calls are matched by IP
        // (identify below) instead; add registration line=yes as a custom field if a carrier needs it.
        'retry_interval=60', 'forbidden_retry_interval=600', 'expiration=3600', ...extra('registration'), '');
    }
    L.push(`[${n}]`, 'type=aor', `contact=sip:${hp}`, 'qualify_frequency=60', ...extra('aor'), '');
    L.push(`[${n}]`, 'type=endpoint', `transport=${transport}`, 'context=asterfi-from-trunk', 'disallow=all',
      `allow=ulaw,alaw,g722`, `aors=${n}`, 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes',
      'rewrite_contact=yes', 'dtmf_mode=rfc4733', 'send_rpid=yes', 'trust_id_inbound=yes');
    if (hasAuth) L.push(`outbound_auth=${n}`);
    // Default the From domain to the provider's host; otherwise Asterisk uses our private IP,
    // which carriers then use as the auth realm and reject (403).
    L.push(`from_domain=${confVal(t.from_domain || t.host)}`);
    if (t.from_user || t.username) L.push(`from_user=${confVal(t.from_user || t.username)}`);
    L.push(...extra('endpoint'), '');
    const matches = [t.host, ...String(t.match_ips || '').split(',')].map((s) => s.trim()).filter(Boolean);
    L.push(`[${n}]`, 'type=identify', `endpoint=${n}`, ...matches.map((m) => `match=${confVal(m)}`), ...extra('identify'), '');
  }
  return L.join('\n');
}

export function renderVoicemail(users, general, groups = []) {
  const L = [
    '[general]', 'format=wav', 'attach=no', 'maxmsg=100', 'maxsecs=300', 'minsecs=2',
    'silencethreshold=128', 'maxlogins=3', 'skipms=3000', 'review=no', 'operator=no', 'moveheard=yes',
    'sendvoicemail=no', 'envelope=yes', `tz=asterfi`, '',
    '[zonemessages]', `asterfi=${confVal(general.timezone || 'America/New_York')}|'vm-received' Q 'digits/at' IMp`, '',
    `[${config.vmContext}]`,
  ];
  for (const u of users.filter((x) => x.vm_enabled)) {
    L.push(`${extSafe(u.extension)} => ${digits(u.vm_pin) || '1234'},${cidName(u).replace(/[,|]/g, ' ')}`);
  }
  // Group boxes share the group's extension as the mailbox number.
  for (const g of groups.filter((x) => x.voicemail?.enabled)) {
    L.push(`${extSafe(g.extension)} => ${digits(g.voicemail.pin) || '1234'},${String(g.name).replace(/[,|\r\n]/g, ' ')},,,hidefromdir=yes`);
  }
  return L.join('\n') + '\n';
}

function renderDialplan({ users, groups, flows, numbers, routes, trunks, general }) {
  const tz = general.timezone || 'America/New_York';
  const trunkById = new Map(trunks.filter((t) => t.enabled).map((t) => [t.id, t]));
  const L = [];
  const push = (...l) => L.push(...l);

  push('; Generated by AsterFi. Do not edit: changes are overwritten.', '');
  push('[asterfi-internal]', 'include => asterfi-features', 'include => asterfi-ext', 'include => asterfi-outbound', '');

  // Users, groups and flows reachable by number.
  push('[asterfi-ext]');
  for (const u of users) {
    const e = extSafe(u.extension);
    push(`exten => ${e},hint,PJSIP/${e}&PJSIP/webrtc-${e}`);
    push(`exten => ${e},1,NoOp(User ${e} ${dpEsc(cidName(u))})`);
    push(` same => n,Gosub(asterfi-dial-user,s,1(${e},${Number(u.ring_seconds) || 25}))`);
    // Voicemail with no target means the user's own mailbox.
    const nd = u.noanswer_dest || { type: 'voicemail' };
    const own = nd.type === 'voicemail' && !extSafe(nd.target);
    push(` same => n,${own ? (u.vm_enabled ? `Goto(asterfi-vm,${e},1)` : 'Hangup()') : gotoDest(nd)}`);
  }
  for (const g of groups) {
    const e = extSafe(g.extension);
    const members = (g.members || []).map(extSafe).filter(Boolean);
    const rs = Number(g.ring_seconds) || 20;
    push(`exten => ${e},1,NoOp(Group ${e} ${dpEsc(g.name)})`);
    push(` same => n,Set(__ASTERFI_GROUP=${e})`);
    if (members.length) {
      push(` same => n,UserEvent(AsterFiTarget,Extensions: ${members.join('&')},Group: ${e})`);
      if (g.queue?.enabled) {
        // Callers wait on hold until a member is free; the fallback runs on timeout, full queue, or nobody signed in.
        push(' same => n,Answer()');
        push(` same => n,Queue(${queueName(g)},t,,,${Number(g.queue.max_wait) || 300})`);
        push(` same => n,UserEvent(AsterFiQueue,Group: ${e},Status: \${QUEUESTATUS})`);
      } else if (g.strategy === 'hunt') {
        for (const m of members) {
          push(` same => n,Dial(Local/${m}@asterfi-ring,${rs})`);
          push(' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?done)');
        }
      } else {
        push(` same => n,Dial(${members.map((m) => `Local/${m}@asterfi-ring`).join('&')},${rs})`);
        push(' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?done)');
      }
    }
    push(` same => n,${gotoDest(g.fail_dest)}`);
    push(' same => n(done),Hangup()');
  }
  for (const f of flows.filter((x) => extSafe(x.extension))) {
    push(`exten => ${extSafe(f.extension)},1,Goto(asterfi-flow-${f.id},s,1)`);
  }
  push('');

  // What callers may dial directly from inside a call-flow menu.
  push('[asterfi-directdial]');
  for (const x of [...users, ...groups]) push(`exten => ${extSafe(x.extension)},1,Goto(asterfi-ext,${extSafe(x.extension)},1)`);
  push('');
  // Forward numbers that are a coworker's extension (rung directly, not screened like an outside number).
  const userExts = users.map((u) => extSafe(u.extension)).filter(Boolean);
  const isUserExt = userExts.length ? `$[\${REGEX("^(${userExts.join('|')})$" \${FWD})}]` : '0';

  push(
    '[asterfi-dial-user]',
    'exten => s,1,UserEvent(AsterFiTarget,Extensions: ${ARG1})',
    // Call forwarding (set from a UniFi phone's Redirect status or My Account): ring that number instead.
    ' same => n,Set(FWD=${FILTER(0-9*#+,${DB(CF/${ARG1})})})',
    ' same => n,GotoIf($["${FWD}"!="" & "${FWD}"!="${ARG1}" & "${ASTERFI_FWDFROM}"=""]?fwd)',
    ' same => n,GotoIf($["${DB(DND/${ARG1})}"="1"]?unavail)',
    ' same => n,Set(DSTR=${PJSIP_DIAL_CONTACTS(${ARG1})})',
    ' same => n,Set(WSTR=${PJSIP_DIAL_CONTACTS(webrtc-${ARG1})})',
    ' same => n,Set(DSTR=${DSTR}${IF($["${DSTR}"!="" & "${WSTR}"!=""]?&)}${WSTR})',
    ' same => n,GotoIf($["${DSTR}"=""]?unavail)',
    // "i": the PBX does the forwarding (above), so a phone's own redirect (a SIP 302) is ignored.
    // U(asterfi-whisper): a call flow's message for whoever answers plays before they're connected.
    ' same => n,Dial(${DSTR},${ARG2},iU(asterfi-whisper))',
    ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?answered)',
    ' same => n,Return()',
    ' same => n(unavail),Set(DIALSTATUS=CHANUNAVAIL)',
    ' same => n,Return()',
    ' same => n(answered),Hangup()',
    // ASTERFI_FWDFROM stops a forward from being forwarded again (A -> B -> A loops).
    ' same => n(fwd),Set(__ASTERFI_FWDFROM=${ARG1})',
    ' same => n,UserEvent(AsterFiForward,Extension: ${ARG1},Number: ${FWD})',
    // A coworker's extension plays the whisper on their own phones; an outside number hears it here.
    ` same => n,GotoIf(${isUserExt}?fwdext)`,
    ' same => n,Dial(Local/${FWD}@asterfi-internal,${ARG2},U(asterfi-whisper))',
    ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?answered)',
    ' same => n,Return()',
    ' same => n(fwdext),Dial(Local/${FWD}@asterfi-internal,${ARG2})',
    ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?answered)',
    ' same => n,Return()',
    '',
    // One member's leg of a group or queue call. A member with forwarding on rings their forward number instead.
    '[asterfi-ring]',
    'exten => _X!,1,GotoIf($["${CALLERID(num)}"="${EXTEN}"]?skip)',
    ' same => n,GotoIf($["${DB(DND/${EXTEN})}"="1"]?skip)',
    ' same => n,Set(FWD=${FILTER(0-9*#+,${DB(CF/${EXTEN})})})',
    ' same => n,GotoIf($["${FWD}"!="" & "${FWD}"!="${EXTEN}" & "${ASTERFI_FWDFROM}"=""]?fwd)',
    ' same => n,Set(DSTR=${PJSIP_DIAL_CONTACTS(${EXTEN})})',
    ' same => n,Set(WSTR=${PJSIP_DIAL_CONTACTS(webrtc-${EXTEN})})',
    ' same => n,Set(DSTR=${DSTR}${IF($["${DSTR}"!="" & "${WSTR}"!=""]?&)}${WSTR})',
    ' same => n,GotoIf($["${DSTR}"=""]?skip)',
    ' same => n,Dial(${DSTR},,iU(asterfi-whisper))',
    ' same => n,Hangup()',
    ' same => n(skip),Congestion()',
    // The forwarded member must press 1 to take it, so their cell's voicemail can't answer for the group
    // (the group then goes on to the next member).
    ' same => n(fwd),Set(__ASTERFI_FWDFROM=${EXTEN})',
    ' same => n,UserEvent(AsterFiForward,Extension: ${EXTEN},Number: ${FWD})',
    // A coworker's extension rings their phones; an outside number must press 1 first.
    ` same => n,GotoIf(${isUserExt}?fwdext)`,
    ' same => n,Dial(Local/${FWD}@asterfi-internal,,U(asterfi-fwd-accept))',
    ' same => n,Hangup()',
    ' same => n(fwdext),Dial(Local/${FWD}@asterfi-ring)',
    ' same => n,Hangup()',
    '',
    '[asterfi-fwd-accept]',
    'exten => s,1,ExecIf($["${ASTERFI_WHISPER}"!=""]?Playback(${ASTERFI_WHISPER}))',
    ' same => n,Read(ACCEPT,asterfi/fwd-accept,1,,3,4)',
    ' same => n,GotoIf($["${ACCEPT}"="1"]?ok)',
    ' same => n,Set(GOSUB_RESULT=ABORT)',
    ' same => n(ok),Return()',
    '',
    // Runs on the answering phone's channel: the caller keeps hearing ringing until it returns.
    '[asterfi-whisper]',
    'exten => s,1,ExecIf($["${ASTERFI_WHISPER}"!=""]?Playback(${ASTERFI_WHISPER}))',
    ' same => n,Return()',
    '',
    // Click-to-call (clicktocall.js): the ;2 half of the originated Local channel rings the user's own phones,
    // ignoring DND and forwarding since they asked for the call. Their phone shows the number being called.
    '[asterfi-click]',
    'exten => _X!,1,UserEvent(AsterFiClick,Extension: ${EXTEN},Number: ${ASTERFI_CLICKNUM})',
    ' same => n,Set(CALLERID(num)=${ASTERFI_CLICKNUM})',
    ' same => n,Set(CALLERID(name)=Calling ${ASTERFI_CLICKNUM})',
    ' same => n,Set(DSTR=${PJSIP_DIAL_CONTACTS(${EXTEN})})',
    ' same => n,Set(WSTR=${PJSIP_DIAL_CONTACTS(webrtc-${EXTEN})})',
    ' same => n,Set(DSTR=${DSTR}${IF($["${DSTR}"!="" & "${WSTR}"!=""]?&)}${WSTR})',
    ' same => n,GotoIf($["${DSTR}"=""]?none)',
    ' same => n,Dial(${DSTR},${ASTERFI_CLICKSECS})',
    ' same => n(none),Hangup()',
    '',
    '[asterfi-vm]',
  );
  // Group mailboxes: the group's greeting (or a generic one), then record. Exact matches win over _X!.
  for (const g of groups.filter((x) => x.voicemail?.enabled)) {
    const e = extSafe(g.extension);
    push(`exten => ${e},1,Answer()`, ' same => n,Wait(0.5)',
      ` same => n,Playback(${g.voicemail.greeting_prompt_id ? `asterfi/prompt-${Number(g.voicemail.greeting_prompt_id)}` : 'vm-nobodyavail'})`,
      ` same => n,VoiceMail(${e}@${config.vmContext})`, ' same => n,Hangup()');
  }
  push(
    'exten => _X!,1,Answer()',
    ' same => n,Wait(0.5)',
    ' same => n,VoiceMail(${EXTEN}@asterfi,u)',
    ' same => n,Hangup()',
    '',
    '[asterfi-goodbye]',
    'exten => s,1,Playback(vm-goodbye)',
    ' same => n,Hangup()',
    '',
    '[asterfi-features]',
    'exten => *97,1,Answer()',
    ' same => n,VoiceMailMain(${ASTERFI_EXT}@asterfi)',
    ' same => n,Hangup()',
    'exten => *98,1,Answer()',
    ' same => n,VoiceMailMain(@asterfi)',
    ' same => n,Hangup()',
    'exten => *43,1,Answer()',
    ' same => n,Playback(demo-echotest)',
    ' same => n,Echo()',
    ' same => n,Hangup()',
    'exten => *76,1,Answer()',
    ' same => n,GotoIf($["${DB(DND/${ASTERFI_EXT})}"="1"]?off)',
    ' same => n,Set(DB(DND/${ASTERFI_EXT})=1)',
    ' same => n,UserEvent(AsterFiDnd,Extension: ${ASTERFI_EXT},State: on)',
    ' same => n,Playback(do-not-disturb&activated)',
    ' same => n,Hangup()',
    ' same => n(off),Set(DB(DND/${ASTERFI_EXT})=0)',
    ' same => n,UserEvent(AsterFiDnd,Extension: ${ASTERFI_EXT},State: off)',
    ' same => n,Playback(do-not-disturb&de-activated)',
    ' same => n,Hangup()',
    'exten => _*77X!,1,Answer()',
    ' same => n,Wait(1)',
    ' same => n,Playback(vm-rec-name)',
    ' same => n,Record(asterfi/prompt-${EXTEN:3}.wav,3,180,k)',
    ' same => n,Wait(0.5)',
    ' same => n,Playback(asterfi/prompt-${EXTEN:3})',
    ' same => n,UserEvent(AsterFiPromptRecorded,Prompt: ${EXTEN:3})',
    ' same => n,Playback(vm-msgsaved)',
    ' same => n,Hangup()',
    '',
  );

  // Queue callback: a waiting caller presses 1 to leave a message (group mailbox) or 2 to request a callback.
  for (const g of groups.filter((x) => x.queue?.enabled && x.queue?.callback_enabled)) {
    const e = extSafe(g.extension);
    push(`[asterfi-qexit-${e}]`);
    if (g.voicemail?.enabled) {
      push('exten => 1,1,NoOp(Queue callback: leave a message)',
        ` same => n,UserEvent(AsterFiQueue,Group: ${e},Status: CALLBACK-MESSAGE)`,
        ' same => n,Answer()',
        ` same => n,VoiceMail(${e}@${config.vmContext})`,
        ' same => n,Hangup()');
    }
    push('exten => 2,1,NoOp(Queue callback: request)',
      ' same => n,Answer()',
      ` same => n,UserEvent(AsterFiCallback,Group: ${e},From: \${CALLERID(num)},Name: \${CALLERID(name)})`,
      ' same => n,Playback(auth-thankyou)',
      ' same => n,Hangup()',
      '');
  }

  // Outbound routing.
  push('[asterfi-outbound]');
  const sorted = [...routes].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const seen = new Set();
  for (const r of sorted) {
    for (const p of r.patterns || []) {
      const pat = String(p).replace(/[^0-9XZNxzn\[\]\-.!*#+_]/g, '');
      if (!pat || seen.has(pat)) continue;
      seen.add(pat);
      push(`exten => ${pat},1,Gosub(asterfi-route-${r.id},s,1(\${EXTEN}))`);
      push(' same => n,Hangup()');
    }
  }
  // Phones redial from history in E.164 (+1860...). Drop the "+" and route the number like a dialed one:
  // +1 numbers become 1NXXNXXXXXX, other countries become 011 + number.
  if (!seen.has('_+1NXXNXXXXXX')) push('exten => _+1NXXNXXXXXX,1,Goto(${EXTEN:1},1)');
  if (!seen.has('_+[02-9]X.')) push('exten => _+[02-9]X.,1,Goto(011${EXTEN:1},1)');
  push('');
  for (const r of sorted) {
    const strip = Math.max(0, Number(r.strip) || 0);
    push(`[asterfi-route-${r.id}]`);
    push(`exten => s,1,Set(NUM=${digits(r.prepend)}\${ARG1:${strip}})`);
    push(' same => n,UserEvent(AsterFiOutbound,Number: ${NUM})');
    for (const tid of r.trunk_ids || []) {
      const t = trunkById.get(Number(tid));
      if (!t) continue;
      const cid = digits(t.caller_id);
      push(` same => n,Set(CALLERID(num)=\${IF($["\${ASTERFI_OUTCID}"!=""]?\${ASTERFI_OUTCID}:${cid || '${CALLERID(num)}'})})`);
      push(` same => n,Dial(PJSIP/\${NUM}@trunk-${t.id},120)`);
      push(' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"|"${DIALSTATUS}"="BUSY"]?done)');
    }
    // Played as early media, never answered: a forwarded or group leg that reaches here must not count as picked up.
    push(' same => n,Progress()');
    push(' same => n,Playback(all-circuits-busy-now,noanswer)');
    push(' same => n,Congestion()');
    push(' same => n(done),Return()');
    push('');
  }

  // Inbound from carriers.
  push(
    '[asterfi-from-trunk]',
    'exten => _X.,1,Set(__ASTERFI_REQ=${EXTEN})',
    ' same => n,Goto(asterfi-did-lookup,s,1)',
    'exten => _+X.,1,Set(__ASTERFI_REQ=${EXTEN})',
    ' same => n,Goto(asterfi-did-lookup,s,1)',
    'exten => _[a-zA-Z].,1,Set(__ASTERFI_REQ=${EXTEN})',
    ' same => n,Goto(asterfi-did-lookup,s,1)',
    'exten => s,1,Goto(asterfi-did-lookup,s,1)',
    '',
    '[asterfi-norm]',
    'exten => s,1,Set(N=${FILTER(0-9,${ARG1})})',
    ' same => n,ExecIf($[${LEN(${N})}=11 & "${N:0:1}"="1"]?Set(N=${N:1}))',
    ' same => n,Return(${N})',
    '',
    '[asterfi-did-lookup]',
    'exten => s,1,Gosub(asterfi-norm,s,1(${ASTERFI_REQ}))',
    ' same => n,GotoIf($["${GOSUB_RETVAL}"!="" & ${DIALPLAN_EXISTS(asterfi-did,${GOSUB_RETVAL},1)}]?asterfi-did,${GOSUB_RETVAL},1)',
    ' same => n,Gosub(asterfi-norm,s,1(${CUT(CUT(PJSIP_HEADER(read,To),@,1),:,2)}))',
    ' same => n,GotoIf($["${GOSUB_RETVAL}"!="" & ${DIALPLAN_EXISTS(asterfi-did,${GOSUB_RETVAL},1)}]?asterfi-did,${GOSUB_RETVAL},1)',
    ' same => n(nomatch),GotoIf(${DIALPLAN_EXISTS(asterfi-did,catchall,1)}?asterfi-did,catchall,1)',
    ' same => n(noservice),Answer()',
    ' same => n,Playback(ss-noservice)',
    ' same => n,Hangup()',
    '',
    '[asterfi-did]',
  );
  for (const n of numbers) {
    const num = n.number === '*' ? 'catchall' : digits(n.number);
    if (!num) continue;
    // A number tied to a trunk only matches calls arriving on that trunk; others fall through.
    const trunk = n.trunk_id && trunkById.get(Number(n.trunk_id));
    push(`exten => ${num},1,NoOp(Number ${num}${trunk ? ` via trunk-${trunk.id}` : ''})`);
    if (trunk) push(` same => n,GotoIf($["\${CHANNEL(endpoint)}"!="trunk-${trunk.id}"]?asterfi-did-lookup,s,${num === 'catchall' ? 'noservice' : 'nomatch'})`);
    push(` same => n,Set(__ASTERFI_DID=${n.number === '*' ? '' : num})`);
    push(` same => n,UserEvent(AsterFiInbound,DID: ${num},Name: ${dpEsc(n.name)})`);
    push(` same => n,${gotoDest(n.destination)}`);
  }
  push('');

  for (const f of flows) push(compileFlow(f, tz));
  return L.join('\n') + '\n';
}

// One queue per ring group that has queuing on. Members are dialed through asterfi-ring (desk + web phone, DND),
// and their busy/available state comes from the user's hint, so a member already on a call is skipped.
export function renderQueues(groups) {
  const L = ['; Generated by AsterFi. Do not edit: changes are overwritten.', ''];
  for (const g of groups.filter((x) => x.queue?.enabled)) {
    const e = extSafe(g.extension);
    const qc = g.queue;
    L.push(`[${queueName(g)}]`,
      `strategy=${g.strategy === 'hunt' ? 'linear' : 'ringall'}`,
      `timeout=${Number(g.ring_seconds) || 20}`,
      'retry=1', 'timeoutrestart=no', 'ringinuse=no', 'autofill=yes', 'musicclass=default',
      'joinempty=unavailable,invalid', 'leavewhenempty=unavailable,invalid',
      `maxlen=${Number(qc.max_callers) || 0}`,
      `announce-position=${qc.announce_position ? 'yes' : 'no'}`, 'announce-holdtime=no',
      `announce-frequency=${qc.announce_position ? 60 : 0}`, 'min-announce-frequency=15');
    // The caller at the front of the line is being rung for, so anything played to them holds up the ringing.
    // Only announce to them when there's a hold message or callback offer to hear, and never say "you are
    // next, thank you for your patience" (callers further back still hear their position).
    const periodic = (qc.callback_enabled && qc.callback_prompt_id) || qc.hold_prompt_id;
    L.push(`announce-to-first-user=${periodic ? 'yes' : 'no'}`);
    if (qc.announce_position) L.push(`queue-youarenext=asterfi/${BLANK}`, `queue-thankyou=asterfi/${BLANK}`);
    // Callers press a single digit to leave the queue; the digit is matched in this context.
    if (qc.callback_enabled) L.push(`context=asterfi-qexit-${e}`);
    // Periodic announcement: the callback offer (if on) plays every callback_after minutes; else the hold message.
    if (qc.callback_enabled && qc.callback_prompt_id) {
      L.push(`periodic-announce=asterfi/prompt-${Number(qc.callback_prompt_id)}`, `periodic-announce-frequency=${(Number(qc.callback_after) || 2) * 60}`);
    } else if (qc.hold_prompt_id) {
      L.push(`periodic-announce=asterfi/prompt-${Number(qc.hold_prompt_id)}`, `periodic-announce-frequency=${Number(qc.hold_every) || 60}`);
    }
    // "linear" (one at a time) rings members in the order listed here.
    for (const m of (g.members || []).map(extSafe).filter(Boolean)) {
      L.push(`member => Local/${m}@asterfi-ring/n,0,${m},hint:${m}@asterfi-ext`);
    }
    L.push('');
  }
  return L.join('\n');
}

export async function loadAll() {
  const [users, groups, flows, numbers, routes, trunks, general] = await Promise.all([
    q('SELECT * FROM users ORDER BY extension'),
    q('SELECT * FROM ring_groups ORDER BY extension'),
    q('SELECT * FROM call_flows ORDER BY id'),
    q('SELECT * FROM numbers ORDER BY number'),
    q('SELECT * FROM outbound_routes ORDER BY priority, id'),
    q('SELECT * FROM trunks ORDER BY id'),
    getSetting('general'),
  ]);
  return { users, groups, flows, numbers, routes, trunks, general };
}

let ami = null;
let timer = null;
let waiters = [];
export function initGenerator(amiClient) {
  ami = amiClient;
}

// Debounced: bursts of edits produce one regenerate + reload.
export function scheduleApply() {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const w = waiters;
      waiters = [];
      try {
        await applyNow();
        w.forEach((x) => x.resolve());
      } catch (e) {
        w.forEach((x) => x.reject(e));
      }
    }, 300);
  });
}

export async function applyNow({ transports = false } = {}) {
  const data = await loadAll();
  const dir = config.asteriskConfDir;
  await mkdir(dir, { recursive: true });
  if (transports) await atomicWrite(path.join(dir, 'pjsip_transports.conf'), renderTransports(data.general));
  await atomicWrite(path.join(dir, 'pjsip_users.conf'), renderUsers(data.users));
  await atomicWrite(path.join(dir, 'pjsip_trunks.conf'), renderTrunks(data.trunks));
  await atomicWrite(path.join(dir, 'extensions.conf'), renderDialplan(data));
  await atomicWrite(path.join(dir, 'voicemail.conf'), renderVoicemail(data.users, data.general, data.groups));
  await ensureBlank();
  await mkdir(RECORDINGS, { recursive: true }).catch(() => {});
  await ensureSystemPrompt('fwd-accept', 'Call for the company line. Press 1 to accept.')
    .catch((e) => console.error('fwd-accept prompt:', e.message));
  await atomicWrite(path.join(dir, 'queues.conf'), renderQueues(data.groups));
  if (ami?.connected) {
    await ami.command('module reload app_queue.so');
    await ami.command('module reload res_pjsip.so');
    await ami.command('dialplan reload');
    await ami.command('voicemail reload');
  }
}

export { idSafe };
