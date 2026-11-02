// Tracks trunk registration results, including the carrier's reason for a rejection,
// which Asterisk only writes to its log (the AMI Registry event carries just the status).
import { open } from 'node:fs/promises';
import { publish } from './events.js';

const LOG = '/var/log/asterisk/messages.log';
const state = new Map(); // client URI (sip:user@host:port) -> { status, reason, at, retryIn }

export const clientUri = (t) => `sip:${t.username}@${t.host}:${Number(t.port) || 5060}`;
// Falls back to the log when nothing has been seen since AsterFi started.
export async function registrationState(t, liveStatus) {
  const uri = clientUri(t);
  if (state.has(uri)) return state.get(uri);
  if (liveStatus === 'Registered') return null;
  const r = await lastReason(uri);
  return r.reason ? { status: liveStatus, ...r, at: null } : null;
}

async function tail(bytes = 65536) {
  const fh = await open(LOG, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Most recent registration warning for this client URI, e.g. "403 Forbidden", with the retry delay.
async function lastReason(uri) {
  const lines = (await tail().catch(() => '')).split('\n').filter((l) => l.includes(`registration attempt to '${uri}'`));
  const l = lines.at(-1);
  if (!l) return {};
  const m = /res_pjsip_outbound_registration\.c: (No response) received from/.exec(l)
    || /res_pjsip_outbound_registration\.c: (\d{3} .+?) (?:fatal )?response received from/.exec(l);
  const retry = /retrying in '(\d+)'/.exec(l);
  return { reason: m ? m[1] : null, retryIn: retry ? Number(retry[1]) : null };
}

export async function onRegistryEvent(e) {
  if (e.ChannelType !== 'PJSIP' || !e.Username) return;
  const uri = e.Username;
  let info = { status: e.Status, reason: null, retryIn: null, at: new Date() };
  if (e.Status !== 'Registered') {
    // The log line is written alongside the event; give it a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    info = { ...info, ...(await lastReason(uri)) };
  }
  state.set(uri, info);
  publish('trunk.registration', { clientUri: uri, ...info });
}

export const REASON_HELP = {
  401: 'The provider did not accept the credentials. Check the username, auth username and password.',
  403: 'The provider rejected the username or password, or this account is not allowed to register from your IP address. Check the credentials with your provider.',
  404: 'The provider does not recognize this username. Check the username and server.',
  408: 'The provider did not answer in time. Check the server address and your internet connection.',
};
