// Click-to-call: ring a user's own phones first, and when they pick up, dial the number for them.
// Used by the console (Call History, Voicemail, Contacts) and by the REST API (POST /api/v1/calls).
import { randomBytes } from 'node:crypto';
import { one } from './db.js';
import { extSafe } from './asterisk/dest.js';

const RING_SECONDS = 30; // how long the user's phones ring before the attempt is dropped

export class CallError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Digits with an optional leading +, the same characters a phone can dial (no * or # feature codes).
export const dialable = (n) => {
  const s = String(n ?? '').trim();
  const d = s.replace(/[^0-9]/g, '').slice(0, 20);
  return d && s.startsWith('+') ? `+${d}` : d;
};

// The user's phones that are signed in now: desk phones and softphones (<ext>) and the web phone (webrtc-<ext>).
async function onlineContacts(ami, ext) {
  const r = await ami.action({ Action: 'PJSIPShowContacts' });
  return (r.events || []).filter((e) => e.Event === 'ContactList').filter((e) => {
    const aor = String(e.ObjectName || '').split(';@')[0] || String(e.Endpoint || '');
    return (aor === ext || aor === `webrtc-${ext}`) && ['Reachable', 'NonQualified', 'Created', 'Unknown'].includes(e.Status);
  });
}

// Returns { callId, extension, number }. The call shows up in Call History under callId once it ends.
export async function clickToCall(ami, { extension, number }) {
  const ext = extSafe(extension);
  const num = dialable(number);
  if (!num) throw new CallError(400, 'Enter a phone number to call.');
  const u = ext && await one('SELECT extension, first_name, last_name, outbound_cid FROM users WHERE extension=$1', [ext]);
  if (!u) throw new CallError(404, `No user has extension ${ext || extension}.`);
  if (num === ext) throw new CallError(400, "That's your own extension.");
  if (!(await onlineContacts(ami, ext)).length) {
    throw new CallError(409, `No phones are signed in as extension ${ext}. Sign in a phone, or turn on the web phone.`);
  }
  const name = `${u.first_name} ${u.last_name}`.trim().replace(/["<>\r\n]/g, '');
  const callId = `c2c-${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString('hex')}`;
  const outcid = String(u.outbound_cid || '').replace(/[^0-9]/g, '');
  // The Local channel's ;2 half rings the user (asterfi-click); once they answer, its ;1 half dials the
  // number in asterfi-internal, the same context their phone dials from. ChannelId makes ;1's uniqueid,
  // and so the call's linkedid, the id we hand back.
  const r = await ami.action({
    Action: 'Originate', Channel: `Local/${ext}@asterfi-click/n`, ChannelId: callId,
    Context: 'asterfi-internal', Exten: num, Priority: 1,
    CallerID: `"${name || ext}" <${ext}>`, Timeout: (RING_SECONDS + 5) * 1000, Async: 'true',
    Variable: [`ASTERFI_EXT=${ext}`, `ASTERFI_CLICKNUM=${num}`, `ASTERFI_CLICKSECS=${RING_SECONDS}`,
      ...(outcid ? [`ASTERFI_OUTCID=${outcid}`] : [])],
  });
  if (r.Response !== 'Success') throw new CallError(502, `Asterisk didn't start the call: ${r.Message || 'unknown error'}`);
  return { callId, extension: ext, number: num };
}
