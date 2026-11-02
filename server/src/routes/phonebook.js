// Remote phonebooks for standard SIP desk phones. Each user has a secret token; the URL is entered in the
// phone's "remote phonebook" setting and returns that user's directory (coworkers, groups, their contacts).
//   /phonebook/<token>/yealink.xml            Yealink remote phonebook
//   /phonebook/<token>/cisco.xml              CiscoIPPhoneDirectory (Cisco, Fanvil, Snom, Htek and others)
//   /phonebook/<token>/gs/phonebook.xml       Grandstream (the phone appends "phonebook.xml" to its server path)
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { directoryFor, flatEntries, contactName } from '../directory.js';

const x = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export async function phonebookToken(userId, { rotate = false } = {}) {
  const u = await one('SELECT phonebook_token FROM users WHERE id=$1', [userId]);
  if (!u) return null;
  if (u.phonebook_token && !rotate) return u.phonebook_token;
  const token = crypto.randomBytes(18).toString('base64url');
  await q('UPDATE users SET phonebook_token=$2 WHERE id=$1', [userId, token]);
  return token;
}

function yealink(dir) {
  const menu = (name, units) => `  <Menu Name="${x(name)}">\n${units.join('\n')}\n  </Menu>`;
  const unit = (name, nums) => `    <Unit Name="${x(name)}" ${nums.slice(0, 3).map((n, i) => `Phone${i + 1}="${x(n)}"`).join(' ')} default_photo="Resource:"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<YealinkIPPhoneBook>\n  <Title>Directory</Title>\n${[
    menu('Coworkers', dir.users.map((u) => unit(`${u.first_name} ${u.last_name}`.trim() || u.extension, [u.extension, ...u.extra.map((p) => p.number)]))),
    menu('Groups', dir.groups.map((g) => unit(g.name, [g.extension]))),
    menu('Contacts', dir.contacts.filter((c) => c.phones.length).map((c) => unit(contactName(c), c.phones.map((p) => p.number)))),
  ].join('\n')}\n</YealinkIPPhoneBook>\n`;
}

function cisco(dir) {
  const entries = flatEntries(dir).map((e) => {
    const label = e.label && e.label !== 'Extension' && e.label !== 'Group' ? ` (${e.label})` : '';
    return `  <DirectoryEntry>\n    <Name>${x(e.name + label)}</Name>\n    <Telephone>${x(e.number)}</Telephone>\n  </DirectoryEntry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CiscoIPPhoneDirectory>\n  <Title>Directory</Title>\n  <Prompt>Select a contact</Prompt>\n${entries.join('\n')}\n</CiscoIPPhoneDirectory>\n`;
}

function grandstream(dir) {
  const groups = [['Coworkers', 1], ['Groups', 2], ['Contacts', 3]];
  const gid = Object.fromEntries(groups);
  const contact = (first, last, nums, group, company = '') => `  <Contact>\n    <FirstName>${x(first)}</FirstName>\n    <LastName>${x(last)}</LastName>\n${
    company ? `    <Company>${x(company)}</Company>\n` : ''}${
    nums.map((n) => `    <Phone type="${x(n.type)}">\n      <phonenumber>${x(n.number)}</phonenumber>\n      <accountindex>1</accountindex>\n    </Phone>`).join('\n')}\n    <Groups>\n      <groupid>${gid[group]}</groupid>\n    </Groups>\n  </Contact>`;
  const gsType = (label) => ({ Mobile: 'Cell', Home: 'Home' }[label] || 'Work');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<AddressBook>\n${[
    ...groups.map(([name, id]) => `  <pbgroup>\n    <id>${id}</id>\n    <name>${name}</name>\n  </pbgroup>`),
    ...dir.users.map((u) => contact(u.first_name || u.extension, u.last_name,
      [{ type: 'Work', number: u.extension }, ...u.extra.map((p) => ({ type: gsType(p.label), number: p.number }))], 'Coworkers')),
    ...dir.groups.map((g) => contact(g.name, '', [{ type: 'Work', number: g.extension }], 'Groups')),
    ...dir.contacts.filter((c) => c.phones.length).map((c) => contact(c.first_name || (!c.last_name ? c.company : ''), c.last_name,
      c.phones.map((p) => ({ type: gsType(p.label), number: p.number })), 'Contacts', c.company)),
  ].join('\n')}\n</AddressBook>\n`;
}

const FORMATS = { 'yealink.xml': yealink, 'cisco.xml': cisco, 'gs/phonebook.xml': grandstream };

export default async function phonebookRoutes(app) {
  app.get('/phonebook/:token/*', async (req, reply) => {
    const render = FORMATS[req.params['*']];
    const token = String(req.params.token || '');
    const u = render && token.length >= 20 ? await one('SELECT id FROM users WHERE phonebook_token=$1', [token]) : null;
    if (!u) return reply.code(404).type('text/plain').send('Not found');
    reply.header('cache-control', 'no-store').type('text/xml; charset=utf-8');
    return render(await directoryFor(u.id));
  });
}
