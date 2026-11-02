import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, migrate, type Db } from '../db/index.js';
import { connectionFrom, createCaseQueue, startCaseWorker } from '../jobs/queue.js';
import { localStorage } from '../storage/index.js';
import {
  createTenant,
  getCase,
  getDocuments,
  getEvents,
  processCase,
  receiveRequest,
  recoverStuckCases,
  type Enqueue,
} from './cases.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://quote:quote@localhost:54329/quote_desk';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:63799';

const root = mkdtempSync(join(tmpdir(), 'quote-desk-'));
const storage = localStorage(root);
const noQueue: Enqueue = async () => {};
const unique = () => Buffer.from(`Please quote part ${randomUUID()}`);

let db: Db;
let tenantId: string;

const waitForStatus = async (id: string, status: string) =>
  vi.waitFor(
    async () => expect((await getCase(db, tenantId, id))?.status).toBe(status),
    { timeout: 15_000, interval: 50 },
  );

beforeAll(async () => {
  db = connect(DATABASE_URL);
  await migrate(db);
  tenantId = await createTenant(db, 'Northline Fabrication');
});

afterAll(async () => {
  await db.end();
  rmSync(root, { recursive: true, force: true });
});

describe('receiveRequest', () => {
  it('stores the file, creates the case and records the audit trail', async () => {
    const bytes = unique();
    const enqueue = vi.fn(noQueue);
    const { caseId, duplicate } = await receiveRequest(
      { db, storage, enqueue },
      { tenantId, filename: '../../quote.txt', bytes },
    );

    expect(duplicate).toBe(false);
    expect(enqueue).toHaveBeenCalledWith({ tenantId, caseId });
    expect((await getCase(db, tenantId, caseId))?.status).toBe('received');

    const [document] = await getDocuments(db, tenantId, caseId);
    expect(document?.filename).toBe('quote.txt');
    expect(document?.storageKey).not.toContain('..');
    expect(await storage.get(document!.storageKey)).toEqual(bytes);
    expect((await getEvents(db, tenantId, caseId)).map((event) => event.type)).toEqual(['case.received']);
  });

  it('turns the same request delivered twice into one case and one job', async () => {
    const bytes = unique();
    const enqueue = vi.fn(noQueue);
    const first = await receiveRequest({ db, storage, enqueue }, { tenantId, filename: 'a.txt', bytes });
    const second = await receiveRequest({ db, storage, enqueue }, { tenantId, filename: 'b.txt', bytes });

    expect(second).toEqual({ caseId: first.caseId, duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('creates exactly one case when the same request arrives concurrently', async () => {
    const bytes = unique();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        receiveRequest({ db, storage, enqueue: noQueue }, { tenantId, filename: 'a.txt', bytes }),
      ),
    );
    expect(new Set(results.map((result) => result.caseId)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  });

  it('writes nothing when a file is rejected', async () => {
    await expect(
      receiveRequest({ db, storage, enqueue: noQueue }, { tenantId, filename: 'x.pdf', bytes: unique() }),
    ).rejects.toThrow('does not match');
  });

  it('can recover a case when queueing fails after commit', async () => {
    const bytes = unique();
    await expect(
      receiveRequest(
        {
          db,
          storage,
          enqueue: async () => {
            throw new Error('redis down');
          },
        },
        { tenantId, filename: 'a.txt', bytes },
      ),
    ).rejects.toThrow('redis down');

    const queued: string[] = [];
    await recoverStuckCases({ db, enqueue: async (job) => void queued.push(job.caseId) }, 0);
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM quote_cases WHERE tenant_id = $1 AND status = 'received'",
      [tenantId],
    );
    expect(queued).toEqual(expect.arrayContaining(rows.map((row) => row.id)));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('tenant isolation', () => {
  it('keeps every read inside the owning business', async () => {
    const other = await createTenant(db, 'Other Business');
    const { caseId } = await receiveRequest(
      { db, storage, enqueue: noQueue },
      { tenantId, filename: 'a.txt', bytes: unique() },
    );

    expect(await getCase(db, other, caseId)).toBeNull();
    expect(await getDocuments(db, other, caseId)).toEqual([]);
    expect(await getEvents(db, other, caseId)).toEqual([]);
  });

  it('lets two businesses submit identical files as separate cases', async () => {
    const other = await createTenant(db, 'Another Business');
    const bytes = unique();
    const mine = await receiveRequest({ db, storage, enqueue: noQueue }, { tenantId, filename: 'a.txt', bytes });
    const theirs = await receiveRequest({ db, storage, enqueue: noQueue }, { tenantId: other, filename: 'a.txt', bytes });
    expect(theirs.caseId).not.toBe(mine.caseId);
  });

  it('refuses a document attached across tenants at the database level', async () => {
    const other = await createTenant(db, 'Third Business');
    const { caseId } = await receiveRequest(
      { db, storage, enqueue: noQueue },
      { tenantId, filename: 'a.txt', bytes: unique() },
    );
    await expect(
      db.query(
        `INSERT INTO case_documents (tenant_id, case_id, filename, media_type, size_bytes, sha256, storage_key)
         VALUES ($1, $2, 'x', 'text/plain', 1, 'x', 'x')`,
        [other, caseId],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('audit trail', () => {
  it('cannot be edited or deleted', async () => {
    const { caseId } = await receiveRequest(
      { db, storage, enqueue: noQueue },
      { tenantId, filename: 'a.txt', bytes: unique() },
    );
    await expect(db.query("UPDATE case_events SET type = 'x' WHERE case_id = $1", [caseId])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM case_events WHERE case_id = $1', [caseId])).rejects.toThrow('append-only');
  });
});

describe('processing', () => {
  it('runs safely more than once', async () => {
    const { caseId } = await receiveRequest(
      { db, storage, enqueue: noQueue },
      { tenantId, filename: 'a.txt', bytes: unique() },
    );
    await processCase({ db, storage }, { tenantId, caseId });
    await processCase({ db, storage }, { tenantId, caseId });

    expect((await getCase(db, tenantId, caseId))?.status).toBe('needs_review');
    const ready = (await getEvents(db, tenantId, caseId)).filter((event) => event.type === 'case.ready_for_review');
    expect(ready).toHaveLength(1);
  });

  it('ignores a job carrying the wrong tenant', async () => {
    const other = await createTenant(db, 'Fourth Business');
    const { caseId } = await receiveRequest(
      { db, storage, enqueue: noQueue },
      { tenantId, filename: 'a.txt', bytes: unique() },
    );
    await processCase({ db, storage }, { tenantId: other, caseId });
    expect((await getCase(db, tenantId, caseId))?.status).toBe('received');
  });

  it('moves a request from upload to review through the real queue', async () => {
    const options = { connection: connectionFrom(REDIS_URL), prefix: `test-${randomUUID()}`, backoffMs: 20 };
    const { queue, enqueue } = createCaseQueue(options);
    const worker = startCaseWorker({ db, storage }, options);

    try {
      const { caseId } = await receiveRequest({ db, storage, enqueue }, { tenantId, filename: 'a.txt', bytes: unique() });
      await waitForStatus(caseId, 'needs_review');
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('marks a case failed, with the reason, after retries run out', async () => {
    const options = { connection: connectionFrom(REDIS_URL), prefix: `test-${randomUUID()}`, backoffMs: 20 };
    const { queue, enqueue } = createCaseQueue(options);
    const broken = {
      put: storage.put,
      get: async () => {
        throw new Error('storage unavailable');
      },
    };
    const worker = startCaseWorker({ db, storage: broken }, options);

    try {
      const { caseId } = await receiveRequest({ db, storage, enqueue }, { tenantId, filename: 'a.txt', bytes: unique() });
      await waitForStatus(caseId, 'failed');
      expect((await getCase(db, tenantId, caseId))?.failureReason).toBe('storage unavailable');
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
