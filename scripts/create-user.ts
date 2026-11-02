/** Creates a sign-in: `npm run user:create -- "Business name" person@example.com` with PASSWORD set. */
import { createUser } from '../src/auth/index';
import { connect } from '../src/db/index';
import { createTenant } from '../src/intake/cases';

const [business, email] = process.argv.slice(2);
const password = process.env.PASSWORD;
if (!business || !email || !password) throw new Error('Usage: PASSWORD=... npm run user:create -- "Business" email');

const db = connect();
const { rows } = await db.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1 ORDER BY created_at LIMIT 1', [business]);
await createUser(db, { tenantId: rows[0]?.id ?? (await createTenant(db, business)), email, password });
await db.end();
console.log(`Created ${email}`);
