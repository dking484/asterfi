// Watches the voicemail spool for new messages and exposes listing/playback/delete.
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { q, one } from './db.js';
import { publish } from './events.js';
import { transcribe, sttSettings } from './stt.js';

const FOLDERS = ['INBOX', 'Old', 'Urgent'];
let ami = null;
let firstScan = true;

export function initVoicemail(amiClient) {
  ami = amiClient;
  const tick = () => scan().catch((e) => console.error('voicemail scan', e.message)).finally(() => setTimeout(tick, 3000));
  tick();
}

function parseTxt(txt) {
  const o = {};
  for (const line of txt.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) o[m[1]] = m[2];
  }
  return o;
}

function splitCallerId(cid) {
  const m = /^"?([^"<]*)"?\s*<([^>]*)>/.exec(cid || '');
  if (m) return { name: m[1].trim() || null, num: m[2].trim() || null };
  return { name: null, num: (cid || '').trim() || null };
}

async function listDir(dir) {
  try { return await readdir(dir); } catch { return []; }
}

// All messages currently in the spool, newest first.
export async function listMessages(mailbox) {
  const root = config.voicemailSpool;
  const boxes = mailbox ? [mailbox] : await listDir(root);
  const out = [];
  for (const box of boxes) {
    if (!/^[0-9*#]+$/.test(box)) continue;
    for (const folder of FOLDERS) {
      const dir = path.join(root, box, folder);
      for (const f of (await listDir(dir)).filter((x) => /^msg\d+\.txt$/.test(x))) {
        try {
          const meta = parseTxt(await readFile(path.join(dir, f), 'utf8'));
          const cid = splitCallerId(meta.callerid);
          out.push({
            msgId: meta.msg_id || `${box}-${folder}-${f}`,
            mailbox: box, folder, file: path.join(dir, f.replace(/\.txt$/, '')),
            callerNum: cid.num, callerName: cid.name,
            duration: Number(meta.duration) || 0,
            receivedAt: new Date(Number(meta.origtime) * 1000),
            heard: folder === 'Old',
          });
        } catch { /* file being written or removed */ }
      }
    }
  }
  // Transcripts live in the database, keyed by Asterisk's msg_id.
  const rows = out.length ? await q('SELECT msg_id, transcript, transcript_status FROM voicemails WHERE msg_id = ANY($1)', [out.map((m) => m.msgId)]) : [];
  const byId = new Map(rows.map((r) => [r.msg_id, r]));
  for (const m of out) {
    m.transcript = byId.get(m.msgId)?.transcript ?? null;
    m.transcriptStatus = byId.get(m.msgId)?.transcript_status ?? null;
  }
  return out.sort((a, b) => b.receivedAt - a.receivedAt);
}

const EMAIL_WAIT_MS = 90 * 1000; // the longest a voicemail email waits for its transcript

// Transcribes one message (a voicemails row) and stores the text. Resolves to the text, or null if it failed.
export async function transcribeVoicemail(vm) {
  const m = await findMessage(vm.mailbox, vm.msg_id);
  if (!m) return null;
  const { model } = await sttSettings();
  await q(`UPDATE voicemails SET transcript_status='pending' WHERE msg_id=$1`, [vm.msg_id]);
  try {
    const text = await transcribe(`${m.file}.wav`, model);
    await q(`UPDATE voicemails SET transcript=$2, transcript_status='done' WHERE msg_id=$1`, [vm.msg_id, text]);
    publish('voicemail.transcribed', { id: vm.msg_id, mailbox: vm.mailbox, transcript: text });
    return text;
  } catch (e) {
    console.error('voicemail transcription', vm.msg_id, e.message);
    await q(`UPDATE voicemails SET transcript_status='failed' WHERE msg_id=$1`, [vm.msg_id]);
    publish('voicemail.transcribed', { id: vm.msg_id, mailbox: vm.mailbox, transcript: null, error: 'Transcription failed' });
    return null;
  }
}

async function scan() {
  const msgs = await listMessages();
  const known = new Set((await q('SELECT msg_id FROM voicemails')).map((r) => r.msg_id));
  for (const m of msgs) {
    if (known.has(m.msgId)) continue;
    // The .txt is written before recording finishes; wait until the audio is settled.
    const st = await stat(`${m.file}.wav`).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < 1500) continue;
    const old = firstScan && Date.now() - m.receivedAt.getTime() > 10 * 60 * 1000;
    const row = await one(
      `INSERT INTO voicemails (msg_id, mailbox, caller_num, caller_name, duration, received_at, notified)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (msg_id) DO NOTHING RETURNING *`,
      [m.msgId, m.mailbox, m.callerNum, m.callerName, m.duration, m.receivedAt, old]);
    if (row && !old) onNewVoicemail(row).catch((e) => console.error('voicemail notify', e.message));
  }
  firstScan = false;
}

async function onNewVoicemail(row) {
  const stt = await sttSettings();
  const transcribing = stt.enabled && stt.available ? transcribeVoicemail(row).catch(() => null) : null;
  const user = await one('SELECT * FROM users WHERE extension=$1', [row.mailbox]);
  const group = user ? null : await one(`SELECT * FROM ring_groups WHERE extension=$1 AND (voicemail->>'enabled')::boolean`, [row.mailbox]);
  publish('voicemail.new', {
    id: row.msg_id, mailbox: row.mailbox, from: row.caller_num, fromName: row.caller_name,
    duration: row.duration, receivedAt: row.received_at,
    user: user ? { id: user.id, extension: user.extension, name: `${user.first_name} ${user.last_name}`.trim(), email: user.email } : null,
    group: group ? { id: group.id, extension: group.extension, name: group.name } : null,
  });
  // The email waits for the transcript, but not forever: a slow one arrives later on the Voicemail page.
  const transcript = transcribing && await Promise.race([transcribing, new Promise((r) => setTimeout(() => r(null), EMAIL_WAIT_MS))]);
  const vm = { ...row, transcript: transcript || null };
  if (group) {
    // One "missed call + voicemail" email to each member (if chosen) and any extra addresses.
    const members = group.voicemail.email_members
      ? await q('SELECT email FROM users WHERE extension = ANY($1) AND email IS NOT NULL', [group.members]) : [];
    const to = [...new Set([...members.map((m) => m.email), ...(group.voicemail.emails || [])].map((x) => x.toLowerCase()))];
    if (to.length) {
      const { sendGroupVoicemailEmail } = await import('./notify/email.js');
      await sendGroupVoicemailEmail(group, to, vm);
    }
  } else if (user?.notify_voicemail && user.email) {
    const { sendVoicemailEmail } = await import('./notify/email.js');
    await sendVoicemailEmail(user, vm);
  }
  await q('UPDATE voicemails SET notified=true WHERE msg_id=$1', [vm.msg_id]);
}

export async function findMessage(mailbox, msgId) {
  return (await listMessages(mailbox)).find((m) => m.msgId === msgId) || null;
}

export function transcode(file, format = 'mp3') {
  return new Promise((resolve, reject) => {
    const args = ['-loglevel', 'error', '-i', file, ...(format === 'mp3' ? ['-f', 'mp3', '-b:a', '48k'] : ['-f', 'wav']), '-'];
    const p = spawn('ffmpeg', args);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code} on ${file}: ${err.trim().slice(-300)}`))));
  });
}

export async function voicemailMp3(mailbox, msgId) {
  const m = await findMessage(mailbox, msgId);
  if (!m) throw new Error('not found');
  return transcode(`${m.file}.wav`);
}

export async function deleteMessage(mailbox, msgId) {
  const m = await findMessage(mailbox, msgId);
  if (!m) return false;
  const r = await ami.action({ Action: 'VoicemailRemove', Mailbox: mailbox, Context: config.vmContext, Folder: m.folder, ID: msgId });
  if (r.Response !== 'Success') throw new Error(r.Message || 'delete failed');
  return true;
}

export async function markHeard(mailbox, msgId) {
  const m = await findMessage(mailbox, msgId);
  if (!m || m.folder !== 'INBOX') return;
  await ami.action({ Action: 'VoicemailMove', Mailbox: mailbox, Context: config.vmContext, Folder: 'INBOX', ID: msgId, ToFolder: 'Old' });
}
