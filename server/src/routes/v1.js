// Public REST API for integrations. Auth: "Authorization: Bearer afk_...". Reads, plus click-to-call.
import { q, one } from '../db.js';
import { apiKeyValid } from '../auth.js';
import { activeCalls } from '../calltracker.js';
import { listMessages } from '../voicemail.js';
import { digits, extSafe } from '../asterisk/dest.js';
import { clickToCall } from '../clicktocall.js';

const userOut = (u) => ({
  id: u.id, extension: u.extension, firstName: u.first_name, lastName: u.last_name,
  name: `${u.first_name} ${u.last_name}`.trim(), email: u.email,
});
const callOut = (c) => ({
  id: c.id, direction: c.direction, from: c.from_num, fromName: c.from_name, to: c.to_num, did: c.did,
  answeredBy: c.answered_by, status: c.status, startedAt: c.started_at, answeredAt: c.answered_at,
  endedAt: c.ended_at, duration: c.duration, talkSeconds: c.talk_seconds, missedExtensions: c.missed_exts,
});

export default async function v1Routes(app, { ami }) {
  app.addHook('preHandler', async (req, reply) => {
    const key = await apiKeyValid(req.headers.authorization);
    if (!key) return reply.code(401).send({ error: 'Invalid or missing API key' });
    req.apiKey = key;
  });

  app.get('/users', async () => (await q('SELECT * FROM users ORDER BY extension')).map(userOut));

  app.get('/users/:extension', async (req, reply) => {
    const u = await one('SELECT * FROM users WHERE extension=$1', [extSafe(req.params.extension)]);
    return u ? userOut(u) : reply.code(404).send({ error: 'Not found' });
  });

  // Filters: since/until (ISO), number (matches from/to), extension, status, direction, limit, offset.
  app.get('/calls', async (req) => {
    const { since, until, number, extension, status, direction, limit = 100, offset = 0 } = req.query;
    const where = [], p = [];
    if (since) { p.push(new Date(since)); where.push(`started_at >= $${p.length}`); }
    if (until) { p.push(new Date(until)); where.push(`started_at < $${p.length}`); }
    if (number) { p.push(`%${digits(number).slice(-10)}%`); where.push(`(from_num LIKE $${p.length} OR to_num LIKE $${p.length})`); }
    if (extension) { p.push(extSafe(extension)); where.push(`(answered_by=$${p.length} OR from_num=$${p.length} OR $${p.length} = ANY(missed_exts))`); }
    if (status) { p.push(status); where.push(`status=$${p.length}`); }
    if (direction) { p.push(direction); where.push(`direction=$${p.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await q(`SELECT * FROM calls ${w} ORDER BY started_at DESC LIMIT ${Math.min(1000, Number(limit) || 100)} OFFSET ${Number(offset) || 0}`, p);
    return rows.map(callOut);
  });

  app.get('/calls/active', async () => activeCalls());

  // Click-to-call: { extension, number }. Rings the user's phones; when they answer, AsterFi dials the number.
  // 202 with { callId } right away; GET /calls/:id finds the call once it has ended.
  app.post('/calls', async (req, reply) => {
    const { extension, number } = req.body || {};
    try {
      return reply.code(202).send(await clickToCall(ami, { extension, number }));
    } catch (e) {
      if (!e.status) throw e;
      return reply.code(e.status).send({ error: e.message });
    }
  });

  app.get('/calls/:id', async (req, reply) => {
    const c = await one('SELECT * FROM calls WHERE id=$1', [req.params.id]);
    return c ? { ...callOut(c), path: c.path } : reply.code(404).send({ error: 'Not found' });
  });

  app.get('/voicemail', async (req) => {
    const msgs = await listMessages(req.query.mailbox ? extSafe(req.query.mailbox) : undefined);
    return msgs.map(({ file, ...m }) => m);
  });
}
