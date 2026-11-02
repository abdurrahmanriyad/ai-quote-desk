import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../db/index';

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

const SESSION_DAYS = 14;
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;

export class AuthError extends Error {}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await derive(password, salt, 64)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await derive(password, Buffer.from(salt, 'hex'), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createUser(db: Db, input: { tenantId: string; email: string; password: string }) {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  await db.query('INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3)', [
    input.tenantId,
    normalizeEmail(input.email),
    await hashPassword(input.password),
  ]);
}

// Checked when the email is unknown, so response time doesn't reveal who has an account.
const DECOY = hashPassword(randomBytes(16).toString('hex'));

/** Returns a session token. Every failure gives the same message. */
export async function signIn(db: Db, emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const recent = await db.query<{ count: string }>(
    `SELECT count(*) FROM login_attempts
     WHERE email = $1 AND attempted_at > now() - ($2 * interval '1 minute')`,
    [email, LOCKOUT_MINUTES],
  );
  if (Number(recent.rows[0]!.count) >= MAX_FAILURES) {
    throw new AuthError('Too many attempts. Try again in 15 minutes.');
  }

  const { rows } = await db.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  const valid = await verifyPassword(password, user?.password_hash ?? (await DECOY));

  if (!user || !valid) {
    await db.query('INSERT INTO login_attempts (email) VALUES ($1)', [email]);
    throw new AuthError('Incorrect email or password');
  }

  await db.query('DELETE FROM login_attempts WHERE email = $1', [email]);
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
    [hashToken(token), user.id, SESSION_DAYS],
  );
  return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
}

export async function getSession(db: Db, token: string | undefined) {
  if (!token) return null;
  const { rows } = await db.query<{ tenant_id: string; email: string }>(
    `SELECT u.tenant_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ? { tenantId: rows[0].tenant_id, email: rows[0].email } : null;
}

export async function signOut(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}
