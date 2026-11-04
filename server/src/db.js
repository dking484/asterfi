import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';

// Return bigint/numeric counts as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// An idle connection that drops (PostgreSQL restarting) is dropped from the pool and replaced on next use;
// without a listener the error would end the process.
pool.on('error', (e) => console.error('database connection lost:', e.message));

export async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function migrate() {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  await convertLegacyAdmins();
}

// v0.1 kept console logins in a separate admins table. Each becomes an admin-role user
// (keeping its password) with the next free extension, then the old tables are dropped.
async function convertLegacyAdmins() {
  if (!(await one(`SELECT to_regclass('public.admins') AS t`)).t) return;
  const admins = await q('SELECT * FROM admins ORDER BY id');
  for (const a of admins) {
    const next = await one(`SELECT coalesce(max(extension::int), 100) + 1 AS n FROM users WHERE extension ~ '^[0-9]{3}$'`);
    const [first, ...rest] = String(a.name || a.username).split(' ');
    await q(`INSERT INTO users (extension, first_name, last_name, sip_password, role, password_hash)
             VALUES ($1,$2,$3,$4,'admin',$5)`,
      [String(next.n), first, rest.join(' '), Math.random().toString(36).slice(2, 18), a.password_hash]);
  }
  await pool.query('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS admins;');
}

const DEFAULT_SETTINGS = {
  general: {
    siteName: 'AsterFi',
    timezone: 'America/New_York',
    externalAddress: '',
    localNets: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    publicUrl: '',
  },
  tts: { engine: 'kokoro', voice: 'af_heart', speed: 1 },
  stt: { enabled: true, model: 'base.en' },
  smtp: {
    host: '', port: 587, secure: false, username: '', password: '',
    fromAddress: '', fromName: 'AsterFi Phone System',
  },
};

export async function getSetting(key) {
  const row = await one('SELECT value FROM settings WHERE key=$1', [key]);
  return { ...(DEFAULT_SETTINGS[key] || {}), ...(row?.value || {}) };
}

export async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  );
}
