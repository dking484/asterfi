import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, q } from './db.js';

const scrypt = promisify(crypto.scrypt);
export const SESSION_COOKIE = 'asterfi_session';
const SESSION_DAYS = 14;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`,
    [token, userId, SESSION_DAYS]);
  await q('DELETE FROM user_sessions WHERE expires_at < now()');
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function sessionUser(token) {
  if (!token) return null;
  return one(`SELECT u.id, u.extension, u.first_name, u.last_name, u.email, u.role, u.theme
              FROM user_sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token=$1 AND s.expires_at > now() AND u.password_hash IS NOT NULL`, [token]);
}

// Sign-in accepts an email address or an extension.
export async function findLogin(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  return one('SELECT * FROM users WHERE (lower(email)=lower($1) OR extension=$1) AND password_hash IS NOT NULL', [id]);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function apiKeyValid(header) {
  const m = /^Bearer\s+(afk_[A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m) return null;
  const row = await one('UPDATE api_keys SET last_used=now() WHERE key_hash=$1 RETURNING id, name', [sha256(m[1])]);
  return row;
}

export function newApiKey() {
  const key = `afk_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 10) };
}

export const randomSecret = (n = 16) => crypto.randomBytes(n * 2).toString('base64url').replace(/[-_]/g, '').slice(0, n);
