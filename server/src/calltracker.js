// Turns the raw AMI event stream into one call record per call (keyed by linkedid),
// and into the call.* / phone.* events that drive webhooks and notifications.
import { q, one } from './db.js';
import { publish } from './events.js';
import { sendMissedCallEmail } from './notify/email.js';

const calls = new Map();      // linkedid -> call state
const chanToCall = new Map(); // uniqueid -> linkedid

// A waiting caller asked a ring group to call them back: email the group's members (and any extra addresses).
async function notifyCallback(groupExt, fromNum, fromName) {
  const group = await one('SELECT * FROM ring_groups WHERE extension=$1', [groupExt]);
  if (!group) return;
  const members = await q('SELECT email FROM users WHERE extension = ANY($1) AND email IS NOT NULL', [group.members]);
  const extras = group.voicemail?.emails || [];
  const to = [...new Set([...members.map((m) => m.email), ...extras].map((x) => x.toLowerCase()))];
  if (!to.length) return;
  const { sendGroupCallbackEmail } = await import('./notify/email.js');
  await sendGroupCallbackEmail(group, to, { from: fromNum, fromName });
}
const VM_SETTLE_MS = 12000;   // wait for the voicemail spool scanner before deciding "missed"

export function activeCalls() {
  return [...calls.values()].filter((c) => !c.ended).map(summary);
}

// The live calls one user is part of: placed, ringing for, or answered by them.
export function activeCallsFor(ext) {
  return [...calls.values()].filter((c) => !c.ended && (c.fromExt === ext || c.answeredBy === ext || c.targets.has(ext)))
    .map(summary);
}

// PJSIP/101-0000002a -> 101; the web phone line PJSIP/webrtc-101-... also counts as 101.
const endpointOf = (channel) => {
  const m = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(channel || '');
  return m ? m[1].replace(/^webrtc-/, '') : null;
};
const isTrunk = (ep) => ep && ep.startsWith('trunk-');

function summary(c) {
  return {
    id: c.id, direction: c.direction, from: c.fromNum, fromName: c.fromName, to: c.toNum, did: c.did,
    answeredBy: c.answeredBy, startedAt: c.startedAt, answeredAt: c.answeredAt,
    state: c.answeredAt ? 'talking' : 'ringing',
  };
}

let userCache = { at: 0, map: new Map() };
async function users() {
  if (Date.now() - userCache.at > 10000) {
    const rows = await q('SELECT id, extension, first_name, last_name, email, notify_missed, notify_voicemail FROM users');
    userCache = { at: Date.now(), map: new Map(rows.map((u) => [u.extension, u])) };
  }
  return userCache.map;
}
export function invalidateUserCache() { userCache.at = 0; users().catch(() => {}); }
// Synchronous lookup so events publish in the order Asterisk sent them; the cache refreshes in the background.
function userNow(ext) {
  if (Date.now() - userCache.at > 10000) users().catch(() => {});
  return userCache.map.get(ext);
}

export function handleAmiEvent(e) {
  try {
    switch (e.Event) {
      case 'Newchannel': return onNewchannel(e);
      case 'UserEvent': return onUserEvent(e);
      case 'DialBegin': return onDialBegin(e);
      case 'DialEnd': return onDialEnd(e);
      // A queue member picking up (its DestChannel is the member's Local leg); backs up the queue's own DialEnd.
      case 'AgentConnect': return onDialEnd({ ...e, DialStatus: 'ANSWER' });
      case 'Newexten': return onNewexten(e);
      case 'Hangup': return onHangup(e);
      case 'NewCallerid': return onNewCallerid(e);
      case 'ContactStatus': return onContactStatus(e);
      case 'QueueCallerJoin': return onQueueJoin(e);
    }
  } catch (err) {
    console.error('calltracker error', e.Event, err);
  }
}

function onNewchannel(e) {
  const id = e.Linkedid;
  chanToCall.set(e.Uniqueid, id);
  let c = calls.get(id);
  if (!c) {
    const ep = endpointOf(e.Channel);
    c = {
      id, channels: new Set(), startedAt: new Date(),
      direction: isTrunk(ep) ? 'inbound' : 'internal',
      trunk: isTrunk(ep) ? ep : null,
      fromNum: e.CallerIDNum && e.CallerIDNum !== '<unknown>' ? e.CallerIDNum : null,
      fromName: e.CallerIDName && e.CallerIDName !== '<unknown>' ? e.CallerIDName : null,
      fromExt: !isTrunk(ep) && ep ? ep : null,
      toNum: e.Exten && e.Exten !== 's' ? e.Exten : null,
      did: null, answeredBy: null, answeredAt: null, ended: false,
      targets: new Set(), rung: new Set(), vmMailbox: null, busy: false, path: [],
    };
    calls.set(id, c);
  }
  c.channels.add(e.Uniqueid);
}

const known = (v) => (v && v !== '<unknown>' ? v : null);

// Caller ID is sometimes set after the channel is created.
function onNewCallerid(e) {
  const c = calls.get(e.Linkedid);
  if (!c || e.Uniqueid !== c.id || c.clickToCall) return; // a click-to-call stays "from" the user who placed it
  c.fromNum = known(e.CallerIDNum) || c.fromNum;
  c.fromName = known(e.CallerIDName) || c.fromName;
}

function callFor(e) {
  return calls.get(e.Linkedid) || calls.get(chanToCall.get(e.Uniqueid));
}

function onUserEvent(e) {
  const c = callFor(e);
  const name = e.UserEvent;
  if (name === 'AsterFiDnd') {
    publish('user.dnd', { extension: e.Extension, dnd: e.State === 'on' });
    return;
  }
  if (!c) return;
  switch (name) {
    case 'AsterFiInbound':
      c.direction = 'inbound';
      c.did = e.DID === 'catchall' ? null : e.DID;
      c.toNum = c.did || c.toNum;
      c.path.push({ at: new Date(), step: 'number', did: c.did, name: e.Name });
      publish('call.inbound', { ...summary(c), numberName: e.Name || null });
      break;
    case 'AsterFiOutbound':
      // A forwarded call goes out through the trunk too, but it's still the original call to us.
      if (c.forwardedTo) break;
      c.direction = 'outbound';
      c.toNum = e.Number;
      publish('call.outbound', summary(c));
      break;
    case 'AsterFiClick': {
      // Click-to-call: the call starts on a Local channel, so credit it to the user whose phones ring first.
      // Their own phones ringing isn't the call ringing them, so it never counts as missed (DialBegin skips fromExt).
      const u = userNow(e.Extension);
      c.clickToCall = true;
      c.fromExt = e.Extension;
      c.fromNum = e.Extension;
      c.fromName = u ? `${u.first_name} ${u.last_name}`.trim() : c.fromName;
      c.toNum = e.Number;
      c.path.push({ at: new Date(), step: 'click-to-call', extension: e.Extension, number: e.Number });
      break;
    }
    case 'AsterFiTarget':
      for (const x of String(e.Extensions || '').split('&').filter(Boolean)) {
        if (x !== c.fromExt) c.targets.add(x);
      }
      c.path.push({ at: new Date(), step: e.Group ? 'group' : 'user', target: e.Group || e.Extensions });
      break;
    case 'AsterFiForward':
      // The user has call forwarding on: their call rings this number instead of their phones.
      c.forwardedTo = e.Number;
      // A queue rings the same member again on each pass; note the forward once.
      if (!c.path.some((s) => s.step === 'forward' && s.from === e.Extension && s.to === e.Number)) {
        c.path.push({ at: new Date(), step: 'forward', from: e.Extension, to: e.Number });
      }
      break;
    case 'AsterFiFlow':
      c.path.push({ at: new Date(), step: 'flow', flow: Number(e.Flow), name: e.Name });
      break;
    case 'AsterFiRecording':
      // The call flow records this call; the file only gets audio once someone answers.
      if (!c.path.some((s) => s.step === 'recording')) c.path.push({ at: new Date(), step: 'recording', file: e.File });
      break;
    case 'AsterFiQueue':
      // Queue() returned without anyone answering: TIMEOUT, FULL, JOINEMPTY, LEAVEEMPTY, or a callback choice.
      c.path.push({ at: new Date(), step: 'queue-exit', group: e.Group, status: e.Status || null });
      break;
    case 'AsterFiCallback':
      // A waiting caller pressed 2 to request a callback at their number.
      c.path.push({ at: new Date(), step: 'callback', group: e.Group });
      c.callbackGroup = e.Group;
      publish('call.callback', { callId: c.id, group: e.Group, from: e.From || c.fromNum, fromName: e.Name || c.fromName, at: new Date() });
      notifyCallback(e.Group, e.From || c.fromNum, e.Name || c.fromName).catch((err) => console.error('callback notify', err.message));
      break;
    case 'AsterFiIvr':
      c.path.push({ at: new Date(), step: 'ivr', flow: Number(e.Flow), node: e.Node, key: e.Key || null });
      publish('ivr.keypress', { callId: c.id, from: c.fromNum, fromName: c.fromName, flowId: Number(e.Flow), node: e.Node, key: e.Key || null });
      break;
  }
}

function onQueueJoin(e) {
  const c = calls.get(e.Linkedid) || callFor(e);
  const group = (/^asterfi-q-(\d+)(?:-[0-9a-f]+)?$/.exec(e.Queue || '') || [])[1];
  if (!c || !group) return;
  c.path.push({ at: new Date(), step: 'queue', group, position: Number(e.Position) || null });
  publish('call.queued', { ...summary(c), group, position: Number(e.Position) || null, waiting: Number(e.Count) || null });
}

function onDialBegin(e) {
  const c = calls.get(e.DestLinkedid) || callFor(e);
  if (!c) return;
  const ep = endpointOf(e.DestChannel);
  if (!ep || isTrunk(ep) || ep === c.fromExt) return;
  if (c.rung.has(ep)) return;
  c.rung.add(ep);
  if (ep !== c.fromExt) c.targets.add(ep);
  const u = userNow(ep);
  publish('call.ringing', { ...summary(c), extension: ep, user: u ? userRef(u) : null });
}

function onDialEnd(e) {
  const c = calls.get(e.DestLinkedid) || callFor(e);
  if (!c) return;
  const ep = endpointOf(e.DestChannel);
  if (e.DialStatus === 'BUSY') c.busy = true;
  if (e.DialStatus !== 'ANSWER' || c.answeredAt) return;
  // A group member's leg (Local/<ext>@asterfi-ring) answering is that member taking the call. It's what counts
  // when the member is forwarded to an outside number: their cell picking up (or its voicemail) inside the
  // leg isn't an answer until they press 1, which is when the leg itself answers.
  const member = /^Local\/([^@]+)@asterfi-ring-/.exec(e.DestChannel || '')?.[1];
  const inGroup = c.path.some((s) => s.step === 'group');
  let by;
  let fwd = null;
  if (member) {
    by = member;
    fwd = c.path.find((s) => s.step === 'forward' && s.from === member) || null;
  } else {
    if (!ep || ep === c.fromExt) return; // other Local legs and the caller's own leg
    if (isTrunk(ep) && c.forwardedTo && inGroup) return; // screened group forward: wait for the member leg
    // A trunk answering a forwarded direct call is the forwarding user picking up on their cell.
    fwd = isTrunk(ep) && c.forwardedTo ? c.path.filter((s) => s.step === 'forward').pop() : null;
    by = fwd ? fwd.from : isTrunk(ep) ? null : ep;
  }
  c.answeredAt = new Date();
  c.answeredBy = by;
  c.path.push({ at: c.answeredAt, step: 'answered', by, ...(fwd ? { forwarded: fwd.to } : {}) });
  const u = c.answeredBy ? userNow(c.answeredBy) : null;
  publish('call.answered', { ...summary(c), user: u ? userRef(u) : null });
}

function onNewexten(e) {
  if (e.Application !== 'VoiceMail') return;
  const c = callFor(e);
  if (!c) return;
  c.vmMailbox = String(e.AppData || '').split('@')[0];
  c.path.push({ at: new Date(), step: 'voicemail', mailbox: c.vmMailbox });
}

function onHangup(e) {
  const id = chanToCall.get(e.Uniqueid) || e.Linkedid;
  chanToCall.delete(e.Uniqueid);
  const c = calls.get(id);
  if (!c) return;
  c.channels.delete(e.Uniqueid);
  if (c.channels.size === 0 && !c.ended) {
    c.ended = true;
    c.endedAt = new Date();
    finalize(c).catch((err) => console.error('finalize call', err));
  }
}

const userRef = (u) => ({ id: u.id, extension: u.extension, name: `${u.first_name} ${u.last_name}`.trim(), email: u.email || null });

async function finalize(c) {
  const answered = !!c.answeredAt;
  if (!answered && c.targets.size + (c.vmMailbox ? 1 : 0) > 0) {
    // Give the voicemail scanner a moment to pick up a message left on this call.
    await new Promise((r) => setTimeout(r, c.vmMailbox ? VM_SETTLE_MS : 1500));
  }
  let vm = null;
  if (c.vmMailbox) {
    vm = await one(
      `SELECT msg_id FROM voicemails WHERE mailbox=$1 AND received_at >= $2 AND call_id IS NULL
       ORDER BY received_at LIMIT 1`, [c.vmMailbox, new Date(c.startedAt.getTime() - 5000)]);
    if (vm) await q('UPDATE voicemails SET call_id=$1 WHERE msg_id=$2', [c.id, vm.msg_id]);
  }
  const status = answered ? 'answered' : vm ? 'voicemail' : c.busy ? 'busy'
    : c.targets.size ? 'missed' : 'abandoned';
  const missed = answered ? [] : [...c.targets];
  const duration = Math.round((c.endedAt - c.startedAt) / 1000);
  const talk = answered ? Math.round((c.endedAt - c.answeredAt) / 1000) : 0;
  const rec = {
    id: c.id, direction: c.direction, from: c.fromNum, fromName: c.fromName, to: c.toNum, did: c.did,
    trunk: c.trunk, answeredBy: c.answeredBy, status, startedAt: c.startedAt, answeredAt: c.answeredAt,
    endedAt: c.endedAt, duration, talkSeconds: talk, missedExtensions: missed, voicemailId: vm?.msg_id || null,
    path: c.path,
  };
  await q(
    `INSERT INTO calls (id, direction, from_num, from_name, to_num, did, trunk, answered_by, status,
       started_at, answered_at, ended_at, duration, talk_seconds, missed_exts, path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING`,
    [c.id, c.direction, c.fromNum, c.fromName, c.toNum, c.did, c.trunk, c.answeredBy, status,
      c.startedAt, c.answeredAt, c.endedAt, duration, talk, missed, JSON.stringify(c.path)]);
  publish('call.ended', rec);

  const umap = await users();
  // A message left in a group's mailbox is emailed to its members as "missed call + voicemail".
  const groupBox = vm ? await one(`SELECT members FROM ring_groups WHERE extension=$1 AND (voicemail->>'enabled')::boolean`, [c.vmMailbox]) : null;
  // A call to a group is emailed as missed "to Service", not to the member who missed it.
  const groupExt = c.path.find((s) => s.step === 'group')?.target || c.path.find((s) => s.step === 'queue')?.group;
  const viaGroup = groupExt ? await one('SELECT name, extension FROM ring_groups WHERE extension=$1', [groupExt]).catch(() => null) : null;
  for (const ext of missed) {
    const u = umap.get(ext);
    // A voicemail left for this user gets one "missed call + voicemail" email instead of a separate missed-call one
    // (if they turned voicemail emails off but missed-call emails on, they still get the missed-call email).
    if (vm && ext === c.vmMailbox && u?.notify_voicemail) continue;
    publish('call.missed', { callId: c.id, extension: ext, user: u ? userRef(u) : null, from: c.fromNum, fromName: c.fromName, did: c.did, at: c.startedAt });
    if (groupBox?.members.includes(ext)) continue;
    if (u?.notify_missed && u.email) sendMissedCallEmail(u, rec, viaGroup).catch((err) => console.error('missed email', err.message));
  }
  setTimeout(() => calls.delete(c.id), 5000);
}

// Registration changes for phones (contacts on user AORs).
const contactState = new Map();
function onContactStatus(e) {
  const aor = String(e.AOR || '').replace(/^webrtc-/, '');
  if (!aor || aor.startsWith('trunk-')) return;
  const st = e.ContactStatus;
  const online = ['Created', 'Reachable', 'Updated'].includes(st);
  const offline = ['Removed', 'Unreachable'].includes(st);
  const key = e.URI;
  const prev = contactState.get(key);
  if (online && prev !== 'online') {
    contactState.set(key, 'online');
    publish('phone.registered', { extension: aor, uri: e.URI, userAgent: e.UserAgent || null, webPhone: String(e.AOR).startsWith('webrtc-') });
  } else if (offline && prev !== 'offline') {
    contactState.set(key, 'offline');
    publish('phone.unregistered', { extension: aor, uri: e.URI });
  }
}

// Drop anything that somehow never got a final Hangup.
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [id, c] of calls) if (c.startedAt.getTime() < cutoff) calls.delete(id);
}, 600000).unref();
