// UniFi Talk device protocol over the /device/inform WebSocket (reverse-engineered from a UVP-TOUCH-MAX).
// A WS message is one or more parts, each: [type u8][flags u8][length u48 BE][JSON body].
//   type 1 = envelope {id, type:'request'|'event'|'response', timestamp, action?|name?}
//   type 2 = payload  {...}
// Requests from the phone carry an id and expect a response message with the same id.
import { randomUUID } from 'node:crypto';

function frame(type, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head[0] = type;
  head[1] = 1;
  head.writeUIntBE(body.length, 2, 6);
  return Buffer.concat([head, body]);
}

export function encodeMessage(env, payload) {
  return payload === undefined ? frame(1, env) : Buffer.concat([frame(1, env), frame(2, payload)]);
}

export function decodeMessage(buf) {
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUIntBE(i + 2, 6);
    parts.push({ type, json: tryJson(buf.subarray(i + 8, i + 8 + len)) });
    i += 8 + len;
  }
  return { env: parts.find((p) => p.type === 1)?.json || null, payload: parts.find((p) => p.type === 2)?.json ?? null };
}

function tryJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); }
}

// Handles one device WebSocket. `log(kind, obj)` records both directions.
// `ctx.config` (optional): the Talk config to push so the phone registers SIP; sent once the phone has announced itself.
export function handleTalkWs(ws, log, ctx = {}) {
  const send = (env, payload) => { ws.send(encodeMessage(env, payload)); log('ws-send', { env, payload }); };
  let provisioned = false;
  const provision = () => {
    if (provisioned || !ctx.profiles) return;
    provisioned = true;
    // ucp4 phones receive their SIP account as a pushed "profiles_update" event; body is the profiles array.
    send({ id: randomUUID(), type: 'event', timestamp: Date.now(), name: 'profiles_update' }, ctx.profiles);
    log('provisioned', { ext: ctx.profiles?.[0]?.numbers?.[0]?.number });
    ctx.onProvisioned?.();
  };
  ws.on('message', (data) => {
    let msg;
    try { msg = decodeMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch (e) { log('ws-parse-error', { message: e.message }); return; }
    log('ws-recv', msg);
    const { env } = msg;
    if (env?.type === 'request') send({ id: env.id, type: 'response', timestamp: Date.now(), action: env.action }, {});
    // Contacts saved on the phone itself: [{id?, name, number}].
    if (env?.action === 'create_contacts' && msg.payload?.contacts?.length) ctx.onCreateContacts?.(msg.payload.contacts);
    // The phone's status menu (Redirect = forward my calls); the number arrives just before the status.
    if (env?.name === 'user_redirect_number_update') ctx.onRedirectNumber?.(msg.payload?.redirect_number);
    // Recents: the phone asks for its call log, and marks it read when opened (event or request, by firmware).
    if ((env?.action || env?.name) === 'get_call_log') ctx.onGetCallLog?.();
    if ((env?.action || env?.name) === 'mark_call_log_as_read') ctx.onCallLogRead?.();
    if (env?.name === 'user_status_update') ctx.onStatus?.(msg.payload?.status);
    // Once the phone announces itself, push its config.
    if (env?.name === 'device_metadata' || env?.action === 'device_metadata') provision();
  });
  // Fallback: provision shortly after connect even if device_metadata ordering differs.
  if (ctx.profiles) setTimeout(provision, 2000);
}
