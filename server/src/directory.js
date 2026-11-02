// A phone's directory: coworkers, ring groups, and the phone owner's own contacts.
// Feeds both UniFi Talk phones (pushed over their WebSocket) and standard SIP phones (XML phonebook URLs).
import { q } from './db.js';

const cleanNum = (n) => String(n || '').replace(/[^0-9*#+]/g, '');

// Personal contacts, with the coworker's current name filled in on entries attached to a coworker.
export const CONTACT_QUERY = `SELECT c.id, c.owner_id, c.coworker_id, COALESCE(u.first_name, c.first_name) AS first_name,
  COALESCE(u.last_name, c.last_name) AS last_name, c.company, c.email, c.phones, c.notes, c.custom, c.created_at, c.updated_at
  FROM contacts c LEFT JOIN users u ON u.id = c.coworker_id`;

export async function directoryFor(userId) {
  const [users, groups, contacts] = await Promise.all([
    q('SELECT id, extension, first_name, last_name, email, created_at FROM users ORDER BY lower(first_name || last_name)'),
    q('SELECT id, extension, name, members FROM ring_groups ORDER BY lower(name)'),
    userId ? q(`${CONTACT_QUERY} WHERE c.owner_id=$1 ORDER BY lower(COALESCE(u.first_name || u.last_name, c.first_name || c.last_name || c.company))`, [userId]) : [],
  ]);
  const cleaned = contacts.map((c) => ({ ...c, phones: (c.phones || []).map((p) => ({ label: p.label || 'Other', number: cleanNum(p.number) })).filter((p) => p.number) }));
  // Your own extra numbers for a coworker belong on that coworker's entry, not on a second entry of their own.
  const extra = new Map(cleaned.filter((c) => c.coworker_id).map((c) => [c.coworker_id, c]));
  return {
    users: users.filter((u) => u.id !== userId).map((u) => {
      const x = extra.get(u.id);
      return x ? { ...u, extra: x.phones, email: u.email || x.email, updated_at: x.updated_at } : { ...u, extra: [] };
    }),
    allUsers: users,
    groups,
    contacts: cleaned.filter((c) => !c.coworker_id),
  };
}

// Display name for a contact; falls back to the company when there is no person's name.
export const contactName = (c) => `${c.first_name} ${c.last_name}`.trim() || c.company || 'Contact';

// One flat list (name, number, label) for phones that only understand simple entries.
export function flatEntries(dir) {
  const out = [];
  for (const u of dir.users) {
    const name = `${u.first_name} ${u.last_name}`.trim() || u.extension;
    out.push({ name, number: u.extension, label: 'Extension', group: 'Coworkers' });
    for (const p of u.extra) out.push({ name, number: p.number, label: p.label, group: 'Coworkers' });
  }
  for (const g of dir.groups) out.push({ name: g.name, number: g.extension, label: 'Group', group: 'Groups' });
  for (const c of dir.contacts) {
    for (const p of c.phones) out.push({ name: contactName(c), number: p.number, label: p.label, group: 'Contacts', company: c.company });
  }
  return out;
}
