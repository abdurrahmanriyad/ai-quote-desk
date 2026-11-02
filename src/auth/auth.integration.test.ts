import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, migrate, type Db } from '../db/index';
import { createTenant } from '../intake/cases';
import { createUser, getSession, signIn, signOut } from './index';

let db: Db;
let tenantId: string;
const PASSWORD = 'correct horse battery';
const newUser = async () => {
  const email = `${randomUUID()}@example.com`;
  await createUser(db, { tenantId, email, password: PASSWORD });
  return email;
};

beforeAll(async () => {
  db = connect(process.env.DATABASE_URL ?? 'postgres://quote:quote@localhost:54329/quote_desk');
  await migrate(db);
  tenantId = await createTenant(db, 'Test Business');
});

afterAll(async () => {
  await db.end();
});

describe('sign-in', () => {
  it('creates a session tied to the right business', async () => {
    const email = await newUser();
    const { token } = await signIn(db, email.toUpperCase(), PASSWORD);
    expect(await getSession(db, token)).toEqual({ tenantId, email });
  });

  it('gives the same message for a wrong password and an unknown email', async () => {
    const email = await newUser();
    await expect(signIn(db, email, 'wrong password here')).rejects.toThrow('Incorrect email or password');
    await expect(signIn(db, `${randomUUID()}@example.com`, PASSWORD)).rejects.toThrow('Incorrect email or password');
  });

  it('locks out repeated failures, even with the right password', async () => {
    const email = await newUser();
    for (let i = 0; i < 5; i += 1) await signIn(db, email, 'wrong password here').catch(() => {});
    await expect(signIn(db, email, PASSWORD)).rejects.toThrow('Too many attempts');
  });

  it('never stores a plain password or token', async () => {
    const email = await newUser();
    const { token } = await signIn(db, email, PASSWORD);
    const { rows } = await db.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
    const stored = await db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token]);
    expect(stored.rows).toHaveLength(0);
  });

  it('rejects short passwords', async () => {
    await expect(createUser(db, { tenantId, email: 'a@example.com', password: 'short' })).rejects.toThrow('at least');
  });
});

describe('sessions', () => {
  it('stops working after sign-out', async () => {
    const { token } = await signIn(db, await newUser(), PASSWORD);
    await signOut(db, token);
    expect(await getSession(db, token)).toBeNull();
  });

  it('stops working after expiry', async () => {
    const { token } = await signIn(db, await newUser(), PASSWORD);
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    expect(await getSession(db, token)).toBeNull();
  });

  it('ignores missing and made-up tokens', async () => {
    expect(await getSession(db, undefined)).toBeNull();
    expect(await getSession(db, 'made-up')).toBeNull();
  });
});
