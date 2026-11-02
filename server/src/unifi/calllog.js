// A UniFi phone's Recents list comes from the controller, not the phone: on connect (and when it asks with
// get_call_log) it is sent "call_log" with the user's last 200 calls, finished calls arrive as
// "call_log_entries_updated", and opening Recents sends mark_call_log_as_read. Entry shape copied from UniFi Talk.
import { q } from '../db.js';

const MISSED = ['missed', 'abandoned', 'busy', 'voicemail', 'failed'];
const MINE = '(from_num=$1 OR answered_by=$1 OR to_num=$1 OR $1 = ANY(missed_exts))';

// One calls row as seen by the user on extension ext.
export function phoneLogEntry(c, ext) {
  const out = c.from_num === ext && c.direction !== 'inbound';
  const missed = !out && c.answered_by !== ext && ((c.missed_exts || []).includes(ext) || MISSED.includes(c.status));
  return {
    id: c.id,
    number: out ? c.to_num : c.from_num,
    type: out ? 'OUTGOING' : missed ? 'MISSED' : 'INCOMING',
    is_read: out || !missed || (c.read_by || []).includes(ext),
    is_video_call: false, is_intercom_call: false, is_group_intercom_call: false,
    timestamp: Math.floor(new Date(c.started_at).getTime() / 1000),
    caller_name: !out && c.from_name && c.from_name !== c.from_num ? c.from_name : null,
    dialed_number: c.to_num,
    dialed_contact_id: null,
    ringing_endpoints: { contacts_count: 0, users_count: 0, external_dids_count: 0, ringing_you: false },
    answered_by_contact_id: null,
    answered_by_number: c.answered_by || null,
  };
}

export async function phoneLogFor(ext) {
  const rows = await q(`SELECT * FROM calls WHERE ${MINE} ORDER BY started_at DESC LIMIT 200`, [ext]);
  return rows.map((c) => phoneLogEntry(c, ext)).filter((e) => e.number);
}

// Opening Recents on the phone clears its missed-call badge.
export async function markPhoneLogRead(ext) {
  await q(`UPDATE calls SET read_by = array_append(read_by, $1) WHERE ${MINE} AND NOT ($1 = ANY(read_by))`, [ext]);
}

// Everyone a finished call belongs in the Recents of.
export function callParties(c) {
  return [...new Set([c.from_num, c.answered_by, c.to_num, ...(c.missed_exts || [])].filter(Boolean))];
}
