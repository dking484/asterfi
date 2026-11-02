// Outbound email using the admin-configured SMTP server (Settings > Email).
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { getSetting, q } from '../db.js';
import { voicemailMp3 } from '../voicemail.js';

let cached = { key: '', transport: null };

async function transport() {
  const s = await getSetting('smtp');
  if (!s.host || !s.fromAddress) throw new Error('Email is not configured (Settings > Email)');
  const key = JSON.stringify(s);
  if (cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: s.host,
        port: Number(s.port) || 587,
        secure: !!s.secure,
        auth: s.username ? { user: s.username, pass: s.password } : undefined,
        tls: { rejectUnauthorized: !s.allowSelfSigned },
        connectionTimeout: 15000,
      }),
    };
  }
  return { t: cached.transport, s };
}

// The white logo for the email header travels inside the message (cid:), so it shows even when AsterFi
// isn't reachable from where the email is read.
const LOGO_CID = 'asterfi-logo';
let logo = null;
try { logo = readFileSync(new URL('./email-logo.png', import.meta.url)); } catch { /* header falls back to text */ }
// The rounded top and bottom edges of the card for classic Outlook, which ignores border-radius
// (cid:card-top, cid:card-bottom; 544px wide, stored at 2x).
const CORNERS = Object.fromEntries(['top', 'bottom'].map((k) => {
  try { return [k, readFileSync(new URL(`./card-${k}.png`, import.meta.url))]; } catch { return [k, null]; }
}));
// Outlook's buttons are images of the pill with its label drawn in (Outlook clips its own drawn VML buttons by a
// pixel or two). Made by hand for each label used below; a label without an image falls back to VML.
const BUTTONS = Object.fromEntries(['View call history', 'Listen to voicemail'].map((label) => {
  const slug = label.toLowerCase().replace(/ /g, '-');
  try { return [label, { cid: `btn-${slug}`, png: readFileSync(new URL(`./btn-${slug}.png`, import.meta.url)), width: Math.max(200, label.length * 10 + 70) }]; } catch { return [label, null]; }
}));
const inlineImages = (html) => [
  ...Object.values(BUTTONS).filter((b) => b && html.includes(`cid:${b.cid}`))
    .map((b) => ({ filename: `${b.cid}.png`, content: b.png, cid: b.cid, contentType: 'image/png' })),
  ...(logo && html.includes(`cid:${LOGO_CID}`) ? [{ filename: 'logo.png', content: logo, cid: LOGO_CID, contentType: 'image/png' }] : []),
  ...Object.entries(CORNERS).filter(([k, v]) => v && html.includes(`cid:card-${k}`))
    .map(([k, v]) => ({ filename: `card-${k}.png`, content: v, cid: `card-${k}`, contentType: 'image/png' })),
];

export async function sendMail({ kind, to, subject, html, text, attachments = [] }) {
  try {
    const { t, s } = await transport();
    const all = html ? [...attachments, ...inlineImages(html)] : attachments;
    await t.sendMail({ from: { name: s.fromName || 'AsterFi', address: s.fromAddress }, to, subject, html, text, attachments: all });
    await q('INSERT INTO email_log (kind, recipient, subject, status) VALUES ($1,$2,$3,$4)', [kind, to, subject, 'sent']);
  } catch (e) {
    await q('INSERT INTO email_log (kind, recipient, subject, status, error) VALUES ($1,$2,$3,$4,$5)',
      [kind, to, subject, 'failed', e.message]).catch(() => {});
    throw e;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function formatNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return n || 'Unknown';
}

async function siteInfo() {
  const g = await getSetting('general');
  return { name: g.siteName || 'AsterFi', url: (g.publicUrl || '').replace(/\/$/, ''), tz: g.timezone || 'America/New_York' };
}

const fmtTime = (d, tz) => new Date(d).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Branded email: blue header with the logo, a large title, then a rounded card with a heading, label/value rows,
// an optional note and a pill button. Tables and inline styles for every client; classic desktop Outlook draws
// with Word and ignores rounded corners, gradients and link padding, so (inside <!--[if mso]> comments) it gets
// a card with image strips for its rounded top and bottom edges and a VML pill button instead (no
// placeholder &nbsp; cells: Outlook pads them and shades them with the page color). The top strip carries 2px of white
// above its border: Outlook can trim an image's top pixel row in these zero line-height cells (a real line height
// isn't an option, Word then adds a seam under the image). Never put an HTML comment inside a conditional
// block (its --> ends the block), and keep the page color off <body>: Outlook paints the body background behind
// text, which showed as a gray bar across the card's top edge.
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const CARD_W = 544; // 600px email minus the card's side margins
export function layout(site, { title, heading, rows = [], note = '', cta = null, extraHtml = '' }) {
  const tr = rows.map(([k, v]) => `<tr>
      <td style="padding:9px 12px 9px 0;color:#5b6472;font-size:15px;width:40%;vertical-align:top;font-family:${FONT}">${esc(k)}</td>
      <td style="padding:9px 0;color:#1f2733;font-size:15px;vertical-align:top;font-family:${FONT}">${esc(v)}</td></tr>`).join('');
  const btnW = Math.max(200, Math.round(String(cta?.label || '').length * 10 + 70));
  // Outlook's button is a VML pill; everyone else gets a styled link. Each lives in its own branch below,
  // because conditional comments can't nest (an inner <![endif]--> would close the outer block).
  // Spacing comes from cell padding: Outlook ignores margins on tables.
  const wrapBtn = (inner) => (cta ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:22px 0 4px">${inner}</td></tr></table>` : '');
  const btnImg = cta && BUTTONS[cta.label];
  const btnMso = btnImg ? wrapBtn(`<a href="${esc(cta.url)}"><img src="cid:${btnImg.cid}" width="${btnImg.width}" height="48" alt="${esc(cta.label)}" style="display:block;border:0"></a>`)
    : cta ? wrapBtn(`<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(cta.url)}" style="height:48px;v-text-anchor:middle;width:${btnW}px;" arcsize="50%" stroke="f" fillcolor="#2f6bff"><w:anchorlock/><center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold;">${esc(cta.label)}</center></v:roundrect>`) : '';
  const btnWeb = cta ? wrapBtn(`<a href="${esc(cta.url)}" style="display:inline-block;padding:13px 34px;font-family:${FONT};font-size:16px;font-weight:600;line-height:22px;color:#ffffff;text-decoration:none;border-radius:999px;background:#2f6bff;background-image:linear-gradient(90deg,#3d7bff,#2457e6)">${esc(cta.label)}</a>`) : '';
  const brand = logo
    ? `<img src="cid:${LOGO_CID}" width="220" height="88" alt="${esc(site.name)}" style="display:block;margin:0 auto;width:220px;max-width:70%;height:auto;border:0">`
    : `<div style="font-size:30px;font-weight:700;color:#ffffff;letter-spacing:.5px">${esc(site.name)}</div>`;
  const inner = (btn) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tr}</table>
        ${note ? `<p style="margin:14px 0 0;color:#5b6472;font-size:14px;line-height:1.5;font-family:${FONT}">${esc(note)}</p>` : ''}
        ${extraHtml}${btn}`;
  const body = `<tr><td style="padding:16px 28px 22px;font-family:${FONT}">${inner(btnWeb)}</td></tr>`;
  const headStyle = `padding:20px 24px;font-family:${FONT};font-size:19px;font-weight:700;color:#0f1f45`;
  return `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]--></head>
<body style="margin:0;padding:0;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f5f9" style="background:#f3f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff">
  <tr><td align="center" bgcolor="#2f6bff" style="padding:26px 24px;background:#2f6bff;background-image:linear-gradient(90deg,#3477ff,#1f4fd6)">${brand}</td></tr>
  <tr><td align="center" style="padding:34px 24px 6px;font-family:${FONT}">
    <h1 style="margin:0;font-size:34px;line-height:1.15;font-weight:800;color:#0f1f45;font-family:${FONT}">${esc(title)}</h1></td></tr>
  <tr><td align="center" style="padding:22px 28px 34px">
<!--[if mso]>
    <table role="presentation" width="${CARD_W}" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr><td style="font-size:0;line-height:0"><img src="cid:card-top" width="${CARD_W}" height="18" alt="" style="display:block;border:0"></td></tr>
      <tr><td bgcolor="#e9f1ff" align="center" style="${headStyle};padding:2px 24px 20px;border-left:1px solid #d9e2f1;border-right:1px solid #d9e2f1">${esc(heading)}</td></tr>
      <tr><td bgcolor="#ffffff" style="padding:16px 28px 8px;border-left:1px solid #d9e2f1;border-right:1px solid #d9e2f1;font-family:${FONT}">${inner(btnMso)}</td></tr>
      <tr><td style="font-size:0;line-height:0"><img src="cid:card-bottom" width="${CARD_W}" height="16" alt="" style="display:block;border:0"></td></tr>
    </table>
<![endif]-->
<!--[if !mso]><!-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d9e2f1;border-radius:16px;border-collapse:separate;overflow:hidden">
      <tr><td align="center" style="${headStyle};background:#e9f1ff;border-radius:16px 16px 0 0">${esc(heading)}</td></tr>
      ${body}
    </table>
<!--<![endif]-->
  </td></tr>
</table>
<p style="margin:14px 0 0;color:#8a93a3;font-size:12px;font-family:${FONT}">Sent by ${esc(site.name)}</p>
</td></tr></table></body></html>`;
}
const plain = (title, heading, rows, note = '') => `${title}\n\n${heading}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${note ? `\n${note}\n` : ''}`;
const callerLabel = (num, name) => (name && name !== num ? `${name} ${formatNumber(num)}` : formatNumber(num));

// A caller missed this user and left a voicemail: ONE email covers both (no separate missed-call email).
export async function sendVoicemailEmail(user, vm, call = null) {
  const site = await siteInfo();
  const caller = callerLabel(vm.caller_num, vm.caller_name);
  const rows = [['From', caller], ['To', `${user.first_name} ${user.last_name}`.trim() + ` (ext. ${user.extension})`],
    ['When', fmtTime(vm.received_at, site.tz)]];
  if (call?.did) rows.push(['Number dialed', formatNumber(call.did)]);
  rows.push(['Voicemail', `${fmtDur(vm.duration || 0)} long`]);
  const attachments = [];
  if (user.vm_attach_audio) {
    const mp3 = await voicemailMp3(vm.mailbox, vm.msg_id).catch(() => null);
    if (mp3) attachments.push({ filename: `voicemail-${vm.msg_id}.mp3`, content: mp3, contentType: 'audio/mpeg' });
  }
  const title = 'Missed Call Alert';
  const heading = `Voicemail from ${caller}`;
  const note = attachments.length ? 'The recording is attached.' : '';
  const cta = site.url ? { url: `${site.url}/voicemail`, label: 'Listen to voicemail' } : null;
  await sendMail({
    kind: 'voicemail', to: user.email, subject: `Missed call + voicemail from ${caller}`, attachments,
    html: layout(site, { title, heading, rows, note, cta }), text: plain(title, heading, rows, note),
  });
}

// A caller reached a ring group, nobody picked up, and they left a message in the group's mailbox.
export async function sendGroupVoicemailEmail(group, recipients, vm) {
  const site = await siteInfo();
  const caller = callerLabel(vm.caller_num, vm.caller_name);
  const rows = [['From', caller], ['To', `${group.name} (ext. ${group.extension})`],
    ['When', fmtTime(vm.received_at, site.tz)], ['Voicemail', `${fmtDur(vm.duration || 0)} long`]];
  const attachments = [];
  if (group.voicemail?.attach_audio) {
    const mp3 = await voicemailMp3(vm.mailbox, vm.msg_id).catch(() => null);
    if (mp3) attachments.push({ filename: `voicemail-${vm.msg_id}.mp3`, content: mp3, contentType: 'audio/mpeg' });
  }
  const title = 'Missed Call Alert';
  const heading = `${group.name}: voicemail from ${caller}`;
  const note = `Nobody in ${group.name} answered, so the caller left a voicemail.${attachments.length ? ' The recording is attached.' : ''}`;
  const cta = site.url ? { url: `${site.url}/voicemail`, label: 'Listen to voicemail' } : null;
  const html = layout(site, { title, heading, rows, note, cta });
  const text = plain(title, heading, rows, note);
  // Sent one by one so members don't see each other's addresses.
  for (const to of recipients) await sendMail({ kind: 'voicemail', to, subject: `Missed call to ${group.name} + voicemail from ${caller}`, attachments, html, text });
}

// A waiting caller asked a ring group to call them back (instead of leaving a voicemail).
export async function sendGroupCallbackEmail(group, recipients, { from, fromName }) {
  const site = await siteInfo();
  const caller = callerLabel(from, fromName);
  const rows = [['Call back', caller], ['Group', `${group.name} (ext. ${group.extension})`], ['When', fmtTime(new Date(), site.tz)]];
  const title = 'Callback Request';
  const heading = `Please call back ${caller}`;
  const note = 'A caller was waiting in the queue and asked to be called back.';
  const cta = site.url ? { url: `${site.url}/calls`, label: 'View call history' } : null;
  const html = layout(site, { title, heading, rows, note, cta });
  const text = plain(title, heading, rows, note);
  for (const to of recipients) await sendMail({ kind: 'callback', to, subject: `Callback requested — ${group.name}`, html, text });
}

// group: the ring group the call was for, when this user missed it as one of its members.
export async function sendMissedCallEmail(user, call, group = null) {
  const site = await siteInfo();
  const caller = callerLabel(call.from, call.fromName);
  const to = group ? `${group.name} (ext. ${group.extension})` : `${user.first_name} ${user.last_name}`.trim() + ` (ext. ${user.extension})`;
  const rows = [['From', caller], ['To', to], ['When', fmtTime(call.startedAt, site.tz)]];
  if (call.did) rows.push(['Number dialed', formatNumber(call.did)]);
  const fwd = (call.path || []).find((x) => x.step === 'forward' && x.from === user.extension);
  if (fwd) rows.push(['Forwarded to', formatNumber(fwd.to)]);
  const title = 'Missed Call Alert';
  const heading = `Missed call from ${caller}`;
  const cta = site.url ? { url: `${site.url}/calls`, label: 'View call history' } : null;
  await sendMail({
    kind: 'missed', to: user.email, subject: group ? `Missed call to ${group.name} from ${caller}` : heading,
    html: layout(site, { title, heading, rows, cta }), text: plain(title, heading, rows),
  });
}

export async function sendPasswordResetEmail(user, code) {
  const site = await siteInfo();
  const title = `${site.name}: your password reset code`;
  const codeHtml = `<p style="margin:18px 0 6px;text-align:center"><span style="font-size:34px;font-weight:700;letter-spacing:8px;color:#0f1f45;font-family:monospace">${esc(code)}</span></p>`;
  const html = layout(site, {
    title: 'Password Reset', heading: 'Your reset code',
    rows: [['For', `${user.first_name || ''}`.trim() || user.email], ['Expires', 'in 15 minutes']],
    note: "Enter this code on the sign-in page to set a new password. If you didn't ask for this, you can ignore this email.",
    extraHtml: codeHtml,
  });
  await sendMail({
    kind: 'reset', to: user.email, subject: title, html,
    text: `Your ${site.name} password reset code is ${code}. It expires in 15 minutes. If you didn't request it, ignore this email.`,
  });
}

// An admin set (or generated) this user's sign-in password and asked to email it with the rest of their login
// details. consoleUrl: the address the admin is using, when Settings has no public URL.
export async function sendLoginDetailsEmail(user, password, consoleUrl) {
  const site = await siteInfo();
  const url = site.url || String(consoleUrl || '').replace(/\/$/, '');
  const host = url ? new URL(url).hostname : '';
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const rows = [['Name', name], ['Sign in at', url || '—'], ['Username', `${user.email} (or extension ${user.extension})`],
    ['Password', password], ['Extension', user.extension]];
  if (user.vm_enabled && user.vm_pin) rows.push(['Voicemail PIN', `${user.vm_pin} (dial *97)`]);
  if (host) rows.push(['Phone server', host]);
  rows.push(['SIP username', user.extension], ['SIP password', user.sip_password]);
  const title = `Welcome to ${site.name}`;
  const heading = 'Your sign-in details';
  const note = 'Change your password after signing in, under My Account. The SIP details are for signing in a desk phone or softphone yourself; phones set up by your administrator already have them.';
  const cta = url ? { url, label: 'Sign in' } : null;
  await sendMail({
    kind: 'login', to: user.email, subject: `${site.name}: your sign-in details`,
    html: layout(site, { title, heading, rows, note, cta }), text: plain(title, heading, rows, note),
  });
}

export async function sendTestEmail(to) {
  const site = await siteInfo();
  await sendMail({
    kind: 'test', to, subject: `${site.name}: test email`,
    html: layout(site, { title: 'Email Is Working', heading: 'Test email', rows: [['Sent', fmtTime(new Date(), site.tz)]] }),
    text: 'Email is working.',
  });
}
