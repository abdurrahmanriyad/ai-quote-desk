/** Shared server resources and the signed-in viewer for the web app. */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import catalogJson from '../data/demo-company/catalog.json' with { type: 'json' };
import company from '../data/demo-company/company.json' with { type: 'json' };
import rulesJson from '../data/demo-company/pricing.json' with { type: 'json' };
import { getSession } from './auth/index';
import { connect, type Db } from './db/index';
import type { Catalog, PricingRules } from './domain/pricing';
import { connectionFrom, createCaseQueue } from './jobs/queue';
import { localStorage } from './storage/index';

export const catalog = catalogJson as Catalog;
export const rules = rulesJson as PricingRules;
export { company };

type Context = {
  db: Db;
  storage: ReturnType<typeof localStorage>;
  enqueue: ReturnType<typeof createCaseQueue>['enqueue'];
};

const cached = globalThis as typeof globalThis & { quoteDesk?: Promise<Context> };

async function start(): Promise<Context> {
  return {
    db: connect(),
    storage: localStorage(process.env.STORAGE_DIR ?? '.data/files'),
    enqueue: createCaseQueue({ connection: connectionFrom() }).enqueue,
  };
}

export const context = () => (cached.quoteDesk ??= start());

export const SESSION_COOKIE = 'quote_desk_session';

export type Viewer = { tenantId: string; email: string | null; canEdit: boolean };

/** A signed-in person, or a read-only visitor when the public demo is switched on. */
export async function getViewer(): Promise<Viewer | null> {
  const { db } = await context();
  const session = await getSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (session) return { ...session, canEdit: true };

  const demo = process.env.DEMO_BUSINESS;
  if (!demo) return null;
  const { rows } = await db.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1 ORDER BY created_at LIMIT 1', [demo]);
  return rows[0] ? { tenantId: rows[0].id, email: null, canEdit: false } : null;
}

export async function requireViewer() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  return viewer;
}

/** Every action that changes data goes through here, so the demo can only ever read. */
export async function requireEditor() {
  const viewer = await requireViewer();
  if (!viewer.canEdit) redirect('/login');
  return { tenantId: viewer.tenantId, reviewer: viewer.email! };
}
