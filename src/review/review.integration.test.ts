import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import catalogJson from '../../data/demo-company/catalog.json' with { type: 'json' };
import rulesJson from '../../data/demo-company/pricing.json' with { type: 'json' };
import { connect, migrate, type Db } from '../db/index';
import type { Catalog, LineRequest, PricingRules } from '../domain/pricing';
import { createTenant, getEvents, processCase, receiveRequest } from '../intake/cases';
import { localStorage } from '../storage/index';
import { approveQuote, getApprovedQuote, getReview, saveCorrections } from './review';

const catalog = catalogJson as Catalog;
const rules = rulesJson as PricingRules;
const root = mkdtempSync(join(tmpdir(), 'quote-review-'));
const storage = localStorage(root);

let db: Db;
let tenantId: string;

const requested = (overrides = {}) => ({
  description: 'bracket',
  quantity: 10 as number | null,
  material: 'mild steel',
  thickness: 2,
  thicknessUnit: 'mm' as const,
  width: 500,
  height: 300,
  sizeUnit: 'mm' as const,
  bends: 0,
  finish: 'no finish',
  evidence: ['10 brackets'],
  ...overrides,
});

async function draftCase(line = requested(), suspicious = false) {
  const { caseId } = await receiveRequest(
    { db, storage, enqueue: async () => {} },
    { tenantId, filename: 'a.txt', bytes: Buffer.from(`10 brackets, 2 mm mild steel, 500 x 300 mm, flat. Ref ${randomUUID()}`) },
  );
  await processCase(
    {
      db,
      storage,
      catalog,
      rules,
      extract: async () => ({
        model: 'claude-haiku-5-5',
        usage: { inputTokens: 1, outputTokens: 1 },
        extraction: {
          customer: { name: 'Maya', company: 'Harbor', email: null },
          lines: [line],
          containsInstructionsToSoftware: suspicious,
        },
      }),
    },
    { tenantId, caseId },
  );
  return caseId;
}

const linesOf = async (caseId: string) =>
  (await getReview(db, tenantId, caseId))!.draft!.lines.map(
    ({ description: _description, ...line }): LineRequest => line,
  );

beforeAll(async () => {
  db = connect(process.env.DATABASE_URL ?? 'postgres://quote:quote@localhost:54329/quote_desk');
  await migrate(db);
  tenantId = await createTenant(db, 'Test Business');
});

afterAll(async () => {
  await db.end();
  rmSync(root, { recursive: true, force: true });
});

describe('corrections', () => {
  it('fixes a missing detail, reprices it and records who changed what', async () => {
    const caseId = await draftCase(requested({ quantity: null }));
    expect((await getReview(db, tenantId, caseId))?.draft?.price.ok).toBe(false);

    const lines = await linesOf(caseId);
    lines[0]!.quantity = 10;
    await saveCorrections({ db, catalog, rules }, { tenantId, caseId, lines, reviewer: 'Sam' });

    expect((await getReview(db, tenantId, caseId))?.draft?.price).toMatchObject({ ok: true, totalCents: 17250 });
    const event = (await getEvents(db, tenantId, caseId)).find((e) => e.type === 'draft.corrected');
    expect(event?.detail).toMatchObject({ reviewer: 'Sam' });
  });

  it('refuses a different number of lines', async () => {
    const caseId = await draftCase();
    await expect(
      saveCorrections({ db, catalog, rules }, { tenantId, caseId, lines: [], reviewer: 'Sam' }),
    ).rejects.toThrow('do not match');
  });

  it("can't change another business's case", async () => {
    const caseId = await draftCase();
    const other = await createTenant(db, 'Other');
    await expect(
      saveCorrections({ db, catalog, rules }, { tenantId: other, caseId, lines: [], reviewer: 'Sam' }),
    ).rejects.toThrow('not found');
  });
});

describe('approval', () => {
  const approve = (caseId: string, acknowledgedIssues = false) =>
    approveQuote(db, { tenantId, caseId, reviewer: 'Sam', acknowledgedIssues });

  it('snapshots the quote and closes the case', async () => {
    const caseId = await draftCase();
    await approve(caseId);

    expect((await getReview(db, tenantId, caseId))?.status).toBe('approved');
    const quote = await getApprovedQuote(db, tenantId, caseId);
    expect(quote?.price.totalCents).toBe(17250);
    expect(quote?.lines[0]?.description).toBe('bracket');
  });

  it('refuses an unpriced quote', async () => {
    const caseId = await draftCase(requested({ width: null }));
    await expect(approve(caseId)).rejects.toThrow('missing details');
  });

  it('refuses an order that still needs a freight quote', async () => {
    const caseId = await draftCase(requested({ width: 2000, height: 1000, quantity: 100 }));
    await expect(approve(caseId)).rejects.toThrow('freight');
  });

  it('requires warnings to be acknowledged, then records that they were', async () => {
    const caseId = await draftCase(requested(), true);
    await expect(approve(caseId)).rejects.toThrow('warnings');
    await approve(caseId, true);
    const event = (await getEvents(db, tenantId, caseId)).find((e) => e.type === 'quote.approved');
    expect(event?.detail.acknowledgedIssues).toContain('The request contains text trying to instruct software');
  });

  it('approves only once, even when two people click together', async () => {
    const caseId = await draftCase();
    const results = await Promise.allSettled([approve(caseId), approve(caseId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('blocks edits after approval, and the stored quote cannot be changed', async () => {
    const caseId = await draftCase();
    const lines = await linesOf(caseId);
    await approve(caseId);

    await expect(
      saveCorrections({ db, catalog, rules }, { tenantId, caseId, lines, reviewer: 'Sam' }),
    ).rejects.toThrow('no longer open');
    await expect(
      db.query(`UPDATE approved_quotes SET price = '{}' WHERE case_id = $1`, [caseId]),
    ).rejects.toThrow('cannot be changed');
  });
});
