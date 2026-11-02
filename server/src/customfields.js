// Admin-defined extra fields for contacts and user profiles (Settings > Contact Fields).
// Definitions live in settings 'contactFields' = { fields: [...] }; values in contacts.custom / users.custom, keyed by field id.
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './db.js';

export const FIELD_TYPES = ['text', 'textarea', 'phone', 'email', 'url', 'date', 'select'];

export async function fieldDefs() {
  return (await getSetting('contactFields')).fields || [];
}

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

export async function saveFieldDefs(list) {
  if (!Array.isArray(list)) throw bad('Expected a list of fields.');
  const seen = new Set();
  const fields = list.slice(0, 50).map((f) => {
    const label = String(f?.label || '').trim().slice(0, 60);
    if (!label) throw bad('Every field needs a name.');
    if (seen.has(label.toLowerCase())) throw bad(`There are two fields named "${label}".`);
    seen.add(label.toLowerCase());
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const options = type === 'select'
      ? [...new Set((Array.isArray(f.options) ? f.options : String(f.options || '').split(/\r?\n|,/)).map((o) => String(o).trim()).filter(Boolean))].slice(0, 50)
      : [];
    if (type === 'select' && !options.length) throw bad(`"${label}" is a dropdown, so it needs at least one choice.`);
    const contacts = f.contacts !== false;
    const users = !!f.users;
    if (!contacts && !users) throw bad(`Choose where "${label}" appears.`);
    return {
      id: /^f_[a-f0-9]{8}$/.test(f.id || '') ? f.id : `f_${randomBytes(4).toString('hex')}`,
      label, type, options, contacts, users,
      user_editable: users && f.user_editable !== false, // users may fill it in on My Account
      public: users && f.public !== false, // coworkers see it on the Contacts page
    };
  });
  await setSetting('contactFields', { fields });
  return fields;
}

function cleanValue(def, v) {
  const s = String(v ?? '').trim().slice(0, def.type === 'textarea' ? 2000 : 300);
  if (!s) return '';
  const fail = (why) => { throw bad(`${def.label}: ${why}`); };
  if (def.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) fail("that email address doesn't look right.");
  if (def.type === 'phone' && !/\d/.test(s)) fail('enter a phone number.');
  if (def.type === 'url' && !/^https?:\/\/\S+$/i.test(s)) fail('links start with http:// or https://.');
  if (def.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail('pick a date.');
  if (def.type === 'select' && !def.options.includes(s)) fail('choose one of the listed options.');
  return s;
}

// Merges submitted values into `current`, touching only fields `allow(def)` permits; values of deleted fields are dropped.
export function mergeCustom(current, input, defs, allow) {
  const out = {};
  const ids = new Set(defs.map((d) => d.id));
  for (const [k, v] of Object.entries(current || {})) if (ids.has(k)) out[k] = v;
  for (const def of defs.filter(allow)) {
    if (!input || !(def.id in input)) continue;
    const v = cleanValue(def, input[def.id]);
    if (v) out[def.id] = v; else delete out[def.id];
  }
  return out;
}

// Only the values a given viewer may see.
export function visibleCustom(custom, defs, allow) {
  const out = {};
  for (const def of defs.filter(allow)) if (custom?.[def.id]) out[def.id] = custom[def.id];
  return out;
}
