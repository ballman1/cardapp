import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 32, SCRYPT);
  const expected = Buffer.from(k, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const SESSION_COOKIE = 'cv_sid';
const SESSION_DAYS = 14;

export async function createSession(db: Db, userId: string): Promise<{ token: string; expires: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [userId, tokenHash(token), expires]);
  return { token, expires };
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
}

export async function userFromRequest(db: Db, req: FastifyRequest): Promise<{ id: string; email: string } | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const r = await db.query(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash(token)]);
  return r.rows[0] ?? null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string };
  }
}

/** preHandler: authentication + CSRF header on state-changing requests. */
export function requireAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'cardvalue') {
      return reply.code(403).send({ error: 'missing_csrf_header' });
    }
    const u = await userFromRequest(db, req);
    if (!u) return reply.code(401).send({ error: 'unauthenticated' });
    req.user = u;
  };
}
