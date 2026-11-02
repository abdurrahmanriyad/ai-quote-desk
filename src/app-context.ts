/**
 * Shared server resources for the web app. There's no sign-in yet, so every
 * request acts as the demo business. Run this locally until auth is added.
 */
import catalogJson from '../data/demo-company/catalog.json' with { type: 'json' };
import company from '../data/demo-company/company.json' with { type: 'json' };
import rulesJson from '../data/demo-company/pricing.json' with { type: 'json' };
import { connect, type Db } from './db/index';
import type { Catalog, PricingRules } from './domain/pricing';
import { createTenant } from './intake/cases';
import { connectionFrom, createCaseQueue } from './jobs/queue';
import { localStorage } from './storage/index';

export const catalog = catalogJson as Catalog;
export const rules = rulesJson as PricingRules;
export { company };
export const REVIEWER = 'Demo reviewer';

type Context = {
  db: Db;
  storage: ReturnType<typeof localStorage>;
  enqueue: ReturnType<typeof createCaseQueue>['enqueue'];
  tenantId: string;
};

const cached = globalThis as typeof globalThis & { quoteDesk?: Promise<Context> };

async function start(): Promise<Context> {
  const db = connect();
  const { rows } = await db.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1 ORDER BY created_at LIMIT 1', [
    company.name,
  ]);
  return {
    db,
    storage: localStorage(process.env.STORAGE_DIR ?? '.data/files'),
    enqueue: createCaseQueue({ connection: connectionFrom() }).enqueue,
    tenantId: rows[0]?.id ?? (await createTenant(db, company.name)),
  };
}

export const context = () => (cached.quoteDesk ??= start());
