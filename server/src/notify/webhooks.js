// Durable webhook delivery: every event is queued per matching webhook and retried with backoff.
import crypto from 'node:crypto';
import { q, one, pool } from '../db.js';
import { bus } from '../events.js';

const BACKOFF_S = [0, 30, 120, 600, 1800, 7200]; // attempt n waits BACKOFF_S[n]
const MAX_ATTEMPTS = BACKOFF_S.length;

export const matches = (patterns, event) => (patterns || []).some((p) =>
  p === '*' || p === event || (p.endsWith('.*') && event.startsWith(p.slice(0, -1))));

export function sign(secret, body, ts) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

export function initWebhooks() {
  bus.on('event', (ev) => enqueue(ev).catch((e) => console.error('webhook enqueue', e.message)));
  const tick = () => work().catch((e) => console.error('webhook worker', e.message)).finally(() => setTimeout(tick, 2000));
  tick();
}

async function enqueue(ev) {
  const hooks = await q('SELECT id, events FROM webhooks WHERE enabled');
  for (const h of hooks.filter((x) => matches(x.events, ev.event))) {
    await q('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3)', [h.id, ev.event, ev]);
  }
}

async function work() {
  const client = await pool.connect();
  let jobs;
  try {
    await client.query('BEGIN');
    jobs = (await client.query(
      `SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status='pending' AND d.next_attempt <= now()
       ORDER BY d.id LIMIT 20 FOR UPDATE OF d SKIP LOCKED`)).rows;
    for (const j of jobs) {
      await client.query("UPDATE webhook_deliveries SET next_attempt = now() + interval '5 minutes' WHERE id=$1", [j.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await Promise.all(jobs.map(deliver));
}

export async function deliver(j) {
  const body = JSON.stringify({ id: String(j.id), ...j.payload });
  const ts = Math.floor(Date.now() / 1000);
  let code = null, text = '', ok = false;
  try {
    const r = await fetch(j.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'AsterFi-Webhooks/1.0',
        'x-asterfi-event': j.event,
        'x-asterfi-delivery': String(j.id),
        'x-asterfi-signature': `t=${ts},v1=${sign(j.secret, body, ts)}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    code = r.status;
    text = (await r.text()).slice(0, 2000);
    ok = r.ok;
  } catch (e) {
    text = e.cause?.message || e.message;
  }
  const attempts = j.attempts + 1;
  if (ok) {
    await q(`UPDATE webhook_deliveries SET status='success', attempts=$2, response_code=$3, response_body=$4, delivered_at=now() WHERE id=$1`,
      [j.id, attempts, code, text]);
  } else if (attempts >= MAX_ATTEMPTS) {
    await q(`UPDATE webhook_deliveries SET status='failed', attempts=$2, response_code=$3, response_body=$4 WHERE id=$1`,
      [j.id, attempts, code, text]);
  } else {
    await q(`UPDATE webhook_deliveries SET attempts=$2, response_code=$3, response_body=$4,
             next_attempt = now() + make_interval(secs => $5) WHERE id=$1`, [j.id, attempts, code, text, BACKOFF_S[attempts]]);
  }
  return { ok, code, body: text };
}

export async function redeliver(id) {
  await q(`UPDATE webhook_deliveries SET status='pending', attempts=0, next_attempt=now() WHERE id=$1`, [id]);
}

export async function sendTest(webhookId) {
  const h = await one('SELECT * FROM webhooks WHERE id=$1', [webhookId]);
  if (!h) throw new Error('not found');
  const payload = { event: 'webhook.test', timestamp: new Date().toISOString(), data: { message: 'Test delivery from AsterFi', webhook: h.name } };
  const d = await one('INSERT INTO webhook_deliveries (webhook_id, event, payload, attempts) VALUES ($1,$2,$3,$4) RETURNING *',
    [h.id, 'webhook.test', payload, MAX_ATTEMPTS - 1]);
  return deliver({ ...d, url: h.url, secret: h.secret });
}
