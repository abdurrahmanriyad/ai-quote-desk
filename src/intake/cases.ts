import { createHash } from 'node:crypto';
import { transaction, type Db, type Tx } from '../db/index';
import type { Storage } from '../storage/index';
import {
  priceQuote,
  type Catalog,
  type LineRequest,
  type PricingRules,
  type QuotePrice,
} from '../domain/pricing';
import type { ExtractionResult } from '../extraction/extract';
import { assertWithinBudget, recordUsage } from '../usage/index';
import { interpretationNotes, interpretLine, verifyEvidence } from '../extraction/interpret';
import { detectMediaType, safeDisplayName } from './files';

export type CaseStatus = 'received' | 'processing' | 'needs_review' | 'failed';

export type QuoteCase = {
  id: string;
  tenantId: string;
  status: CaseStatus;
  failureReason: string | null;
};

export type CaseDocument = {
  id: string;
  filename: string;
  mediaType: string;
  sha256: string;
  storageKey: string;
};

export type CaseEvent = { type: string; detail: Record<string, unknown> };

export type Enqueue = (job: { tenantId: string; caseId: string }) => Promise<void>;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function recordEvent(
  tx: Tx | Db,
  tenantId: string,
  caseId: string,
  type: string,
  detail: Record<string, unknown> = {},
) {
  await tx.query('INSERT INTO case_events (tenant_id, case_id, type, detail) VALUES ($1, $2, $3, $4)', [
    tenantId,
    caseId,
    type,
    detail,
  ]);
}

/**
 * Accepts one uploaded request. Order matters: the file is stored before the
 * row exists, and the job is queued after commit, so a crash at any point
 * leaves something a retry or the recovery sweep can finish.
 */
export async function receiveRequest(
  deps: { db: Db; storage: Storage; enqueue: Enqueue },
  input: { tenantId: string; filename: string; bytes: Buffer },
): Promise<{ caseId: string; duplicate: boolean }> {
  const mediaType = detectMediaType(input.filename, input.bytes);
  const hash = sha256(input.bytes);
  const storageKey = `${input.tenantId}/${hash}`;

  await deps.storage.put(storageKey, input.bytes);

  const result = await transaction(deps.db, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO quote_cases (tenant_id, content_sha256) VALUES ($1, $2)
       ON CONFLICT (tenant_id, content_sha256) DO NOTHING
       RETURNING id`,
      [input.tenantId, hash],
    );

    const created = inserted.rows[0];
    if (!created) {
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM quote_cases WHERE tenant_id = $1 AND content_sha256 = $2',
        [input.tenantId, hash],
      );
      return { caseId: existing.rows[0]!.id, duplicate: true };
    }

    await tx.query(
      `INSERT INTO case_documents (tenant_id, case_id, filename, media_type, size_bytes, sha256, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.tenantId,
        created.id,
        safeDisplayName(input.filename),
        mediaType,
        input.bytes.length,
        hash,
        storageKey,
      ],
    );
    await recordEvent(tx, input.tenantId, created.id, 'case.received', { mediaType });
    return { caseId: created.id, duplicate: false };
  });

  if (!result.duplicate) await deps.enqueue({ tenantId: input.tenantId, caseId: result.caseId });
  return result;
}

/** Every read takes a tenant ID, so one business can never load another's case. */
export async function getCase(db: Db, tenantId: string, caseId: string): Promise<QuoteCase | null> {
  const { rows } = await db.query<{ id: string; tenant_id: string; status: CaseStatus; failure_reason: string | null }>(
    'SELECT id, tenant_id, status, failure_reason FROM quote_cases WHERE id = $1 AND tenant_id = $2',
    [caseId, tenantId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, tenantId: row.tenant_id, status: row.status, failureReason: row.failure_reason }
    : null;
}

export async function getDocuments(db: Db, tenantId: string, caseId: string): Promise<CaseDocument[]> {
  const { rows } = await db.query<{
    id: string;
    filename: string;
    media_type: string;
    sha256: string;
    storage_key: string;
  }>(
    `SELECT id, filename, media_type, sha256, storage_key FROM case_documents
     WHERE case_id = $1 AND tenant_id = $2 ORDER BY created_at`,
    [caseId, tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    sha256: row.sha256,
    storageKey: row.storage_key,
  }));
}

export async function getEvents(db: Db, tenantId: string, caseId: string): Promise<CaseEvent[]> {
  const { rows } = await db.query<CaseEvent>(
    'SELECT type, detail FROM case_events WHERE case_id = $1 AND tenant_id = $2 ORDER BY id',
    [caseId, tenantId],
  );
  return rows;
}

export async function createTenant(db: Db, name: string) {
  const { rows } = await db.query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);
  return rows[0]!.id;
}

export type Pipeline = {
  db: Db;
  storage: Storage;
  catalog: Catalog;
  rules: PricingRules;
  extract: (mediaType: string, bytes: Buffer) => Promise<ExtractionResult>;
  monthlyBudgetUsd?: number;
};

const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'message/rfc822']);

/**
 * Pipeline step for one case. Safe to run more than once: a retry replaces the
 * draft. The model reads the request; catalog matching, pricing and verification
 * are all plain code, and the result always stops at a person.
 */
export async function processCase(deps: Pipeline, job: { tenantId: string; caseId: string }) {
  const { db, storage } = deps;
  const claimed = await db.query(
    `UPDATE quote_cases SET status = 'processing', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status IN ('received', 'processing')`,
    [job.caseId, job.tenantId],
  );
  if (claimed.rowCount === 0) return;

  await recordEvent(db, job.tenantId, job.caseId, 'case.processing');

  const [document] = await getDocuments(db, job.tenantId, job.caseId);
  if (!document) throw new Error(`Case has no document: ${job.caseId}`);

  const bytes = await storage.get(document.storageKey);
  if (sha256(bytes) !== document.sha256) throw new Error(`Stored file changed: ${document.id}`);

  await assertWithinBudget(db, job.tenantId, deps.monthlyBudgetUsd ?? 5);
  const { extraction, usage, model } = await deps.extract(document.mediaType, bytes);
  await recordUsage(db, { ...job, model, usage });
  const lines = extraction.lines.map((line) => interpretLine(line, deps.catalog));
  const price = priceQuote(lines, deps.catalog, deps.rules);

  const reviewIssues = [
    ...(TEXT_TYPES.has(document.mediaType)
      ? verifyEvidence(extraction, bytes.toString('utf8'))
      : ['Quotes from this file type are not checked automatically yet']),
    ...interpretationNotes(extraction, deps.catalog),
  ];
  if (extraction.containsInstructionsToSoftware) {
    reviewIssues.push('The request contains text trying to instruct software');
  }

  await transaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO case_drafts
         (case_id, tenant_id, model, extraction, lines, price, review_issues, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (case_id) DO UPDATE SET
         model = EXCLUDED.model, extraction = EXCLUDED.extraction, lines = EXCLUDED.lines,
         price = EXCLUDED.price, review_issues = EXCLUDED.review_issues,
         input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
         created_at = now()`,
      [
        job.caseId,
        job.tenantId,
        model,
        JSON.stringify(extraction),
        JSON.stringify(lines),
        JSON.stringify(price),
        JSON.stringify(reviewIssues),
        usage.inputTokens,
        usage.outputTokens,
      ],
    );
    await tx.query(
      `UPDATE quote_cases SET status = 'needs_review', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [job.caseId, job.tenantId],
    );
    await recordEvent(tx, job.tenantId, job.caseId, 'case.ready_for_review', {
      model,
      reviewIssues: reviewIssues.length,
    });
  });
}

export async function getDraft(db: Db, tenantId: string, caseId: string) {
  const { rows } = await db.query<{ price: QuotePrice; review_issues: string[]; lines: LineRequest[] }>(
    'SELECT price, review_issues, lines FROM case_drafts WHERE case_id = $1 AND tenant_id = $2',
    [caseId, tenantId],
  );
  const row = rows[0];
  return row ? { price: row.price, reviewIssues: row.review_issues, lines: row.lines } : null;
}

/** Called once retries run out, so a stuck request is visible instead of silent. */
export async function failCase(db: Db, job: { tenantId: string; caseId: string }, reason: string) {
  await transaction(db, async (tx) => {
    await tx.query(
      `UPDATE quote_cases SET status = 'failed', failure_reason = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status <> 'needs_review'`,
      [job.caseId, job.tenantId, reason],
    );
    await recordEvent(tx, job.tenantId, job.caseId, 'case.failed', { reason });
  });
}

/** Re-queues cases that committed but never ran, such as after a crash. */
export async function recoverStuckCases(deps: { db: Db; enqueue: Enqueue }, olderThanMs: number) {
  const { rows } = await deps.db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM quote_cases
     WHERE status IN ('received', 'processing') AND updated_at < now() - ($1 * interval '1 millisecond')`,
    [olderThanMs],
  );
  for (const row of rows) await deps.enqueue({ tenantId: row.tenant_id, caseId: row.id });
  return rows.length;
}
