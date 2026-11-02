import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url });
}

export async function transaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Applies unapplied files in name order. The lock stops two deploys racing. */
export async function migrate(db: Db) {
  await transaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(727274)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await tx.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const folder = join(process.cwd(), 'migrations');
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith('.sql') || applied.has(name)) continue;
      await tx.query(readFileSync(join(folder, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
  });
}
